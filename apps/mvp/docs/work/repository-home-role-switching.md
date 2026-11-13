---
title: Repository home defaults to the highest role, with switching down
status: in-progress
area: app
owner: vibelang-factory builder (Claude Opus)
updated: 2026-10-22 04:05 PDT
links: [../rulings.md, repository-declared-home.md, effect-repository-home.md, prelaunch-vibelang-on-smithers.md, roles-and-labels.md]
---

## Built — 2026-10-22 04:05 PDT

**What:** `View as` on a repository's home: a person opens on their own view and switches down to each lower one that shows something; a visitor, or anyone with one view, sees no switcher, even on a home open to anyone (`src/features/home/view.ts` `viewsOf`, `actions.view`).

**Proof:** `src/features/home/{view,home}.test.ts` (each role, never up, a visitor on an "anyone" home); e2e `home-effect.spec.ts` (Effect, three roles) and `vibelang-{contributor,maintainer}.spec.ts` (VibeLang). Commit "a repository's own home before a clone, and View as" on builder/vibelang-factory, not yet on main.

**Next step:** land, deploy, run the VibeLang journeys against smithers.sh.

## What

Open a repository home in the person’s highest authorized view. Allow switching down to contributor or user; never offer a view above the person’s authority.

## Why

SCOPE-14 requires maintainer-first behavior for maintainers and prevents users or signed-out visitors seeing the contributor option. SCOPE-13 prioritizes polished visitor, contributor and maintainer views for the VibeLang factory.

## Current state

At 00:41 the lead reports the Effect home already chooses the view on the server. The switching control is missing and scheduled after deployment. No implementation or passing end-to-end receipt exists. Declare the view through the public plugin interface; authorization remains server-enforced.

## Next step

Add the role-limited switching control using shared UI components and the existing home services; prove default selection, switching down and denied upward access for each role, including signed-out visitors.

## Open questions for Will

None; SCOPE-14 settles the behavior.

Evidence: script-filtered user-typed text and lead text replies from session 6253ecf2, approximately 22:44–00:44 PDT; rulings, queue answers through 00:17:42 PDT, current decisions, proposals, TODOs, rules and shared briefs/designs. Automated notifications and teammate messages are excluded as human evidence. Product checks are lead-reported receipts; this tracker validates the site build only. Existing execution owners and all history are retained.
