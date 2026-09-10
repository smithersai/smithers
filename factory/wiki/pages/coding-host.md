# The configured native coding host

The coding host is a private repository recipe over the existing native Control factory, executable catalog, flow runtime, AgentAction, QuickJS, and Plue JJ adapter. Its deployment configuration selects existing services; there is no separate CodingService, ledger, queue or gateway extension. See [native control](native-control.md) for the shared authority and observation boundary.

## Select one portable host

`flows/coding/host.ts` receives a platform and trusted operator options. Node and Bun adapters provide their own SQL, filesystem, subprocess, crypto, HTTP and model transport implementations. The same recipe and durable engine execute on both runtimes; Bun does not launch a Node sidecar. Node's rebuildable Undici transport and Bun's existing fetch transport retain their platform-specific behavior.

The existing `Serve` protocol remains the network boundary. A configured host advertises `coding-plan/v1` only after the expected executable delegates and provisioned native repository binding are available; native conflicts refuse startup. An ordinary CLI does not advertise that capability. Enabling the explicit project planning configuration also installs `coding/request` and advertises `coding-request/v1`.

## Keep operator choices outside the prompt

The separate executable is `smithers-coding-host`. `SMITHERS_CODING_PROJECT` names one bounded JSON configuration file; the loader does not discover a file from repository contents or accept one from a model. It names public wiki inputs, output, reviewer policy, and registered implementation/check flows. The verified catalog supplies the executable digests. The wiki destination must be outside the canonical source workspace. Before publication, its path is resolved and checked again so an ancestor changed during review cannot redirect output into source. An absent option retains the manual plan route; an invalid explicit file refuses startup.

`SMITHERS_CODING_IMPLEMENT_MODEL` explicitly selects a `provider:model`. Optional PLAN, POC and WIKI model variables map the existing logical seats and otherwise use that explicitly selected implementation model. Existing workspace/user provider setup supplies authentication. The owning gateway ID and API key remain deployment credentials, never plan fields. A configured host requires a credential or explicit operator approval authority even on loopback. Restart the host to adopt a changed configuration or pinned catalog.

## Preserve existing authority

Every native module handler is bound to its recorded active approved root. Model tools use the existing guarded filesystem, contained spawner, capability envelope and shared budget. Evidence-only planning, prototype and review actions have an empty tool catalog and capability ceiling. A prompt saying “do not edit” is not the enforcement mechanism.

Deterministic wiki publication, source capture and scratch cleanup retain the existing trusted host filesystem as a service value. That value is not installed over the model tools. Immutable check processes still use the contained, permission-checked spawner. Compensable file tools use immutable native preimages and final-target eligibility; arbitrary shell commands remain irreversible.

## Bind the running reviewer to approval

The private host hashes its actual source reviewer recipe or exact deployed artifact bytes. Reviewer identity includes that host policy, the operator's policy label, selected model and gateway. A target repository does not need to carry the Smithers reviewer implementation.

Only declarations that delegate to `coding/WikiCheck` receive a derived policy identity covering the configured pages and reviewer. A model-written frontmatter value cannot override it. The same Registry layer supplies planning, approval, native module authority and executable loading. Its derived execution digest must match before the original registry verifies the exact original body bytes. Changing host policy invalidates old approval and review reuse; ordinary descriptors keep their identity.

`factory/coding/project.ts` is the repository-specific configuration. It names the existing PACKAGE fast and slow test targets and a required semantic wiki check. Ordinary check declarations call those existing build targets instead of copying their test inventories. The operator supplies the installed build toolchain and explicit environment.

## Inspect the packaged boundary

The private build entry emits one executable ESM artifact using the existing esbuild dependency. Node's shebang is the default; invoking the same artifact with Bun selects the Bun composition. QuickJS is bundled, SQLite is the runtime builtin, and existing process containment helpers retain their embedded source. Plue separately provisions JJ, Python and the native adapter/exporter. General CLI commands keep their existing executable.

Source and bundle acceptance fixtures exercise real QuickJS, native SQLite, JJ writes and immutable checks behind scripted models. Those test definitions describe the exercised contracts; they do not certify a deployment or the quality of live model decisions. Consult the [request lifecycle](coding-request.md) and [checks](coding-checks.md) for domain behavior.
