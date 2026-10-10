# kankan-shoucang "整理台" desk: study and 收藏夹 re-implementation spec for Luokixi

I only read files. Nothing in /home/user/luokixi was changed. My one scratch file is `/tmp/claude-0/-home-user-luokixi/3c26a0ee-2f2d-557b-b645-dae2a7981a06/scratchpad/research/desk/spring.mjs`, which converts the reference springs into our spring units. All reference paths below are relative to `…/scratchpad/ref/kankan-shoucang/`. That repo is AGPL, so everything below describes how it behaves. Nothing should be copied: no code, no names (`buildOrganized`, `ensureDeskState`, `DeskCard`), and not its pseudo-random number constants.

---

## 1. What the user sees

**Desk layout** (`app/components/DeskView.tsx:183-298`, `app/lib/desk-card-metrics.mjs`)
- The desk is one scrolling surface on a warm bone colour (`#EBE9E4`) with three faint radial "ambient light" gradients (`DeskView.tsx:1606-1613`).
- Groups sit in a fixed grid:
  - columns: 5 at width ≥1720, 4 at ≥1280, 3 above 900, otherwise 2 (`desk-card-metrics.mjs:10-16`);
  - each cell is 340px tall, with 42px or 60px side padding (`DeskView.tsx:203-207`).
- Each group is a pile of cards with a label pill about 155px above the pile centre (`:229`).
- "Loose" notes (new imports, not yet filed) are laid out in a row band at the top. They get ±15px x and ±10px y jitter, rotation within ±8°, and z 500+i (`:278-295`).

**Card look** (`:824-937`)
- Size 156×196, paper `#FDFCFA`, radius 10, padding 7/7/18 (a Polaroid look).
- Image area is 118px tall, radius 6, with a static `filter: saturate(.78) contrast(1.06) sepia(.05)`.
- Under the image: an 8.5px category chip tinted with the category colour, then a 12.5px Playfair title clamped to 2 lines.
- Shadow is two warm layers. With no cover image, the card shows the title's first character on a colour gradient. Video notes get a ▶ badge.

**How a stack is drawn** (collapsed, `:260-273`)
- Every card in the group is rendered (no cap).
- Each card is offset on a golden-angle spiral. Radius is min(i·3, 25) plus ±10 jitter. X offset is ±10 extra, Y is compressed ×0.6 with ±7.5 jitter, so roughly ±45px × ±28px.
- Rotation is random within ±14°. The random values come from a deterministic generator seeded by the card's index in the group, so the same index always gets the same tilt.
- z-index is random 0–19 plus groupIndex·15. The top card is therefore effectively random, not the newest.
- Weakness: because the seed is the index, filtering or moving cards reshuffles every tilt.

**Hover**
- Card: scale 1.06 and z+100, 150ms (`:789`). The pile does not fan out.
- Label pill: scale 1.05 and y −2, spring (`:1998-1999`).

**Expand** (`:240-259`, `:1944-1947`)
- Clicking the label pill toggles the group open. Clicking an empty spot on the desk collapses it (`:1798-1803`).
- The open group's cards spring into an upright grid that floats over the desk:
  - 3 columns (2 if the desk is ≤600px wide), with a centre-to-centre pitch of 170px across and 210px down;
  - the grid starts 30px below the cluster centre and is clamped 24px inside the viewport (`desk-card-metrics.mjs:18-29`);
  - z is 300+i.
- Everything else dims to opacity .35, scale .75, z 0, and stops taking clicks (`DeskView.tsx:784-786`, `:2132`). The grid overlaps the piles below; nothing reflows. The screenshot `screenshot-group.jpg` shows this "ghosted desk".
- The label pill turns white with a coloured border, the chevron rotates 180°, and a pencil (rename) button pops in from x −10 / scale .8 (`:2073-2120`).

**Collapse**
- The same spring runs back to the scattered positions. There is no reverse stagger.

**Opening a note**
- Clicking a card opens a centred reader modal (`:369-400`): backdrop blur(20px) fading in over 250ms, panel springing in from scale .92.
- There is no shared-element transition from the card, and Escape does not close it.

**Drag & drop**, using native HTML5 drag (`:1494-1537`, `:1860-1909`, `:1937-1980`):
- **Card onto another group**:
  - while a card is dragged, every *other* group shows a dashed drop zone (radius 30, 330px tall), which tints with the group colour on hover;
  - dropping on the zone or on the label pill moves the card, and for custom groups also rewrites the note's category (`:1405-1417`).
