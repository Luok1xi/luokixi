# GSAP picks for Luokixi: 26 references for an Apple-style motion layer

## 0. Access, site fit and ground rules

**What I could and couldn't reach**
- `gsap.com`, `tympanus.net`, `codepen.io`, `threeui.com`, `emilkowal.ski` and `ryanmulligan.dev` gave DNS or proxy errors in WebFetch. For those I used WebSearch result pages, plus the README links inside cloned repos (the Codrops demo URLs). Every URL below appeared in one of those.
- `github.com` worked. I shallow-cloned these into `/tmp/claude-0/-home-user-luokixi/3c26a0ee-2f2d-557b-b645-dae2a7981a06/scratchpad/research/gsap-picks/repos/` and read them as data: `codrops/{GridToSlider,MenuToGrid,ImageToGridTransition,ScrollBasedLayoutAnimations,OneElementScroll,ThumbFullTransition,ImageStackGrid}`, `feitangyuan/kankan-shoucang`, `MengTo/threeui`.
- I did not start a dev server. Nothing in `/home/user/luokixi` was modified.

**Where GSAP is used today**
- Only `src/pages/community.js` (community.html), `src/pages/home.js` and `src/js/intro.js`.
- `home.js` and `intro.js` are not reachable from any HTML entry, because `index.html` loads `today.js`. So adding GSAP to today, materials, circle, map or me pays the ~28 KB gzip core cost for the first time.

**Rules taken from the installed package (v3.15.0)**
- **Flip must always get `scale: true`.** Without it, `Flip.js:446-452` tweens `width`/`height`, which is a layout every frame and breaks the house rule.
  - `simple: true` skips the rotation/skew math; use it for lists.
  - `absolute: true` costs one layout at the start, not one per frame.
- **GSAP writes inline styles on the main thread every tick.** It does not run on the compositor the way WAAPI or CSS do.
  - Use GSAP only where it adds something unique: Flip measuring and relayout of many elements, Draggable/Inertia velocity, SplitText, ScrollTrigger scrub, DrawSVG/MorphSVG.
  - Keep one-shot enter/exit, press states, `openFrom`/`closeTo` (`src/js/fx.js:83-122`) and `story.js` on WAAPI/CSS. That keeps Codex's 5250 → 55 style-write result from `docs/HOME_MOTION.md`.
- **`lagSmoothing` is safe.** The default is `lagSmoothing(500, 33)` (`gsap-core.js:1270`), so only gaps over 500 ms are clamped. Normal slow frames don't stretch time, which matches Codex's real-time spring fix.
- **SplitText with Chinese:** `words` relies on whitespace, so a Chinese heading becomes one "word". Use `type: 'lines', mask: 'lines', autoSplit: true` with an `onSplit()` that returns the tween. Use `chars` only for headings of 12 characters or fewer.
- **Cross-page shared elements can't use Flip.** Flip cannot survive a navigation. For something like discover → project.html, keep using the cross-document `@view-transition` already in place (`src/styles/components.css:1490`, `shell.js:75` pageswap) with matching `view-transition-name`s.

## A. Shared elements and transitions (Flip)

**1. P0 · 收藏夹 desk: stacks that open into a card wall** — https://github.com/feitangyuan/kankan-shoucang, https://github.com/codrops/ImageStackGrid, https://github.com/codrops/GridToSlider, https://gsap.com/docs/v3/Plugins/Flip
- **Effect.** In kankan (`app/components/DeskView.tsx:260-272`) each category is a messy stack: golden-angle offsets of radius ≤25px, rotation ±14°, random z. Clicking a stack spreads it into a 2–3 column wall, and the other groups dim to opacity 0.35 / scale 0.75. Their Framer spring is stiffness 220, damping 24, mass 0.8. That works out to response ≈0.38 s and damping ≈0.90, close to Luokixi's `SPRINGS.snappy` (0.42 / 0.85).
- **Fit.** me.html 收藏 tab, `src/pages/me.js:278-286` (today a flat `.me-list`). Group the real `st.me.stars` by `e.kind`, using the `KIND` map at me.js:22. Local saves (me.js:365) get their own "本机" stack.
- **Adapt.**
  - Stacked transforms come from CSS custom properties.
  - On expand: `Flip.getState(cards)` → toggle `.is-wall` → `Flip.from(state, { scale: true, absolute: true, simple: false /* rotation */, duration: .46, ease: gsapSpring('snappy'), stagger: { each: .02, from: clickedIndex }, zIndex: 10 })`. The `from` stagger is GridToSlider's `demo1/index.js:79`.
  - Hover lift is a CSS `scale(1.04)` over 150 ms.
  - Drop kankan's 3 s breathing loop, its `filter`, and its drag-to-regroup (there is no API for regrouping, and faking it would be fake data).
