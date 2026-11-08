# 0023. Registered actions and slash commands

Status: implemented against published VibeLang 0.0.12, 2026-11-08. Exact receipts are in the lane report.
Rulings: VL-4, VL-7 to VL-14, VL-17, VL-18, VL-21, VL-23, VL-24, VL-29.
Design: [actions](../designs/actions/index.html), including [lead notes](../designs/actions/LEAD-NOTES.md).
The lead deploys. The lane report records exact local checks and the remaining host and coverage boundaries.

## Foundation

An action is a real imported `@smthrs/flow` declaration in `@smthrs/registry`'s portable `Bundled` catalog.
The catalog retains each declaration and its actual schemas; it needs no filesystem and invents no file
provenance or second graph. Executable implementations still belong to the host's ordinary engine registrations.

`@smthrs/engine` now supplies `StepTrace.Sink` at its existing dispatch boundary. Observations carry run id,
flow tag, action name, engine key, attempt, timestamp and lifecycle, never payloads, results or failure messages.
A sink defect or self-interruption cannot change work; caller cancellation still reaches execution. Replay
upserts the same identity. Persisted journals remain authoritative. SDK tests exercise real engines, injected
faulty services, admission/cancellation races, Node/Bun loading and browser bundles.

Library catalog entries used: `@smthrs/flow` (declarations and RunMetrics), `@smthrs/registry` (catalog),
`@smthrs/engine` (memory engine and StepTrace), `@smthrs/platform-cloudflare` (existing SQLite execution host),
`@smthrs/ui-css` (Smithers component CSS). The feature uses a Foldkit view over these packages; no React view
is copied from apps/mvp.

## App contract

The Factory-core Actions Effect service is shared by buttons, slash commands and agent callers.
Starting returns a run id before work finishes. Cards, lists and the trace share one run record. ActionRequested,
ActionStep and ActionSettled go through conversation.vibe's existing numbered decide/apply machine. Terminal
runs ignore late telemetry and competing settlements; step keys and attempts identify replayed steps.

The third run replays the preserved candidate against its recorded base and rebases it with jj. Memory and
SQLite/alarm hosts exercise real registrations; scene, browser, flow, HTTP, CLI and MCP cases exercise the same
service. The report distinguishes current checks from historical receipts and records measured coverage.

## Design precedence and departures

- The lead notes make CI, Triage, Release, Docs sync and Sandbox examples. Offer a command only with its real
  registered flow. Post, Reply, Tour and the existing docs/history flows provide the initial real inventory;
  register the wiki and other lanes' actual flows as they land.
- Decision 0019 requires Contributor for registered actions, with the existing public tour exception. This wins
  over the design's Community threshold. A flow may require Maintainer; it cannot silently weaken the base policy.
  Internal reply, tour-speech, bootstrap and approval flows do not become arbitrary menu commands.
- The host resolves the authenticated role. A request body never supplies one. The same policy filters controls,
  slash discovery and direct dispatch. Agents never approve or merge.
- Omit repository branch/SHA placeholders for actions with no repository context. Show actual actor, state and
  duration. Never invent repository metadata to fill an example row.
- Post needs a message: its runs pane has a labeled input, and `/post <message>` supplies it from the composer.
  This input is absent from the example CI design and is necessary to invoke the real flow.
- Logs show actual engine steps and outcomes, not invented checkout/install/test output. Results remain separate.
- Keep the complete designer artifact verbatim in wiki/designs/actions. Dark-only remains VL-27.

## Effect annotation correction (lead decision, 2026-11-07 00:10 PST)

The lead resolved `actions-schema-json-field` as an Effect 4.1.1 type annotation bug. It does not change VibeLang compilation rules and needs no compiler-policy approval. The initial upstream hold is lifted.

`patches/effect@4.1.1.patch`, registered through pnpm, changes the source and published declaration of `Schema.Json` from `Codec<Json>` to its concrete subtype `JsonValueSchema`. That interface extends `Codec<Json>`, specializes only the decoded/encoded required readonly key flags and `Rebuild`, and preserves every other public view. The existing JSON union type keeps its name. Effect already imports a JSON Schema module as `JsonSchema`, so `JsonValueSchema` also avoids that collision. Runtime code is unchanged. The same correction, a changeset and type/runtime regressions landed on our Effect fork main as `c30802502817062118a6b58904a362b6d2863ace` for upstreaming.

The app compiler regression failed first with EK2109 on unpatched Effect. Positive cases cover required readonly JSON, aliases, annotation/check/rebuild, nested fields, schema errors, fixed tuples and records. Negative cases retain optionalKey/mutableKey and widened-key refusal, tuple/record strict checks, and required-input rejection. This preserves VIP-15 rather than weakening it. Every production workspace package importing Schema is inventoried and typechecked in 67 successful package commands; the coding child is checked by its parent, while root design examples and maintainer historical fixtures are explicitly excluded. Receipts, exits and source paths are in the lane report. Patch removal conditions are in `patches/README.md`: upgrade to a release carrying equivalent precise metadata and pass both regression classes without the patch.

