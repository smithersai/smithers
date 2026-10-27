---
title: Production bug bash navigation chrome
status: in-review
area: frontend
owner: bb-chrome
updated: 2026-10-26
links: []
---

Reproduce the assigned navigation, phone header, timeline, pinned message and install command findings on production, then retain a regression for each repair. Catalog: `@smthrs/ui` for shared controls, theme tokens and chat presentation. No new dependencies. Mac mini unavailable; verification runs on Latitude. Each repair is delivered separately for the lander.


Delivered as separate fixes: themed navigation and compact phone chrome; one issues Back action with the issues minimization target; repository bells reserved beside headings and mounted in issue/PR detail headers; one visitor sign-in action; intact scrollable install commands; and contained timeline labels and previews with visible zoom labels. Shared UI changes carry changesets.

Production probes reproduced the findings before implementation and were repeated afterward. Production still serves the previous implementation; these probes are not evidence that the repairs have deployed. The phone unread count appears after sync, tapping Chat opens its composer, pinned content does not overlap the transcript, and New issue already has one Back action. No product change was needed for those reports; the meaningless phone shortcut hint is hidden by the header fix.

Latitude: app typecheck, importRules and lint pass. All 53 focused behavioral tests pass; the changed attention contract has 100% statements, branches, functions and lines. Shared UI's complete 2,661-test unit suite and typecheck pass, with changed source files at 100% measured lines/functions. Bun does not report branch/statement coverage; package-wide coverage is not claimed. Layout browser tests use actual UI components and production stylesheets, without request interception or module mocks.

Lander: deploy the delivered revision, run the chrome e2e specs against the deployment, and inspect the populated timeline at 390, 1180 and 1280 pixels, including keyboard-focused previews. Run the scripted timeline journey locally. Confirm one sign-in action, one issues Back action, bells clear of titles, a compact scrollable phone header, an intact scrollable install command and no timeline preview over chat. The Mac mini was unreachable, so no local app e2e or GIF receipt is claimed.
