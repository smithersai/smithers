/**
 * Targets for the `flows-jj` crate and the WebAssembly artifact it produces.
 *
 * The Rust gates and the wasm reproducibility gate are declared here, beside the
 * crate that owns them, so `smithers-build lint '//crates/flows-jj:cargoClippy'` is the
 * same command a pipeline runs. The cargo flags that make a check a gate live in
 * the target implementations, not here.
 *
 * The two lanes are addressed by exact label rather than by a recursive pattern
 * on purpose. The cargo gates need only a Rust toolchain; the wasm rebuild needs
 * an uncached one and takes minutes, so it is a separate CI job and a bare
 * `//crates/flows-jj` under the test verb would pull it into both.
 */
import { Smithers } from "@smthrs/targets"

/**
 * The crate sources, the workspace manifest, and the lockfile.
 *
 * The jj fork the crate builds against is a cargo git dependency pinned to one
 * rev, so the lockfile is the whole of its declaration here and a fresh checkout
 * needs nothing beyond `cargo fetch`.
 */
const sources = [
  Smithers.glob("//crates/flows-jj/**/*.rs"),
  Smithers.file("//Cargo.toml"),
  Smithers.file("//Cargo.lock"),
  Smithers.file("//rust-toolchain.toml")
]

/**
 * Refuses any crate source `rustfmt` would rewrite.
 *
 * @since 0.1.0
 * @category lint
 */
const cargoFmt = Smithers.Cargo.Fmt({
  workspace: true,
  data: sources,
  changes: ["crates/flows-jj/**/*.rs"]
})

/**
 * Runs clippy over every target with warnings promoted to errors.
 *
 * @since 0.1.0
 * @category lint
 */
const cargoClippy = Smithers.Cargo.Clippy({
  package: "flows-jj",
  allTargets: true,
  locked: true,
  denyWarnings: true,
  data: sources
})

/**
 * Runs the crate's native test suite against the pinned jj-lib.
 *
 * @since 0.1.0
 * @category test
 */
const cargoTest = Smithers.Cargo.Test({
  package: "flows-jj",
  locked: true,
  data: sources
})

/**
 * Checks the build script's own helpers: path remapping, the host guard, and
 * the reproducibility comparison.
 *
 * @since 0.1.0
 * @category test
 */
const buildScript = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//crates/flows-jj/build-wasm.test.mjs")]),
  srcs: [Smithers.file("//crates/flows-jj/build-wasm.mjs")],
  deps: []
})

/**
 * Rebuilds `flows_jj.wasm` from source and byte-compares it against the
 * committed artifact.
 *
 * The committed module is a reproducibility contract: rebuilding it from source
 * with the pinned toolchain must give the same bytes. `--verify` is what makes
 * that one target — the script rebuilds into a scratch directory, compares, and
 * never overwrites the committed bytes. A scratch `CARGO_TARGET_DIR` keeps the
 * rebuild clean-room and exercises the script's own handling of it.
 *
 * This runner's host triple is part of the contract, so the script refuses to
 * run anywhere but the canonical host rather than report a byte diff.
 *
 * @since 0.1.0
 * @category test
 */
const wasmReproducibility = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//crates/flows-jj/build-wasm.mjs"), ["--verify"]),
  srcs: [...sources, Smithers.file("//packages/smithers/flows/jj/wasm/flows_jj.wasm")],
  deps: [],
  env: { CARGO_TARGET_DIR: "target/wasm-reproducibility" },
  cwd: "."
})

export const Package = Smithers.Package({
  targets: { buildScript, cargoClippy, cargoFmt, cargoTest, wasmReproducibility }
})
