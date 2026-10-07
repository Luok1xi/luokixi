#!/usr/bin/env python3
"""Offline art preparation, plus explicitly invoked local ComfyUI generation.

No hosted model SDK, credentials, model installation, or background network calls.
The shared public/art/manifest.json is never modified by this tool.
"""
from __future__ import annotations

import argparse
import functools
import hashlib
import io
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from PIL import Image, ImageOps, __version__ as PILLOW_VERSION

VERSION = 1
MAX_FILE_BYTES = 75_000_000
MAX_PIXELS = 40_000_000
MAX_VARIANT_BYTES = 200_000
ID = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
PRIVATE_PARTS = {".git", ".ssh", ".env", ".secrets", "owner-private", "node_modules"}
DEFAULTS = {"widths": [480, 960, 1600], "maxBytes": 200000, "quality": 82, "minQuality": 40}
# This adapter intentionally supports a small auditable built-in txt2img graph.
COMFY_NODES = {
    "CheckpointLoaderSimple", "CLIPTextEncode", "EmptyLatentImage", "KSampler",
    "KSamplerAdvanced", "VAEDecode", "SaveImage", "LoraLoader", "VAELoader",
    "CLIPSetLastLayer", "ModelSamplingDiscrete", "EmptySD3LatentImage",
}


