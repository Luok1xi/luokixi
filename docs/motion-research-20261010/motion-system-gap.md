# motion-web motion system and Luokixi motion layer: gap analysis

I read all of motion-web except the 3D-only references (`light-3d`, `image-plane-3d`, `shaders-spec`, `scene-streaming`, `image-asset-pipeline`, `scene-audio`), which I only skimmed because they have nothing to say about DOM interaction. Licence is CC BY-NC: everything below is restated principle plus measured numbers, and none of it should be copied verbatim into the repo. Paths are relative to `/tmp/claude-0/-home-user-luokixi/3c26a0ee-2f2d-557b-b645-dae2a7981a06/scratchpad/ref/motion-web/` (motion-web) and `/home/user/luokixi/` (Luokixi). I modified nothing in the repo and wrote no scratch files.

**Headline:** Luokixi already has the right building blocks. The problems are fragmentation and inconsistency, not missing effects:
- spring curves are played at durations they were not sampled for;
- page transitions have three competing rule sets;
- there are two reveal systems;
- there are four separate toast implementations;
- the press rule is silently overridden by component styles;
- big surfaces bounce.

Fix the foundation first (sections 3 and 4) before adding new "cooler" effects.

---

## 1. The motion system motion-web teaches

### 1.1 Duration scale (`references/motion-tokens.md` §Duration)

| Token | Value | Intent |
|---|---|---|
| instant | 80–100ms | cursor feedback, tooltip |
| fast | 150–200ms | hover, button active, toggle |
| standard | 280–350ms | card expand, panel, drawer |
| medium | 400–500ms | section reveal, image open |
| slow | 600–800ms | page enter, hero text, route transition |
| cinematic | 1000–1400ms | cold-open beat only |
| ambient | continuous | loops |

The governing rule: "if you can't justify a duration with the intent column, halve it."

### 1.2 Easing tokens

**Cubic curves:**

| Name | Curve | Use |
|---|---|---|
| ease-out-expo | `(0.16,1,0.3,1)` | default for reveals |
| ease-in-expo | `(0.7,0,0.84,0)` | exits only |
| ease-in-out-quart | `(0.76,0,0.24,1)` | loops |
| ease-out-back | `(0.34,1.56,0.64,1)` | playful hovers |
| ease-out-circ | `(0,0.55,0.45,1)` | crisp |
| ease-sharp | `(0.65,0,0.45,1)` | — |
| ease-standard | `(0.4,0,0.2,1)` | Material baseline |
| ease-expressive | `(0.68,-0.6,0.32,1.6)` | rarely |
| linear | — | scrub and progress only |

**Spring presets (stiffness / damping / mass):**

| Preset | Values |
|---|---|
| gentle | 100 / 15 / 1 |
| default | 200 / 22 / 1 |
| snappy | 350 / 28 / 1 (button feedback) |
| bouncy | 200 / 10 / 1 |
| heavy | 150 / 35 / 1.5 |
| stiff | 500 / 40 / 1 (cursor) |

**`linear()` rule:** generate the stops from the same spring config the JS uses, so CSS-only small controls share the sprung character. Example: `linear(0, 0.32 8%, 0.79 20%, 1.03 30%, 1.01 46%, 1)`.

**Easing lives in exactly one layer:** a driving timeline stays linear and each element eases itself, because easing at two levels multiplies (`references/timeline-orchestration.md` §2).

**B3 slop gate** (`references/design-slop.md`): one easing and one duration everywhere reads as a CSS default. Use at least three tiers, plus springs where things should feel physical.

### 1.3 Choreography rules

**Stagger values:** tight grid 40ms; standard list 70–80ms; editorial line 80–100ms; dramatic 120–180ms; a single decisive CTA gets 0ms. Order is top-to-bottom; exits use `from: "end"`. Native CSS: `animation-delay: calc(sibling-index() * 60ms)`, falling back to no delay.

**Arc tokens** (`references/choreography-arc.md`):

| Arc | Values |
|---|---|
| cold-open | entry 1.2s, expo-out, stagger 0.1s; midpoint 0.8s, stagger 0.06s; CTA 0.6s, no stagger |
| broadside | 0.4s `(0.65,0,0.45,1)` |
| editorial | line clip 0.7s `(0.77,0,0.18,1)`, stagger 0.08s; image scale 1.05→1 over 1s |
| staccato | 0.3s, stagger 0.04s; hover 0.15s |

**Sequencing:**
- **One window, one event.** An opacity change "eats" every other motion in its window, so a fade gets only the first ~10% of a segment.
- **Draw → say → hand off.** Three abutting segments; copy never refers to something not yet drawn.
- **Containers exit on their content's schedule**, never back-derived from the next section.
- **Every act owes one "money frame"**, where art, copy and interactability are all complete at once.
- **Copy blocks stagger about 0.02 of scroll apart**, the lightest block last (timeline-orchestration §4–§9).

