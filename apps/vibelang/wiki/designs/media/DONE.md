# DONE

Designed VL-19: every marketing file in `app-src/public/media/` placed where it earns its place.
Six unused files placed: `card-01` (tour stop 1 + agent's chat answers), `magic-move.mp4` (stop 2, plays once),
`token-bars.png` (stop 3), `card-07-install.png` (stop 4), `agent-loop.mp4` (stop 5, loops), `card-06-compiler.png`
(chat empty state); splash and brand files unchanged; wiki, history, issues/actions/sandboxes deliberately get none.
Videos muted, no autoplay sound, loop only where the loop reads, still posters under reduced motion (two new posters
extracted: `magic-move-poster.jpg`, `agent-loop-poster.jpg`); loading shows the poster, failure removes the figure.
`index.html` (self-contained, live CSS verbatim) has 9 screens × media states at 1280 and 390 with no overflow;
screenshots in `shots/`, defaults in `desktop.png`/`phone.png`. Two app bugs found: 390px header overflow and the
empty `.vl-gradient` background-image in the captured CSS.
