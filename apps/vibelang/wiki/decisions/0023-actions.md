# 0023. Registered actions and slash commands

Status: SDK foundation implemented; app implementation held at an upstream schema integration gap, 2026-11-07.
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

The pending implementation has memory-engine API tests, scene tests and a preview. Its candidate conversation
machine passed 38 Dafny obligations and rejected five new executable mutations. These receipts describe that
candidate, not a claim that the whole app feature is verified or shipped. Live routes, real account policy,
agent tools, other lanes' flow registration and complete browser/workerd/flow coverage still have to land.

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

## Upstream hold

The live protocol's polymorphic JSON input reaches an integration gap between Effect4.1.1 and VibeLang0.0.12.
Effect's Schema.Json annotation erases concrete readonly/required key flags. VibeLang deliberately refuses
unprovable modifiers under its accepted VIP-15, raising EK2109. A blanket checker relaxation would weaken that
rule. The minimal reproduction and independent source diagnosis are recorded as
`actions-schema-json-field` under the lane's vibelang-bugs directory.

The narrow proposed upstream correction preserves Effect Json's other public views and publishes its actual
key metadata. Will's lane instruction requires bringing changes to how existing VibeLang code compiles or
behaves to him first. Approval is pending. No compiler, dependency patch or alternate-schema workaround has
been applied. The unfinished app source is preserved with the lane report.

## Dependencies and evidence

No new app dependency. The two SDK packages include vibelang-runtime0.0.12, already used by the app, for their
new VibeLang source. The engine's browser proof adds the monorepo's vibelang-unplugin0.0.12 as a build/test tool;
0008 lists it as awaiting Will's VL-5 approval.

Both SDK suites report 100% statements, branches, functions and lines. Retained JSON receipts name Bundled.vibe
and StepTrace.vibe explicitly. The initial suspicion of coverage omission was unproven: Vitest's agent-facing
text report hides fully covered files. Explicit source globs make the measured language scope clear.
