---
title: Restore release and documentation CI gates
status: in-progress
area: maintenance
owner: Codex ci-release
updated: 2026-10-29
links: [../rulings.md, ../../../../.smithers/flows/README.md]
---

Reproduce the script gates and repository flow/documentation gates with CI's
commands on Latitude. Repair stale release contracts against the current
workspace and hosted docs architecture without weakening the gates.

Library catalog: `@smthrs/targets` declares the gates; `.smithers/flows` owns
repository release automation. `apps/site` remains the docs build mounted by
`apps/mvp/infra/DocsSite.ts` at `/docs`.

The baseline reproduced eight failing gates. Removed assertions refer to
SCOPE-3's native bridge and backend generators (`82b5490d`) and the retired
global release banner (`c95d756e`). The quickstart deliberately targets the
published rc.16 API (`96628360`), and the classifier fixture must match the
public root import in its guide (`b01bcacd`). Discovery also inventories the
provider load flow added in `bc1b7da8`.

SDK-6 workspace links remain in source manifests; publication and npm consumer
metadata resolve them to registry versions before leaving the workspace. A real
tarball regression covers all four dependency fields. Packing failures retain
the package manager's stdout diagnostic.

Hosted documentation uses the app's configurable domain with scoped docs zone
routes. Its gate evaluates the pure routing helpers with an injected hostname,
permits those scoped routes, and refuses duplicate domains, overlapping routes,
whole-host shadows and unrecognized dynamic claims. The command reference
tracks Guest access for `/new` and `/clone`.

The published rc.16 CLI declaration defect remains recorded by the existing
broken test and `bugbash4-cli-types.md`; no skip or checker workaround was added.

The CLI's views dependency supports Node 22.19 like the CLI itself; its parser
dependencies support that floor, and its full suite passes on that exact Node
release. Observability's API peer range stays below 1.10, matching the installed
SDKs' peer contracts and the strict all-adapter consumer installation.

Fixture inventory comes from jj in a checkout or the real tracked-source receipt
in a source mirror, filtered to the fixture directory. Mirror tests use isolated
temporary projects so unrelated global configuration cannot change discovery.

The release graph already builds every public library. Packing now validates
those completed ESM, declaration and CommonJS outputs without rebuilding each
package a second time. Standalone packing still rebuilds cleanly and refuses
stale outputs when that build fails. A real build-counter regression proves the
duplicate-build defect; evaluated graph assertions retain every library and API
baseline dependency. No timeout or coverage threshold was widened.

Installed-package smoke exposed a second build defect: the CommonJS package
boundary hid the root's package import map. The shared library builder preserves
external imports and rebases source targets to emitted JavaScript and
declarations. Real CommonJS resolution regressions fail on the old builder;
unsupported relative targets fail the build instead of shipping broken links.

Strict installed CLI typechecking then exposed two declaration defects. The
generic sandbox command payload now constructs its Struct explicitly; the same
conditional-type problem reproduces under TypeScript and VibeLang. The CLI's
published declarations require the PostgreSQL driver's types, so the executable
installs both supported SQL drivers at its tested Effect version. Database
library drivers remain optional. The installed CLI MCP consumer typechecks remain
strict for ESM and CommonJS, without `skipLibCheck`.
