# Sylva liquid-metal buttons: research and a Luokixi port plan

The two Sylva controls are a pill "Explore the work" button and a round play button. Both come from one five-stage WebGL2 renderer. It runs all the time, about 17–21 passes per frame, one WebGL context per button. CSS can rebuild almost all of the look. I built a prototype and measured it in Chromium traces:

| Prototype measurement | Paints | Style recalcs |
|---|---|---|
| Idle, 2 s | 0 | 0 |
| 20 pointer moves while lit | 0 | – |
| The "busy" rim spin, 2 s | 0 | 0 |
| A full hover → press → leave sequence | ≈28 (one-off, from class toggles and ripple insertion) | – |

I recommend a CSS-only port. WebGL would be an optional later phase for one button at most. Nothing in `/home/user/luokixi` was changed (`git status` is clean).

All reference paths are relative to `/tmp/claude-0/-home-user-luokixi/3c26a0ee-2f2d-557b-b645-dae2a7981a06/scratchpad/ref/threeui`:
- **Sylva page** (`S`): `public/landing-pages/inner-green-3d.html`. It is byte-identical to `src/shaders/sylva-living-world/sources/inner-green-3d.html`; `SylvaHero` iframes this page.
- **Standalone button** (`L`): `src/shaders/liquid-metal-button/liquid-metal-button.html`.
- **React wrapper**: `src/shaders/liquid-metal-button/LiquidMetalButton.tsx`.

The renderer code is the same in `S` and `L`, except Sylva adds a 30 Hz idle cap and per-button glow values.

**Scratch outputs**, all under `/tmp/claude-0/-home-user-luokixi/3c26a0ee-2f2d-557b-b645-dae2a7981a06/scratchpad/research/sylva/`:
- **Screenshot sheets:** `standalone-sheet.png`, `sylva-sheet.png`, `sylva-play-sheet.png`, `proto-light.png`, `proto-dark.png`, `proto-zoom2.png`.
- **Prototype:** `proto/liquid.css` (204 lines), `proto/liquid.js` (77 lines), `proto/index.html`.
- **Scripts:** `shoot.mjs`, `reduced.mjs`, `proto-shoot.mjs`, `proto-trace*.mjs`.

---

## 1. Visual anatomy

**DOM** (S:793–825): `.liquid-stage[data-liquid-metal]` holds three children, bottom to top:
- `.liquid-plate`, a CSS div;
- `canvas.liquid-fx`, covering the whole stage;
- `button.liquid-button`, transparent, carrying the label and icon.

All sizes derive from the button height `--h`, using `--lu: calc(var(--h)/516)`. The 516 is the reference height they measured.
- The stage gets `padding: 900·lu` (1.74h) on every side so the bloom is not cut off by the canvas edge.
- A wrapper `clip-path` then trims the bloom to a rounded rectangle: `.pill-clip` uses `inset(72u 60u 26u 60u round 62u)`, `.play-clip` uses `inset(131u 106u 73u 106u round 92u)`.
- The explore button is h = 60.156u. At a 1600px viewport the measured canvas is 413×270 CSS px for a 203×60 button.

**Layer 1: plate (CSS, S:287–358).** A pill with:
- background `linear-gradient(180deg, rgba(255,255,255,.085), rgba(255,255,255,.014) 44%, transparent 64%), rgba(10,12,10,.42)`;
- drop shadows scaled to h: `0 .08h .18h rgba(0,0,0,.38)`, `0 .24h .50h rgba(0,0,0,.28)`, `0 .48h .96h rgba(0,0,0,.16)`;
- top edge highlight `inset 0 1px 0 rgba(255,255,255,.13)` and lower glow `inset 0 -.02h .05h rgba(255,255,255,.05)`.

The standalone version uses a solid `#0b0c0e` with shadows at .72/.62/.42 (L:44–63). The plate does not change colour. Only its darkness and shadow change (see §2).