- **Reordering groups**: a label pill is draggable, and dropping it on another label inserts it before that one (`desk-workspace.mjs:173-183`).
- **No reordering inside a group.**
- **Drag image**: an off-screen clone at opacity .92 (`:162-175`).
- **Edge auto-scroll**: the edge band is clamp(72px, 13% of viewport height, 110px), speeding up to 4–20px per frame (`desk-card-metrics.mjs:31-41`).
- **Drag-in import**: dropping a Xiaohongshu card from the browser shows a full-screen frosted "松手收录" overlay with a 1.35s pulsing icon, then a status pill (`:1615-1705`).

**Selection**
- Alt/Option-click toggles selection, but only inside the expanded group (`:1441-1455`). Selected cards get a coloured ring and a check badge.
- Dragging a selected card moves the whole set, with a count bubble. Selection clears whenever the expanded group changes (`:1259-1261`).

**Search** (`:1263-1286`, `:1735-1752`)
- Matches every whitespace-separated token against title, body, OCR text, tags, author, category and group name (`scripts/lib/note-search.mjs`).
- Typing collapses the open group, and groups with no matches are hidden.
- Non-matching cards are removed with no exit animation; the remaining cards spring to their recomputed spots. Escape clears the box.

**Empty states**
- No notes: icon plus "把一条笔记拖进来".
- No matches: icon plus "没找到相关收藏" (`:1813-1859`). Both fade in with y 6–8.
- A floating "新建分组" button at bottom centre creates a group, expands it and starts rename (`:1377-1388`, `:2165-2189`).

## 2. Animation mechanics

**Engine.** Framer Motion springs on `x`, `y`, `rotate`, `scale` and `opacity`. It is not FLIP in the DOM sense: every card is absolutely positioned in one flat layer (`left:-78px; top:-98px`, moved by x/y), and positions are a pure function of (notes, groups, assignments, width, open group). Any state change re-targets each card's spring. This flat layer is why a card can fly from one stack into another.

**Springs**, converted to SwiftUI units with my script:

| Use | Setting | ζ | response | settle | overshoot |
|---|---|---|---|---|---|
| Card | stiffness 220 / damping 24 / mass .8 | .905 | .38s | ~354ms | .13% |
| Reader | 350 / 30 | .80 | .34s | ~430ms | 1.5% |
| Chevron | 250 / 20 | .63 | .40s | ~620ms | 7.7% |

The card spring is about our `snappy` (`src/js/motion.js:9-14`).

Other timings:
- Card hover: 150ms tween.
- Labels enter: y 5 over 300ms.
- Modals: 220–250ms fades.
- New cards mount from opacity 0 / scale .8.

**Stagger.** None; all cards start together.

**z-index** is animated as a value:
- dimmed cards 0, piles random plus 15 per group, open grid 300+i, loose cards 500+;
- label pills 400 (100 while something is open, 600 for the open or target group);
- drop zones 550, overlays 220/300/310.

**Idle loop.** Each card "breathes" forever: scale 1→1.015 and y 0→−2 over 3s with a seeded 0–3s delay (`:811-821`).

**Performance tricks** (all of them):
- `desk-performance.mjs` turns breathing off once 60 or more notes are visible.
- Every card has `will-change: transform, opacity` (one compositor layer per card).
- `memo` on the card component; images use `decoding="async"`.
- Desk saves to the server are debounced by 250ms. Notes are polled every 2s via a revision check (`app/page.tsx:36`).
- No virtualization, no cap on cards per pile.
- `backdrop-filter` is used on labels, badges, the header and overlays.

**Reduced motion and keyboard.** There is no reduced-motion handling. Cards are clickable `div`s that cannot be focused, there is no keyboard path for drag, and drag doesn't work well on touch.

## 3. Data model

**Workspace.** `{ groups:[{id, name, kind:'auto'|'custom', sourceCategory}], noteGroupMap:{noteId: groupId|'loose'}, knownNoteIds:[] }` (`desk-workspace.mjs`).
- Group order is the array order. Order inside a group is the notes array order.
- Auto groups are derived from each note's inferred category: a regex-weighted score in `category-inference.mjs`, with 9 categories plus "待分类".

