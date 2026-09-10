# @smthrs/review — src

Source for `smithers-review`: a CLI (the package `bin` is `../bin/smithers-review.mjs`)
that reviews a change set with model-backed steps and renders a self-contained
HTML walkthrough, optionally posting the result as a GitHub PR review, plus the
Cloudflare Worker behind review.smithers.sh (sharing, session minting, metered
Anthropic proxy; deployed via `../alchemy.run.ts`).

Directory map:

- `cli/` — arg parsing, live progress, publishing, and the entry point.
- `workflow/` — the four-round review flow, its seats, and finding verification.
- `quiz/` — change-impact assessment and the reviewer comprehension quiz.
- `walkthrough/` — story normalization and the walkthrough HTML renderer.
- `diffs/` — Pierre + fallback diff-to-HTML rendering; the package's only
  export map entry (`smithers-review/diffs`).
- `github/` — PR integration via the `gh` CLI.
- `text/` — small shared text helpers (fences, pluralize, diff trimming).
- `server/` — the Cloudflare Worker (never runs in the CLI process).

Data flow: the flow's success value IS the answer. `Review.execute` resolves to
a `ReviewResult` carrying the target, the review, the story, the quiz, and the
walkthrough, and `cli/main.ts` reads that value directly to print summaries,
publish, and post to GitHub. Run state lives in SQLite (default:
`<repo>/.smithers-review/review.db`), with each review identified by an execution
ID printed at startup and on execution failure. Reusing the database alone
starts a new review. To recover an interrupted review, repeat the original
command with the same review options, database, and execution ID:

```sh
smithers-review /path/to/repo --db /path/to/review.db --execution-id review-recovery
```

An unused ID starts a review; an existing ID resumes it. The durable engine
validates the stored input before joining the execution and rejects changed
review options or repository paths. Once preparation has settled, recovery
uses its recorded diff snapshot even if the working tree changes. Completed
file batches are reused without calling their providers again; an in-flight
call may run again. A completed execution returns its recorded result. Use a
new ID (or omit `--execution-id`) to review the current working tree.
Keep the original seat configuration when recovering unfinished model work.
Publishing and GitHub posting happen after the durable flow and run again
when those options are supplied on recovery.

Tests live in `../tests`, mirroring these directories.
