# Repository coding workflow

The private configured coding host composes the existing native Control host, executable catalog, agent actions, QuickJS sandbox, Plue JJ adapter and immutable command checks. Node and Bun use the same Effect composition with their own platform adapters.

## Configuration

`flows/coding/serve.ts` loads the explicitly selected project configuration and landing configuration before constructing the host. Provider authentication comes from the workspace configuration. The host keeps mutable run state outside the source working copy.

## Entry points and checks

The repository catalog registers `coding/request` and `coding/vibe`. The former accepts a coding request; the latter finalizes a validated request. Check targets are declared in `flows/PACKAGE.ts`, including policy, runtime, native, native-bun, bundle and bundle-bun checks. A declaration is not evidence that a check or landing completed.
