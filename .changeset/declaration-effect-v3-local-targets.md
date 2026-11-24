---
"@smthrs/build-cli": patch
---

A `PACKAGE.ts` in a package that installs another Effect major for its own code now loads when the declaration does not
import `effect` and resolves the CLI's own `@smthrs/targets`. Before, a monorepo with a root `@smthrs/targets` install
and an Effect v3 package (evmts/tevm's `bundler-packages/compiler`) was refused with `declaration_dependency_mismatch`.
A declaration that imports `effect` directly, or a second copy of the same Effect major, is still refused.
