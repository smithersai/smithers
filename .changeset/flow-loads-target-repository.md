---
"@smthrs/registry": minor
"@smthrs/cli": minor
---

A durable flow can load code from the repository it works on. A module that computes the target of a load (`createRequire(...)`, `import(name)`) was refused before it ran; discovery now records it as `computed` on `Descriptor.ModuleImport`, and a host that provides the new `LoadGuard` service admits the flow and decides each such load when it happens. A file outside the flow source root (`.smithers/flows`) loads, so a codemod flow can use the target repository's TypeScript, linters and bundler configuration. A file under the source root that was not measured is refused with `UnmeasuredLoadError`, which names it, whether it is reached directly, through `..`, or through a symbolic link. A flow directory that is a symbolic link out of the source root is refused. `@smthrs/registry/node/NodeLoadGuard` implements the guard with a `node:module` resolve hook and `smthrs` provides it. A host without a guard, or with its own `Options.load`, keeps the refusal.
