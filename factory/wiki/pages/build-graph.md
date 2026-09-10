# Dependency-bound build targets

`PACKAGE.ts` declares repository targets using `@smthrs/targets`; `.smithers/WORKSPACE.ts` declares shared toolchain and host configuration. A target's input files and dependency edges participate in its key. A documentation generator needs those code dependencies just as a compiler does.

## Declare exact wiki inputs

The catalog's page helper accepts an owning Markdown path and source inputs. Its `sourceFiles` definition unions those paths across the configured pages. `flows/wiki/PACKAGE.ts` imports that list and turns it into explicit repository-root file inputs, alongside the generator's own dependencies.

This matters across package boundaries. File globs are package scoped. A named `Filegroup` is the reusable way to carry another package's set of files into a consumer; explicit file inputs are appropriate for this small curated recipe.

## Distinguish generation and verification

The wiki's preview build performs deterministic source capture and rendering. It carries an unreviewed status. The verified run calls a model-backed semantic reviewer for every section of every page and refuses verified success if any section remains unsupported or uncertain.

A source digest proves which bytes were read. It cannot prove that prose accurately explains those bytes. The review gate is therefore a separate operation with its own source-bound receipt, and the writer rechecks inputs after the review.

## Understand the portability boundary

The workspace currently declares a Node toolchain for repository targets and separately declares Bun. Selecting Node for the build command is a repository policy; it is not a reason for a reusable flow to import Node filesystem or SQL APIs. The generation actions depend on Effect services, and the executable selects the Node or Bun runtime composition.

## Give coding checks real graph inputs

The private coding gate recipe declares source-only Filegroups with each owning package directory. The CLI honors explicit Filegroup cwd consistently in planning, target indexing and affected-file matching; the default remains the declaring package. Package-scoped glob and escape checks remain in force. The coding inventory also depends on the workspace membership manifest and package export maps, so another package's source change cannot hide behind a stale partial glob.

Fast policy targets, slower runtime/native targets and bundle acceptance are distinct existing targets. Native launchers refuse missing Plue/JJ helpers before opt-in fixtures could skip; they invoke the selected Node or Bun runtime and run fixtures sequentially. A per-fixture timeout is not the enclosing target's total timeout. See the owning coding testing guide for exact labels and limits; declaring those targets is not a receipt that they passed.