## Third-run compiler decision and published compatibility

The lead's 2026-11-08 03:00 PST decision classifies the service-spread inference defect as a bug fix: a valid
program was wrongly rejected. One upstream correction covers both `actions-service-spread` and
`service-method-spread`. Compiler acceptance/runtime cases cover retrieved implementations and explicit `.Shape`
annotations; missing methods, incompatible results and ordinary class-prototype spreads remain rejected.
The release note and service guide are updated in VibeLang's unreleased section; the fix enters its merge queue.
Publishing the next npm version remains Will's action.

The original 48-file candidate was hash-checked, replayed on exact base
`2347bf8638e1354032cf27b4bbdae41c8884c384`, and rebased with jj. No archived file was overlaid on main.
The three test-only spread wrappers are unnecessary: the existing faulty Factory transport fails a Tour start,
which is the operation a person requests. The cancellation test uses the real Tour's durable wait. Both seams
compile on 0.0.12, preserve all sandbox methods, and retain real engines, state, events and services.
No cast, method-copy decorator or compiler workaround was added. No production action code needs to wait for release.

The local compiler package was linked and tested. Its focused spread cases pass; the full local-head app check
also reports five unrelated EK0401 errors at existing tagged-union/SDK constructors, and TS7023 at an existing recursive sandbox effect.
These diagnostics are retained separately in `~/vl/vibelang-bugs/actions-local-head-throws/` and
`~/vl/vibelang-bugs/actions-local-head-recursion/`; they are not hidden
or counted as a green local-head app check. Main's landing gate uses published 0.0.12.

## Implemented surfaces and boundaries

Buttons, slash commands, scripted agent requests, harness flow bindings, CLI and MCP use the same Actions service.
The catalog contains real core, history and issue declarations. Internal/bootstrap/approval flows remain
inspectable without becoming arbitrary commands. History writes carry their stable execution identity to the
owning history API. Sandbox commands reach the owning Factory's generation and allowance checks.
The new action MCP list wraps its array in an object so MCP's object-root structured output and the CLI manifest
have identical schemas.

The trace opens a failed step first, otherwise its current/parked step, then its last completed step. Step buttons
select that step's actual lifecycle record; the result stays separate. Re-run retains input and changes the selected
run id. Terminal cards reject late snapshots, steps and settlements. Cancelling preserves completed step results.
The action subscription starts only when runs exist, preserving Factory-only embedded clients.

The HTTP boundary bounds both start and rerun bodies to 32,000 bytes, including chunked bodies, and reads for at
most three seconds. Foreign browser Origins are refused. The protocol never accepts a client role. Decision
0019's actual session and grant host now supplies `ActionIdentity`: command discovery, start, rerun and cancel
recheck current policy before cached receipts. Alarm admission checks the stored initiating owner again.
Mock Actions uses the same Factory accounts and Policy service; role events immediately clear stale controls,
and an epoch prevents an old discovery response from restoring them.

A Post's owner is committed atomically with its accepted event. Live agent calls carry that owner through
Cloudflare's server-only entrypoint props, with fresh grant checks; no cookie or secret enters execution storage.
The mock agent refuses to borrow a subsequently selected identity. History callbacks refresh current grants;
sandbox actions forward to the existing account gateway. Reply children can be cancelled under the parent Post
permission without making the internal Reply declaration directly runnable. Repeated ids must have the same
request, and a queued request interrupted before engine admission rearms on retry.

Conversation action contracts are proved with fresh Dafny generation and executable mutations. Behavioral scene,
API, flow, MCP, browser and workerd tests supplement those contracts. Feedback fuzzing exercises real role-gated
requests, traces, reruns and cancellation; the benchmark checks 50 real memory-engine request/trace/cancel cycles.
These are measured feature cases, not whole-app 100% coverage or proof of HTTP, SQL, the DOM or Cloudflare.

## Dependencies and evidence

No new app dependency. The app's existing Node types and DOM test tool are aligned to the monorepo's 26.4.1
and20.13.2 to share the Vitest runner with @effect/vitest; decision0008 records the registration regression.
The two SDK packages include vibelang-runtime0.0.12, already used by the app, for their
new VibeLang source. The engine's browser proof adds the monorepo's vibelang-unplugin0.0.12 as a build/test tool;
0008 lists it as awaiting Will's VL-5 approval.

Both SDK suites report 100% statements, branches, functions and lines. Retained JSON receipts name Bundled.vibe
and StepTrace.vibe explicitly. The initial suspicion of coverage omission was unproven: Vitest's agent-facing
text report hides fully covered files. Explicit source globs make the measured language scope clear.

**VL-31 cancellation regression.** Ending a registered tutorial could wake its alarm and record Passed before the Cancel receipt. The tour cancellation path now records its terminal cancellation before canceling/waking the execution; the one machine prevents the alarm from overwriting it. The real workerd regression first observed Passed, then requires Cancelled and its retained steps. Normal Learn more still ends through EndTour without canceling its conversation object.