class ArtError(ValueError):
    pass


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def read_json(path: Path, limit=4_000_000):
    if path.stat().st_size > limit:
        raise ArtError(f"JSON too large: {path.name}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ArtError(f"Invalid JSON: {path.name}") from exc


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_bytes(data)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def write_json(path: Path, value):
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


@contextmanager
def exclusive(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handle = path.open("x", encoding="utf-8")
    except FileExistsError:
        raise ArtError(f"Another operation holds {path.name}; wait for it. After a crash, verify that its recorded process has stopped before removing this private lock") from None
    try:
        with handle:
            handle.write(json.dumps({"pid": os.getpid(), "startedAt": datetime.now(timezone.utc).isoformat()}))
        yield
    finally:
        path.unlink(missing_ok=True)


def serialized(name):
    def decorate(function):
        @functools.wraps(function)
        def run(self, *args, **kwargs):
            with exclusive(self.work / f"{name}.lock"):
                return function(self, *args, **kwargs)
        return run
    return decorate


def inside(path: Path, base: Path) -> bool:
    return path.resolve().is_relative_to(base.resolve())


def checked_text(value, field, *, empty=False, limit=20000):
    if not isinstance(value, str) or (not empty and not value.strip()) or len(value) > limit:
        raise ArtError(f"Invalid {field}")
    return value


class Pipeline:
    def __init__(self, root: Path, config: Path | None = None, work: Path | None = None):
        self.root = root.resolve()
        self.public = (self.root / "public").resolve()
        self.art = self.root / "public" / "art"
        # resolve() also catches directory junctions on Windows.
        if self.public != self.root / "public" or self.art.resolve() != self.art:
            raise ArtError("public/art must use real project directories; no symlink/junction")
        self.work = (work or self.root / "campus" / ".data" / "art-pipeline").resolve()
        if inside(self.work, self.public):
            raise ArtError("Cache, original images and journals cannot be placed in public/")
        if not inside(self.work, self.root):
            raise ArtError("Work directory must stay inside this project")
        if any(part.lower() in PRIVATE_PARTS for part in self.work.relative_to(self.root).parts):
            raise ArtError("Work directory cannot overwrite sensitive project directories")
        self.patch_path = self.work / "manifest.patch.json"
        self.cache_path = self.work / "cache.json"
        data = read_json(config or self.root / "scripts" / "art-assets.json")
        if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get("assets"), list):
            raise ArtError("Expected version: 1 and assets: []")
        defaults = data.get("defaults", {})
        if not isinstance(defaults, dict):
            raise ArtError("defaults must be an object")
        self.assets = {}
        for raw in data["assets"]:
            if not isinstance(raw, dict):
                raise ArtError("Each asset must be an object")
            a = dict(raw)
            ident = a.get("id", "")
            if not isinstance(ident, str) or not ID.fullmatch(ident) or ident in self.assets:
                raise ArtError("Asset ids must be unique lowercase slugs")
            slots = a.get("slots")
            if not isinstance(slots, list) or not slots or any(not isinstance(s, str) or not ID.fullmatch(s) for s in slots):
                raise ArtError(f"Invalid slots for {ident}")
            if len(set(slots)) != len(slots):
                raise ArtError(f"Duplicate slots in {ident}")
            a["type"] = a.get("type", "concept")
            if a["type"] not in {"concept", "photo"}:
                raise ArtError("type must be concept or photo")
            for field in ("alt", "rights", "reviewer"):
                checked_text(a.get(field), field)
            a["prompt"] = checked_text(a.get("prompt", ""), "prompt", empty=a["type"] == "photo")
            a["review"] = a.get("review", "pending")
            if a["review"] not in {"pending", "approved"}:
                raise ArtError("review must be pending or approved")
            source = a.get("source")
            if not isinstance(source, dict):
                raise ArtError("source must contain title and optional public URL")
            checked_text(source.get("title"), "source.title")
            url = checked_text(source.get("url", ""), "source.url", empty=True)
            if url:
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
                    raise ArtError("source.url must be a public http(s) URL without credentials")
                if any(k.lower() in {"token", "key", "api_key", "signature", "sig", "auth", "password", "access_token"} for k, _ in urllib.parse.parse_qsl(parsed.query)):
                    raise ArtError("source.url cannot contain access tokens or signed credentials")
            # Explicit allowlist prevents private source paths or other fields entering the patch.
            a["source"] = {"title": source["title"], "url": url}
            a["focal"] = a.get("focal", "50% 50%")
            if not isinstance(a["focal"], str) or not re.fullmatch(r"\d{1,3}(?:\.\d+)?% \d{1,3}(?:\.\d+)?%", a["focal"]) or any(float(v[:-1]) > 100 for v in a["focal"].split()):
                raise ArtError("focal must contain two percentages from 0 to 100")
            for key, fallback in DEFAULTS.items():
                a[key] = a.get(key, defaults.get(key, fallback))
            widths = a["widths"]
            if not isinstance(widths, list) or not 1 <= len(widths) <= 8 or any(type(w) is not int or not 16 <= w <= 4096 for w in widths):
                raise ArtError("widths must be 1 to 8 integers between 16 and 4096")
            a["widths"] = sorted(set(widths))
            if type(a["maxBytes"]) is not int or not 256 <= a["maxBytes"] <= MAX_VARIANT_BYTES:
                raise ArtError("maxBytes must be between 256 and 200000")
            if any(type(a[k]) is not int for k in ("quality", "minQuality")) or not 1 <= a["minQuality"] <= a["quality"] <= 95:
                raise ArtError("quality must be 1..95 and no less than minQuality")
            self.assets[ident] = a
        all_slots = [s for a in self.assets.values() for s in a["slots"]]
        if len(all_slots) != len(set(all_slots)):
            raise ArtError("A slot cannot belong to more than one asset")

    def asset(self, ident):
        if ident not in self.assets:
            raise ArtError(f"Unknown asset id: {ident}")
        return self.assets[ident]

    def public_path(self, url):
        if not isinstance(url, str) or not re.fullmatch(r"art/[A-Za-z0-9_./-]+\.webp", url):
            raise ArtError("Only local art/*.webp paths are allowed")
        rel = PurePosixPath(url)
        if any(part in {".", ".."} or part.startswith(".") or part.lower() in PRIVATE_PARTS for part in rel.parts):
            raise ArtError("Private paths and traversal are forbidden")
        target = self.public.joinpath(*rel.parts)
        if not inside(target, self.art):
            raise ArtError("Image path escapes public/art")
        return target

    def cached(self):
        data = read_json(self.cache_path) if self.cache_path.exists() else {"version": VERSION, "recipes": {}, "assets": {}}
        if data.get("version") != VERSION or not isinstance(data.get("recipes"), dict) or not isinstance(data.get("assets"), dict):
            raise ArtError("Invalid private cache")
        return data

    def check_variant(self, v, max_bytes=MAX_VARIANT_BYTES):
        if not isinstance(v, dict):
            raise ArtError("Invalid variant entry")
        path = self.public_path(v.get("src"))
        if not path.is_file():
            raise ArtError(f"Missing image: {v['src']}")
        if path.stat().st_size > max_bytes:
            raise ArtError(f"Image exceeds byte budget: {v['src']}")
        raw = path.read_bytes()
        if len(raw) > max_bytes or len(raw) != v.get("bytes") or sha(raw) != v.get("sha256"):
            raise ArtError(f"Size or SHA-256 mismatch: {v['src']}")
        try:
            with Image.open(io.BytesIO(raw)) as im:
                im.load()
                if im.format != "WEBP" or im.size != (v.get("w"), v.get("h")):
                    raise ArtError(f"Image dimensions or format mismatch: {v['src']}")
        except (OSError, ValueError) as exc:
            raise ArtError(f"Invalid image: {v['src']}") from exc

    def verify_entry(self, entry):
        if not isinstance(entry, dict) or not isinstance(entry.get("variants"), list) or not entry["variants"]:
            raise ArtError("Entry needs image variants")
        variants = entry["variants"]
        widths = [v.get("w") for v in variants]
        if any(type(w) is not int or w <= 0 for w in widths) or widths != sorted(set(widths)):
            raise ArtError("Variant widths must be unique and ascending")
        for v in variants:
            self.check_variant(v)
        largest = variants[-1]
        for key in ("src", "w", "h"):
            if entry.get(key) != largest[key]:
                raise ArtError(f"Primary {key} does not match largest variant")
        expected = ", ".join(f"{v['src']} {v['w']}w" for v in variants)
        if entry.get("srcset") != expected:
            raise ArtError("srcset does not match verified paths and widths")
        if entry.get("review") not in {"approved", "pending"}:
            raise ArtError("Missing review state")
        meta = entry.get("meta", {})
        for key in ("type", "source", "rights", "reviewer", "prompt", "sourceSha256"):
            if key not in meta:
                raise ArtError(f"Missing provenance: {key}")

    def plan(self):
        manifest_path = self.art / "manifest.json"
        manifest = read_json(manifest_path).get("slots", {}) if manifest_path.exists() else {}
        patch = read_json(self.patch_path).get("slots", {}) if self.patch_path.exists() else {}
        declared = {s for a in self.assets.values() for s in a["slots"]}
        discovered = set()
        for folder in (self.root / "src", self.root):
            files = folder.rglob("*.js") if folder.name == "src" else folder.glob("*.html")
            for file in files:
                if inside(file, self.root):
                    discovered.update(re.findall(r'data-art=["\x27]([a-z][a-z0-9-]{0,63})["\x27]', file.read_text(encoding="utf-8")))
        groups, records = {}, []
        for a in self.assets.values():
            statuses = {}
            for slot in a["slots"]:
                entry = patch.get(slot) or manifest.get(slot)
                if not entry:
                    statuses[slot] = "missing"
                    continue
                try:
                    if "variants" in entry:
                        self.verify_entry(entry)
                    else:
                        path = self.public_path(entry.get("src"))
                        if not path.is_file():
                            raise ArtError("Missing legacy image")
                    statuses[slot] = "ready" if entry.get("review") == "approved" else "needs-review"
                except (ArtError, OSError):
                    statuses[slot] = "broken"
            group = sha(canonical({k: a[k] for k in ("prompt", "type", "source", "rights")}))[:16]
            groups.setdefault(group, []).append(a["id"])
            records.append({"id": a["id"], "slots": statuses, "needsImage": any(v in {"missing", "broken"} for v in statuses.values()), "type": a["type"], "prompt": a["prompt"], "reuseGroup": group, "source": a["source"], "rights": a["rights"]})
        result = {"version": VERSION, "networkRequests": 0, "note": "Plan only. Use Codex image generation separately, ingest authorized images, or explicitly run generate against your own local ComfyUI.", "assets": records, "duplicatePromptGroups": [ids for ids in groups.values() if len(ids) > 1], "unconfiguredSlots": sorted(discovered - declared)}
        write_json(self.work / "plan.json", result)
        return result

    @serialized("ingest")
    def ingest(self, ident, input_path: Path):
        a = self.asset(ident)
        input_path = input_path.resolve()
        if any(p.lower() in PRIVATE_PARTS for p in input_path.parts):
            raise ArtError("Refusing a sensitive input path")
        if not input_path.is_file() or input_path.stat().st_size > MAX_FILE_BYTES:
            raise ArtError("Input is missing or exceeds 75 MB")
        raw = input_path.read_bytes()
        source_hash = sha(raw)
        recipe = {"version": VERSION, "pillow": PILLOW_VERSION, "source": source_hash, **{k: a[k] for k in DEFAULTS}}
        recipe_hash = sha(canonical(recipe))
        cache = self.cached()
        variants = cache["recipes"].get(recipe_hash)
        reused = bool(variants)
        if variants:
            try:
                for v in variants:
                    self.check_variant(v, a["maxBytes"])
            except (ArtError, OSError):
                variants, reused = None, False
        if not variants:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(raw)) as source:
                        if source.format not in {"PNG", "JPEG", "WEBP", "AVIF"} or getattr(source, "n_frames", 1) != 1:
                            raise ArtError("Only a single-frame PNG, JPEG, WebP or AVIF image is accepted")
                        if source.width * source.height > MAX_PIXELS:
                            raise ArtError("Input exceeds 40 million pixels")
                        source.load()
                        corrected = ImageOps.exif_transpose(source)
                        mode = "RGBA" if "A" in corrected.getbands() or "transparency" in corrected.info else "RGB"
                        clean = corrected.convert(mode)
                        # Reconstruct the image to strip EXIF, comments and hidden metadata.
                        im = Image.frombytes(mode, clean.size, clean.tobytes())
            except (OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
                raise ArtError("Input image is corrupt or too large") from exc
            widths = sorted({min(w, im.width) for w in a["widths"]})
            pending, variants = [], []
            for width in widths:
                height = max(1, round(im.height * width / im.width))
                resized = im.resize((width, height), Image.Resampling.LANCZOS)
                encoded = None
                qualities = list(range(a["quality"], a["minQuality"] - 1, -6))
                if qualities[-1] != a["minQuality"]:
                    qualities.append(a["minQuality"])
                for quality in qualities:
                    output = io.BytesIO()
                    resized.save(output, format="WEBP", quality=quality, method=6)
                    if output.tell() <= a["maxBytes"]:
                        encoded = output.getvalue()
                        break
                if encoded is None:
                    raise ArtError(f"{ident} at {width}px exceeds {a['maxBytes']} bytes at minimum quality; use smaller configured widths or simplify the source")
                url = f"art/generated/art-{recipe_hash[:24]}-{width}.webp"
                pending.append((self.public_path(url), encoded))
                variants.append({"src": url, "w": width, "h": height, "bytes": len(encoded), "sha256": sha(encoded), "quality": quality})
            # Nothing public is written until all sizes pass the budget.
            for path, encoded in pending:
                atomic_write(path, encoded)
            cache["recipes"][recipe_hash] = variants
        largest = variants[-1]
        entry = {"src": largest["src"], "srcset": ", ".join(f"{v['src']} {v['w']}w" for v in variants), "sizes": "(max-width: 600px) 100vw, (max-width: 1100px) 80vw, 1100px", "w": largest["w"], "h": largest["h"], "alt": a["alt"], "focal": a["focal"], "review": a["review"], "variants": variants, "meta": {"type": a["type"], "source": a["source"], "rights": a["rights"], "reviewer": a["reviewer"], "prompt": a["prompt"], "sourceSha256": source_hash, "recipeSha256": recipe_hash, "preparedAt": datetime.now(timezone.utc).isoformat()}}
        self.verify_entry(entry)
        patch = read_json(self.patch_path) if self.patch_path.exists() else {"version": VERSION, "_note": "Merge reviewed slots deliberately; the shared manifest was not overwritten.", "slots": {}}
        for slot in a["slots"]:
            patch["slots"][slot] = entry
        cache["assets"][ident] = {"recipe": recipe_hash, "sourceSha256": source_hash, "slots": a["slots"]}
        write_json(self.cache_path, cache)
        write_json(self.patch_path, patch)
        return {"id": ident, "cacheHit": reused, "variants": variants, "slots": a["slots"], "patch": str(self.patch_path), "sharedManifestChanged": False, "networkRequests": 0}

    def verify(self, path=None):
        manifest = read_json(path or self.patch_path)
        if not isinstance(manifest.get("slots"), dict):
            raise ArtError("Manifest must contain slots")
        failures = []
        for slot, entry in manifest["slots"].items():
            try:
                if not isinstance(slot, str) or not ID.fullmatch(slot):
                    raise ArtError("Invalid slot id")
                self.verify_entry(entry)
            except (ArtError, OSError, TypeError, KeyError) as exc:
                failures.append({"slot": slot, "error": str(exc)})
        return {"ok": not failures, "checkedSlots": len(manifest["slots"]), "errors": failures}

    @serialized("generate")
    def generate(self, ident, workflow_path, prompt_node, endpoint="http://127.0.0.1:8188", timeout=90, resume=None):
        a = self.asset(ident)
        if a["type"] != "concept":
            raise ArtError("Generated images cannot be recorded as documentary photos")
        if not 1 <= timeout <= 600:
            raise ArtError("Timeout must be 1..600 seconds")
        transport = LocalComfy(endpoint)
        workflow = read_json(Path(workflow_path), 2_000_000)
        if not isinstance(workflow, dict) or not 1 <= len(workflow) <= 32 or any(not isinstance(v, dict) or v.get("class_type") not in COMFY_NODES for v in workflow.values()):
            raise ArtError("Use an API-format graph with supported built-in txt2img nodes; custom nodes are not run")
        prompt_node = str(prompt_node)
        if workflow.get(prompt_node, {}).get("class_type") != "CLIPTextEncode":
            raise ArtError("--prompt-node must select the positive CLIPTextEncode node")
        if not isinstance(workflow[prompt_node].get("inputs"), dict):
            raise ArtError("Prompt node inputs missing")
        workflow[prompt_node]["inputs"]["text"] = a["prompt"]
        save_nodes = []
        for node_id, node in workflow.items():
            inputs = node.get("inputs", {})
            if not isinstance(inputs, dict):
                raise ArtError("Workflow inputs must be objects")
            if node["class_type"] == "SaveImage":
                inputs["filename_prefix"] = f"luokixi/{ident}"
                save_nodes.append(node_id)
            if node["class_type"] in {"EmptyLatentImage", "EmptySD3LatentImage"}:
                width, height = inputs.get("width"), inputs.get("height")
                if inputs.get("batch_size", 1) != 1 or type(width) is not int or type(height) is not int or not 64 <= width <= 2048 or not 64 <= height <= 2048:
                    raise ArtError("Local generation is limited to one image, 64..2048 pixels per side")
            if node["class_type"] in {"KSampler", "KSamplerAdvanced"}:
                steps = inputs.get("steps")
                if type(steps) is not int or not 1 <= steps <= 60:
                    raise ArtError("Local sampling is limited to 1..60 steps")
            # Avoid loading paths outside ComfyUI's installed model directories.
            for key, value in inputs.items():
                if key.endswith("_name") and isinstance(value, str) and (".." in PurePosixPath(value.replace("\\", "/")).parts or ":" in value or value.startswith(("/", "\\"))):
                    raise ArtError("Model names must be relative installed-model names")
        classes = [node["class_type"] for node in workflow.values()]
        if len(save_nodes) != 1 or sum(c in {"EmptyLatentImage", "EmptySD3LatentImage"} for c in classes) != 1 or sum(c in {"KSampler", "KSamplerAdvanced"} for c in classes) != 1:
            raise ArtError("Workflow must contain exactly one latent, one sampler and one SaveImage node")
        job_hash = sha(canonical({"endpoint": transport.endpoint, "workflow": workflow}))
        journal_path = self.work / "jobs" / f"{job_hash}.json"
        journal = read_json(journal_path) if journal_path.exists() else {"requestSha256": job_hash}
        original = self.work / "originals" / f"{job_hash}.png"
        if journal.get("state") == "complete" and original.is_file() and sha(original.read_bytes()) == journal.get("originalSha256"):
            result = self.ingest(ident, original)
            result.update({"generationCacheHit": True, "provider": "local-comfyui", "promptId": journal.get("promptId")})
            return result
        if resume:
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", resume):
                raise ArtError("Invalid resume prompt id")
            journal.update({"promptId": resume, "state": "queued"})
            write_json(journal_path, journal)
        prompt_id = journal.get("promptId")
        deadline = time.monotonic() + timeout
        if not prompt_id:
            if journal.get("state") == "submitting":
                raise ArtError("Previous POST outcome unknown; do not submit twice. Check ComfyUI, then use --resume-prompt-id with its actual id")
            journal.update({"state": "submitting", "createdAt": datetime.now(timezone.utc).isoformat()})
            write_json(journal_path, journal)
            response = transport.json("POST", "/prompt", {"prompt": workflow, "client_id": f"luokixi-art-{job_hash[:16]}"}, deadline=deadline)
            prompt_id = response.get("prompt_id")
            if not isinstance(prompt_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", prompt_id):
                raise ArtError("ComfyUI returned no valid prompt_id; inspect its queue before resuming")
            journal.update({"promptId": prompt_id, "state": "queued"})
            write_json(journal_path, journal)
        while time.monotonic() < deadline:
            history = transport.json("GET", "/history/" + prompt_id, deadline=deadline)
            record = history.get(prompt_id)
            if record:
                status = record.get("status", {})
                if status.get("status_str") == "error":
                    journal["state"] = "failed"
                    write_json(journal_path, journal)
                    raise ArtError("Local workflow failed; inspect ComfyUI. No automatic re-submission")
                candidates = []
                for node_id in save_nodes:
                    candidates.extend(record.get("outputs", {}).get(node_id, {}).get("images", []))
                if candidates:
                    info = candidates[0]
                    filename, subfolder = info.get("filename", ""), info.get("subfolder", "")
                    if not filename or any(x in filename for x in ("/", "\\", ":")) or filename in {".", ".."} or "\\" in subfolder or ":" in subfolder or subfolder.startswith("/") or ".." in PurePosixPath(subfolder).parts or info.get("type") != "output":
                        raise ArtError("Unsafe ComfyUI output path")
                    query = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": "output"})
                    raw = transport.request("GET", "/view?" + query, limit=32_000_000, deadline=deadline)
                    # Preserve exact generator bytes privately; ingest checks format and strips metadata.
                    atomic_write(original, raw)
                    result = self.ingest(ident, original)
                    journal.update({"state": "complete", "originalSha256": sha(raw)})
                    write_json(journal_path, journal)
                    result.update({"generationCacheHit": False, "provider": "local-comfyui", "promptId": prompt_id, "journal": str(journal_path)})
                    return result
            time.sleep(min(.5, max(0, deadline - time.monotonic())))
        raise ArtError(f"Local generation still pending; re-run the same command to resume {prompt_id}. No second job will be submitted")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ArtError("ComfyUI redirects are forbidden")


class LocalComfy:
    def __init__(self, endpoint):
        try:
            url = urllib.parse.urlsplit(endpoint)
            host = url.hostname
            if host == "localhost":
                host = "127.0.0.1"  # No DNS resolution or proxy is used.
            if url.scheme != "http" or not ipaddress.ip_address(host).is_loopback or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
                raise ValueError()
            port = url.port or 8188
        except (ValueError, TypeError):
            raise ArtError("ComfyUI endpoint must be plain HTTP on a literal loopback IP or localhost") from None
        self.endpoint = f"http://{'[' + host + ']' if ':' in host else host}:{port}"
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, payload=None, limit=2_000_000, deadline=None):
        remaining = deadline - time.monotonic() if deadline else 20
        if remaining <= 0:
            raise ArtError("Local request timed out; existing generation journal retained")
        req = urllib.request.Request(self.endpoint + path, data=canonical(payload) if payload is not None else None, headers={"Content-Type": "application/json", "Accept": "application/json, image/*"}, method=method)
        try:
            with self.opener.open(req, timeout=min(20, remaining)) as response:
                declared = response.headers.get("Content-Length")
                if declared:
                    if not declared.isdecimal() or int(declared) > limit:
                        raise ArtError("Local response exceeds size limit or has invalid Content-Length")
                raw = response.read(limit + 1)
                if len(raw) > limit:
                    raise ArtError("Local response exceeds size limit")
                return raw
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ArtError("Local ComfyUI request failed; journal retained, no automatic re-submission") from exc

    def json(self, method, path, payload=None, deadline=None):
        try:
            result = json.loads(self.request(method, path, payload, deadline=deadline))
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeError) as exc:
            raise ArtError("Invalid JSON returned by local ComfyUI") from exc


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--work-dir", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan")
    ing = sub.add_parser("ingest")
    ing.add_argument("--id", required=True)
    ing.add_argument("--input", required=True, type=Path)
    verify = sub.add_parser("verify")
    verify.add_argument("--manifest", type=Path)
    gen = sub.add_parser("generate")
    gen.add_argument("--id", required=True)
    gen.add_argument("--workflow", required=True, type=Path)
    gen.add_argument("--prompt-node", required=True)
    gen.add_argument("--endpoint", default="http://127.0.0.1:8188")
    gen.add_argument("--timeout", type=float, default=90)
    gen.add_argument("--resume-prompt-id")
    args = parser.parse_args(argv)
    try:
        p = Pipeline(args.root, args.config, args.work_dir)
        if args.command == "plan":
            result = p.plan()
        elif args.command == "ingest":
            result = p.ingest(args.id, args.input)
        elif args.command == "generate":
            result = p.generate(args.id, args.workflow, args.prompt_node, args.endpoint, args.timeout, args.resume_prompt_id)
        else:
            result = p.verify(args.manifest)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get("ok") is False else 0
    except (ArtError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
