---
title: Restore release and documentation CI gates
status: blocked
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

Native CommonJS builds share the CLI's module metadata shim, so the packaged
sandbox host retains its module URL and locates the ESM guest runner. Ordinary
libraries keep the neutral build; a real browser bundle checks that no Node
imports are introduced there. Native metadata resolution and strict module
semantics cover paths with spaces through both module conditions, even when the
compiler does not emit a strict directive.

The published quickstart's fixed contract (`96628360`) stays outside automatic
version retargeting. A real version bump in an isolated workspace advances the
release and its following documentation, verifies coherence at the new version,
and preserves the published guide byte for byte.

Consumer profiles selecting the Node host now require its runtime and SQLite
driver, relocated together in `8c69f33c`. This includes Bun's shared native
lifecycle and migration apply; migration scan still excludes both dependencies.

The quickstart consumer follows the published contract (`96628360`) through the
normal registry instead of substituting same-version candidate tarballs. Its
explicit Effect pin remains exact, while unpinned guide fixtures still verify
today's latest version. Both cases retain physical-copy, adapter peer and replay
checks.

Thirteen owned gates pass on Latitude. Full smoke builds and checks all 51
libraries, packs successfully and reaches its real npm/pnpm consumer matrix.
The six stale host/guide failures then pass in a focused rerun, including both
published quickstart replays. The remaining latest-Effect profiles install
4.1.0, which the workspace's exact 4.0.5 peers refuse. Their gate is retained;
completion depends on the separately owned `builder/effect-upgrade` cohort.
The required Sol review awaits the brief's all-gates-green precondition.

Touched SDK suites pass: repo-targets 195, views 243 (also on Node 22.19),
observability 239 and sandbox 877, at their configured 100% source coverage.
Sandbox's 23 existing skips and the published declaration TODO remain distinct
from that executed evidence. App typecheck, import rules, module lint and the
generated target index pass. No known-red entry, timeout or threshold changed.
