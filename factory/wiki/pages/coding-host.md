# Configured coding host

`host.ts` is this repository's private deployment recipe. It composes the existing native Control host, executable catalog, `AgentAction`, QuickJS sandbox, packaged JJ helper and immutable command checks; it is not a public coding service, database or second executor.

## One composition on Node and Bun

The same Effect composition runs on Node and Bun, with concrete adapters for filesystem, subprocess containment, crypto, SQLite, model transport and HTTP. No Node sidecar is required on Bun.

## Operator configuration

The host reads `<root>/.smithers/coding-project.json` by default, and `SMITHERS_CODING_PROJECT` overrides that path. It registers `coding/verify`, and registers `coding/wiki` when the project enables its wiki. The `coding/implement` role maps to a seat alias or an explicit `provider:model`; the deployment entry requires `SMITHERS_CODING_IMPLEMENT_MODEL` and `SMITHERS_GATEWAY_ID`. Startup requires a credential or an explicitly supplied approval authority even on loopback.

Host databases live outside the `--root` working copy, by default in `<parent of root>/.smithers-coding-state/<basename of root>`. A state directory inside `--root` is refused at startup unless `SMITHERS_CODING_STATE_IN_ROOT=1` opts back in.

## Authority stays with the approved root

Every native handler traverses recorded parent edges to its one active, approved Control root and receives that root's approved capability envelope. Planning, prototype and wiki review models use the evidence-only authority recipe. The configured wiki output must resolve outside the canonical source workspace.

## Review policy identity

When Wiki is enabled, the reviewer policy, selected wiki model and gateway identity participate in review reuse identity. The host's own contribution is a digest of exactly the wiki review policy sources: the deployment bundler injects it, and source mode reads those files beside the module. Nothing else in the host build is covered, so a host deploy that leaves the review task alone keeps prior reviews reusable.

Only `coding/WikiCheck` descriptors receive a derived policy identity; source-authored policy metadata cannot override the host.

## Deployment artifact

`flows/coding/build.mjs` emits one executable ESM file. The Node shebang selects the default runtime, and running it with Bun uses the Bun adapters. It is installed as `/usr/local/bin/smithers-coding-host`, and `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` must name the packaged JJ helper by absolute path. The host catalog is pinned for its process lifetime, so a changed executable definition requires a restart.
