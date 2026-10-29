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
