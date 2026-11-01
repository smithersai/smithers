# Contributing to VibeLang

Small fixes, clear bug reports, and examples that teach one thing are welcome.

## Set up

From a language-source checkout, with Go, Bun, and Node on your path:

```sh
sh scripts/setup.sh
```

The source documents Go 1.26 with automatic Go 1.27 download, Bun 1.4.1, and Node 26.10 as its tested toolchain. The compiler's Go module requires Go 1.27.

Setup builds the native compiler, packs the runtime, builds the editor VSIX, and installs a local Bun starter under `~/.bun-create/vibelang`. It can link the compiler into `~/.local/bin` when that directory is on your path. Projects made from the local starter depend on this checkout. Keep it available and rerun setup after compiler or runtime changes.

## Find your way around

| Path | Responsibility |
| --- | --- |
| `typescript/tsc/` | Go compiler fork, checker, lowering, and language server |
| `typescript/vibelang/` | Language cases and smoke checks |
| `packages/runtime/` | Runtime and continuation kernel |
| `packages/compiler/` | Compiler launcher and npm packaging |
| `packages/create-vibelang/`, `templates/app/` | Starter generator and starter project |
| `packages/vite/`, `packages/unplugin/` | Build-tool integration |
| `packages/ts-mapper/` | TypeScript mapping utilities |
| `editors/` | Editor extension and LSP configurations |
| `examples/` | Runnable language examples |
| `docs/user/`, `docs/design/` | User guides, specification, and language decisions |
| `scripts/release/` | Package assembly, rehearsal, publishing, and verification |
| `prototype/`, `experiments/` | Earlier compilers and language experiments |

## Test your change

The full local starter check builds the toolchain, creates a temporary app, installs dependencies, builds, runs it, and tests it:

```sh
sh scripts/e2e.sh
```

It isolates the starter and launcher directories. It still builds inside your checkout. Run it before submitting changes to installation, compilation, the runtime, or the starter.

Compiler package tests also run directly:

```sh
cd packages/compiler
node --test test/*.test.mjs
```

For compiler semantics, add a case alongside related cases in `typescript/vibelang/`. For editor, runtime, or integration changes, use that package's test script and document what you ran. A passing starter check does not establish that every language feature works. Include failed and unavailable checks in your PR.

## Make a pull request

1. Pick one bug or TODO. Search existing issues and PRs first. For language design changes, discuss the intended behavior before implementation.
2. Keep the change focused. Add a regression test that fails without the fix, and update affected examples, diagnostics, and docs.
3. Open a draft PR early if feedback would help. Link its issue or describe the TODO, explain the behavior before and after, and include exact validation results.
4. Address review feedback. A person reviews and merges the finished change. Agents may propose code and run checks; they do not approve or merge.

## Code style and review

Follow the surrounding code and each package's existing configuration. Format Go changes with gofmt. Keep TypeScript and VibeLang examples consistent with nearby files. Do not reformat unrelated code or edit generated output instead of its source.

Reviewers should be able to reproduce the change. Explain any syntax or API break, failure behavior, compatibility effect, and dependency addition. Tests should assert behavior, including rejected programs and useful diagnostics. Never put credentials or private user content in fixtures or logs.

## A first contribution

Browse [good first issues](https://github.com/smithersai/vibelang/labels/good%20first%20issue) or [documentation work](https://github.com/smithersai/vibelang/labels/documentation). Labels are entry points, not a promise that a task is ready. Ask on the issue before starting a large change. A reduced bug example or a correction to a guide is useful work on its own.

## Ask for help

Open an [issue](https://github.com/smithersai/vibelang/issues) with your goal, operating system, compiler version, smallest reproducer, expected result, actual result, and relevant output. Remove credentials first. Keep suspected vulnerabilities out of public issues; see [security reports](MAINTAINERS.md#security-reports).

## Code of conduct

The compiler fork includes the upstream [Microsoft Open Source Code of Conduct](typescript/CODE_OF_CONDUCT.md). It governs upstream contributions. A VibeLang-wide policy and confidential conduct contact still need to be adopted before this page is published as final community guidance.
