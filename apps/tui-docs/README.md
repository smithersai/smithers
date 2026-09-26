# TUI documentation

A dedicated Astro site. Author pages in `apps/tui/docs/`; this site reads those
files directly. It is separate from the generated package-reference fleet in
`apps/docs/`.

```bash
pnpm --filter @smithers/tui-docs build
pnpm --filter @smithers/tui-docs start
```

Open http://localhost:4388. `dev` runs Astro's editor server; use `start` for the
same-origin sponsored endpoint. The browser can call a CORS-enabled provider
from either server.

## Executable Markdown

A `tui-script` fence names a recording. Write `Type "…"`, `Press Enter`,
`Wait for "…"`, and `Capture "…"` on separate lines. The parser rejects other
instructions. Repeated IDs must have identical scripts.

The recorder launches the real TUI in a private PTY with a fresh two-file
workspace. It uses the checked-in `fix-add.jsonl` model recording, executes the
cells against real files, and requires `node check.mjs` to pass. It captures the
terminal's cells and colors through xterm, renders PNG frames in Chromium, and
encodes a GIF with FFmpeg. Markdown becomes the GIF, a reduced-motion poster,
and an accessible text transcript.

`//apps/tui-docs:recordings` declares the source docs, TUI inputs, workspace
runtime source closure, scripts, and lockfile. `:build` depends on that target.
Both are cached builds. The recorder also verifies content hashes before a
local cache hit and restores missing public artifacts from `.cache/recordings`.
It publishes a receipt only after successful execution and GIF encoding.
Source changes invalidate the record; prose-only changes reuse the same script.

Recording requires Node from `.node-version`, Bun >=1.4, Python 3, FFmpeg,
and Chromium. `SMITHERS_DOCS_BUN`, `FFMPEG`, and `CHROME_BIN` select installed
tools. Linux uses Playwright's installed Chromium; macOS defaults to Chrome.
Model replay makes recording offline. The site itself needs no native TUI or
private service once built.

## Browser host and recovery

The playground runs `Agent.Agent` on `Flow.make` using the production QuickJS
cell sandbox. Its only capabilities are `ls`, `read`, `write`, and `check` over
a bounded virtual volume. `check` evaluates addition in a separate QuickJS
runtime with memory and execution limits. Neither runtime receives DOM,
network, host filesystem, or process access.

The engine is the existing memory engine. Reload durability comes from the
playground host's atomic journal, not from that engine: each completed model
response is persisted before the cell executes; each flow result, file state,
and visible event are committed in one localStorage write. Recovery runs the
same production loop from the original prompt, rehydrates the model responses
and call results, and reconstructs the private execution volume in order.
Previously committed operations do not execute again. Web Locks allow one
writer across tabs. Persistence failure stops progression.

Every checkpoint contains a consistent transcript and files. Branching starts a
new task from those files while retaining the original branch. Storage is capped
at 4 MB; files are capped at 16 × 8 KB. Browser storage eviction or clearing site
data deletes the sandbox. A model request that had no committed response may
be billed again on explicit resume. This is a bounded sandbox guarantee, not a
claim that native shell effects, network changes, or billing can be undone.

## Provider access

Settings accept a base URL, model, and API key. HTTPS and local HTTP providers
are supported; the provider must allow browser CORS. The key stays in tab
memory and is sent only to that provider. Re-enter settings after a reload to
resume a personal-provider run with the same model and endpoint.

The portable Node server offers sponsored access when `OPENROUTER_API_KEY` is
set server-side. It reads the current OpenRouter catalog and chooses the lowest
estimated price among text models with at least 32K context. Free entries sort
first. It forces a 2,048-token output ceiling and rejects oversized requests.
SQLite reserves spend before each call, retains reservations on ambiguous
failure, and caches successful responses. Limits default to $0.50 and 100
calls per UTC day, plus 16 calls per visitor cookie. Missing credentials or
exhausted limits produce a visible, retryable refusal.

Self-hosting variables: `PORT`, `HOST`, `DOCS_ORIGIN`, `DOCS_BUDGET_DB`,
`DOCS_DAILY_DOLLARS`, and `DOCS_DAILY_CALLS`. Use a persistent budget database
shared by requests to the same server. Hosted deployment, keys, domain setup,
and multi-instance routing belong in the private deployment repository.

## Evidence

```bash
pnpm --filter @smithers/tui-docs check
pnpm --filter @smithers/tui-docs test
pnpm --filter @smithers/tui-docs build
pnpm --filter @smithers/tui-docs test:browser
pnpm exec smthrs test '//apps/tui-docs:browserTests'
pnpm exec smthrs lint '//:targetIndex'
```

Browser tests run the production agent with a controlled HTTP provider response.
They start the portable server on an unused port; `DOCS_TEST_URL` selects an
existing server instead.
They cover unresolved transport, editable chat, duplicate submission, cross-tab
exclusion, historical visibility, reload during a model request, branch isolation,
personal credentials, provider refusal, mobile width, and site routes. Unit tests
also interrupt the real agent and recover it without duplicate completed calls.
These are offline correctness tests, not evidence of a live OpenRouter model's
quality or a hosted deployment. Release tracking: issue #1774.

The existing Cloud `docs` gate runs this site's typecheck and unit tests.
`:browserTests` builds recordings and the site before launching its browser;
that gate needs a runner with the recording toolchain above. It is not covered
by the current unprivileged Cloud image's JavaScript-only docs gate.
