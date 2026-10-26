---
title: GitHub shapes hung signed out (shared read-token permit)
status: done
area: worker
owner: Claude readtoken
updated: 2026-10-25
links: [../decisions/0104-request-owned-worker-io.md, ../rules.md]
---
smithers.sh's ChatApi cancelled 60 to 600 GitHub shape reads an hour as hung since 10-24. A signed-out reader's
visibility check took the App read token through one `Semaphore.make(1)` per isolate (`worker/github/ReadToken.ts`), so
readers waited on another request's mint. Fixed: the isolate keeps only the token and its expiry; a read that finds none
fresh mints for itself. Each mint counts `github_token_mints{kind="read"}` and logs `github.read_token`.

The same fix covers ReadToken's other build sites: RepoAbout's (a Member's About read without the App), RepoUpstream's
in each FlowExecution object. A sweep of everything ChatApi's program builds once found no other isolate-shared state a
request waits on, signed in or out. `worker.request-owned-io` now rejects Semaphore, Latch, Queue, PubSub,
SynchronizedRef, SubscriptionRef and their Tx forms, and a Ref of pending work.

`worker/GitHubShapes.workerd.test.ts` is red on the old permit (7 of 8 signed-out first reads hung; all 8 signed-in
answered) and green after (48 of 48). The About workerd flake under load was the test reading bodies late: Miniflare
re-wraps undici's response body, and undici cancels it when the dropped original is collected. Both workerd tests now
read each body on arrival under `MINIFLARE_ASSERT_BODIES_CONSUMED`.

`github/Api.ts` forked `reconcileIfStale` into the never-closed isolate scope, so its I/O belonged to the forking
request and Reconcile could silently not start. The read now awaits the admission beside its own work, at most 2 seconds,
once per bucket in an isolate, and logs and counts `started`, `timed_out` or `not_started` (the lead's call: no
`waitUntil`, DUR-3).

Catalog entries used: @smthrs/integrations (GitHub AppAuth, GitHubClient), @smthrs/database PostgresDatabase,
@smthrs/effect-electric ShapeProxy, @smthrs/targets NodeTest, Effect Metric and HttpClient. No new dependency.