**Reconciliation** (`desk-workspace.mjs:37-122`):
- an auto group is created for every category present;
- new notes go to "loose" once a workspace exists, otherwise to their auto group;
- deleted notes are pruned;
- empty auto groups are dropped, empty custom groups are kept.

**Persistence.** Two tiers:
- `localStorage` key `kankanshoucang:desk-workspace:v1`, written on every change;
- the local API, written by `PUT /desk-workspace` with a 250ms debounce.

On load the local copy wins first, then the server copy replaces it if it has content (`DeskView.tsx:1210-1249`). Moving a card to a custom group also does `PATCH /notes/categories`.

## 4. Re-implementation spec: Luokixi 收藏夹

**Where it goes.** Replace `SECTIONS.stars()` (`src/pages/me.js:278-287`) with `mountFavorites(el, st)` in a new `src/js/favorites-desk.js`. It should return a dispose function, following the `mountContribution` pattern at `me.js:382`. The section stays at `me.html#stars`.

### 4.1 Sources and what the API allows

**Server stars** come from `st.me.stars` (`campus/hub/api.py:212`) as `entry_data` (`campus/hub/core.py:103-117`), with these fields: `id, slug, kind, data{title,summary,credit,uploads,links,tags,circle…}, owner, updated, siteStars, collection`.