**Stillness:**
- A keyframe with zero velocity guarantees a dead beat after it; fill that beat with another track (§5).
- "灵动 vs 飘" is a stillness ratio, not an easing problem (§11).
- "Stillness = emphasis": isolate the CTA with a motion pause (choreography-arc §Common Arc Failures).

**Enter/exit asymmetry:**
- Page transition (`references/pattern-recipes.md` #8): enter opacity 0 / y 16 → 0 over 0.45s `[0.16,1,0.3,1]`; exit opacity 0 / y −8 over 0.25s `[0.7,0,0.84,0]`; `mode="wait"`.
- Dialog (`references/components.md` §11): `@starting-style`, opacity + `translate 0 8px`, 0.2s, with `overlay` / `display allow-discrete`.

**Invitations** (`references/affordance.md` §5): stagger multiple marks 0.15–0.20 apart, ink first and line second.

### 1.4 Interaction feedback rules

**State matrix every component owes** (`references/components.md` §2):

| State | Rule |
|---|---|
| hover | says something specific about *that* element; wrapped in `@media (hover:hover) and (pointer:fine)` |
| active | a real press, `scale(.98)` or a colour step, ≤80ms |
| focus | `:focus-visible` with a 2px outline at 3px offset; never `:focus` |
| disabled | attribute + reason nearby |
| loading | in-place label swap with width locked (`visibility:hidden` on the label, not text replacement) |
| error | adjacent to the control, `aria-describedby`, never colour alone |
| empty | designed |
| success | persistent; "a toast that fades is not a receipt" (`references/production-polish.md` §4) |

**Button recipe** (components §5): `transition: background-color 140ms, transform 90ms`; 44px minimum hit area; at most three button roles.

**Gestures** (affordance §7, §8, §11):
- **Click and drag on the same element:** "down records, up decides", with a 6px slop.
- **No press-and-hold** entry to anything.
- **Restoring after a gesture is immediate**, never on a timer.
- **Copy never explains the interaction.**
- **Peripheral vision catches fast-and-small:** 5px over 0.25s (~20px/s) gets noticed; 2px over 4.6s does not.

**Handfeel** (`references/handfeel.md`):
- Things that land with weight use an underdamped spring.
- Things that *follow* (cursor, rail, tooltip, highlight) use `x += (t-x)*(1-exp(-k·dt))`, with a lead term `target + vel/k` to cancel the `speed/k` lag.
- One quantity, one filter, one target: anything written after the filter "hunts".
- Pose is driven by acceleration through a critically damped spring, `c = 2√k`.
- Wheel momentum guard: accumulate 90px, lock 550–650ms, decay 0.92 per frame.
- Screen shake: take the max, never the sum; different frequency per axis; linear decay; nothing over 0.35s.

### 1.5 Page transition rules

- Use `@view-transition { navigation: auto }` and always test with reduced motion (components §12).
- **Shared-element handoff** (affordance §10): at frame 0 the incoming element must equal the outgoing `getBoundingClientRect()` within 3%, measured at t=0.002 via a `__hold(t)` probe. Anchor on the element actually clicked; geometry has one source, never two literals.
- Per arc: cold-open crossfade with blur 0.9s; broadside ≤0.3s; staccato stagger-out plus stagger-in in 0.4s total.

### 1.6 Scroll motion rules

- **Climb from "rung 1.5" upward** (`references/build-mode.md` ladder, pattern-recipes #16):
  - Use native `animation-timeline: view()/scroll()` before reaching for GSAP.
  - Author the *finished* state as plain CSS, and put the timeline inside `@supports` (Firefox has none).
  - Keep reduced motion as a separate gate.
  - Reach for GSAP only for pinning, seekable timelines, or cross-element orchestration.
- **Reveal is an editing decision** (B2): reserve entrances for 2–3 things per page and give them different arrivals. A universal fade-up is slop.
- **A scroll-mapped reveal on something already on screen resolves at frame 1**, so give it its own load clock (SKILL.md:383).
- Scroll should inject *energy*, not position (pattern-recipes #15).
- Listeners are `{passive:true}`. Never `preventDefault` a wheel unconditionally; hand it back at the ends (SKILL.md:415).

### 1.7 Performance rules

**Property tiers** (motion-tokens §Transform Budget):

| Tier | Properties |
|---|---|
| cheap | transform, opacity |
| medium | blur, clip-path (small areas only) |
| expensive | width, height, top, left, padding, margin |
| very expensive | large box-shadow, border-radius during scale |

**Loop and layer discipline:**
- `will-change` only during an animation, removed on finish.
- One rAF loop per page, ≤1ms of work per frame.
- Never a CSS `transition` on a property also written by rAF or GSAP (build-mode §CSS Layering).
- An inline style outranks `:hover`, so ship per-element state as a custom property (`--z`) (SKILL.md:362).
- Pause off-screen with IntersectionObserver; cap DPR at 2.
- A covering panel must never depend on rAF to leave: use a `setTimeout` fallback (`cases/press-stack/index.html:503-512`).

**Budgets:** INP <200ms, CLS <0.05.

### 1.8 Accessibility rules

- **Reduced-motion fallback ladder:** opacity only at 200ms → translate only, 8px → nothing. A reduced-motion page is *designed*, not broken.
- **Nothing stuck hidden.** `scripts/verify_case.py:1065-1074` fails any `h1,h2,h3,p,[class*=num]` left at opacity 0, `visibility:hidden` or a closed `clip-path`.
- Nothing essential behind hover; visible focus everywhere; 44px targets.
- `aria-live` for motion-triggered state.
- Faded overlays get `pointer-events:none`.
- Shake is gated on reduced motion and never applied to text being read (`references/baseline-ui.md` §1–§4, handfeel §8).

### 1.9 Verification rules

- **Probe surface:** `__hold(t)` / `__seek` / clock pins (`references/verification-harness.md` §1).
- **Read `getComputedStyle`, not inline style.** An inline read reported a perfect hard cut for a 250ms crossfade (toy-flipbook §5 #2).
- **Prove frame-rate independence** by running 30, 60 and 120fps and diffing (§12).
- **Drive real input.** `measure_churn.py` drives a real wheel and reports churn %, mid-flight count and idle activity, because `scrollTo()` teleports past where the motion lives.
- **A composite "quality score" is worse than no test** (§0).

---

## 2. The cases

Every case is a single HTML file. `cases/index.html` is just the gallery: border and colour hovers, no motion system.

### string-clock
- **Effect:** slack elastic clock hands, exact tip, sagging body; grab and fling.
- **Technique:** Verlet strings on a fixed timestep, `DT=1/120` with an accumulator, `DAMP .994` per step.
  - Tip spring `K_TIP 1600 / C_TIP 52` (~0.25s settle; gravity droop `g/k` ≈1.4u = 0.26°).
  - Hub spring `900 / 40` (~0.4s).
  - Solver deliberately soft: 3 passes at stiffness 0.5, `MAX_STRETCH 3`, `BIAS 110` (trailing bow), `GRAV 1200/2200`, wind 900 at 1.7 / 0.41 rad/s.
- **Values (product controls on a creative canvas):**
  - Buttons: `transform .18s cubic-bezier(.2,.8,.3,1)`; hover `translateY(-1px)`; active `scale(.97)` / `.985`.
  - Segmented thumb: `.28s`, same curve.
  - Hint: opacity `.3s`.
  - Reduced motion: transitions `.01ms` plus an analytic `restShape()`, a designed still frame (`index.html:91-136, 413-426, 260-263`).

### ink-crowd
- **Effect:** hand-drawn WebGL2 crowd that follows the pointer.
- **Technique:** MRT plus depth buffer; outline from depth discontinuity only; boil clock `floor(t*11)`.
- **Values:**
  - Follows: yaw `1-exp(-6·dt)`, walk blend `1-exp(-5·dt)` (`index.html:635,641`).
  - Outline: width 2.7, thresholds .14 / .32; 22px blocks at ±22%; fov 26.
  - 62 figures × 10 capsules = 620 instances.

### press-stack
- **Effect:** nine sticky screens, each riding over the last, with a type wipe.
- **Technique:**
  - Native scroll. Each screen is `sticky; top:0; 100vh` with `margin-bottom:100vh` to buy a viewport of dwell.
  - Progress is `(scrollY-top)/vh`; cover progress is `(scrollY-top-vh)/vh`.
- **Values (`index.html:231-236, 420-475, 495-512`):**
  - Wipe: unlit words at `DIM .22` (dimmed, never 0), per-word ramp `.20`, lean `.17`.
  - Copy rise: 22px, opacity `.06→1`, window `.34`, stagger `.42/n`. Notes: 26px, stagger .09, window .45.
  - Pointer: `exp(-3.6·dt)`; sleeves 34px × depth; card 12° under `perspective(900px)`.
  - Preloader: 2200ms + 260ms hold, then exits with `transform .78s cubic-bezier(.76,0,.24,1)` to −100%, with a `setTimeout` fallback.
  - Easing: smoothstep `q²(3−2q)`. Reduced motion removes the preloader and sets q=1.

### wheel-rail
- **Effect:** wheel and pointer drive everything; the document never scrolls.
- **Technique:**
  - Wheel hijack `{passive:false}`. Rail follows `exp(-6.2·dt)`: 660px behind 40ms after a tick, 2px behind after 900ms.
  - Pointer parallax follow 3.4; blob 46 / arc 26 / panel 7px (7× depth ratio).
  - Every word is written every frame, so reveals scrub backwards.
- **Values (`index.html:279-280, 371, 421, 495-540, 614`):**
  - Words: rise 8px, band `.34`, stagger `.55/n`, start `.90`. Raised surfaces: 18px, band `.30`.
  - Grid rules draw `(age-240-i·55)/700`; intro draw 1500ms, stagger 130ms.
  - Pointer proximity (150px) scales a node ×2 with `.28s cubic-bezier(.33,1,.68,1)`; hint fade `.5s`, same curve.
  - Radar sweep period 3950ms; grain `steps(1,end) 8s`.
  - Churn: 48% vs the reference's 64%.

### toy-flipbook
- **Effect:** a console you turn with the mouse; fast spins kick the desk toys.
- **Technique:**
  - Four yaw frames hard-cut by `Math.round(spring)`, with no transition anywhere.
  - Scrub spring stiffness 55 / damping .9; wheel kick 2.6, clamped ±9.
  - Held jitter: 11Hz, ±2.4px, ±1.1°.
  - Desk toys: gravity 900px/s²; kicked at 120–180px/s when |v|>2.2 with a 6%/frame roll; bounce 35%; squash decays over ~10 frames; `transform-origin:50% 100%`.
- **Entrance values (`index.html:90-280, 341-349, 393, 417`):**
  - Nav: `700ms cubic-bezier(.16,1,.3,1)` from −14px.
  - Device: `900ms (.34,1.56,.64,1)` with .15s delay, from −60px / −6° / .92.
  - Words: 700ms back-out, delay `.35+.12i s`, from 34px / 3° / .85. Toys pop 600ms with delay `1+.13i s`.
  - Hover: words `rotate(-2.5deg) scale(1.07)` at 220ms; nav links `rotate(-2deg) scale(1.06)` at 180ms, both back-out.
  - Depth gains: blob −260px; headline lines ×−.55 / ×.8 (opposite signs shear the headline); console 150px / 13° / scale 1.08.

### char-curtain
- **Effect:** 576 glyphs on 24 independent Verlet strings that part under the pointer instead of denting.
- **Values (`index.html:163-178`):**
  - No horizontal links at all. Gravity .28, drag .025, 5 passes, home pull .35, radius 75, force 4.8, y-bias .35, bounce .6.
  - Speed → colour and alpha: `min(v/8,1)`, alpha `1-.35r`.
  - Wheel gust .055 per notch, decaying ×.94 per frame (~2.7s).
  - A DOM live readout, so screen readers and the oracle see activity.

### lyre-crows
- **Effect:** strum strings, words fall loose, crows hunt them and rewrite their own tails with what they caught.
- **Values (`index.html:179-275, 419-422`):**
  - Rate limit: max 4 words aloft, 800ms cooldown.
  - Unconditional decay: `1/240` per frame (~4s) whether or not anything eats the word.
  - Steering clamps the *force* (.055), which gives turns a radius; max speed 2, dive gain 1.55.
  - Deterministic paper specks via `sin(i·713.82)`.

### Scripts
- `verify_case.py`: acceptance floor plus per-case oracles, including the reduced-motion hidden check.
- `measure_churn.py`: churn / mid-flight / idle under a real wheel.
- `measure_structure.py`: section shapes, token scales, polish.
- `measure_frames.py`: video contact sheets, palette, traces, wipes.
- `record_showcases.py`: Playwright recording with smoothstep mouse paths.
- `subset_fonts.py`: subset and inline fonts.

---

## 3. Gap analysis against Luokixi's motion layer

### 3.1 What we already do well (keep)

- **Asymmetric exits are mostly right:**
  - View transitions: old page fades in 160ms, new page enters in 300–420ms (`src/styles/motion.css:28-37, 52-57`).
  - Dialog: enter 220 / 360ms, exit 160 / 220ms with ease-in (`motion.css:76-119`).
  - Mobile sheet: enter 420ms, exit 280ms (`motion.css:123-147`).
  - `rollTo`: 120ms ease-in out, 260ms iOS in (`src/js/fx.js:63-75`).
- **Springs are generated the right way:** SwiftUI-style response/damping springs sampled into `linear()` (`src/js/motion.js:9-57`, `src/styles/tokens.css:109-143`). This is exactly the motion-tokens recommendation.
- **The carousel spring keeps velocity:** it is closed-form and carries velocity between actions, so it is interruptible (`src/js/carousel-motion.js`).
- **Timeout guards:** `settle()` and the 2s view-transition skip (`fx.js:15`, `motion.js:93`) handle the hidden-tab and rAF-throttling lesson.
- **Native scroll timelines are done right:** `view()` reveal with the finished state as default and an IntersectionObserver fallback (`motion.css:185-202`), plus the iOS large-title collapse (`motion.css:205-228`).
- **Also in place:** `data-live` (`src/js/shell.js:221-229`), `touchstart` registration for `:active` on iOS (`fx.js:139-142`), and the segmented-control thumb moving by `translateX` (`src/styles/store.css:110-124`).

### 3.2 What we lack

1. **A complete token scale.** Tokens stop at `--dur-1..4` (160 / 280 / 520 / 900ms, `tokens.css:104-107`). There is no instant (80–100ms) press-in token, no exit durations, no stagger, distance or scale tokens, and no `--ease-in` exit curve.
   - Literal exit curves are scattered: `cubic-bezier(0.4,0,1,1)` ×3, the `ease-in` keyword, `cubic-bezier(0.4,0,0.6,1)`.
   - Across the stylesheets, transitions and animations use ~40 distinct literal durations (300ms ×17, 160ms ×16, 400ms ×13, …) against 57 uses of `--dur-*`.
   - In JS, `fx.js`, `opening.js`, `materials.js:82-91` and `reputation.js` hard-code durations and curves.
   - `--ease-interface` is defined outside tokens (`src/styles/redesign.css:2`).
2. **A unified toast.** There are four copies: `.dc-toast` (`discover.css:384`), `.cx-toast` (`map.css:1137`), `.pd-toast` (`project.css:671`) and `#kb-toast` (`knowledge.css:6`, no motion at all).
   - All use the same 240 / 300ms ease-out and a fixed 3.6s timeout (`src/pages/map.js:71-81`, `discover.js:50-60`, `project.js:55`).
   - No queue, no pause on hover or focus.
   - Action links ("去登录") vanish after 3.6s.
   - Errors (`toast(e.message)`) and confirmations both go through toasts, against "error adjacent to the cause" and "success persists".
3. **Loading → success → error choreography.** There is no shared pending button state: no delayed spinner, no width lock, no success morph, no error shake. Only `aria-busy` opacity .55–.6 on two feeds (`circle-news.css:144`, `app-store.css:2`).
   - The skeleton shimmer loops forever with no `data-live` and no timeout (`motion.css:251-253`); motion-web's rule is "a fallback that is not an infinite skeleton".
4. **List insert, remove, reorder and filter motion.** ~130 `innerHTML =` assignments across pages (map 20, reputation 19, circle 18, …), so filters and tabs hard-swap with no exit and no move animation. GSAP Flip is installed and unused.
5. **A sound shared-element primitive.**
   - `openFrom` uses a *non-uniform* scale (`fx.js:87-92`), which distorts the radius and text.
   - It starts at `opacity: .5`, so the handoff frame is a cross-dissolve rather than a match (affordance §10).
   - The source card stays visible during the flight.
   - It is used only in circle (`src/pages/circle.js:355`).
6. **Interruptibility for WAAPI one-shots.** `pop()` and `openFrom()` restart from keyframe 0 when re-triggered mid-flight. Nothing starts from the current computed transform or uses `commitStyles()`.
7. **Pointer-follow and drag primitives.** No `exp(-k·dt)` follower, no 6px down/up slop helper, no velocity projection or rubber-band. These will be needed for the favorites desk drag.
8. **A probe and QA surface** for motion: `__hold`, a handoff-size check, churn measurement.

### 3.3 Where we conflict with motion-web's advice (or our own rules)

1. **Spring curves played at durations they were not sampled for.** `--spring-bouncy` (sampled over 725ms) runs at 300 / 400 / 600ms in 14 places, for example:
   - `today.css:324,356,444,534`
   - `market.css:71,277,409,425,543,583`
   - `carousel.css:61,161,232`
   - `apple.css:170`

   `--spring-smooth` (671ms) runs at 400 / 700ms (`apple.css:228`, `account.css:454`, `today.css:580`). That makes each one a different, stiffer spring, so the site has no single motion character.
2. **Bouncing on large surfaces and list rows**, against our own rule (`motion.css:3`) and Apple practice:
   - `.as-lockup` row (`today.css:347/356`), `.as-review` card (`:435/444`) and `.td-quick-item` (`:524/534`) use bouncy at 400ms.
   - The `.hc-slide` carousel card (`carousel.css:61`) uses bouncy at 600ms.
   - `--ease-spring`, a cubic overshoot, is used 12×.
3. **The press rule loses to component styles.** The press transition is declared with `:where()`, which has zero specificity (`motion.css:152-170`).
   - Any component that declares its own `transition` replaces it: `.gn-btn { transition: background 160ms }` (`components.css:113`) releases with an instant snap.
   - On home, `.as-lockup` releases with the bouncy curve instead of `--ease-ios` 380ms.
4. **Uniform hover lift.** `.card-hover:hover { translateY(-4px) scale(1.008) }` plus a transitioned `box-shadow` (`components.css:572-588`) is slop gate B1 and paint-tier work. Likewise `.v3-tile:hover translateY(-3px)` (`v3.css:601`).
   - Only 3 stylesheets gate hover with `(hover:hover) and (pointer:fine)`; ~100 `:hover` rules are ungated, which causes sticky hover on touch.
5. **Universal fade-up.** `[data-reveal]` (1s, 30px, `--ease-apple`, 80ms stagger capped at index 6; `base.css:209-224`, `shell.js:195-218`) appears 109 times, including generated list rows and cards (`src/js/community.js:118`, `src/pages/community.js:71,130`, `contribute.js:50`).
   - That is gate B2, it is slower than motion-web's "medium" tier, and it contradicts our own rule that list items don't move (`motion.css:11`).
   - It is a second reveal system next to `.as-reveal` (28px, view timeline).
6. **Three competing page-transition rule sets:**
   - `components.css:1490-1546`: a `page` group plus `lk-*` keyframes. These are now mostly dead, because `motion.css:19` sets `#main { view-transition-name: none }`.
   - `motion.css:18-70`: the intended owner.
   - `v3.css:740-750`: root at 420ms.

   Because of specificity and load order:
   - `html[data-vt]::view-transition-old(root) { animation-duration: 240ms }` (`components.css:1522-1525`) beats motion.css's 160ms fade-out for "same", "forward" and "back".
   - On destination pages that load `v3.css` (home via `today.js:19`, `design.js`), un-directed transitions run at 420ms.
   - So transition timing depends on cascade accidents.
7. **Symmetric `.dlg`.** Enter and exit both use 320ms ease-out, and the backdrop transitions `background` colour (paint) rather than opacity (`components.css:931-977`). motion.css's generic dialog is already correct, so the two disagree.
8. **Layout properties in transitions:** `v3.css:59` (width), `base.css:103` (top), `carousel.css:198` (width; overridden in collins but still live code).
9. **Documentation drift.** `docs/DESIGN.md:34` (data-reveal 1s) and `:36` (scroll motion via ScrollTrigger) don't match reality (native `view()` timelines, two reveal systems).

### 3.4 motion-web advice we should not adopt

These conflict with owner feedback and with Apple restraint:
- idle breathing ("nothing perfectly still", handfeel §6)
- velocity tilt and skew (§2), jelly wobble (§4)
- custom cursors
- scroll hijacking (wheel-rail)
- held 11Hz jitter
- count-up (pattern-recipes #10)
- grain loops

We already removed tilt, particles, count-up, per-frame springs, width animation and the story View Transition; keep them out.

---

## 4. Proposed Luokixi motion tokens and choreography rules

### 4.1 Tokens for `src/styles/tokens.css`

Additive. Legacy names keep their values; existing `--ease-ios` and `--spring-*` stay as they are.

```css
:root {
  /* Duration — Apple-feel is ~15% shorter than motion-web's web scale */
  --dur-instant: 90ms;      /* press-down, highlight, tooltip out */
  --dur-fast: 160ms;        /* = --dur-1: hover tint, toggle, chip */
  --dur-standard: 280ms;    /* = --dur-2: popover/menu/toast in, list-item enter */
  --dur-medium: 420ms;      /* sheet/dialog present, page push, card expand, FLIP move */
  --dur-slow: 640ms;        /* section reveal (once), hero entrance */
  --dur-cinematic: 1100ms;  /* opening only (opening.js MIN_MS) */
  --dur-exit-fast: 100ms;   /* exits ≈ 0.6× their enter, always --ease-in */
  --dur-exit: 180ms;
  --dur-exit-medium: 260ms;
  --dur-1: var(--dur-fast); --dur-2: var(--dur-standard);
  /* --dur-3 520ms / --dur-4 900ms: legacy, media hover-zoom only */

  /* Easing — four curves plus springs, nothing else */
  /* --ease-ios (0.32,0.72,0,1): large surfaces enter/move, never overshoots */
  /* --ease-out (0.22,1,0.36,1): small things enter, reveals */
  --ease-in: cubic-bezier(0.4, 0, 1, 1);   /* NEW: every exit */
  /* --ease-in-out (0.65,0,0.35,1): autoplay, symmetric loops */
  --ease-linear: linear;                   /* scrub, progress */
  /* deprecated for new code: --ease-apple (== CSS ease), --ease-spring
     (fake overshoot), --ease-interface (move here or delete) */

  /* Semantic spring aliases — ALWAYS use a spring with its own -dur */
  --press-release: var(--spring-interactive);     --press-release-dur: var(--spring-interactive-dur); /* 229ms, ~0.5% overshoot */
  --settle: var(--spring-snappy);                 --settle-dur: var(--spring-snappy-dur);             /* 537ms: thumbs, toggles, chips */
  --confirm: var(--spring-bouncy);                --confirm-dur: var(--spring-bouncy-dur);            /* 725ms: ≤64px icons only (like, follow, check) */
  --surface: var(--spring-smooth);                --surface-dur: var(--spring-smooth-dur);            /* 671ms: drag release, Flip move */

  /* Distance and scale */
  --shift-xs: 4px;  --shift-s: 8px;  --shift-m: 16px;  --shift-l: 24px;
  --shift-tab: 14px; --shift-push: 48px;      /* match fx-from-right / fx-push-over */
  --press-scale: 0.96; --press-scale-card: 0.98; --enter-scale: 0.97;

  /* Stagger — total spread ≤ 300ms */
  --stagger-tight: 30ms;  /* rows, cap 6 */
  --stagger: 50ms;        /* cards/shelves, cap 6 */
  --stagger-lines: 80ms;  /* headline lines only */

  /* Feedback timing */
  --delay-pending: 150ms;  /* show a spinner only if still pending (nav progress already waits 140ms) */
  --min-pending: 400ms;    /* once shown, keep it at least this long — no flicker */
  --hold-success: 1200ms;  /* transient success such as 已复制, then revert */
}
@media (prefers-reduced-motion: reduce) {
  :root { --shift-xs:0px; --shift-s:0px; --shift-m:0px; --shift-l:0px; --shift-tab:0px; --shift-push:0px;
          --press-scale:1; --press-scale-card:1; --enter-scale:1;
          --stagger-tight:0ms; --stagger:0ms; --stagger-lines:0ms; }
}
```

**JS mirror:** export `MOTION = { dur, ease, stagger }` from `src/js/motion.js` so `fx.js`, `opening.js`, `materials.js` and `reputation.js` stop hard-coding values.

**GSAP bridge:**
- `CustomEase.create('ios', '0.32,0.72,0,1')` and `CustomEase.create('ios-in', '0.4,0,1,1')`.
- Spring eases built from the same `curve()` samples as an SVG path, used with duration = `spring(name).duration / 1000`.

### 4.2 Choreography rules (Apple-adapted)

1. **Size decides the curve.**
   - Surfaces larger than ~⅓ of the viewport (pages, sheets, dialogs, cards, rows) use `--ease-ios` or `--surface`, with no overshoot.
   - Overshoot (`--confirm`) only on ≤64px direct-manipulation confirmations: like, follow, check, bag icon.
   - Remove bouncy from `.as-lockup`, `.as-review`, `.td-quick-item` and `.hc-slide`.
2. **Springs carry their own duration.** Never `400ms var(--spring-bouncy)`. Fix all 19 occurrences listed in 3.3 #1.
3. **Enter/exit asymmetry.**
   - Exit takes ≈0.6× the enter duration, uses `--ease-in`, travels at most half the enter distance, and has no stagger (or `from: end`).
   - An exiting element gets `pointer-events: none` at t=0.
   - The backdrop finishes no later than the panel. Align `.dlg` with motion.css.
4. **Press.**
   - Down: `--dur-instant` ease-out to `--press-scale` (cards use `--press-scale-card`).
   - Release: `--press-release-dur var(--press-release)`.
   - Declare the press as a composed `scale` property (`scale: var(--press-scale)`) instead of `transform`, so components keep their own `transform`/`transition`. Or raise the rule out of `:where()` and write it as `transition: transform …, <component props>` via a `--tx-extra` custom property.
   - Feedback starts on `pointerdown` within one frame; it never waits for the network (optimistic `rollTo` + `pop`; roll back with the reverse direction on failure).
5. **Hover.**
   - Only inside `(hover:hover) and (pointer:fine)`.
   - Must say something specific: media zoom 1.03 over 900ms `--ease-ios` (already `motion.css:178-181`), or a title tint.
   - No uniform card lift and no `box-shadow` transition. If elevation is needed, fade the opacity of a pre-rendered `::after` shadow.
6. **Reveal.**
   - One system only: `.as-reveal` with a native `view()` timeline and IntersectionObserver fallback.
   - `--shift-l` and `--dur-slow` `--ease-out`.
   - Section-level blocks only, at most 2–3 per screen; never feed or list items.
   - Retire `[data-reveal]` from generated cards and rows.
7. **Pending → success / error.**
   - The button locks its width immediately and is disabled.
   - The spinner fades in only after `--delay-pending` and stays at least `--min-pending`.
   - Success: label crossfade at `--dur-fast` plus `pop()` on the icon. The state persists where it matters (已收藏); transient confirmations revert after `--hold-success`.
   - Error: inline message linked by `aria-describedby`, plus an optional wrapper shake of `translateX` 0/−8/7/−5/3/0px over 320ms with linear decay (handfeel §8 ceiling 0.35s). No shake under reduced motion.
8. **One `toast()` in `fx.js`** replacing the four copies:
   - Queued, `role="status"` (`role="alert"` only when action is required), one position above the tabbar.
   - Enter `--dur-standard --ease-ios` from `--shift-m`; exit `--dur-exit --ease-in` to `--shift-s`.
   - Dwell = clamp(2s, 1s + 120ms × characters, 7s). Paused while hovered, focused or the tab is hidden; toasts with an action stay until dismissed.
   - Not for form errors or receipts.
   - Prefer a solid surface over `.glass` while animating (backdrop-filter is costly).
9. **List changes use GSAP Flip.**
   - `Flip.getState(items)` → mutate DOM → `Flip.from(state, …)` with: moves at `--dur-medium` 'ios'; entering items from opacity 0 / scale .96 over `--dur-standard`; leaving items `absolute` to opacity 0 over `--dur-exit` 'ios-in'; stagger `--stagger-tight`.
   - Animate at most ~30 items; beyond that, crossfade the container over 200ms.
   - Wrap the `innerHTML` swaps on filter and tab changes (circle, reputation, materials, discover).
10. **Shared element (card → detail).**
    - Hide the source card during the flight.
    - Frame 0 must match the source rect within 3%.
    - Uniform scale on an outer frame, with the content as a counter-transformed or late-fading child starting at 30–40% of the flight.
    - Exit returns to the source if it is on screen, otherwise a `--dur-exit` fade and drop.
    - Reverse from the *current* value if closed mid-open (`openFrom` / `closeTo` rewrite).
11. **Interruptibility.** Before any WAAPI animation:
    - read `getComputedStyle(el).transform`, or call `anim.commitStyles(); anim.cancel()`;
    - start from that value;
    - skip `pop()` if `el.getAnimations().length > 0`.

    Drags and follows use `1-exp(-k·dt)` with k≈12–18 for a "glued" follow, plus the 6px down/up slop. Throws project the landing point from release velocity with Apple's deceleration-rate form, `v·r/(1−r)` with r=0.998 per ms, and rubber-band past bounds: `(1 − 1/(x·0.55/d + 1))·d`. This toolkit is what the favorites desk drag will need. Desk stacking order goes through a `--z` custom property, never inline `z-index` (SKILL.md:362).
12. **Page transitions: one owner, `motion.css`.**
    - Delete `components.css:1498-1546` (keep only the `.gn` / `.tabbar` names) and `v3.css:740-750`.
    - Keep exits ≤200ms and enters ≤420ms. Chrome stays put. Nothing else animates on arrival ("one window, one event").
13. **Performance and accessibility floor.**
    - transform and opacity only; `will-change` only during an animation; never a CSS transition on a property that WAAPI or rAF also writes.
    - `.as-skeleton` stops shimmering after ~8s and shows a retry state.
    - All loops get `data-live`.
    - Reduced motion keeps today's 0.01ms kill switch (`base.css:227-235`).
    - **Decision for the owner:** iOS "Reduce Motion" replaces slides and zooms with ~150ms cross-dissolves rather than removing them. Allowing opacity-only `--dur-fast` fades for dialogs, toasts and page changes under reduced motion would be closer to Apple, but it relaxes our current rule that reduced motion shows the final state immediately.
14. **QA hooks.** In dev, expose `window.__hold(t)` for `openFrom`/Flip, and check:
    - handoff size error <3% at t=0.002;
    - nothing stuck at opacity 0 under reduced motion (the verify_case selector);
    - `getComputedStyle` (not inline) reads when asserting mid-flight states;
    - spring math at 30, 60 and 120fps (the existing 5 spring tests already cover part of this).