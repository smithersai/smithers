# Configuring the workspace coding host

This is private deployment configuration for `smithers-coding-host`, the separate
workspace executable. The ordinary Smithers CLI keeps its existing commands.
The host uses the same Effect composition and durable engine on Node and Bun.

Set `SMITHERS_CODING_PROJECT` to an explicit UTF-8 JSON file to enable the prompt
route's owning implementation and check configuration. There is no filename
discovery. An unset variable leaves the manual plan route available; an empty,
missing, malformed or invalid explicit file refuses startup. The file is read
once before host construction through the injected Effect filesystem. Restart
the host to adopt a changed configuration or catalog.

Both the config filename and optional `wikiOutput` resolve relative to `--root`; absolute
paths are accepted. The output may point at the separate wiki repository. JSON
is limited to 256 KiB of actual streamed bytes. Unknown properties are refused,
including nested page/check properties. Wiki page IDs and check IDs must be
unique; related page IDs must be present. The existing wiki recipe still owns
source path admission, publication and semantic verification.

```json
{
  "wiki": false,
  "implementation": "coding/implementation",
  "checks": [{
    "id": "types",
    "target": "types",
    "flow": "checks/types",
    "tier": "fast",
    "required": true
  }],
  "historyLimit": 100,
  "maxMemoryBytes": 49152
}
```

Wiki is off by default. Source files, existing project documents and resolved
native JJ history provide planning context without generated artifacts. To
enable Wiki, add `"wiki": true`, an external `wikiOutput`, a `reviewer` identity,
and the non-empty `pages` inventory using the Wiki `PageSpec`. Supplied optional
metadata is still validated while the feature is off. This flag leaves native
history, source identity and validation invariants intact. An explicitly required
`checks/wiki` refuses while Wiki is off; update that operator policy deliberately.
Optional generated-Wiki checks are omitted while the feature is off.

The example names must identify real registered implementation/check flows in
that repository. This file does not define shell commands or accept claimed
flow digests; the existing catalog supplies verified execution identities.
`reviewer` identifies the semantic review policy, not a provider credential or
a claim that review already passed. Page entries use the existing wiki
`PageSpec`; check entries use the existing `Check` without `flowDigest`.
`historyLimit` is optional (1–100, default 100). `maxMemoryBytes` is optional
(1024–92160, default 49152). A project with no adequate required checks still
fails the existing planning/validation policy; the loader invents none.

```sh
SMITHERS_CODING_PROJECT=/etc/smithers/project.json \
SMITHERS_CODING_IMPLEMENT_MODEL=provider:implementation-model \
SMITHERS_CODING_PLAN_MODEL=provider:planning-model \
SMITHERS_CODING_POC_MODEL=provider:prototype-model \
SMITHERS_CODING_WIKI_MODEL=provider:review-model \
smithers-coding-host serve --root /home/developer/workspace
```

`SMITHERS_CODING_IMPLEMENT_MODEL` is required. The optional plan, POC and wiki
variables select the existing logical seats `coding/plan`, `coding/poc` and
`wiki/reviewer`. When omitted, the host explicitly uses the implementation model
for that role. Every selection must be a `provider:model`; this configuration
does not add credentials or a broker. Existing workspace/user provider setup
supplies authentication. Deployment still supplies the owning
`SMITHERS_GATEWAY_ID`, gateway `SMITHERS_API_KEY`, and existing binding/single-host
lock. `PATH` remains the explicit environment for declared check executables.

The loader adds no public package API, service, database or gateway payload.
Its private `ProjectConfig` is the existing memory configuration plus the wiki
reviewer identity. Operator data is never accepted from model output or a
gateway request. Startup diagnostics identify the invalid contract without
printing the JSON contents.


For this Smithers repository, generate the opinionated configuration from the
repository-owned target configuration:

```sh
node factory/coding/project.ts ../smithers-wiki > /tmp/smithers-project.json
SMITHERS_CODING_PROJECT=/tmp/smithers-project.json smithers-coding-host serve --root .
```

`factory/coding/project.ts` selects existing PACKAGE targets: codingPolicy blocks
as the policy gate; codingRuntime, native Node/Bun, deployment bundle Node/Bun,
run as required slow checks. Wiki is off in this generated default; calling
`smithersProject(output, true)` includes the public page catalog and required
semantic Wiki check. The ordinary `checks/*`
declarations contain only target invocations, not copied test lists. The host
must provide `smithers-build`, the declared toolchain, native helpers and build
cache through its existing command environment. An immutable source export does
not borrow the editing checkout's node_modules. Cold toolchain/bootstrap cost
may make the blocking target slow; its label is policy, not a latency receipt.
The default config is generated without provider credentials or private Ops data.