Limits of that payload:
- at most 200 items;
- no `order_by`;
- no starred-at time (`Star.created` exists at `models.py:82` but isn't sent);
- withdrawn or unpublished entries silently drop out.

Circle posts are Entries with `kind:'topic'`, so they already arrive in this list (`circle.js:485-505`).

**Moving a star is supported.** `hubApi.star(id, true, name)` (`campus/hub-client.js:88`) uses `update_or_create`, which changes `collection` in place (`api.py:395-400`). Constraints:
- the user's email must be verified, otherwise 403 "请先验证邮箱再参与共建。" (`core.py:29-35`);
- the name must be non-empty and at most 80 characters.

**Not supported by the API**, so the client must work around it or Codex must add it:
- **Empty collections**: a collection is just a string on Star rows, so a new empty one exists on the client only until the first card is dropped in.
- **Rename**: one star call per item, not atomic. Do it sequentially and roll back on failure. Ask Codex for a bulk rename endpoint.
- **Collection order and card order**: keep these locally under `luokixi.favorites.desk.v1` as `{order:[names], pending:[names]}`. Ask Codex for `starredAt`, plus `order_by('-created')`.

**Collection overwrite risk.** Every existing caller sends the default name (`circle.js:492`, `discover.js:251`). Because of `update_or_create`, a star(true) call with stale UI state would reset a filed item to 默认收藏. Ask Codex to keep the existing collection when the field is absent.

**Card covers.** `/api/hub/uploads/{uploads[0]}/photo` only works for png/jpg/webp and returns a 1280px JPEG (`files.py:96-108`). That is too heavy for 160px cards: ask Codex for a small preview size and use `onerror` to fall back.

**Local stacks, read-only.** These are badged "仅本机", accept no drops, and stay visible even when offline or logged out:
- **本机收藏的项目**: `notebook.read().savedProjects` (`src/js/community-notebook.js`). These are repo URL strings only. Show the title as the `owner/repo` path and the host as a chip; never invent descriptions.
- **资料袋**: `readBag()` (`src/js/materials-catalog.js:10-16`). Items have `{title,url,format,course,year}`, up to 30. The card uses the `.mt-doc` glyph and the stack opens `materials.html?bag=`.

**Detail links.** Projects go to `project.html?slug=`, topics to `circle.html?post=`, places to `map.html?place=`.

### 4.2 Grouping

- **Default view, "按收藏夹"**: one stack per `collection`, ordered by the local order list and then by size. Inside an expanded stack, cards are sorted by kind (`KIND`, `me.js:19-22`) and each card shows its kind tag.
- **"按类型"**: offered through the existing `.as-seg` segmented control. Selected automatically when the user has only one collection, so 200 items in 默认收藏 don't become one giant pile. This works like macOS "Use Stacks → Group by Kind". Moving cards is disabled here because kind is intrinsic.

### 4.3 Stack visuals (our own design, quieter than the reference)

**Layout.**
- Desk: CSS grid `repeat(auto-fill, minmax(220px, 1fr))`, gap 28/20px.
- Card: 160×200 on desktop, 128×160 on phones, with the **same size in the pile and in the open grid**, so Flip never has to scale and text never distorts.
- Card styling: radius `--r-s`, a 4:3 cover on top, then `.tag` for the kind and a 2-line title at 13px, shadow `--card-shadow`.

**Pile.**
- Render at most 4 cards per pile; show the rest as "+N" in the label. The label is a `<button>` with the name and count.
- Seed each card's jitter from **a hash of its entry id** (for example FNV-1a split into 3 fractions), so a card keeps its tilt when others move or are filtered out.
- Per depth d (0 is top):
  - top card: rotation ±1.5°;
  - cards behind: ±(3 + 2.5d)° alternating sides, x jitter (h−.5)·10·d px, y d·3px, scale 1−.02d.
- The top card is the most recent star. Until `starredAt` exists, use the server array order as the proxy.
- Cards under the top one are `inert` and `aria-hidden`.

**Hover peek** (only under `(hover:hover) and (pointer:fine)`):
- the pile fans: top card y −4, card 1 at −8° / x −14, card 2 at +8° / x +14;
- driven by CSS custom properties with `transition: transform var(--spring-interactive-dur) var(--spring-interactive)`;
- the hover shadow is `--card-shadow-hover` on an `::after` whose **opacity** changes (box-shadow must not animate, per `docs/DESIGN.md:33`).

**Press.** Reuse `.fx-press` (`src/styles/motion.css:162-166`).

### 4.4 Expand and collapse with GSAP Flip

1. `const s = Flip.getState(cards)`.
2. Add `is-open` to the stack. This makes it span the full row (`grid-column: 1/-1`) and lays its pile out as `grid-template-columns: repeat(auto-fill, var(--fav-card-w)); justify-content: center`. Render the remaining cards now, starting at opacity 0.
3. `Flip.from(s, { …options })` with:
   - `duration: .54` (matches `--spring-snappy-dur` 537ms);
   - `ease`: a CustomEase sampled from `SPRINGS.snappy`. This needs a small export from `motion.js` so GSAP and CSS share one curve;
   - `absolute: true, nested: true, scale: true`;
   - `stagger: { amount: Math.min(.18, n * .016) }`;
   - `zIndex: 5`;
   - `onEnter`: opacity 0→1 and scale .9→1;
   - `prune: true`.
4. Other stacks dim to opacity .4 and scale .96 over 280ms `--ease-ios`, and become `inert`. Unlike the reference, they reflow below the open row instead of being covered.
5. Add `is-flipping` while running to turn off the CSS hover transitions, since they fight GSAP's inline transforms. On click, call `Flip.killFlipsOf(cards)` first so repeated clicks continue from where the cards currently are.
6. Collapse: the same steps reversed, `stagger.from: 'end'`, `.42s`. Extra cards fade out (`onLeave`), then unmount.

Close triggers: the label again, Escape, or clicking the desk background. Opening a card uses the existing `openFrom`/`closeTo` card-to-dialog FLIP (`src/js/fx.js:79-115`), which is better than the reference's centred pop-in.

### 4.5 Drag to move (server stacks only, "按收藏夹" view only)

**Mechanism.** GSAP `Draggable` with pointer events, not HTML5 drag-and-drop (which is unreliable on iOS):
- mouse: `minimumMovement: 4`;
- touch: start only after a 400ms long-press. Keep `allowNativeTouchScrolling` until the press arms; on arming, a 120ms scale pop.
- `autoScroll: 1` replaces the reference's hand-written edge scrolling.

**Lift.** Scale 1.06, rotation 0, the shadow `::after` fades in.

**Targets.** Other stack labels and piles show a ring (opacity on a pseudo-element). Hit-test with `Draggable.hitTest(el, '35%')`.

**Drop.**
1. `Flip.getState` on the card, move its node into the target pile, then `Flip.from` so it tucks under the top card.
2. `hubApi.star(id, true, target)`, and keep the returned `collection` as the truth.
3. On error: Flip it back, then toast `e.message` (the verified-email case, for example).

A miss springs back to x/y 0. An empty pending stack is a dashed placeholder reading "拖一张卡片到这里".

**Multi-select.** A "选择" button in the expanded header (iOS Photos style) shows check badges. Dragging a selected card carries the whole set with a count bubble; this is the reference's idea, triggered by a button instead of Alt.

**Stack order.** Dragging a label reorders stacks, saved locally only.

### 4.6 Keyboard and accessibility

- Label: `<button aria-expanded aria-controls>`. The open grid: `role="region" aria-label="考研 · 12 项"`.
- Cards are links. Arrow keys move a roving tabindex. Escape collapses the stack and returns focus to its label.
- Every card has a "⋯" menu: 移到收藏夹… (lists the collections plus 新建), 取消收藏 (with an undo toast). This is also the main move path on touch.
- Keyboard drag: Space picks a card up, ←/→ cycles target stacks, Enter drops, Escape cancels. An `aria-live="polite"` region announces "已拿起《…》" and "已移到「考研」".

### 4.7 Reduced motion

- No Flip: classes switch at once, with at most a 120ms opacity crossfade.
- No hover fan. Pile rotation capped at ±2° (static, which is fine).
- Drag still follows the finger (that's direct manipulation), but a drop lands instantly.
- No idle loops anywhere. Do **not** carry over the breathing animation: it is an ambient per-card loop, and our motion docs record that the owner found per-card ambient motion laggy.

### 4.8 Mobile, 375px

- Desk: 2 columns, `padding-inline: 16px`, gap 20/12px, giving cells of about 165px.
- Pile: x offset ≤8px and rotation ≤±6°, so nothing overflows and the page never scrolls sideways.
- The open stack spans both columns with a 2-column grid of 128px cards, then `scrollIntoView({ block: 'start' })` (instant under reduced motion).
- Any floating "新建收藏夹" button sits at `bottom: calc(var(--tabbar-h) + 12px)` (`components.css:290-300`).

### 4.9 Offline, static and logged-out

- `hubApi.available` false, or `hubState().online` false: show only the local stacks, with the notice "只保存在这台电脑的浏览器里，记得导出备份".
- Online but logged out: the local stacks plus the existing `needLogin()` card.
- Online and logged in: server stacks, then a "本机" divider and the local stacks. Hide a local project if a starred project's `data.links.repo` is the same URL.
- Empty states keep the current copy and CTA (`me.js:281`), plus a no-results state "没找到相关收藏" with a clear button.

### 4.10 Search

- Debounce 120ms. Match tokens against title, summary, credit, tags, collection name and kind label.
- `Flip.getState`, then set `hidden` on non-matching cards and on stacks with no matches, then `Flip.from` with `onLeave` (opacity to 0 and scale .9, 180ms) and `onEnter` (fade in).
- Labels show "3 / 12". Use `rollTo` (`fx.js:63`) for count changes, which is the existing digit roll, not the removed count-up. Escape clears the box.

### 4.11 Performance

- At most 4 cards per collapsed pile, so roughly 200 cards in the DOM only while a stack is open.
- `loading="lazy" decoding="async"` on images; `content-visibility: auto` on stack cells.
- No permanent `will-change`: GSAP applies 3D transforms only while a tween runs.
- No `backdrop-filter` on cards or labels.
- Animate only transform and opacity.
- Backend, for Codex: `entry_data` runs 1–3 queries per star (`core.py:110-113`), so 200 stars means hundreds of queries.

### 4.12 Inspired by the reference vs. ours

**Taken as ideas from kankan-shoucang (re-implemented, not copied):**
- labelled piles with seeded tilt and offset;
- the label pill with count and rotating chevron;
- one stack opening into a flat grid while the rest dims;
- clicking the desk to collapse;
- dragging a card onto a stack to re-file it;
- dragging labels to reorder stacks;
- "new group" that opens straight into rename;
- drop-target highlighting;
- multi-drag with a count bubble;
- edge auto-scroll;
- search that hides empty groups;
- a "lightweight above N items" threshold;
- saving locally at once and to the server with a debounce.

**Designed ourselves:**
- the Star.collection mapping and its limits (verified email, 80 characters, no empty collections, rename by many calls, client-side order);
- CSS-grid layout plus GSAP Flip instead of JS-computed coordinates;
- tilt seeded by entry id instead of index;
- capped piles, the hover fan and recency-ordered top card;
- Draggable with touch long-press and optimistic move with rollback;
- the ⋯ move menu and the keyboard drag path;
- all reduced-motion behaviour;
- the 375px layout;
- local "仅本机" stacks for the offline and static cases;
- card-to-detail FLIP through `fx.openFrom`;
- App Store tokens instead of warm paper and Playfair;
- dropping the breathing loop and per-card blur.