**Layer 2: canvas.** It is drawn by five shader programs and composited premultiplied on top of the plate:
- **FRAG_SCENE, the "metal" (S:1044).** A field `V = (y − valley(x))·density(x)` produces a family of parallel curves. It is drawn through a soft plateau (`tone()`, width .46, edge .04) and sampled 21 times across the spectrum. The dispersion is .30 band-periods with a Cauchy-style skew of 1.5. The effect: warm fringe on the low edge of each ribbon, cool on the high edge, razor-thin rainbow lines where the field is pinched, broad navy-to-cyan washes where it opens. Other details:
  - It uses its own slope to fold itself (refract .18).
  - A light envelope `smoothstep(-.26,.10)` below the valley curve keeps the upper crescent dark.
  - Gain is 1.9, and the output is multiplied by `uHover`. **At rest the face is black; the metal only appears when hovered or focused.**
- **FRAG_RIM (S:976).** A 1.5 to 3.2·BH/516 device-px stroke on the pill edge, measured by arc length:
  - Floor brightness .20, so the outline is always drawn.
  - Three travelling highlights: weights .62/.44/.30, widths .075/.135/.200 laps, speeds +0.07, −0.044 and +0.024 laps/s (one lap takes 14.3 s, 22.7 s and 42 s).
  - Colour fringing: R/G/B are offset ±0.42 px across the stroke (red outside, cyan inside) and ±0.03 laps along it.
  - Brighter on top (bias .35).
- **Soften blur (S:1171, S:1197).** Downsample to half resolution, then a separable Gaussian with σ = 0.24·(BH/2)·0.95, run as 1–4 iterations. This is what makes the ribbons look molten rather than etched.
- **Bloom.** The softened metal plus the rim, downsampled by `DOWN = clamp(round(BH/129),1,4)`, then blurred at 4 radii (1, 2.3, 5.2, 9 ×). Gain is 1.95 and radius 1.30; the play button uses 1.28 and .94.
- **FRAG_COMP (S:1211).** Combines the layers:
  - It re-applies contrast with `pow(m.rgb/m.a, 1.5)`, which gives the "poured metal" punch.
  - A "veil" dims the metal to 0.44 in the label band, ramping from |y|/half = .46 to .88.
  - 30% of the bloom is allowed back inside the pill.
  - The bloom is cut by 62% under the drop shadow, so the shadow keeps its contrast.

**Layer 3: label.** `#fff`, weight 500, line-height 1.
- Explore button: Lexend at 0.271h (16.3px). Icon 0.291h, gap 0.217h, padding left 0.184h and right 0.434h.
- Standalone: Inter at 0.401h (20.9px at h = 52).
- The label is nudged `translateY(2·lu)` so the cap height, not the em box, sits centred. Latin only; CJK does not need it.
- Play button: a 0.341h triangle, shifted right by 14·lu to look centred.

**Extra ring on the play button (S:360–386, CSS).**
- `.play-ring`: 1px `rgba(255,255,255,.17)` circle.
- Its `::after` (alpha .32) goes from opacity 0 / `scale(.86)` to 1 / `scale(1.06)` on `:hover` or `:focus-within`. Opacity takes .7s `cubic-bezier(.22,.61,.36,1)`, scale .9s `cubic-bezier(.16,1,.3,1)`.

**What I saw in the screenshots** (`standalone-sheet.png`, `sylva-sheet.png`):
- **Idle:** a dark glass pill with a thin rim that is amber at the right and cyan at the top-left.
- **Hover:** a molten white crescent rises from the bottom with amber and blue edge fringes and a soft halo outside.
- **Press:** a crease ring spreads from the contact point.
- **Focus:** the button is lit, plus an outline.

## 2. Every interaction state

The renderer uses frame-rate-independent exponential smoothing: `x += (target − x)·(1 − b^dt)`, with `dt` clamped to 1/20 s. Below, τ = −1/ln b, and the "~95%" figure is 3τ.

