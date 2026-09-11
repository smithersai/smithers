# Electrobun review and fixes — 2026-09-04

The review covered the native Bun host, renderer and durable state, flow and
agent execution, shared RPC contracts, Worker endpoints, authentication,
repository and target operations, code intelligence, terminals, and packaging.
Findings were reproduced where practical, fixed in source, and checked with
regressions and browser/native integration tests.

This workspace already contained substantial work from other sessions. This
report identifies the changes made for this review; the complete working-tree
diff also contains unrelated changes. No release, deployment, or commit was
performed by this review.

## Durable data and frame history

| Finding | Fix and reason |
| --- | --- |
| The native server chose a new port each launch. Browser storage is scoped to scheme, host **and port**, making saved state disappear after restart. | Persist the first loopback port with an atomic, private file. Subsequent launches use that port; an occupied or corrupt saved origin fails explicitly instead of silently opening an empty store. |
| TanStack local-storage collections changed query metadata when optimistic writes were acknowledged. Real browser queries failed with “Query contributors with same row key are not congruent,” leaving chat unusable. | Use locally authoritative collections and a dedicated durable adapter. Acknowledging a local write no longer changes its authority metadata. |
| Collection acknowledgement happened before storage committed. Failed writes left cached state that a later successful write could resurrect. | Build durable writes from committed rows, await storage before acknowledgement, and roll back failed optimistic transactions. |
| Overlapping dispatches could share a nested storage batch; the first promise resolved before its bytes were committed. | Serialize each transaction through one coordinator and give each dispatch its own durable commit. |
| A rejection handler could dispatch using another failed transaction's still-visible optimistic state. | Check original row values against committed rows as well as invalidating queued transactions after failure. A fresh retry after rollback is allowed. |
| A failed SQLite delta could be followed by later deltas derived from the missing state. | Stop the queue after the first rollback. Close the database even when flushing fails. |
| Failure to remove a write-ahead marker after a successful live write incorrectly reported the whole write as failed. | Treat the live write as the commit point; recover leftover markers on the next open. |
| Earlier SQLite and localStorage layouts were no longer imported, risking apparently empty upgrades. | Restore schema-validated migration for historical key/value and collection layouts. Import and mark completion atomically, quarantine invalid rows, retain originals, and let current data win. |
| Schema stamping could overwrite evidence of an incompatible or unsuccessful upgrade. | Stamp only after a validated open commits. Protect future versions and malformed stamps/envelopes without changing their bytes. |
| Frame forks changed navigation pointers but did not restore independent historical application state. | Record revision snapshots for historical frames and branches, including messages, cards, world documents, editor selection, and draft. Save the outgoing branch and restore the incoming branch through the shared dispatcher. |
| Clearing one conversation could remove another branch's frames; forgetting an account could leave archived state. | Scope clearing to the active branch and remove archived snapshots when forgetting the account. Frame validation also understands archived cards, and branch changes refuse during an active response. |

```text
User / agent / system
          |
          v
    shared dispatch
          |
          v
  optimistic projection ----> UI
          |
          v
 serialized durable commit
     |                 |
   success           failure
     |                 |
 acknowledge       roll back
                   reject stale dependents

Saved frame at revision R
          |
          +---- original branch --> later work A
          |
          +---- fork from R ----> independent work B
```

Implementation: [NativeOrigin.ts](../src/bun/NativeOrigin.ts),
[DurableCollection.ts](../src/mainview/chain/DurableCollection.ts),
[SqliteRowStorage.ts](../src/mainview/chain/SqliteRowStorage.ts),
[TransactionalStorage.ts](../src/mainview/chain/TransactionalStorage.ts),
[SchemaVersion.ts](../src/mainview/chain/SchemaVersion.ts),
[AppStore.ts](../src/mainview/state/AppStore.ts),
[frames.ts](../src/mainview/state/controller/frames.ts).
The storage format and migration rules are documented in [persistence.md](persistence.md).

## Sign-in, remote reads, and attribution

