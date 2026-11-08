# 0023. Registered actions and slash commands

Status: SDK foundation and Effect annotation correction landed; app candidate held at service-spread inference, 2026-11-08.
Rulings: VL-4, VL-7 to VL-14, VL-17, VL-18, VL-21, VL-23, VL-24, VL-29.
Design: [actions](../designs/actions/index.html), including [lead notes](../designs/actions/LEAD-NOTES.md).
The app feature is not claimed done or deployed. The lane report holds its preview and remaining work.

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

The planned Factory-core Actions Effect service is shared by buttons, slash commands and agent callers.
Starting returns a run id before work finishes. Cards, lists and the trace share one run record. ActionRequested,
ActionStep and ActionSettled go through conversation.vibe's existing numbered decide/apply machine. Terminal
runs ignore late telemetry and competing settlements; step keys and attempts identify replayed steps.

The second-run candidate has real memory-engine and workerd hosts, scene/browser tests, durable run results,
agent tools and shared CLI/MCP commands. Its conversation machine passed 45 Dafny obligations and rejected nine executable mutations in a frozen reconstruction. Fifteen action
browser checks and two SQLite/alarm workerd checks passed before the latest sandbox rebase. These receipts
describe that candidate, not a claim that the feature is verified or shipped. Current account policy integration,
other lanes' flow execution, full regression/coverage/fuzz/benchmark checks and final browser integration remain.

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

## Service-spread hold (second run)

The first-run archive was reconstructed against its recorded base and rebased with jj, retaining later tour,
history, proof and sandbox work. The second-run archive is `~/vl/vl-actions.pending2/`: 48 changed files,
a unified delta, exact base files and SHA-256 manifest. Its base is `2347bf8638e1354032cf27b4bbdae41c8884c384`.
It is unfinished source; reconstruct and rebase the delta instead of overlaying files.

After the sandbox lane extended Factory, the faulty-service wrappers exposed a separate VibeLang0.0.12 issue.
Retrieving a two-method service in an effect and returning `{ ...base, first: replacement }` loses `second` from
the inferred shape. VibeLang exits2; equivalent native Effect/TypeScript and an ordinary-interface spread exit0.
Controls still reject a missing method and a wrongly typed result. The emitted JavaScript retains the spread.
Reproduction, exact command and diagnostics: `~/vl/vibelang-bugs/actions-service-spread/README.md`.

The candidate app's current typecheck exits2 in three fault-injection wrappers. No cast, compiler change or
method-by-method bypass was introduced. Will's standing instruction requires approval before a change to
existing compilation behavior; the earlier lead decision authorizes only the Effect Json annotation correction.
The compiler correction therefore awaits Will before the lane resumes integration. The lane report records
remaining replay, cancellation, policy, trace-selection and validation work without claiming completion.

## Dependencies and evidence

No new app dependency. The app's existing Node types and DOM test tool are aligned to the monorepo's 26.4.1
and20.13.2 to share the Vitest runner with @effect/vitest; decision0008 records the registration regression.
The two SDK packages include vibelang-runtime0.0.12, already used by the app, for their
new VibeLang source. The engine's browser proof adds the monorepo's vibelang-unplugin0.0.12 as a build/test tool;
0008 lists it as awaiting Will's VL-5 approval.

Both SDK suites report 100% statements, branches, functions and lines. Retained JSON receipts name Bundled.vibe
and StepTrace.vibe explicitly. The initial suspicion of coverage omission was unproven: Vitest's agent-facing
text report hides fully covered files. Explicit source globs make the measured language scope clear.
