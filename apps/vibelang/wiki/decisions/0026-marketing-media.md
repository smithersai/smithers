# 0026. Marketing media at the Tour’s stops

Status: accepted, 2026-11-08. Rulings: VL-19, VL-13, VL-27, VL-28. Extends 0014.

The designer’s source is preserved verbatim under [designs/media](../designs/media/NOTES.md), including its
self-contained HTML, assets and desktop/phone screenshots. The two supplied end-state posters are copied to public/media.

VL-31 replaces the docs tour with the [onboarding theatre](0014-agent-tour.md#vl-31-theatre-walkthrough-2026-11-08-lane-vl-learnmore).
Its step catalog contains app destinations and exact subtitles. The former five per-stop media placements and
catalog are removed; the preserved designer source remains historical reference.

| File | Placement |
| --- | --- |
| logo-dark.svg, icon.svg | Header, favicon |
| contract.mp4, contract-poster.jpg | Splash; muted, controls, loop; paused poster on reduced motion |
| card-06-compiler.png | Empty chat; removed as soon as an entry or pending post exists |

Native image/video errors remove their complete figure. Reduced motion renders the splash poster.

`MediaAssets` is an injected Effect service with an identity default. The fault host substitutes valid PNG bytes
for a video and lets the real browser decoder fail; the image-failure case supplies a missing asset. No request is
intercepted. Native outcome commands log, span and count only loaded/failed and image/video, with no URL or user text.
Existing durable Tour steps retain their existing observations; media adds no server work or model calls.

The CSS reports were checked on current main before implementation: all header controls fit at 390px and the title’s
computed background-image is a linear gradient. Both checks remain as regressions; no fix to either was necessary.

Behavioral evidence: failing compiler-card scene first; missing placements/reduced posters fail in the browser;
then each actual file decodes at its stop in dark, light-preferring and phone projects. Browser cases also retain
viewport geometry, posters during native loading, exact video loop policy, reduced motion, real decode failure and
empty-chat image failure. Screenshots beside the lane report show all stops and the empty chat at 1280 and 390px.
Browser decoding/layout and Effect execution remain runtime proof boundaries, as in 0018; these tests are not formal
proofs of the browser. The conversation machine and Tour’s durable sequencing are unchanged.

Catalog entries used: `@smthrs/ui-css` for the chat; `@smthrs/flow` and `@smthrs/engine` for the existing shared Tour.
No dependency added. Existing test-tool peer versions align to the monorepo (0008). No deployment in this lane.
