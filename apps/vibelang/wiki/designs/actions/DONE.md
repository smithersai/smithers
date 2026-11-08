# DONE — actions/

Designed Actions (VL-24): registered workflows as a maximizable chat pane, GitHub's list → runs → live trace (steps +
log), run by button, by `/command`, or by the agent with a live run card in the chat.
The slash menu is the existing completion component, filtered per role: viewer `/tour`; new +`/sandbox`; community
+`/triage` `/docs`; contributor +`/ci`; maintainer +`/release`; viewers watch all runs, run none.
15 screens in `index.html` (chat, list, max, runs, trace, done, agent, five slash menus, empty, loading, error),
each verified at 1280px and 390px — shots in `shots/`, canonical pair `desktop.png`/`phone.png`.
All copy, keyboard paths, reused (`vl-pane`, `vl-docs`, `sui-*`) and new (`vl-act-*`, `vl-term*`) components, and
every decision are in `NOTES.md`.
