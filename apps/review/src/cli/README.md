# cli/

The `smithers-review` bin's implementation. `../../bin/smithers-review.mjs` is
the entry point and `main.ts` starts nothing on import, so a test imports its
exported helpers (`buildRunSummaryLine`) without running a
review.

The command is split in two on purpose. `main.ts` is the light half: parsing,
the usage text, and the version, with no import of the flow. `runReview.ts` is
the heavy half, reached through a dynamic import once a run is actually going to
happen. Loading the flow, the engine, and the walkthrough renderer costs about
nine seconds of module loading, and `--help` must not pay it;
`tests/cli/main.test.ts` pins that.

- `parseReviewArgs.ts` — flag parsing with mutually exclusive review targets
  (`--commit` / `--from`+`--to` / `--pr`).
- `createProgressReporter.ts` — live stderr progress fed by the
  `@smthrs/agent/EventSink` seam, which hands a host every `AgentEvent` on its
  way past. 0.x polled the engine's output tables for this.
- `whichBinary.ts` — `PATH` lookup for the `gh` binary. 0.x called `Bun.which`,
  which tied the command to one runtime.
- `publishWalkthrough.ts` — uploads the walkthrough HTML to the share service;
  config from `SMITHERS_REVIEW_PUBLISH_URL`/`_TOKEN` env vars or
  `~/.smithers-review.json`. One 60s deadline covers the request and the
  response-body read, so a share service that stalls mid-body cannot hold the
  PR post behind it.

Behaviors worth knowing:

- `--pr` derives `--from`/`--to` from the PR base and uses the PR title/body
  as review background.
- Publishing and the summary file are best-effort: their failures never fail
  the review, and a stalled publish times out rather than blocking the PR post.
- A failed review never posts a "0 findings" PR review.
- The PR review is posted before earlier smithers reviews are marked
  superseded, so a failed post leaves the previous reviews intact.