- **Cost.** About 30 cards: fine. Over 40, cap the stack to the top 6 and show a "+N" badge.

**2. P1 · 发布 button grows into its menu** — https://gsap.com/docs/v3/Plugins/Flip (Flip.fit), https://GreenSock.com/docs/v3/Plugins/Flip/static.fit(), https://www.osmo.supply/resource/gallery-to-overlay-transition-with-gsap-flip
- **Fit.** `.fab` / `.gn-publish` → `#gn-pub` (`src/partials/nav.html:34`, `shell.js:112`, `components.css:215`).
- **Adapt.**
  - Open: `Flip.fit(menu, fabRect, { scale: true })`, then `Flip.from` to its natural box over 0.40 s with `ease: 'ios'`, like an iOS context menu. Items fade and move y 6→0 with a 0.03 s stagger. The FAB icon rotates 45° on its own transform.
  - Close: reverse over 0.24 s with `power2.in`.
- **Risk.** Low: a single element. Its glass background must not use a backdrop-filter that animates.

**3. P1 · Circle post → thread, with title and avatar moving as shared elements** — https://gsap.com/community/forums/topic/24940-app-store-card-transition-effect/, https://gsap.com/community/forums/topic/31598-flip-applying-saved-state-from-one-element-to-another/, https://motion.dev/tutorials/js-app-store
- **Fit.** `circle.js:346-356 openThread`, which already uses `openFrom`.
- **Adapt.** Keep the WAAPI dialog growth. Then:
  - Before `showModal`, call `Flip.getState(card.querySelectorAll('[data-flip-id]'))`.
  - Use unique ids such as `post-{id}-title` and `post-{id}-avatar`, and put the same ids on the thread header.
  - Run `Flip.from(state, { targets: dlg.querySelectorAll('[data-flip-id]'), scale: true, duration: .46, ease: 'ios' })`.
- **Risk.** The ids must be unique, or Flip can't match pairs (per the forum). Text scaling is acceptable; iOS scales text the same way.

**4. P1 · Photo lightbox for circle post photos (Photos.app zoom)** — https://tympanus.net/codrops/2026/07/30/building-an-infinite-gsap-scroll-gallery-with-parallax-and-flip-transitions/, https://github.com/codrops/ThumbFullTransition
- **Fit.** `.cs-post-photos img` (`circle.js:112`) and `.cs-op-photos img` (`circle.js:334`).
- **Adapt.**
  - Open: Flip the thumbnail into a fixed full-screen `<img>` with `scale: true, duration: .42, ease: 'ios'`, and fade the backdrop 0→1 over 0.28 s.
  - Dismiss: drag down, using pick 14's Observer pattern.
  - Skip the "hide native scroll" part of the Codrops article.
- **Risk.** Swap to the full-resolution image only after the animation finishes, to avoid a decode hitch.

**5. P2 · Map row or reputation cell → detail header icon** — https://tympanus.net/codrops/2022/09/19/menu-to-grid-layout-animation, https://github.com/codrops/MenuToGrid
- **Fit.** `map.js:573 rowHTML` → `771 detailHTML`, and `reputation.js:133 cell` → `284 detail`, when they render in the same document.
- **Adapt.** Same `data-flip-id` pattern as pick 3, 0.38 s, `ease: 'ios'`. Use it only on the icon and title, never the whole panel.

