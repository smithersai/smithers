# Repository coding workflow

The private configured coding host composes the existing native Control host, executable catalog, agent actions, QuickJS sandbox, packaged JJ helper and immutable command checks. Node and Bun use the same Effect composition with their own platform adapters.

## Configuration

The host reads `.smithers/coding-project.json` from its root, or the path `SMITHERS_CODING_PROJECT` names, once before it is constructed. Cloud relies on this host-side lookup. The host keeps its mutable run state outside the source working copy.

## Entry points

The host registers `coding/request` for a coding request, `coding/vibe` to finalize a validated request when a landing binding is provisioned, and `coding/verify`, which reruns the required checks on one retained commit of the mythical stack. When the project enables its wiki it also registers `coding/wiki`, which stands on one retained stack commit, refreshes the declared wiki pages and answers the verified pages. A registration is not evidence that a request, check or refresh completed.
