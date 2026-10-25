---
title: Visitor file pages wait for repository sync
status: in-progress
area: app
owner: claude visitor-files
updated: 2026-10-25
links: [../features/repo.md, ../features/home.md, ../features/sign-in.md, ../features/branch-workspace.md]
---

Library catalog: Electric sync (`@smthrs/effect-electric`), local-first state (`@smthrs/effect-tanstack-db`), the
repository view (`@smthrs/repo-view`) and UI components (`@smthrs/ui`).

## The bug

A signed-out visitor opening `https://smithers.sh/smithersai/vibelang/blob/main/README.md` on production `a0a126492c`
saw a full-pane grey skeleton for 11 to 15 s, sometimes past a 30 s probe, with both Home and Code underlined, while
the About, Home, tree, file and refs reads all answered 200.

- The page's load waited for the repository's row from the repositories' Electric shape before it resolved a head
  (`ready`), so no file read started until the shape answered, and a cold shape takes many seconds. The route's warm
  gave up after `pageWait`, but the load it then opened kept waiting.
- With no row and a shape that hadn't answered, the page's header was `unknown`, which showed the skeleton.
- Home's link, `/$owner/$repo`, leads every repository URL, so TanStack Router marked it current beside Code.
- Signed out, the page still ran `branch/track` (`POST /api/branches` → 401) and the engine asked for run credentials
  (`POST /api/runs/<id>/credential` → 401).

## The fix

- A page's head comes from whichever answers first: the device's ready row, or RepoApi's `GET /refs`, which reads the
  row in Postgres directly ([a page's head](../features/repo.md#a-pages-head)). The refs' answer also fills the picker.
  A `404` or a failed read claims nothing and leaves the page to the row.
- The view row keeps the resolved `defaultBranch`; `pageOf` and `shownOf` (`view.ts`) decide what the page shows, and
  `RepoPage` renders them, so a file shows from the view's resolution before Electric delivers the row.
- The tabs mark a link current only at its exact URL.
- `branch/track` and the run credential are skipped when sign-in's row says nobody is signed in.
- Records: `repo.head.load`, `repo.locate` with `source`, `smithers_web_repo_head_load_ms`,
  `smithers_web_repo_locate_ms`, and `auth.run_credential` `outcome: signed_out`.

## Proof

- Production before the fix (`a0a126492c`, a fresh signed-out browser): the README rendered 12.4 s after navigation and
  `examples/react-vite/vite.config.ts` 10.7 s; Home and Code were both current; each page sent two credential
  requests and one `POST /api/branches`, all `401`.
- `src/features/repo/visitor.test.ts` holds the repositories' shape (the faulty shape source) and proves a file shows
  within 5 s once RepoApi answers; it fails on main.
- `src/screens/repo/tabs.test.ts`, the signed-out cases in `src/features/branch/branch.test.ts` and
  `src/flows/credentials.test.ts` fail on main.
- `e2e/vibelang-visitor.spec.ts` "a file opened by its URL" runs against the deployment.

Not covered: the app's own boot before the route runs (about 9 s in the production probe before the About request was
sent) and the cold shape `500`s are separate work.