## B. Lists and filtering (Flip)

**6. P0 · Materials filter and sort reflow** — https://tympanus.net/codrops/2023/04/12/grid-view-switch-animation, https://gsap.com/community/forums/topic/36832-flip-onenter-onleave-delay/
- **Fit.** `materials.js:134-162 renderList`, which replaces `innerHTML`.
- **Adapt.**
  - Add `data-flip-id="mat-${x.id}"` to `.mt-row`.
  - Before rendering, take `state = Flip.getState('.mt-row')`. After rendering, call `Flip.from(state, { targets: '.mt-row', simple: true, scale: true, duration: .36, ease: 'ios', onEnter: els => gsap.fromTo(els, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .36, stagger: .02 }) })`.
  - Leaving rows have already been removed by `innerHTML`, so just let them drop out.
- **Risk.** If more than 40 rows are affected, or a typing-driven filter fires within 150 ms, skip Flip and render instantly. Spotlight doesn't animate rows while you type either.

**7. P1 · Removing a row from the 资料袋 (iOS table delete)** — same Flip docs
- **Fit.** `materials.js:164 renderBag` / `#bag-list`.
- **Adapt.**
  - Keep the removed row with `absoluteOnLeave: true`, fade it to opacity 0 and x −12 over 0.18 s.
  - Siblings close the gap with `Flip.from(..., { simple: true, scale: true, duration: .32, ease: 'ios' })`.
  - The dock count already uses `rollTo`.

**8. P1 · Circle board switch and reputation directory pages** — https://gsap.com/community/forums/topic/36832-flip-onenter-onleave-delay/
- **Fit.** `circle.js:91 selectBoard` / `121 renderFeed`, and `reputation.js:151 directory` pager.
- **Adapt.**
  - Shared items Flip; new items use `onEnter` with a 0.03 s stagger, capped at 8 items.
  - Give `onEnter` and `onLeave` the same duration (0.3 s). That is the forum's fix for out-of-sync swaps.
  - Wrap each render in a `gsap.context(..., container)` and call `ctx.revert()` before the next `innerHTML`.

## C. Text