| Finding | Fix and reason |
| --- | --- |
| Native Cloud login expected a POST callback, while the actual API redirects the browser to a token-bearing URL fragment. | Add the browser bridge required by the real protocol. Remove the fragment from the address bar before forwarding credentials to the native host. |
| A browser callback needed to be bound to the login attempt; origin or Fetch Metadata checks alone do not prove which login produced a redirect. | Generate a 256-bit `callback_state` per attempt. The API binds it to its OAuth verifier cookie and echoes it in the fragment. Native completion verifies state and the bridge nonce before claiming the attempt. Wrong, absent, old, oversized, and replayed callbacks are rejected. |
| The API's default CLI scopes omit capabilities required by the desktop app. | Request the eight documented app scopes explicitly, without adding organization/user write or administrative scopes. |
| A late callback or keychain write could restore a session after logout. | Fence sign-in generations and serialize credential writes. Expired cached credentials are invalidated and restored sessions re-probe granted scopes. |
| Linear sign-in opened a system-browser URL protected by a renderer-only header, returning 401. | Use a short-lived, one-use navigation handoff and strip that capability before forwarding upstream. |
| Checking DNS and then fetching a hostname permitted DNS rebinding between validation and connection. | Native HTTPS connects to the validated address while preserving the original Host, TLS SNI, and certificate checks. |
| Worker fetch cannot provide the same arbitrary-address pinning guarantee. | Advertise `browser.read` only when an explicitly trusted `BROWSER_EGRESS` service binding exists. Without it, omit the capability and return a typed unavailable response. |
| Remote-read timeouts did not cover every stage, and body/redirect failures could escape the intended limits. | Apply one deadline across DNS, redirects, response headers, and body reads; cap bodies, reject URL credentials/private destinations, and normalize streaming errors. Native compressed responses are decoded within the bounded read path. |
| Renderer-supplied run IDs could be reused as billing identifiers across invocations. | Allocate a server-owned UUID for each invocation. Preserve renderer correlation and cancellation IDs separately, and map approval IDs only through the matching private invocation. |
| Cloud polling could continue indefinitely while requests failed. | Enforce the overall deadline independently of successful polling. |
| A new UTF-8 decoder per terminal frame corrupted characters split across frames. | Keep a streaming decoder for each terminal connection. |

```text
Desktop starts login + random state
                |
                v
      API OAuth attempt + verifier
                |
                v
 Browser callback: credentials + state
                |
       state matches this attempt?
           /                 \
         yes                  no
          |                    |
   complete once             reject

Remote URL --> resolve/check --> pin public address --> TLS --> bounded body
                                     |
                             original hostname remains
                             the certificate identity
```

Implementation: [CloudAuth.ts](../src/bun/CloudAuth.ts),
[LinearAuth.ts](../src/bun/LinearAuth.ts),
[native BrowserFetch.ts](../src/bun/BrowserFetch.ts),
[shared BrowserFetch.ts](../../../packages/rpc/src/BrowserFetch.ts),
[Worker index.ts](../../server/src/index.ts),
[CloudAgent.ts](../src/bun/CloudAgent.ts),
[CloudSeam.ts](../src/mainview/state/seams/CloudSeam.ts),
[CloudTerminalClient.ts](../src/mainview/state/CloudTerminalClient.ts).

The necessary API counterpart is in the adjacent `plue` checkout:
`internal/routes/auth.go`, `internal/routes/auth_native_callback_test.go`,
`scripts/generate-openapi.ts`, both generated OpenAPI files, and
`docs/specs/engineering.md`. Legacy CLI callers without state remain supported.
**Deploy the API support before releasing the new native client.** The new
native client deliberately refuses an old API response without callback state.

The Worker binding contract and validation requirements are documented in
[browser-egress.md](../../server/docs/browser-egress.md). No binding was deployed.

## Flows, forms, repository identity, and agent execution

