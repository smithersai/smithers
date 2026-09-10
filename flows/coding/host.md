# Configured coding host

`host.ts` is this repository's private deployment recipe. It composes the existing native Control host, executable catalog, `AgentAction`, QuickJS sandbox, Plue JJ adapter and immutable command checks. It is not a public coding service, database, gateway extension or second executor.

The same Effect composition runs on Node and Bun. The concrete adapters supply filesystem, path, subprocess containment, crypto, SQLite, model transport and HTTP. No Node sidecar is required on Bun. Runtime-specific imports stay at the executable boundary; repository workflows do not select a runtime.

The `coding/implement` role must map to an explicit `provider:model` through the existing `SeatResolver`. Workspace/user provider configuration supplies authentication. The host neither invents provider defaults nor copies platform seat credentials into the workspace process. Its deployment entry requires `SMITHERS_CODING_IMPLEMENT_MODEL` and the owning `SMITHERS_GATEWAY_ID`; the existing `SMITHERS_API_KEY` authenticates the gateway. These are operator configuration, never fields accepted from a plan.

The private deployment entry passes that same operator credential to the existing
native control composition. This explicitly selects its gateway approval
delegation as well as authenticating HTTP. Programmatic composition can supply
the existing `Application.Config.approvalAuthority` for a narrower policy; it
takes precedence. An omitted credential retains local-only approval. These are
private host options, not new control APIs, and do not change ordinary CLI
`ControlBridge` delegation policy. The native request acceptance exercises
plan, approve, run and steer through real bearer-authenticated HTTP; its local
watch only collects the resulting journal evidence.

The executable accepts the existing command shape:

```sh
smithers-coding-host serve --root /home/developer/workspace --host 0.0.0.0 --port 7331 --listen
```

`--help` and `--version` work before opening the repository or resolving provider credentials. The same `Serve.refuse` policy requires a credential and explicit `--listen` for a non-loopback bind. The Plue service owns its workspace lifetime lock and process scope.

`coding-plan/v1` is advertised only after the configured catalog includes `coding` and `coding/implementation` with their expected native delegates, and Plue's adapter verifies the repository's provisioned native binding. Conflicted JJ state refuses startup. The gateway reports the existing protocol version and workspace hash, plus the owning gateway row ID. The ordinary CLI does not advertise this capability.

Providing the private `planning` operator configuration also enables
[`coding/request`](request.md) and its `coding-request/v1` health capability.
This composes existing verified wiki, memory, first planning, discarded POC,
second planning and correction flows. It returns their recorded `Plan` plus
product outcome through the normal Control operations. The complete POC source
preview remains in its ordinary child result.
The same verified catalog is injected into those action layers before they
register. Planning, prototype and wiki review receive their configured
`planningModel`, `pocModel` and `wikiModel`, each falling back to the explicit
implementation model, through the existing seat resolver. All these model roles
use the evidence-only authority recipe. The required wiki `reviewer` policy,
selected wiki model and gateway identity participate in review reuse identity.
The same identity includes the running host's policy fingerprint. A deployed
bundle embeds a digest of its exact compiled bytes before inserting the digest
declaration. Source mode hashes its own module-relative reviewer, schema,
evidence, assessor, reuse and authority inputs plus dependency pins. It does not
read the target repository to identify the running host. Target source captures
still independently invalidate affected pages, and reused reviews still pass
the current assessor. Source hosts must restart after their recipe changes.

The configured wiki output must resolve outside the canonical source workspace,
including outside `.flows`. Relative operator paths are resolved from the source
root; use a sibling or separate wiki directory. Existing parent symlinks are
resolved before any write, dangling links are refused, and the resulting
canonical path is bound to the host. This prevents generated publication from
being included in a later JJ implementation snapshot. Project JSON and direct
private host composition apply the same check.

Catalog imports need the existing trusted host filesystem to load verified declaration bytes through a temporary sibling module. Deterministic wiki publication and memory verification also use that injected host filesystem for the operator's configured paths, with the owning wiki's canonical source/output and semantic checks. The model receives captured evidence only. Resulting agent registrations use the original guarded context. Immutable checks separately capture the trusted filesystem only for host-owned scratch creation and cleanup; their processes retain the contained, guarded spawner. Agent file tools retain their workspace guards.

Every native handler traverses recorded parent edges to its one active, approved Control root. It receives the existing `AgentAction.Host` with that root's approved capability envelope, along with the shared budget and quota policy. Construction-time services grant no execution authority. The real standard tool catalog is shared with `AgentSession`.

