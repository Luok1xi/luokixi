"""Meaningful offline/cache/security tests; ComfyUI lifecycle uses loopback mocks."""
import copy
import io
import json
import random
import socket
import tempfile
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from art_pipeline import ArtError, LocalComfy, Pipeline, exclusive, write_json


@contextmanager
def comfy_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_data(self, data, mime="application/json"):
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            state["posts"] += 1
            state["posted"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if state.get("disconnect"):
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send_data(b'{"prompt_id":"mock-task-1"}')

        def do_GET(self):
            state["gets"] += 1
            if state.get("redirect"):
                self.send_response(302)
                self.send_header("Location", "https://example.com/not-allowed")
                self.end_headers()
            elif state.get("huge"):
                self.send_response(200)
                self.send_header("Content-Length", "999999999")
                self.end_headers()
            elif self.path.startswith("/history/"):
                if state.get("pending"):
                    result = {}
                elif state.get("failed"):
                    result = {"mock-task-1": {"status": {"status_str": "error"}}}
                else:
                    result = {"mock-task-1": {"status": {"completed": True}, "outputs": {"9": {"images": [{"filename": state.get("filename", "mock.png"), "subfolder": "luokixi", "type": "output"}]}}}}
                self.send_data(json.dumps(result).encode())
            elif self.path.startswith("/view?"):
                self.send_data(state["image"], "image/png")
            else:
                self.send_error(404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="luokixi-art-test-")
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        (self.root / "public" / "art").mkdir(parents=True)
        (self.root / "src").mkdir()
        self.asset = {"id": "study", "slots": ["today-study", "mat-study"], "type": "concept", "alt": "Library concept", "prompt": "An elegant library, no letters", "rights": "Original generated concept illustration", "reviewer": "Test reviewer", "review": "approved", "source": {"title": "Test generator", "url": ""}, "widths": [48, 96, 240]}
        self.config = {"version": 1, "assets": [self.asset]}
        self.save_config()
        self.input = self.root / "source.png"
        Image.new("RGB", (200, 120), "#558ab0").save(self.input)
        self.workflow = self.root / "workflow.json"
        write_json(self.workflow, {
            "3": {"class_type": "KSampler", "inputs": {"seed": 5, "steps": 20, "cfg": 8, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
            "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "example.safetensors"}},
            "5": {"class_type": "EmptyLatentImage", "inputs": {"batch_size": 1, "width": 512, "height": 512}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "replace this", "clip": ["4", 1]}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "letters, logos", "clip": ["4", 1]}},
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
            "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "whatever", "images": ["8", 0]}}
        })

    def tearDown(self):
        self.temp.cleanup()

    def save_config(self):
        write_json(self.root / "scripts" / "art-assets.json", self.config)

    def pipeline(self):
        self.save_config()
        return Pipeline(self.root)

    def state(self, **kwargs):
        return {"posts": 0, "gets": 0, "image": self.input.read_bytes(), **kwargs}

    def test_ingest_dimensions_budget_provenance_and_no_manifest_overwrite(self):
        original = {"version": 1, "slots": {"unrelated": {"src": "unchanged"}}}
        manifest = self.root / "public" / "art" / "manifest.json"
        write_json(manifest, original)
        p = self.pipeline()
        result = p.ingest("study", self.input)
        self.assertFalse(result["cacheHit"])
        self.assertEqual([v["w"] for v in result["variants"]], [48, 96, 200])
        self.assertTrue(all(v["bytes"] <= 200000 for v in result["variants"]))
        self.assertEqual(json.loads(manifest.read_text()), original)
        saved = json.loads(p.patch_path.read_text())["slots"]["today-study"]
        self.assertEqual(saved["meta"]["prompt"], self.asset["prompt"])
        self.assertEqual(saved["meta"]["reviewer"], "Test reviewer")
        self.assertNotIn(str(self.input), p.patch_path.read_text())
        self.assertTrue(p.verify()["ok"])

    def test_cache_skips_encoding_and_cross_asset_deduplicates(self):
        other = copy.deepcopy(self.asset)
        other.update({"id": "second", "slots": ["another-place"]})
        self.config["assets"].append(other)
        p = self.pipeline()
        first = p.ingest("study", self.input)
        paths = [p.public_path(v["src"]) for v in first["variants"]]
        mtimes = [path.stat().st_mtime_ns for path in paths]
        with patch.object(Image.Image, "save", side_effect=AssertionError("Re-encoded cached image")):
            second = p.ingest("second", self.input)
        self.assertTrue(second["cacheHit"])
        self.assertEqual(second["variants"], first["variants"])
        self.assertEqual(mtimes, [path.stat().st_mtime_ns for path in paths])
        self.assertEqual(len(list((p.art / "generated").glob("*.webp"))), 3)

    def test_changed_recipe_or_input_reencodes(self):
        p = self.pipeline()
        original = p.ingest("study", self.input)
        self.asset["quality"] = 70
        updated = self.pipeline().ingest("study", self.input)
        self.assertFalse(updated["cacheHit"])
        self.assertNotEqual(original["variants"][0]["src"], updated["variants"][0]["src"])
        Image.new("RGB", (200, 120), "red").save(self.input)
        changed = self.pipeline().ingest("study", self.input)
        self.assertFalse(changed["cacheHit"])

    def test_concurrent_ingest_and_generate_are_not_submitted_twice(self):
        p = self.pipeline()
        with exclusive(p.work / "ingest.lock"):
            with self.assertRaisesRegex(ArtError, "Another operation"):
                p.ingest("study", self.input)
        with exclusive(p.work / "generate.lock"):
            with self.assertRaisesRegex(ArtError, "Another operation"):
                p.generate("study", self.workflow, "6")
        self.assertFalse((p.work / "generate.lock").exists())

    def test_tampered_cached_image_is_detected_and_rebuilt(self):
        p = self.pipeline()
        result = p.ingest("study", self.input)
        p.public_path(result["variants"][0]["src"]).write_bytes(b"bad")
        self.assertFalse(p.verify()["ok"])
        self.assertFalse(p.ingest("study", self.input)["cacheHit"])
        self.assertTrue(p.verify()["ok"])

    def test_srcset_tamper_and_traversal_rejected(self):
        p = self.pipeline()
        p.ingest("study", self.input)
        data = json.loads(p.patch_path.read_text())
        data["slots"]["today-study"]["srcset"] = "https://evil.invalid/image.webp 400w"
        write_json(p.patch_path, data)
        self.assertFalse(p.verify()["ok"])
        for path in ("art/../.env.webp", "art/.data/secret.webp", "art/owner-private/a.webp", "art/%2e%2e/x.webp", "C:/private.webp", "https://evil.invalid/a.webp"):
            with self.subTest(path=path), self.assertRaises(ArtError):
                p.public_path(path)
        with self.assertRaises(ArtError):
            Pipeline(self.root, work=self.root / "public" / "cache")

    def test_symlink_cannot_write_outside_public_art(self):
        p = self.pipeline()
        external = self.root / "elsewhere"
        external.mkdir()
        try:
            (p.art / "generated").symlink_to(external, target_is_directory=True)
        except OSError:
            self.skipTest("Creating Windows symlinks needs an OS privilege")
        with self.assertRaises(ArtError):
            p.ingest("study", self.input)
        self.assertEqual(list(external.iterdir()), [])

    def test_corrupt_input_and_budget_fail_before_public_write(self):
        p = self.pipeline()
        self.input.write_bytes(b"not an image")
        with self.assertRaises(ArtError):
            p.ingest("study", self.input)
        noise = random.Random(17).randbytes(128 * 128 * 3)
        Image.frombytes("RGB", (128, 128), noise).save(self.input)
        self.asset.update({"maxBytes": 256, "widths": [128], "quality": 85, "minQuality": 80})
        with self.assertRaisesRegex(ArtError, "exceeds"):
            self.pipeline().ingest("study", self.input)
        self.assertFalse((p.art / "generated").exists())

    def test_exif_orientation_and_metadata_are_removed(self):
        exif = Image.Exif()
        exif[274] = 6
        exif[270] = "private source metadata"
        self.input = self.root / "rotated.jpg"
        Image.new("RGB", (120, 200), "red").save(self.input, exif=exif)
        p = self.pipeline()
        result = p.ingest("study", self.input)
        largest = result["variants"][-1]
        self.assertEqual((largest["w"], largest["h"]), (200, 120))
        with Image.open(p.public_path(largest["src"])) as im:
            self.assertEqual(dict(im.getexif()), {})

    def test_plan_reports_missing_duplicate_prompts_and_unconfigured_slots_offline(self):
        other = copy.deepcopy(self.asset)
        other.update({"id": "second", "slots": ["second-slot"]})
        self.config["assets"].append(other)
        (self.root / "src" / "page.js").write_text('<div data-art="unknown-place"></div>', encoding="utf-8")
        p = self.pipeline()
        with patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("Network during plan")):
            result = p.plan()
        self.assertTrue(result["assets"][0]["needsImage"])
        self.assertEqual(result["duplicatePromptGroups"], [["study", "second"]])
        self.assertEqual(result["unconfiguredSlots"], ["unknown-place"])
        p.ingest("study", self.input)
        self.assertFalse(p.plan()["assets"][0]["needsImage"])

    def test_config_rejects_duplicate_slots_invalid_budgets_and_private_urls(self):
        original = copy.deepcopy(self.config)
        cases = [{"id": "../../escape"}, {"maxBytes": 250000}, {"widths": [True]}, {"focal": "0%;bad 0%"}, {"source": {"title": "Source", "url": "file:///secret"}}]
        for changes in cases:
            with self.subTest(changes=changes):
                self.config = copy.deepcopy(original)
                self.config["assets"][0].update(changes)
                with self.assertRaises(ArtError):
                    self.pipeline()
        self.config = copy.deepcopy(original)
        other = copy.deepcopy(self.asset)
        other["id"] = "second"
        self.config["assets"].append(other)
        with self.assertRaises(ArtError):
            self.pipeline()

    def test_local_generate_full_lifecycle_and_second_call_has_zero_requests(self):
        p, state = self.pipeline(), self.state()
        with comfy_server(state) as endpoint:
            first = p.generate("study", self.workflow, "6", endpoint, 3)
            self.assertEqual(state["posts"], 1)
            self.assertEqual(state["posted"]["prompt"]["6"]["inputs"]["text"], self.asset["prompt"])
            self.assertEqual(state["posted"]["prompt"]["9"]["inputs"]["filename_prefix"], "luokixi/study")
            calls = (state["posts"], state["gets"])
            second = p.generate("study", self.workflow, "6", endpoint, 3)
            self.assertEqual(calls, (state["posts"], state["gets"]))
            self.assertFalse(first["generationCacheHit"])
            self.assertTrue(second["generationCacheHit"])
            self.assertTrue(p.verify()["ok"])

    def test_generation_timeout_resumes_known_job_without_duplicate_submission(self):
        p, state = self.pipeline(), self.state(pending=True)
        with comfy_server(state) as endpoint:
            with self.assertRaisesRegex(ArtError, "pending"):
                p.generate("study", self.workflow, "6", endpoint, 1)
            state["pending"] = False
            p.generate("study", self.workflow, "6", endpoint, 3)
            self.assertEqual(state["posts"], 1)

    def test_unknown_post_result_does_not_submit_twice_and_explicit_resume_works(self):
        p, state = self.pipeline(), self.state(disconnect=True)
        with comfy_server(state) as endpoint:
            with self.assertRaises(ArtError):
                p.generate("study", self.workflow, "6", endpoint, 2)
            with self.assertRaisesRegex(ArtError, "outcome unknown"):
                p.generate("study", self.workflow, "6", endpoint, 2)
            self.assertEqual(state["posts"], 1)
            state["disconnect"] = False
            p.generate("study", self.workflow, "6", endpoint, 2, resume="mock-task-1")
            self.assertEqual(state["posts"], 1)

    def test_comfy_endpoint_and_custom_nodes_are_rejected(self):
        for url in ("https://example.com", "http://192.168.1.2:8188", "http://evil.local:8188", "http://user:pass@127.0.0.1:8188", "http://127.0.0.1:8188/proxy"):
            with self.subTest(url=url), self.assertRaises(ArtError):
                LocalComfy(url)
        p = self.pipeline()
        write_json(self.workflow, {"6": {"class_type": "RunShellCommand", "inputs": {}}})
        with self.assertRaisesRegex(ArtError, "custom nodes"):
            p.generate("study", self.workflow, "6")

    def test_comfy_rejects_multiple_generation_branches_and_batches(self):
        p = self.pipeline()
        original = json.loads(self.workflow.read_text())
        for node_id in ("3", "5", "9"):
            graph = copy.deepcopy(original)
            graph["20"] = copy.deepcopy(graph[node_id])
            write_json(self.workflow, graph)
            with self.subTest(node_id=node_id), self.assertRaisesRegex(ArtError, "exactly one"):
                p.generate("study", self.workflow, "6")
        graph = copy.deepcopy(original)
        graph["5"]["inputs"]["batch_size"] = 3
        write_json(self.workflow, graph)
        with self.assertRaisesRegex(ArtError, "one image"):
            p.generate("study", self.workflow, "6")

    def test_comfy_redirects_large_responses_and_output_traversal_rejected(self):
        for kwargs in ({"redirect": True}, {"huge": True}, {"filename": "../../secret.png"}):
            with self.subTest(kwargs=kwargs), comfy_server(self.state(**kwargs)) as endpoint:
                with self.assertRaises(ArtError):
                    self.pipeline().generate("study", self.workflow, "6", endpoint, 2)

    def test_generated_photo_and_failed_workflow_are_not_published(self):
        self.asset["type"] = "photo"
        with self.assertRaisesRegex(ArtError, "documentary"):
            self.pipeline().generate("study", self.workflow, "6")
        self.asset["type"] = "concept"
        with comfy_server(self.state(failed=True)) as endpoint:
            with self.assertRaisesRegex(ArtError, "failed"):
                self.pipeline().generate("study", self.workflow, "6", endpoint, 2)
        self.assertFalse((self.root / "public" / "art" / "generated").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