| Finding | Fix and reason |
| --- | --- |
| Agent delegation could launch a harness without the required human confirmation. | Route it through the shared confirmation flow; pending tool results accurately say a form or confirmation was rendered. |
| A mutable global actor could change while an asynchronous flow was running. | Bind user/agent identity to the invocation across awaits, while preserving shared subscriptions, epochs, and watchers. Background diagnostics use the system actor. |
| Same-name repositories and multiple working copies could cause a file/code action to target the wrong checkout. | Carry the exact local repository ID through cards, RPC payloads, and follow-up actions. Refuse ambiguous name-only selection. |
| A delayed harness launch could use a repository selected after the launch began. | Capture and retain the intended repository at invocation time. |
| Native picking advertised a connected repository before the host finished opening it; an immediate command failed, and a refused open could leave a connected entry. | Publish the connector only after successful host adoption. Preserve the actual refusal on failure. The native test also waits for the selected sidebar row. |
| Form submission allowed duplicate execution or edits while work was pending. | Set submitting state synchronously and disable edit/dismiss/resubmit until settlement. Recover interrupted submissions on boot with explicit retry guidance. |
| Clearing an optional prefilled value restored it from the original arguments. | Preserve explicit clearing in the derived submission payload. |
| The menu that opened a form could leave its backdrop covering the form. | Close initiating human menus through shared transitions when rendering the form. Agent-rendered forms do not dismiss unrelated human menus. |
| File paths with spaces, quotes, backslashes, or Unicode broke between slash, button, and form entry. | Use a shared argument parser/formatter with round-trip tests. |
| Tool JSON that was null, an array, or a primitive, and unexpected executor exceptions could terminate the tool loop. | Validate argument objects and return recoverable tool errors. Harden run-claim parsing against null input. |
| Workspace file tools told the model only that a card existed. | Return bounded contents or directory names, including binary/truncation information, so the model can answer the actual question. |
| Flow listing did not reliably respect an explicitly selected repository. | Resolve explicit context first, then the active repository. |

```text
Slash --------+
Button -------+--> one flow --> fixed actor + exact working copy
Agent --------+        |
                       +--> missing input --> form
                       +--> consequential agent act --> confirmation
                       +--> execute once --> embedded result
```

Implementation: [Flows.ts](../src/mainview/flows/Flows.ts),
[ActorBindings.ts](../src/mainview/state/ActorBindings.ts),
[forms.ts](../src/mainview/state/controller/forms.ts),
[FileArgs.ts](../src/mainview/flows/FileArgs.ts),
[turns.ts](../src/mainview/state/controller/turns.ts),
[WorkspaceSeam.ts](../src/mainview/state/seams/WorkspaceSeam.ts).

## Native lifecycle, target tooling, build, and diagnostics

| Finding | Fix and reason |
| --- | --- |
| Duplicate active chat IDs could replace response ownership and orphan a stream. | Reject duplicates before acquiring writer ownership. |
| Concurrent custom-agent edits could lose one another's updates. | Serialize agent-store mutations. |
| Starting a new target run could precede reading existing journals. | Load prior history first while retaining initialization-time events. |
| Piped CLI execution silently selected agent output, which omitted successful target progress when a pattern run failed. The app consequently showed one failed row and incorrect totals for a four-target run. | Explicitly request the CLI's human/plain progress policy for target execution. Standard input remains closed, so this does not enable prompts. The parser receives all outcomes and the final counts regardless of inherited agent/CI environment markers. |
| Stale language-server publications could acquire the current file digest and look fresh. | Track document versions and reject outdated diagnostics on both local and cloud paths. |
| An idle language server was removed from ownership before shutdown completed. | Retain it until exit, deduplicate retirement, and make replacement/kill-all await it. |
| Normal cold TypeScript project loading could exceed the steady five-second query limit. | Give initialization and the first project-load window separate bounded 15-second allowances. After the first successful positioned query, retain the five-second steady limit. |
| Native quit could terminate before server, PTY, and language-server cleanup finished. | Veto the initial Electrobun quit event, await cleanup, then finish quitting. |
| Harness detection advertised Cerebras credentials that child processes never received. | Include the already-recognized credential variable in the intended harness environment allowlist. |
| CI preview imported repository declarations without the existing read-only loader sandbox. | Run the import in that sandbox with writable scratch only. A real macOS regression proves an absolute write to the original checkout is denied. |
| The Tailwind 4 build used the previous PostCSS integration; font URLs broke when CSS imports were flattened. | Install/configure `@tailwindcss/postcss`, use the v4 CSS entry/config, and import fonts from the renderer entry so assets resolve correctly. |
| Marking startup complete removed later error monitoring. | Stop the startup deadline while keeping runtime error and unhandled-rejection reporting active until explicit disposal. |