**9. P1 · Masked line reveal on large page titles (once)** — https://gsap.com/docs/v3/Plugins/SplitText/, https://webflow.com/blog/gsap-splittext-rewrite, https://www.osmo.supply/resource/masked-text-reveal
- **Fit.** The first `.as-largetitle` heading per page (circle, materials, reputation, map), after the one-time opening hands the page over (`today.js` `entered`).
- **Adapt.**
  - `SplitText.create(h, { type: 'lines', mask: 'lines', autoSplit: true, aria: 'auto', onSplit: s => gsap.from(s.lines, { yPercent: 100, duration: .6, ease: 'ios', stagger: .06 }) })`.
  - Run it inside `document.fonts.ready`, then call `split.revert()`.
  - Never apply it to body text or carousel slides (`carousel.js` is Codex's compositor path).
- **Cost.** 3.7 KB gzip, and the lines mask uses `overflow: clip`.

**10. P2 · Scroll-scrubbed word highlight on one statement block** — https://www.osmo.supply/resource/highlight-text-on-scroll, https://gsap.com/docs/v3/Plugins/ScrollTrigger/
- **Fit.** The lead statement on rules.html or school.html only.
- **Adapt.**
  - Split into chars for Chinese. Tween opacity 0.2→1 with ScrollTrigger `scrub: true`, `start: 'top 85%'`, `end: 'center 45%'`.
  - Where `animation-timeline: view()` is supported, use CSS instead and keep SplitText only for the splitting.
- **Risk.** Hundreds of spans. Limit it to 1 paragraph of 120 characters or fewer.

**11. P2 · ScrambleText for status labels only** — https://gsap.com/docs/v3/Plugins/ScrambleTextPlugin/, https://osmo.supply/resource/text-scramble-load-scroll-hover
- **Fit.** studio.html job states and the Latin parts of spotlight's "正在建立索引…".
- **Adapt.** `scrambleText: { text, chars: '01', speed: .6, revealDelay: .1 }` over 0.5 s.
- **Rule.** Never on counts or stats. That would bring back the count-up the owner rejected; `rollTo` (`fx.js:68`) stays the numeric-change pattern.

## D. Buttons and micro-interactions

**12. P0 · Sylva press model on DOM buttons** — https://github.com/MengTo/threeui (Sylva's source is `public/landing-pages/inner-green-3d.html`)
- **What Sylva actually does.** The button is a WebGL metal pill (three.js shaders, about 198 KB page, a continuous rAF loop). Do not port the shader. Port its interaction model:
  - One shared hot state for hover, press and keyboard focus (focus only via `:focus-visible`), file lines 1626-1661.
  - Asymmetric smoothing (lines 1477-1484): hover-in time constant ≈150 ms, hover-out ≈110 ms, press-in ≈50 ms, press release ≈180 ms (≈540 ms to settle).
  - Pressed shadow switches in 0.10 s; the plate eases back over 0.38 s `cubic-bezier(.22,.61,.36,1)`.
  - A ripple starts at the exact pointer point (`localPt`, line 1448); Enter or Space ripples from the center.
  - On `pointerenter`, the highlight jumps to where the cursor entered rather than where it last was.
- **Fit.** `.btn-primary`, `.as-get`, `.fab`, `.rail-btn` (`discover.js:164-171`), `.mt-add`.
- **Adapt.**
  - Keep the `motion.css:153-171` press scale.
  - On `pointerdown`, set `--px/--py` once (not per frame). A `::after` ring goes `scale(0)→1` and opacity .22→0 over 700 ms `power2.out`; this is just WAAPI, no GSAP needed.
  - Keyboard presses ripple from 50%/50%.

**13. P1 · Pointer-following highlight (iPadOS pointer feel, no tilt)** — https://gsap.com/docs/v3/GSAP/gsap.quickTo(), https://osmo.supply/resource/magnetic-hover-effect, https://www.osmo.supply/resource/momentum-based-hover
- **Fit.** Hero and primary CTAs, FAB, `.gn-publish`. Only under `(hover: hover) and (pointer: fine)`.
- **Adapt.**
  - A highlight child follows the pointer with `gsap.quickTo(hl, 'x', { duration: .35, ease: 'power3.out' })` (same for y). Use `clientX/Y`; the forum warns about `pageX`.
  - Optional magnetic pull on the button itself, capped at 3–4 px. Replace Osmo's `elastic.out` with `power3.out`.
- **Risk.** No 3D tilt (Opus removed it). Use one pointermove listener per button.

**14. P1 · Toasts as one top-center capsule (Dynamic Island / Sonner)** — https://emilkowal.ski/ui/building-a-toast-component, https://ui.aceternity.com/blocks/illustrations/dynamic-island
- **Fit.** Replace the duplicated `.dc-toast` (discover.css:384), `.cx-toast` (map.css:1137), `.pd-toast` (project.css:671) and `#kb-toast` with one shared toast.
- **Adapt.**
  - Enter: y −12→0, scale .92→1, opacity, 0.42 s `ease: 'ios'`. Exit: 0.2 s `power2.in`.
  - When toasts queue, older ones scale to .94 and shift y +8 (Sonner's stack).
  - The capsule keeps a fixed width per message; don't morph its width, because scaleX distorts the 999px radius.
- **Note.** Emil moved off keyframes because they can't be interrupted. GSAP's `overwrite: 'auto'` or WAAPI `cancel()` both handle that.

## E. Drag and gestures

**15. P0 · Map bottom sheet you can drag, with momentum snapping** — https://gsap.com/docs/v3/Plugins/Draggable/, https://gsap.com/docs/v3/Plugins/InertiaPlugin/
- **Fit.** `map.js:342-354`. Today `setSheet` is click-only, using `#cx-handle` / `.cx-panel-head`.
- **Adapt.**
  - `Draggable.create(panel, { type: 'y', trigger: '.cx-panel-head', inertia: true, bounds: { minY: openY, maxY: peekY }, edgeResistance: .85, snap: { y: [openY, halfY, peekY] }, minDuration: .25, maxDuration: .6, overshootTolerance: 0, onThrowComplete: syncAria })`.
  - Inertia projects the throw's end point and then snaps to the nearest stop. That is the iOS "project, then pick a detent" behavior.
  - Uses translate3d. Recompute `peek()` in `syncPeek`.
- **Cost.** About 17 KB gzip for Draggable + Inertia.

**16. P1 · Drag-to-dismiss with velocity for story and mobile sheets** — https://gsap.com/docs/v3/Plugins/Observer/
- **Fit.** Replace the hand-written touch code in `story.js:81-101` (Codex's file, so coordinate). Also use it for the mobile `dialog` sheets (`motion.css:120-140`) and the pick 4 lightbox.
- **Adapt.**
  - `Observer.create({ target: dlg, type: 'touch,pointer', lockAxis: true, dragMinimum: 6, ignore: 'button,a,input,textarea,select', onPress: s => armed = dlg.scrollTop <= 0, onDrag, onDragEnd: s => (dy > 110 || s.velocityY > 900) ? close() : settleOpen() })`.
  - Track the finger 1:1 for sheets, 0.35× for the story card. `velocityY` is in px/s.

**17. P1 · 高赞原话 wall you can grab and fling** — https://gsap.com/docs/v3/HelperFunctions/helpers/seamlessLoop/, https://tympanus.net/codrops/?p=91004, https://gsap.com/community/forums/topic/39212-infinite-product-image-gallery-with-seamlessloop-helper/
- **Fit.** `reputation.js:85-111`, today a CSS `rp-drift` marquee (`reputation.css:111`, `data-live`).
- **Adapt.**
  - Use the `horizontalLoop()` helper per lane with `{ repeat: -1, speed: .5, draggable: true }`.
  - On hover: `gsap.to(loop, { timeScale: 0, duration: .5 })`. On release: back to 1 over 1 s.
  - Pause off-screen through the existing `observeLive` and keep `data-live`.
  - Keep `aria-hidden` on the duplicated bullets.

**18. P2 · Swipe-left on a discover slide = 不感兴趣** — https://github.com/mattblang/swing, https://gsap.com/community/forums/topic/37175-gsap-stacked-animation-card/
- **Fit.** `discover.js:263 hide`, which already has undo.
- **Adapt.**
  - Draggable `type: 'x'`, `lockAxis: true`, `allowNativeTouchScrolling: true`, so vertical CSS snap stays native (`discover.css:20,73-74`; don't replace it with Observer).
  - Commit if x < −120 or vx < −800, then x→−100% plus opacity over 0.28 s. No rotation.
  - Leave a 24px dead zone at the left edge for the iOS back gesture.

**19. P2 · Swipe actions on rows (like Mail)** — Draggable docs
- **Fit.** 资料袋 rows and me 收藏 list rows (pick 1's list view).
- **Adapt.** `type: 'x'`, `snap: [0, -88]`, `edgeResistance: .9`. Reveal a real 移除 button; reuse the existing toggle APIs, no fake actions.

## F. Scroll storytelling (no scroll hijacking: DESIGN.md §5)

**20. P2 · Pinned media with stepped text (apple.com product page)** — https://gsap.com/docs/v3/Plugins/ScrollTrigger/, https://github.com/codrops/OneElementScroll, https://tympanus.net/codrops/2023/07/20/scroll-based-layout-animations
- **Fit.** One explainer section on school.html, or a new-student guide: a pinned "phone" frame that switches between map, materials and circle screenshots as text steps scroll by.
- **Adapt.**
  - `pin: true` on the media column only, `scrub: .5`. Animate the children, never the pinned element itself.
  - Crossfade only (opacity), at most 3 steps, and no horizontal pin.
  - Screenshots or art come from Codex.

**21. P2 · Image-sequence scrub** — https://gsap.com/docs/v3/HelperFunctions/helpers/imageSequenceScrub, https://codepen.io/GreenSock/embed/VwgevYW
- **Fit.** Only if Codex produces a real campus flyover or object render: 60 webp frames or fewer, about 2 MB or less, drawn to canvas.
- **Rule.** Apple's AirPods frames in the demo must not be reused.

**22. P2 · Flip combined with scroll (layout formations)** — https://github.com/codrops/ScrollBasedLayoutAnimations
- **Fit.** If anywhere, the contribution view (`src/js/contribution-view.js`, me.html): blocks regroup from a grid into a timeline as the section enters.
- **Rule.** Run it once on enter, not scrubbed. Codrops tweens `filter`; skip that.

**Don't use ScrollTrigger.batch for long lists.** `motion.css` deliberately keeps list items still, as apple.com does. CSS `animation-timeline` plus the IntersectionObserver fallback in `fx.js:20-30` already covers section reveals.

## G. SVG

**23. P1 · DrawSVG check marks for real successes** — https://gsap.com/docs/v3/Plugins/DrawSVGPlugin/, https://tympanus.net/codrops/?p=93244 (its DrawSVG underline demo)
- **Fit.**
  - `.mt-add` "＋→✓" (`materials.js:129`, today text glyphs)
  - quest complete (`map.css:2437 .cx-quest.is-complete`)
  - upload success and reminder saved
- **Adapt.** `fromTo(path, { drawSVG: '0%' }, { drawSVG: '100%', duration: .32, ease: 'power2.out' })`, followed by `pop()`.
- **Cost.** It animates `stroke-dashoffset`, which is a paint, not a compositor property. Allow it as an exception only for icons of 48px or less, played once (`intro.js:43` sets the precedent). 2.2 KB gzip.

**24. P1 · Draw today's class-order line on the map** — DrawSVG docs
- **Fit.** `map.js:313`, `L.polyline(... className: 'cx-route')`, which draws in Leaflet's SVG renderer (`campus-map.js:43`).
- **Adapt.**
  - After `fitCampus` fires `moveend`, draw `polyline.getElement()` over 0.9 s `power1.inOut`.
  - Then `clearProps: 'strokeDasharray,strokeDashoffset'` so the CSS dashes come back.
  - Kill the tween on `zoomstart`, because Leaflet rewrites `d`. Replay only on a campus switch.

**25. P1 · Favorite heart and star fill without morphing** — pattern from https://www.osmo.supply/resource/morphing-play-pause-toggle and https://css-tricks.com/?p=254303
- **Fit.**
  - discover save (`discover.js:164`; `save()` at 234 has no `pop` today)
  - circle star (`circle.js:485`)
  - reputation rating (`reputation.js:572-576`)
- **Adapt.** Use two stacked paths, outline and filled. The fill layer goes scale .4→1 and opacity 0→1 over 0.28 s `ease: 'ios'`, the container gets `pop()`, and un-favoriting reverses over 0.18 s. This is all transform and opacity, so MorphSVG isn't needed.

**26. P2 · MorphSVG for true shape-to-shape icon changes** — https://gsap.com/docs/v3/Plugins/MorphSVGPlugin
- **Fit.** The discover 搭建 rounded-square-with-plus → check (`discover.js:171`), and play/pause in `src/js/player.js`.
- **Adapt.** `morphSVG: { shape, shapeIndex: 'auto' }`, 0.28 s, `ease: 'ios'`.
- **Cost.** It animates the `d` attribute (paint), so keep it to small icons. 9.6 KB gzip: load it with `import()` on the first toggle.

**Do not adopt**
- ScrollSmoother: it is scroll hijacking.
- Liquid-glass SVG `feDisplacementMap` and animated `backdrop-filter`: CPU-heavy, and Codex already removed live blur.
- An Apple Dock magnify effect (https://webflow.com/made-in-webflow/website/osmo-apple-dock): apple.com's own nav doesn't magnify.
- Breathing loops, tilt, particles, count-up, tweening `filter` (Codrops GridToSlider tweens `brightness/hue-rotate`), elastic easing on big surfaces, and story View Transitions.

## Foundation: licensing, bundle, setup

**License**
- GSAP is 100% free, including every former Club plugin (SplitText, MorphSVG, Inertia and the rest), for commercial use too. The Webflow-sponsored change shipped with 3.13. Sources: https://gsap.com/blog/3-13/, https://webflow.com/blog/gsap-becomes-free, and `node_modules/gsap/README.md:60-62`.
- The license is the "Standard no-charge" license (`package.json` license field → https://gsap.com/standard-license, mirrored at https://gsap.com/community/standard-license/).
- The only carve-out is for no-code visual animation builders that compete with Webflow. A free student site is not affected.
- Older pages calling Inertia, DrawSVG or MorphSVG "Club only" are stale.

**Bundle sizes** (gzip -9 of `node_modules/gsap/dist/*.min.js`, v3.15.0)

| Module | Size |
|---|---|
| core | 28.3 KB |
| ScrollTrigger (includes `ScrollTrigger.observe`, so no separate Observer is needed on pages that load it) | 18.0 KB |
| Draggable | 13.5 KB |
| Flip | 9.7 KB |
| MorphSVG | 9.6 KB |
| ScrollSmoother (don't use) | 5.5 KB |
| Observer | 4.3 KB |
| ScrambleText | 4.0 KB |
| CustomEase | 3.7 KB |
| SplitText | 3.7 KB |
| Inertia | 3.3 KB |
| DrawSVG | 2.2 KB |

**Setup**
1. **Import only what each page needs**, e.g. `import { Flip } from 'gsap/Flip'`. Register once in a new shared module, e.g. `src/js/gsap.js`, which Vite will split into a shared chunk across MPA entries:
   ```js
   import { gsap } from 'gsap'; import { CustomEase } from 'gsap/CustomEase';
   gsap.registerPlugin(CustomEase);
   CustomEase.create('ios', '0.32,0.72,0,1');   // = --ease-ios (tokens.css:103)
   CustomEase.create('out', '0.22,1,0.36,1');   // = --ease-out (tokens.css:98)
   gsap.defaults({ ease: 'ios', duration: 0.42 });
   ```
   Pages then do `gsap.registerPlugin(Flip)` and so on, locally.
2. **One spring vocabulary.** Add a `gsapSpring(name)` to `src/js/motion.js` that returns `{ duration: settle(p), ease: t => t >= 1 ? 1 : curve(p)(t * settle(p)) }`. Then GSAP and WAAPI share `SPRINGS.smooth`, `snappy`, `bouncy` and `interactive`.
3. **Reduced motion.**
   ```js
   gsap.matchMedia().add({ ok: '(prefers-reduced-motion: no-preference)', reduce: '(prefers-reduced-motion: reduce)' }, ctx => { if (ctx.conditions.reduce) return; /* create tweens */ })
   ```
   When reduced, Flip callers just apply the DOM change. Sources: https://gsap.com/docs/v3/GSAP/gsap.matchMedia/, https://www.gsap.com/resources/a11y/.
4. **Cleanup in multi-page modules.** Use one `gsap.context(fn, container)` per re-rendered region and call `ctx.revert()` before replacing `innerHTML`. The regions are today.js `show()` (656), circle `renderFeed`, discover shelf switch (446-458), map `view()` (824) and materials `renderList`. On `pagehide`, call `Flip.killFlipsOf(...)` / `ctx.revert()` so a page restored from the back/forward cache never comes back mid-animation. Source: https://gsap.com/docs/v3/GSAP/gsap.context().

**Suggested order**
- **P0:** 1, 6, 12, 15, plus the foundation.
- **P1:** 2, 3, 4, 7, 8, 9, 13, 14, 16, 17, 23, 24, 25.
- **P2:** the rest.