| State | Trigger (S:1621–1676) | Value / timing |
|---|---|---|
| Idle | – | Rim travels forever (14.3 s per lap for the lead highlight). Metal ×0, so black. Plate at rest. |
| Hover in | `pointerenter` with `pointerType==='mouse'` only | `hover → 1` with b = 0.0012: τ = 149 ms, ~95% in 446 ms ("quick to bloom"). Plate gets `.hot` via a 0.38s `cubic-bezier(.22,.61,.36,1)` transition on box-shadow and background: rgba(8,10,8,.50), deeper shadows (.44/.34/.20), top highlight .17. |
| Hover out | `pointerleave` (mouse) | b = 0.00012: τ = 111 ms, ~95% in 332 ms ("a touch quicker to die"). |
| Pointer tracking | `window` `pointermove`, only while hovered or pressed, so a press can slide off the button | A soft "well" (radius .55h) trails the cursor: lag b = .0016, τ = 155 ms. It pushes the field's sample point outward, so the bands bulge like a lens. Push is .32h when still, up to +.40h at speed; speed is normalised to 4.5 h/s and smoothed (rise τ 145 ms, fall τ 256 ms). Well strength b = .004 (τ 181 ms). The rim nearest the cursor brightens ×(1 + .8·well). On enter, the well is placed where the cursor came in and speed is reset to 0, so it never slides in from an old position. |
| Press | `pointerdown` (any pointer type), plus Enter/Space `keydown` (not repeats) | `press` snaps on with b = 1e-9 (τ 48 ms, ~3 frames). The rim lifts ×(1 + .85·press). `.press` on the plate: rgba(7,9,7,.55), tighter shadows, `transition-duration: .10s`, so the button seems to settle onto the surface. No scale change. |
| Ripple | Every press. Keyboard presses ripple from the centre. | 3 slots reused round-robin, each living 4 s. Ring radius = age·1.85h·facet, where facet = 1 + .18·cos(6θ + 2.1·age + 2.4i): a six-sided wavefront that rotates. Width .2h, crest shape exp(−\|x\|^1.15) (a crease, not a soft swell), fades as e^(−1.35·age) (τ .74 s). It pushes the bands (amplitude 1.35), adds light ∝ rip²·.45 after the blur so the crease stays sharp, and flares the rim ×(1 + 1.6·rip) as it crosses the edge. |
| Release | `window` `pointerup` / `pointercancel`, `keyup` | `press → 0` with b = .004: τ 181 ms, ~95% in 543 ms ("lets go slowly"). |
| Focus | `focus` → `on.focus = btn.matches(':focus-visible')` | Keyboard focus only lights it. A mouse click deliberately does not leave it glowing. Outline `4·lu solid rgba(255,255,255,.55)`, offset `10·lu`. **Bug:** the page-wide rule `a:focus-visible, button:focus-visible{border-radius:6u}` at S:619 out-ranks `.liquid-button{border-radius:999px}`, so the ring comes out nearly square (`sylva-sheet.png`, frame 11). |
| Touch | – | No hover. The metal lights only while the finger is down, then fades over ~330 ms. `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent`. |
| Disabled | **Not handled.** | No `:disabled` styling and the handlers ignore it. Elsewhere in ThreeUI, Lumen CTA uses opacity .55 with `cursor: default`, and circle-buttons use `grayscale(.7)` with opacity .48 and `not-allowed`. |
| Reduced motion | `calm.matches` | The clock stops (`if(!calm.matches) clock += dt`), so the rim freezes. Hover and press fades still run. A frame "signature" check skips drawing when nothing has changed. |

## 3. Rendering cost and pausing

- **One WebGL2 context per button.**
  - The Sylva hero runs three: two buttons plus the three.js moss scene.
  - The React wrapper puts each button in an iframe (`srcDoc`) with its own context.
- **Render targets.** RGBA16F, using `EXT_color_buffer_half_float`: 2 full-res, 2 half-res, 2 bloom.
- **Canvas size.** About 4.5h tall; for the 60px hero button that is 826×540 at DPR 2 (DPR is capped at 2).
- **Passes per frame.** Scene, rim and composite at full res; a downsample; 2 × (1–4) blur passes at half res; a downsample; 8 bloom passes. That is 17 draws for 52px at DPR 1 and 21 for 60px at DPR 2.
  - Because `DOWN = round(BH/129)`, the bloom runs at **full resolution** for any button under about 190 device px tall. That is roughly 5.8M fragment invocations per frame per hero button, and the scene shader alone does 21 spectral evaluations plus noise per pixel.