Implementation: [server.ts](../src/bun/server.ts),
[agents.ts](../src/bun/routes/agents.ts),
[TargetRunHistory.ts](../src/bun/TargetRunHistory.ts),
[LspSession.ts](../src/bun/lsp/LspSession.ts),
[LspHost.ts](../src/bun/lsp/LspHost.ts),
[NativeShutdown.ts](../src/bun/NativeShutdown.ts),
[CiMatrix.ts](../src/bun/CiMatrix.ts),
[StartupWatchdog.ts](../src/mainview/StartupWatchdog.ts).

## Verification

- Production renderer build and full UI TypeScript check pass.
- Renderer tests: **1,635 tests across 149 isolated files pass**. Isolation avoids
  shared browser globals and module mocks contaminating unrelated Bun suites.
- Focused durable-storage, migration, frame, and rollback checks: **77 pass**.
- Worker tests: **193 pass**; shared RPC tests: **168 pass**; both TypeScript checks pass.
- Cloud client and timeout checks: **53 pass**.
- Final real language-server and lifecycle checks: **35 pass**, including the
  bounded cold-start/steady-state regression.
- Final native-picking, working-copy, and actor/form regression checks: **11 pass**.
- Target invocation and output-parser checks: **20 pass**, with the real failed
  pattern run additionally checked through the browser.
- Native authentication and real Chromium callback checks: **26 pass**.
  The adjacent API's auth tests pass; generated OpenAPI tests: **8 pass**.
- Native tests separately covered the real PTY, DNS-pinned TLS, CI sandbox,
  history, agent store, shutdown, and HTTP/WebSocket boundaries.
- Browser: **38 non-live scenarios passed across the review runs**. This covers
  agent creation, boot, changes, chat, workspaces, code intelligence, frame
  navigation, installed harnesses, repository identity, targets, flow runs,
  Linear/import, tabs, graph history/replay/affected/CI, and real terminals.
  The final five affected browser checks passed together. The live model-turn
  scenario was intentionally skipped in the deterministic stub configuration.
  After changing the CLI progress policy, the successful target-run and complete
  real graph/replay scenarios were rerun together and both passed.
- Packaged desktop: the final stable macOS build, disk-image installation,
  **12 bridge/fixture contract tests**, and **all five native scenarios pass**.
  The scenarios exercise authenticated startup, chat/write-failure recovery
  and relaunch persistence, cancelled/invalid/recovered native folder picks,
  a real GitHub fixture target with restored pins and repository access after
  relaunch, and a real PTY's output and deletion.
  The complete driver exited successfully after its postflight fixture/process
  audit and removal of the temporary package project.

Regression coverage also corrects stale test assumptions: repository opening is
intentionally silent, so tests explicitly request a target list or another card.
Tests wait for repository adoption, asynchronous token coloring, and terminal
run status rather than fixed sleeps. Both the target table and real graph tests
use temporary checked-in fixtures instead of relying on mutable personal
checkouts; the graph test no longer deletes fixed scratch paths in one.
The packaged restart test also verifies the host's current remembered-directory
contract: the approved repository and its access return without another picker.

## Remaining verification and rollout limits

- These are local source changes. Neither the API nor Worker nor desktop app was deployed.
- Production OAuth with a real account and a paid model turn were not exercised.
  Callback security was tested with a real browser and controlled API/provider fixtures.
- Previously saved data under old randomly chosen origins is not automatically
  discoverable from a new browser origin. The stable-origin fix prevents future
  fragmentation; it does not claim to recover every historical browser origin.
- If a prior broken release already created an authoritative current storage
  envelope while leaving older keys behind, migration deliberately does not
  resurrect possibly deleted rows. The retained originals permit manual recovery.
- A complete source review and these tests cannot establish absence of every
  possible defect, nor substitute for live deployment validation.

Detailed run logs are retained at
`/tmp/smithers-electrobun-review-20260904/`. The browser evidence is split across
`verified-browser.log` (16 passes before dependency replacement interrupted it),
`verified-browser-rest.log` (17 further passes), and
`verified-browser-last.log` (the five repaired cases, all passing).
`verified-target-browser.log` records the two further target/graph passes. Earlier
failing logs are retained as reproduction evidence rather than overwritten by
an unsupported claim that the initial full run passed. Another active session
reinstalled the shared workspace dependencies during validation; missing-module
failures from that interruption were followed by dependency repair and reruns.
`final-packaged-restoration.log` records the successful final package and native
suite; `final-typecheck-restoration.log` records the final UI TypeScript check.
