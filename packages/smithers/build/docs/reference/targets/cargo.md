---
title: "CargoLint and CargoTest"
description: "The three Rust gates as declared targets: cargo fmt --check, cargo clippy, and cargo test."
---

The three checks a Rust workspace gates on, `cargo fmt --check`,
`cargo clippy`, and `cargo test`, as declared targets. The flags that make a
check a gate rather than a fixer live in the target implementation, not at the
call site.

```ts
import { Smithers } from "@smthrs/targets"

export const rustToolchain = Smithers.Rust.Pinned({})

const srcs = [
  Smithers.glob("//crates/flows-jj/**/*.rs"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock")
]

// cargo fmt --check
const cargoFmt = Smithers.CargoLint({
  toolchain: rustToolchain,
  check: Smithers.Cargo.Fmt(),
  srcs,
  deps: []
})

// cargo clippy --all-targets --locked -- -D warnings
const cargoClippy = Smithers.CargoLint({
  toolchain: rustToolchain,
  check: Smithers.Cargo.Clippy(),
  srcs,
  deps: []
})

// cargo test --locked
const cargoTest = Smithers.CargoTest({
  toolchain: rustToolchain,
  check: Smithers.Cargo.Test(),
  srcs,
  deps: []
})

export const Package = Smithers.Package({
  targets: { cargoFmt, cargoClippy, cargoTest }
})
```

There are two target types rather than one because a target's participating
verbs are fixed by its type: the planner selects by kind, so one type covering
both verbs would put `cargo fmt` in the graph of `smithers-build test`. `CargoLint`
takes only the lint checks and `CargoTest` only the test check, so the mismatch
is a type error at the call site.

Bazel's `rules_rust` models the same gates as `rustfmt_test`, `rust_clippy`, and
`rust_test`, one rule apiece. The deviation is the check union: all three run
the same executable over the same declared crate sources and differ only in
argv, so the split is one level down.

## Rust.Pinned

`Rust.Pinned({})` declares that the toolchain comes from a checked-in
`rustup` pin. `rustup` reads `rust-toolchain.toml` and installs exactly what it
pins, components and targets included. The pin is an `Input.File`, so its
content digest is key material and a channel change cannot reuse Cargo results
from the previous compiler.

| Name     | Type         | Default                         | Description                                                  |
| -------- | ------------ | ------------------------------- | ------------------------------------------------------------ |
| `pin`    | `Input.File` | `file("//rust-toolchain.toml")` | The file `rustup` reads. Its content digest is key material. |
| `rustup` | `string`     | `"rustup"`                      | The installer executable.                                    |
| `cargo`  | `string`     | `"cargo"`                       | The build-tool executable.                                   |

The declaration is inert data. `Rust.install(toolchain)` renders
`rustup toolchain install`, which is what [GithubCiGen](github-ci-gen.md)
derives its bootstrap step from, and `Rust.cargo(toolchain, args)`
renders the argv these targets run.

## Checks

| Constructor                                             | Renders                                              |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `Cargo.Fmt()`                                           | `cargo fmt --check`                                  |
| `Cargo.Clippy({ allTargets?, locked?, denyWarnings? })` | `cargo clippy --all-targets --locked -- -D warnings` |
| `Cargo.Test({ locked? })`                               | `cargo test --locked`                                |

Every clippy option defaults to `true`, which is the gate form: a declaration
that wants less has to say so. `-D warnings` goes after `--`; passed before it,
cargo reads it as one of its own and rejects it. `Cargo.Fmt()` has no option at
all: a formatter that rewrites the tree is not a gate, and a target that could
be either would make every declaration a question about which one it is.

## Attributes

| Name        | Type                          | Default  | Description                                                    |
| ----------- | ----------------------------- | -------- | -------------------------------------------------------------- |
| `toolchain` | `RustToolchain.RustToolchain` | required | The declared toolchain, including the pin content digest.      |
| `check`     | `LintCheck` / `TestCheck`     | required | Which gate this target runs.                                   |
| `srcs`      | `Array<Input.Declared>`       | required | Crate sources, manifests, and the lockfile.                    |
| `deps`      | `Array<Target.Target>`        | required | Dependency targets.                                            |
| `cwd`       | `string`                      | `"."`    | Where cargo runs. Defaults to the root that owns `Cargo.lock`. |

## Outputs

None. A gate's product is its exit code.

## Channels and status

|          |                                                       |
| -------- | ----------------------------------------------------- |
| Kinds    | `lint` (CargoLint), `test` (CargoTest)                |
| Success  | `Exec.Result`                                         |
| Error    | `Exec.ExecError`                                      |
| Executes | Yes, on a host with the declared toolchain installed. |

## See also

- [ToolBuild](tool-build.md): the escape hatch for a toolchain with no target
  type of its own
- [GithubCiGen](github-ci-gen.md): derives `rustup toolchain install` from the
  same declaration
