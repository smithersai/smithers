# Marketing media placements — NOTES

VL-19: "We have marketing materials generated these should be used throughout our site." The audit found 6 of the 10
files in `app-src/public/media/` unused. This design places all six where each earns its place — a picture or a video
instead of words, never beside an explanatory sentence (MINIMAL TEXT) — and says why the wiki, the history and the new
panes get none.

`index.html` is one self-contained dark page (VL-27): the live stylesheet inlined verbatim, this design's additions in
`extra.css`, markup in `body.html`; `./build.sh` reassembles. The top bar (design chrome, not the app) switches Screen
and media State (Default / Loading / Reduced motion / Media failed). `shots/` has every screen at 1280×800 and
390×844; `shots.mjs` re-renders them. No horizontal scroll at either width. `desktop.png`/`phone.png` are the
placement map.

## The placements

| File | Where | Why |
| --- | --- | --- |
| `contract.mp4` + `contract-poster.jpg` | Splash hero — **unchanged** | The contract `A!E!R` is the one idea the splash teaches; the motion earns the hero. Learn more stays the only primary action. |
| `card-01-contract.png` | Tour stop 1 (`/`, what VibeLang is); also the agent's in-chat answer when asked about a type | The card *is* the contract, drawn: returns / fails / needs. In chat, the agent answers with the picture alone — the card's own words say it. |
| `magic-move.mp4` | Tour stop 2 (`002-why-effect`) | The stop's claim is "keeps all of Effect, drops the boilerplate"; the video shows the Effect TypeScript morphing into the same program in VibeLang. |
| `token-bars.png` | Tour stop 3 (cheat sheet) | The stop claims each form is the Effect it compiles to; the 47-pair measurement (6.6% fewer tokens) is the proof. A still — the number is the point. |
| `card-07-install.png` | Tour stop 4 (`/setup`) | The stop is the install command; the card shows the command and its output. A picture instead of a typed command list. |
| `agent-loop.mp4` | Tour stop 5 (`/vips`, the factory) | The stop introduces this site as the coding factory; the video is the factory's loop: the agent writes, the compiler answers with what to write instead. |
| `card-06-compiler.png` | Chat empty state | The empty chat's job is to show what asking gets: diagnostics that say what to write. A still, no motion beside the composer. |
| `icon.svg`, `logo-dark.svg` | Favicon, header — unchanged | Brand. |

Every file is placed; none is left over.

## Where no media goes, and why

- **Wiki** — the project's working memory is prose by design (VL-23); a marketing figure decorates it.
- **History** — the mythical stack is itself the evidence; art adds nothing.
- **Issues, Actions, Sandboxes** — GitHub-like operational lists (VL-18). GitHub puts no art on a list; media would
  push rows below the fold.

## How media appears at a tour stop

The maximized pane (0014: docs left, the stop's paragraph right on desktop; docs above the paragraph on phones) gains
a figure, `.vl-stop-media`, at the top of the narration column, above the agent's words. The docs page stays the
substance; the media is the stop's proof, replacing what would otherwise be a second paragraph of description. On
phones the figure is capped at `30vh` (`object-fit: contain`) so the docs, the media and the words all stay in the
viewport, which `e2e/tourfix.spec.ts`'s bounding-box rule already requires.

## Video rules

- All videos `muted playsinline`; none autoplays sound. Tour videos carry no controls (the agent is driving; Escape
  ends the tour). The splash's `contract.mp4` keeps its controls, as live.
- **Loop:** `contract.mp4` and `agent-loop.mp4` loop — each is a cycle (type → the signature; write → the diagnostics)
  that reads continuously. `magic-move.mp4` plays once and holds its last frame — the frame *is* the answer ("136
  tokens instead of 202"); a loop would re-scramble it.
- **Reduced motion:** a still poster, never a playing video. `contract-poster.jpg` exists; this design ships two new
  posters extracted from the videos' end states: `magic-move-poster.jpg` (the answer frame) and
  `agent-loop-poster.jpg` (the full-diagnostics frame).
- **Loading** shows the poster (a slow video is indistinguishable from its still). **Failed** removes the figure
  entirely; the layout holds — the stop's words and docs remain, the chat empty state loses nothing it needs.

## States and keyboard

- The bar's State select demonstrates Loading (poster / `sui-skeleton` for the chat's image), Reduced motion (stills),
  and Media failed (figure removed, layout intact).
- No new keyboard paths: media is decorative content in panes and bubbles, not interactive. During the tour the only
  keys are as today (Escape ends it; the docs are inert). Alt text / `aria-label` on every image and video (wording in
  `body.html`; each states what the media shows, not that it is marketing).
- Roles: media is identical for viewer through maintainer, so there is no role switcher.

## Components

- **Reused as-is:** `vl-top`/`vl-nav`/`vl-pill`, the whole splash (`vl-splash`, `vl-media`), `vl-pane`, `vl-docs` +
  `vl-docs-bar`/`vl-docs-frame`, `vl-glow`, `vl-esc`, `sui-chat-*` (messages, empty, message, bubble, composer),
  `sui-skeleton`, `sui-table`/`sui-table-container` (the map), the dark tokens.
- **New (3 classes, all in `extra.css`):** `.vl-stop-media` (tour figure), `.vl-empty-media` (chat empty-state
  figure), `.vl-msg-media` (media inside an agent's bubble). One layout class, `.vl-docs-body` (+`.vl-tour-side`),
  formalizes 0014's maximized split and carries the phone stacking. `mdoc-*` classes are design-only mock docs pages
  standing in for the vibelang.sh iframe.

## Found while designing (for the app, not shipped here)

1. **The header overflows ~10px at 390px** (logo 124px + Mock pill + three links). `extra.css` carries the proposed
   fix scoped to `max-width: 420px` (tighter padding, 13px links); it should land in `app-src/src/web/styles.css`.
2. **The captured `live-app.css` lost `.vl-gradient`'s `background-image`** (empty declaration), which renders the
   splash's "Vibe" invisible. The design restores it from `--vl-gradient`; worth checking the app's built CSS.
