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

## Effect annotation correction (lead decision, 2026-11-07 00:10 PST)

The lead resolved `actions-schema-json-field` as an Effect 4.1.1 type annotation bug. It does not change VibeLang compilation rules and needs no compiler-policy approval. The initial upstream hold is lifted.

`patches/effect@4.1.1.patch`, registered through pnpm, changes the source and published declaration of `Schema.Json` from `Codec<Json>` to its concrete subtype `JsonValueSchema`. That interface extends `Codec<Json>`, specializes only the decoded/encoded required readonly key flags and `Rebuild`, and preserves every other public view. The existing JSON union type keeps its name. Effect already imports a JSON Schema module as `JsonSchema`, so `JsonValueSchema` also avoids that collision. Runtime code is unchanged. The same correction, a changeset and type/runtime regressions landed on our Effect fork main as `c30802502817062118a6b58904a362b6d2863ace` for upstreaming.

The app compiler regression failed first with EK2109 on unpatched Effect. Positive cases cover required readonly JSON, aliases, annotation/check/rebuild, nested fields, schema errors, fixed tuples and records. Negative cases retain optionalKey/mutableKey and widened-key refusal, tuple/record strict checks, and required-input rejection. This preserves VIP-15 rather than weakening it. Every workspace package importing Schema is inventoried and typechecked; receipts, exits and source paths are in the lane report. Patch removal conditions are in `patches/README.md`: upgrade to a release carrying equivalent precise metadata and pass both regression classes without the patch.

## Dependencies and evidence

No new app dependency. The two SDK packages include vibelang-runtime0.0.12, already used by the app, for their
new VibeLang source. The engine's browser proof adds the monorepo's vibelang-unplugin0.0.12 as a build/test tool;
0008 lists it as awaiting Will's VL-5 approval.

Both SDK suites report 100% statements, branches, functions and lines. Retained JSON receipts name Bundled.vibe
and StepTrace.vibe explicitly. The initial suspicion of coverage omission was unproven: Vitest's agent-facing
text report hides fully covered files. Explicit source globs make the measured language scope clear.
