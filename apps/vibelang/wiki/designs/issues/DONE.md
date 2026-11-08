# DONE

Designed brick 3 (VL-20): issues as a tree, tasks, and proposing a VIP, in `~/smithers-builders/vl-designs/issues/`.
`index.html` is one self-contained dark page on the live stylesheet: 15 screens (list/tasks/VIPs, issue detail,
commit dialog, committed task, 4-step VIP form, VIP in review and accepted, agent filing/splitting in chat, roles
table), switchable by screen, role and list state (empty/loading/error), correct at 1280px and 390px.
Tasks are a state of an issue (maintainer commits, agent is the default assignee); VIPs are issues with a template
and In review → Accepted/Declined; the tree shows as parent/children on rows, details and timeline events.
Components are the shipped `sui-*`/`vl-*` classes; the only new ones are `ix-*` (steps, tree rows, avatars, radio
rows). Screenshots for every screen at both sizes are in `shots/` (rendered with Playwright from
`~/smithers-builders/vl-mono/apps/vibelang`), with `desktop.png`/`phone.png` as the default view; `NOTES.md` has the
interactions, keyboard paths, full copy list and decisions.