Steering uses `Notifications.make` over the captured Control notification queue. It is addressed to the approved root, including after a cold descendant resume. Drain boundaries combine the native execution ID with the agent's frame boundary, so two descendants cannot accidentally replay each other's drain. Native usage and execution evidence remain in the native journal; Control lifecycle and steering remain in their existing stores.

The default queue delivers a root steer to its first consuming boundary and does not broadcast it. When the operator enables `coding/request`, the private queue decorator routes root Messages to that request's coordinator. Model settings and explicit leaf messages keep their existing behavior. The coordinator receives messages after the POC, before implementation and after correction, then materializes a fresh source-bound plan before another mutation. Each admitted handler binds its verified root source once, avoiding a fresh ancestor walk and disk read on every frame. See [request.md](request.md) and [steering.md](steering.md) for the durable receipts, limits and current final-drain boundary.

The host catalog is pinned for its process lifetime. Deploying a changed executable definition requires restarting the host. A source change after approval explicitly fails the old plan; restarting cannot make that old approval describe the new source. An ordinary host without the configured catalog leaves native module runs parked.

The native acceptance fixture uses a scripted model behind the existing `SeatResolver`, while exercising the actual `AgentAction`, QuickJS cell, guarded write, Plue adapter, immutable checks and durable Control/engine journals. This distinguishes executable evidence from an agent's claimed summary. Both required fast and slow checks must inspect the implemented revision before validation succeeds.

## Deployment artifact

`node flows/coding/build.mjs /path/to/smithers-coding-host` uses the repository's existing esbuild dependency to emit one executable ESM file. It fits Plue's current gzip/base64 single-executable staging path. The Node shebang selects the default runtime; `bun smithers-coding-host ...` uses the Bun adapters in the same artifact. A build-only lazy wrapper keeps the Bun SQLite builtin behind the existing dynamic platform import, preventing an eager Node import of `bun:sqlite`. It changes no SQL or gateway protocol.

QuickJS's existing single-file variant is bundled. SQLite remains the runtime's native builtin, and process containment programs remain their existing embedded source. Plue separately provisions JJ, Python, the owning coding adapter/configuration and `smithers-jj-export`; these are explicit native dependencies, not files hidden inside the JavaScript artifact. Declared repository modules still resolve their own project dependencies as usual. This artifact is private deployment composition, not another published package or runtime primitive.

The configured executable is staged separately from the general Smithers CLI.
Plue's existing `SMITHERS_WORKSPACE_CODING_HOST_BINARY` operator option selects
that artifact; it is installed as `/usr/local/bin/smithers-coding-host`. General
CLI pack setup and interactive commands retain their existing executable.

Engine compensation uses the private `snapshots.ts` configuration of the existing
Jj service. Its opaque preimage is an immutable full commit ID; snapshots never
create or describe another planned JJ change. Privileged snapshot subprocesses
use the existing contained spawner and Control journal process ledger. Standard
agent tools keep their existing guarded spawner and native journal process ledger.

`filesystem.ts` adds native JJ eligibility to the existing guarded standard file
tools. New ignored files, metadata/symlink paths, native snapshot exclusions and
oversized files are refused before final mutation. Existing tracked ignored files
remain editable. Write/Edit/ApplyPatch retain their own parsing and atomic sibling
replacement. A transient Set tracks only exclusive Preserve siblings until final
rename/cleanup; final destinations always receive the native prospective-byte
check. It is not persistent file ownership or memory. As with Preserve itself,
process death can leave an operational sibling; this never makes an ignored user
file an accepted output. Direct streaming/writable handles, recursive mutations,
links and independent permission/timestamp changes are explicitly unsupported in
this coding configuration. Shell commands remain irreversible and are never
advertised as fully compensated file tools. The guard recognizes the provisioned
root and the canonical root returned by the existing guarded filesystem, allowing
Preserve's atomic replacements under OS aliases such as `/var` to `/private/var`.
It never resolves child symlinks independently or relaxes the filesystem boundary.
Native eligibility requests retain the exact provisioned repository path.

The native acceptance test rejects an ignored Write, writes through a `*.tmp`
ignore rule, edits the resulting file, verifies both immutable check tiers, and
asserts one planned JJ atom and matching health identity. Run the same bundle
proof with `node flows/test/coding-host-bundle.mjs` or
`bun flows/test/coding-host-bundle.mjs`, with `PLUE_CODING_ADAPTER_SOURCE` and
`PLUE_JJ_EXPORT_BINARY` pointing to the actual Plue artifacts. It exercises bundled
QuickJS, builtin SQLite and contained processes; `--version` alone is insufficient.