- **The loop never stops.**
  - The standalone version redraws every frame forever, because the rim keeps moving.
  - Sylva added an idle cap of `IDLE_HZ = 30` (S:1468), because two buttons dropped the page from 92 to 50 fps (the author's own comment).
- **My measurements (headless SwiftShader).**
  - Standalone idle: about 187 `drawArrays`/s, i.e. about 11 fps × 17 passes, using all the CPU it can get.
  - At DPR 2 the page's own rAF fell to 4/s.
  - The Sylva page with the moss disabled and only the two buttons: 2 rAF/s.
- **Pausing.**
  - Standalone and Sylva: none. No IntersectionObserver; they rely on the browser throttling rAF in background tabs.
  - React wrapper (`LiquidMetalButton.tsx:203–212`): unmounts the iframe when off-screen (`rootMargin: "80px"`) or when the tab is hidden. This destroys the context, and all 5 programs recompile on return.
- **Reduced-motion bug (measured).** Idle draws 0/s. After a single click it renders at full rate forever: 0 → 187 draws/s. The ripple's age comes from the stopped clock, so `clock − r.t > 4` never becomes true, `ripLive` stays true, and the skip never applies. Do not copy this.

## 4. Port plan for Luokixi

### What stays WebGL and what becomes CSS

| Sylva part | Luokixi port |
|---|---|
| Plate, drop shadows, top sheen | **CSS** on `.lm::after`. Never transitioned: the shadow change between rest, hover and press becomes a bloom-opacity change instead of a box-shadow transition (house rule: no per-frame box-shadow). |
| Travelling rim with colour fringing | **CSS:** a masked 1px ring (`mask-composite: exclude`, same pattern as `.spot-glow` in `src/styles/motion.css:272–294`), made of a fixed top-biased floor gradient plus a child `<i>` with two opposite conic highlights. Only the child's `rotate` moves, so it runs on the compositor. At rest it is static, at 318° (light from the top-left). |
| Pointer-led rim (Sylva's `[data-spec]`, S:216; `drawSpec`, S:2026) | **CSS + JS:** rotate = 318° + nx·17° + ny·8.6°. That is Sylva's ±0.30 / ±0.15 rad sway around a fixed light angle, done with the correct angle conversion. Sylva passes radians in standard maths orientation straight into a CSS conic angle, so its highlight is mirrored. The range is ±26°, so no wrap-around handling is needed. |
| Molten crescent (FRAG_SCENE) | **CSS approximation:** `.lm-pool`, layered radial gradients (white core, thin `--g1` cool fringe, thin `--g4` warm fringe) inside `.lm-metal` (`overflow: hidden`). The metal layer carries a mask that reproduces the label-band dimming (`#000 0 6%, rgba(0,0,0,.5) 27% 73%, #000 94%`). Hover: opacity 0 → 1 and `translateY(36%) scaleX(.84)` → none. |
| Cursor well | **CSS + JS:** `pool.style.translate = nx·0.24·width`, with `transition: translate 260ms cubic-bezier(.2,1,.3,1)`. This approximates τ = 155 ms. |
| Press ripple | **CSS:** an `<i class="lm-ripple">` placed at the contact point, sized 4.4h. `lm-grow` scales .04 → 1 and `lm-fade` takes opacity 1 → 0, both 900 ms. It is faster up front than the shader's constant 1.85 h/s, because navigating links tear the page down within ~150 ms. It sits inside `.lm-metal`, so the label-band dimming applies for free. Removed on `animationend`. |
| Bloom | **CSS:** `.lm::before` with fixed radial gradients (white plus `--g1`/`--g4` tints). No `filter`; only opacity moves. |
| Laminar spectral ribbons, self-folding, lens-like bending around the cursor, six-sided ripple | **Not reproducible in CSS.** Optional phase 2 below. |

Optional phase 2 (WebGL): only for the home hero CTA, only on fine pointers, never under reduced motion.
- One shared WebGL2 canvas for the whole site, sized to the pill with no padding (bloom and rim stay CSS).
- FRAG_SCENE only, with 21 → 9 spectral samples, rendered at about 1/3 resolution. Bilinear upscaling stands in for the σ ≈ 0.114·BH soften blur; the field is low-frequency (2.4 bands per height).
- Create it on the first `pointerenter`, cross-fading from the CSS pool.
- Draw only while `hover > .002 || press > .002 || a ripple is live`, then cancel rAF. Call `WEBGL_lose_context` after 30 s idle.
- Age ripples with `performance.now()`, never with the frozen clock.
- Estimated cost: about 3.4k fragments × 9 taps per frame, against Sylva's ~5.8M.

### Light, dark and glass

These are the prototype values in `proto/liquid.css`; they use tokens, plus the house palette's fixed Apple greys.

- **Light** (default, on `--bg` #fff / `--bg-alt` #f5f5f7):
  - plate `#1d1d1f` (= light `--fg`);
  - drop `0 1px 2px rgba(0,0,0,.16), 0 12px 26px -12px rgba(0,0,0,.55)`;
  - bloom opacity .5, showing as an Apple-Intelligence-style blue-left / orange-right halo on white;
  - rim highlights at .42 at rest.
- **Dark** (`@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]`):
  - plate `#1c1c1e` (= `--bg-elev`), plus a `0 0 0 1px rgba(255,255,255,.1)` hairline so it separates from #000;
  - drop `0 10px 26px -8px rgba(0,0,0,.8)`;
  - bloom .7, rim rest .55.
- **`.is-glass`** (over hero cards and photos): Sylva's plate exactly (`rgba(10,12,10,.42)` + sheen + the three h-scaled shadows); bloom .75; focus outline `#fff`. No `backdrop-filter`. Sylva measured about 20 fps with a backdrop blur over a canvas that repaints every frame.
- The label is `#fff` at weight 600 (CJK), with `text-shadow: 0 1px 1px rgba(0,0,0,.22)`. Gradient text stays static, per DESIGN.md.

### State timings in the sketch

- **Hot** (hover on fine pointers, keyboard focus, or press): fade in 450 ms, fade out 330 ms, `var(--ease-out)`.
- **Press:** highlights to 1 in 50 ms, pool `scale(1.06, 1.14)` in 60 ms, bloom ×1.25; release follows the 330 ms out timing. `.lm:active { transform: scale(.97) }`, consistent with `motion.css:156`.
- **Focus:** `outline: 2px solid var(--accent); outline-offset: 3px`, keeping the pill radius.
- **Disabled:** label opacity .42; metal and highlights hidden; no press scale.
- **Busy (`aria-busy="true"`), new:** `lm-orbit` rotates the highlights 360° in 1.4 s linear. It survives `disabled`, because the auth and materials code sets `disabled` while busy (`src/pages/auth.js:139`, `src/pages/materials.js:64`). It is driven by the real request state, so it does not fake progress.
- **Reduced motion:** all transitions 1 ms, no ripple (JS also skips creating one), no busy orbit, no `:active` scale. The lit state and the static rim stay, so the button still reads as a button.
- **Idle drift:** the rim does not travel at rest by default. If one hero should drift (Sylva's 14.3 s per lap), add a nested wrapper animated only under `[data-live].is-live` (`observeLive`, `src/js/shell.js:222`).

### Code sketch

**CSS core** (full file: `proto/liquid.css`):
```css
/* Adapted from ThreeUI LiquidMetalButton (MIT, (c) 2026 Meng To) */
.lm{--lm-h:48px;--lm-plate:#1d1d1f;--lm-hair:transparent;--lm-glow:.5;--lm-rest:.42;--lm-a:318deg;
  --lm-drop:0 1px 2px rgba(0,0,0,.16),0 12px 26px -12px rgba(0,0,0,.55);
  position:relative;isolation:isolate;display:inline-flex;align-items:center;justify-content:center;gap:.5em;
  min-height:var(--lm-h);padding:0 calc(var(--lm-h)*.5);border:0;border-radius:var(--r-pill);background:none;
  color:#fff;font:600 17px/1 var(--font-sans);touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.lm::before{content:"";position:absolute;z-index:-2;inset:-80% -24% -110%;border-radius:50%;pointer-events:none;opacity:0;
  background:radial-gradient(40% 30% at 50% 56%,rgba(255,255,255,.5),transparent),
    radial-gradient(28% 26% at 30% 58%,color-mix(in srgb,var(--g1) 55%,transparent),transparent),
    radial-gradient(28% 26% at 70% 58%,color-mix(in srgb,var(--g4) 50%,transparent),transparent);
  transition:opacity 330ms var(--ease-out)}                                  /* bloom */
.lm::after{content:"";position:absolute;z-index:-1;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.1),rgba(255,255,255,.02) 44%,transparent 64%),var(--lm-plate);
  box-shadow:var(--lm-drop),0 0 0 1px var(--lm-hair),inset 0 1px 0 rgba(255,255,255,.14)}   /* plate */
.lm>.lm-label{position:relative;z-index:3;text-shadow:0 1px 1px rgba(0,0,0,.22)}
.lm-metal{position:absolute;inset:0;z-index:1;overflow:hidden;border-radius:inherit;pointer-events:none;
  mask-image:linear-gradient(180deg,#000 0 6%,rgba(0,0,0,.5) 27% 73%,#000 94%)}           /* label-band dimming, Sylva .44 */
.lm-pool{position:absolute;inset:0 -30% -12%;opacity:0;transform:translateY(36%) scaleX(.84);
  background:radial-gradient(30% 64% at 50% 100%,#fff 0 34%,rgba(255,255,255,.9) 48%,transparent),
    radial-gradient(40% 82% at 44% 100%,transparent 54%,color-mix(in srgb,var(--g1) 55%,#fff) 62%,transparent 72%),
    radial-gradient(48% 98% at 62% 100%,transparent 60%,color-mix(in srgb,var(--g4) 55%,#fff) 66%,transparent 74%);
  transition:opacity 330ms var(--ease-out),transform 330ms var(--ease-out),translate 260ms cubic-bezier(.2,1,.3,1)}
.lm-rim{position:absolute;inset:0;z-index:2;padding:1px;overflow:hidden;border-radius:inherit;pointer-events:none;
  background:linear-gradient(180deg,rgba(255,255,255,.36),rgba(255,255,255,.08) 50%,rgba(255,255,255,.16));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
.lm-rim>i{position:absolute;left:50%;top:50%;width:112%;aspect-ratio:1;translate:-50% -50%;rotate:var(--lm-a);opacity:var(--lm-rest);
  background:conic-gradient(from -24deg,transparent 0,color-mix(in srgb,var(--g4) 80%,#fff) 12deg,#fff 24deg,
    color-mix(in srgb,var(--g1) 80%,#fff) 36deg,transparent 58deg 168deg,color-mix(in srgb,var(--g2) 70%,#fff) 184deg,
    rgba(255,255,255,.85) 204deg,transparent 236deg);
  transition:opacity 330ms var(--ease-out),rotate 320ms var(--ease-out)}
.lm.is-hot::before{opacity:var(--lm-glow);transition-duration:450ms}
.lm.is-hot .lm-pool{opacity:1;transform:none;transition-duration:450ms,520ms,260ms}
.lm.is-hot .lm-rim>i{opacity:.9}
.lm.is-press .lm-pool{transform:scale(1.06,1.14);transition-duration:330ms,60ms,260ms}
.lm.is-press .lm-rim>i{opacity:1;transition-duration:50ms,320ms}
.lm:active{transform:scale(.97)}
.lm-ripple{position:absolute;left:var(--x);top:var(--y);width:calc(var(--lm-h)*4.4);aspect-ratio:1;
  margin:calc(var(--lm-h)*-2.2) 0 0 calc(var(--lm-h)*-2.2);border-radius:50%;
  background:radial-gradient(closest-side,transparent 78%,rgba(255,255,255,.8) 92%,transparent);
  animation:lm-grow 900ms cubic-bezier(.25,.6,.35,1) both,lm-fade 900ms cubic-bezier(.3,.6,.4,1) both}
.lm[aria-busy="true"] .lm-rim>i{opacity:1;animation:lm-orbit 1.4s linear infinite}
/* + keyframes, :focus-visible, disabled:not([aria-busy]), .is-glass, dark-mode vars, reduced-motion block */
```

**JS core** (full file: `proto/liquid.js`, ~70 lines). It has no rAF loop and no observers; pointer moves are batched into one rAF write.
```js
const done = new WeakSet();          // not an attribute: story.js / innerHTML clones must be re-enhanced
function enhance(el){ if(done.has(el)) return; done.add(el);
  el.querySelectorAll(':scope>.lm-metal,:scope>.lm-rim').forEach(n=>n.remove());
  el.insertAdjacentHTML('afterbegin', LAYERS);           // .lm-metal>i.lm-pool + .lm-rim>i
  const on={over:false,press:false,focus:false};
  const sync=()=>{ el.classList.toggle('is-hot',on.over||on.press||on.focus); el.classList.toggle('is-press',on.press);
    if(!on.over&&!on.press){ pool.style.translate=''; lobe.style.rotate=''; } };
  const aim=()=>{ frame=0; if(!box||reduce.matches||!(on.over||on.press)) return;
    const nx=clamp((px-box.left-box.width/2)/(box.width/2)), ny=clamp((py-box.top-box.height/2)/(box.height/2));
    lobe.style.rotate=`${(318+nx*17+ny*8.6).toFixed(1)}deg`; pool.style.translate=`${(nx*box.width*.24).toFixed(1)}px 0`; };
  // pointerenter (mouse only; box read once) / pointermove (rAF-coalesced) / pointerleave
  // pointerdown → press + ripple at contact; pointerup|cancel on window via one AbortController
  // focus → on.focus = el.matches(':focus-visible'); keydown Enter (and Space on <button>), !repeat → press + centre ripple
}
export const mountLiquid=(scope=document)=>scope.querySelectorAll('.lm').forEach(enhance);
```

**Integration:**
- Add `src/styles/liquid.css` and import it in `src/js/shell.js` after `motion.css` (line 10).
- Call `mountLiquid(scope)` from `refreshFx()` (`src/js/fx.js:46`) and `initFx()` (`src/js/fx.js:144`).
- Call `refreshFx(heroEl)` after the hero is rendered (`src/pages/today.js:296`), and after discover slides and the auth body render.
- Credit "ThreeUI LiquidMetalButton, MIT © 2026 Meng To" in the file headers and in a new `THIRD_PARTY_NOTICES.md`. The repo has only `LICENSE`.

### Which Luokixi buttons get it

At most one per viewport.
1. **Home hero carousel primary.** `src/pages/today.js:157`: `<a class="glass-pill is-solid">` becomes `<a class="lm is-glass"><span class="lm-label">…</span></a>`. This is the strongest candidate for the optional WebGL phase. Also drop the `.glass-pill:hover` scale-up (`src/styles/carousel.css:164`); Sylva and Apple light the button rather than grow it.
2. **Discover primary "读中文导读".** `src/pages/discover.js:153`, `.slide-cta .btn-primary`.
3. **Studio "开始协作".** `studio.html`, `#studio-start`, with `aria-busy` while the run starts (`src/pages/studio.js:25–27`).
4. **Auth submit.** `src/pages/auth.js:122`, `.acct-wide`; set `aria-busy` next to `btn.disabled = true` at line 139.
5. **Optional: materials "打包下载".** `materials.html:99` / `src/pages/materials.js:231`, with `aria-busy` while zipping.

Not these:
- `.as-get` pills (`src/styles/store.css:198`; keep the flat iOS look);
- form save / "提交审核" buttons, `.btn-sm`;
- `.rail-btn`, navigation, segmented controls;
- story-dialog secondary buttons.

### Do not port
- Pointer-parallax tilt (`.par`, S:603). Opus v2 removed tilt.
- The pollen burst on click (`burstAt`, S:3647). Particles were removed.
- Dock magnification: it animates width and height every frame (S:1979; `animated-top-dock/topDockController.ts`), and Codex removed width animations.
- `clip-path` entrance wipes (paint-heavy).
- The 0.38s box-shadow/background transition on the plate.
- The continuously moving idle rim.
- The reduced-motion ripple bug.
- The square focus ring.

## 5. Other ThreeUI micro-interactions worth learning

1. **Pointer-led lit edge on glass.** Sylva `[data-spec]`, S:216 and S:2026–2062. A conic masked to the border points at the cursor. Brightness = smoothstep(1 − distance/reach), with reach 185–250 design units. The angle follows with τ 125 ms and brightness with τ 111 ms; keyboard focus forces brightness to 0.9.
   - Off for coarse pointers and reduced motion.
   - Lessons about the underlying logic: all layout reads happen inside the rAF frame, never in the pointer handler; targets are recomputed only when the pointer actually moved, which avoids oscillation; whichever input moved last owns the state; re-measure on `document.fonts.ready`.
   - Candidate: the global nav capsule only, rotating a child element instead of writing CSS variables every frame.
2. **Round icon-button hover.** S:496: `transform: scale(1.1) rotate(8deg)` over .5s `cubic-bezier(.16,1,.3,1)`; background to `#fff` over .4s. Candidates: carousel arrows, map round buttons.
3. **Concentric halo on play buttons.** S:379–386: opacity over .7s, `scale(.86 → 1.06)` over .9s. Candidates: the listening player (`src/js/player.js`), discover "观看演示".
4. **Light swelling from the centre on round buttons.** `src/shaders/circle-buttons/circle-buttons.css:149–175`: `face::after` radial highlight `scale(.5 → 1)` over 700 ms and opacity over 500 ms; `:active scale(.98)`. Skip its endlessly orbiting blurred aura.
5. **Spinning border for "busy".** `src/shaders/neuform-isolated/sources/spinning-border-button.html`: `conic-gradient(from 90deg, transparent 0 75%, #fff 100%)` in an `inset: -100%` layer spinning 3s linear, faded in over 300 ms; arrow nudges 2px. Adopted above as `aria-busy`.
6. **Text roll on state change.** Sliding Text CTA: label `translateY(32px)` + fade out, a copy slides in from −32px over 300 ms, `cubic-bezier(.15,.83,.66,1)`. Without its blur, this is the existing `rollTo()` (`src/js/fx.js:63`). Use it for "放入资料袋 → ✓ 已放入" (`src/pages/today.js:521`) and "关注 → 已关注" (`src/pages/circle.js:87`).
7. **Toggle knob squash.** `src/shaders/skeuomorphic-toggle/ModernToggle.tsx:49–110` and `modern-toggle.css:70,166`: the knob stretches with speed (scaleX up to 1.16, scaleY down to .9, origin trailing the direction of travel), spring k = 210, c = 19.5 (ζ ≈ 0.67); icons cross-scale .6 at −18° → 1 over .34s `cubic-bezier(.32,.72,0,1)`. Port as a WAAPI keyframe animation with `spring('snappy')` (`src/js/motion.js`), **not** a per-frame rAF spring, which Codex removed.
8. **Static machined rim.** Gradient Pill: `linear-gradient(180deg, rgba(255,255,255,.8), rgba(0,0,0,.4), rgba(255,255,255,.8))` masked to 1px. A good still rim for reduced motion or secondary buttons.
9. **Avoid:**
   - Glassmorphism and Gradient Beam CTAs: endless rotations plus backdrop blur, and `background-position` dot animation.
   - Lumen CTA: hover by `filter: brightness(1.12)`.
   - Launch / "plus" 3D-key lips: a `box-shadow` change on `:active`, and not Apple-like.

A related item to measure: `.glass-pill` uses `backdrop-filter: blur(24px) saturate(180%)` over the scrolling discover feed (`src/styles/discover.css:50`). Sylva's note about backdrop filters over moving content suggests profiling it.