import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  buildEnvironment,
  canonicalHost,
  foreignHostError,
  remapFlags,
  reproductionFailure,
  rustcCommitHash,
  rustcHost,
  targetDir
} from "./build-wasm.mjs"

const verboseVersion = [
  "rustc 1.89.0 (29483883e 2025-08-04)",
  "binary: rustc",
  "commit-hash: 29483883eed69d5fb4db01964cdf2af4d86e9cb2",
  "commit-date: 2025-08-04",
  "host: aarch64-apple-darwin",
  "release: 1.89.0",
  "LLVM version: 20.1.7"
].join("\n")

// These fixtures stand in for compiler startup failures only. Running a real
// canonical compiler here could launch a full build and overwrite shipped bytes.
const runStartup = (compiler, cargo) => {
  const directory = mkdtempSync(join(tmpdir(), "flows-jj-startup-"))
  try {
    for (const [name, script] of Object.entries({ rustc: compiler, cargo })) {
      if (script !== undefined) {
        const executable = join(directory, name)
        writeFileSync(executable, `#!/bin/sh\n${script}\n`)
        chmodSync(executable, 0o755)
      }
    }
    return spawnSync(process.execPath, [fileURLToPath(new URL("./build-wasm.mjs", import.meta.url)), "--verify"], {
      cwd: directory,
      env: { ...process.env, PATH: directory },
      encoding: "utf8",
      timeout: 10000
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const args of [[], ["--verify"]]) {
  for (const kind of ["directory", "file"]) {
    test((args.length === 0 ? "build" : "verify") + " command runs through a symlinked " + kind, () => {
      const directory = mkdtempSync(join(tmpdir(), "flows jj entrypoint "))
      try {
        const script = fileURLToPath(new URL("./build-wasm.mjs", import.meta.url))
        const link = join(directory, "entrypoint.mjs")
        symlinkSync(kind === "directory" ? dirname(script) : script, link, kind === "directory" ? "dir" : "file")
        const entrypoint = kind === "directory" ? join(link, "build-wasm.mjs") : link
        const result = spawnSync(process.execPath, [entrypoint, ...args], {
          cwd: directory,
          env: { ...process.env, PATH: directory },
          encoding: "utf8",
          timeout: 10000
        })
        assert.equal(result.error, undefined)
        assert.equal(result.status, 1)
        assert.match(result.stderr, /rustc.*not found on PATH/)
        assert.equal(result.stdout, "")
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
}

for (const mode of ["stdin", "eval"]) {
  test("build helpers can be imported from " + mode + " without starting a build", () => {
    const directory = mkdtempSync(join(tmpdir(), "flows-jj-import-"))
    try {
      const script = new URL("./build-wasm.mjs", import.meta.url).href
      const source = "const { canonicalHost } = await import(" + JSON.stringify(script) + "); console.log(canonicalHost)"
      const args = mode === "stdin" ? ["--input-type=module", "-"] : ["--input-type=module", "-e", source]
      const result = spawnSync(process.execPath, args, {
        cwd: directory,
        env: { ...process.env, PATH: directory },
        input: mode === "stdin" ? source : undefined,
        encoding: "utf8",
        timeout: 10000
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, "")
      assert.equal(result.stdout.trim(), canonicalHost)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test("build command reports a missing compiler without attempting a build", () => {
  const result = runStartup(undefined)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /`rustc` not found on PATH/)
  assert.equal(result.stdout, "")
})

test("build command preserves compiler probe failure status and diagnostics", () => {
  const result = runStartup("printf '%s\\n' 'compiler fixture failure' >&2\nexit 7")
  assert.equal(result.error, undefined)
  assert.equal(result.status, 7)
  assert.match(result.stderr, /compiler fixture failure/)
  assert.match(result.stderr, /rustc -vV failed/)
  assert.equal(result.stdout, "")
})

test("build command refuses a noncanonical compiler host before invoking Cargo", () => {
  const result = runStartup("printf '%s\\n' 'host: aarch64-apple-darwin' 'commit-hash: abc123'")
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /this host is aarch64-apple-darwin/)
  assert.match(result.stderr, /docker run/)
  assert.doesNotMatch(result.stderr, /`cargo` not found/)
  assert.equal(result.stdout, "")
})

const canonicalVersionProbe = [
  'if [ "$1" = "-vV" ]; then',
  `  printf '%s\\n' 'host: ${canonicalHost}' 'commit-hash: abc123'`,
  "  exit 0",
  "fi"
].join("\n")
const canonicalCompiler = `${canonicalVersionProbe}\nprintf '%s\\n' '/fixture/sysroot'`

test("build command reports a failed sysroot probe before invoking Cargo", () => {
  const result = runStartup(`${canonicalVersionProbe}\nprintf '%s\\n' 'sysroot fixture failure' >&2\nexit 9`)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 9)
  assert.match(result.stderr, /sysroot fixture failure/)
  assert.match(result.stderr, /rustc --print sysroot failed/)
  assert.equal(result.stdout, "")
})

test("build command reports missing Cargo after successful compiler probes", () => {
  const result = runStartup(canonicalCompiler)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /`cargo` not found on PATH/)
  assert.equal(result.stdout, "")
})

test("build command preserves failed Cargo status and uses the locked WASI build", () => {
  const result = runStartup(canonicalCompiler, "printf '%s\\n' 'cargo fixture failure' \"$@\" >&2\nexit 23")
  assert.equal(result.error, undefined)
  assert.equal(result.status, 23)
  assert.match(result.stderr, /cargo fixture failure\nbuild\n--locked\n--release\n--target\nwasm32-wasip1\n--package\nflows-jj\n/)
  assert.match(result.stderr, /cargo build failed/)
  assert.match(result.stderr, /rustup target add wasm32-wasip1/)
  assert.equal(result.stdout, "")
})

test("targetDir defaults to the workspace target directory", () => {
  assert.equal(targetDir({}, "/repo"), join("/repo", "target"))
})

test("targetDir treats an empty CARGO_TARGET_DIR as unset", () => {
  assert.equal(targetDir({ CARGO_TARGET_DIR: "" }, "/repo"), join("/repo", "target"))
})

test("targetDir honors an absolute CARGO_TARGET_DIR", () => {
  const absolute = resolve("/tmp", "flows-ci-target")
  assert.equal(targetDir({ CARGO_TARGET_DIR: absolute }, "/repo"), absolute)
})

test("targetDir resolves a relative CARGO_TARGET_DIR against the workspace root, like cargo", () => {
  assert.equal(
    targetDir({ CARGO_TARGET_DIR: "ci-target" }, "/repo"),
    resolve("/repo", "ci-target")
  )
})

test("rustcCommitHash extracts the commit-hash line of rustc -vV", () => {
  assert.equal(rustcCommitHash(verboseVersion), "29483883eed69d5fb4db01964cdf2af4d86e9cb2")
})

test("rustcCommitHash rejects output without a commit-hash line", () => {
  assert.throws(() => rustcCommitHash("rustc 1.89.0"), /commit-hash/)
})

test("rustcHost extracts the host line of rustc -vV", () => {
  assert.equal(rustcHost(verboseVersion), "aarch64-apple-darwin")
})

test("rustcHost rejects output without a host line", () => {
  assert.throws(() => rustcHost("rustc 1.89.0"), /host/)
})

test("foreignHostError passes the host the committed artifact is built on", () => {
  assert.equal(foreignHostError(canonicalHost), undefined)
})

test("foreignHostError refuses a host whose bytes CI cannot reproduce", () => {
  const error = foreignHostError("aarch64-apple-darwin")
  assert.match(error, /aarch64-apple-darwin/)
  assert.match(error, new RegExp(canonicalHost))
  // The refusal is only actionable if it carries the canonical rebuild.
  assert.match(error, /docker run/)
  assert.match(error, /node packages\/smithers\/flows\/jj-wasm\/build-wasm\.mjs/)
})

test("remapFlags replaces every machine-specific prefix with a fixed token", () => {
  assert.deepEqual(
    remapFlags({
      cargoHome: "/home/user/.cargo",
      commitHash: "abc123",
      sysroot: "/home/user/.rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu",
      workspaceRoot: "/home/user/flows"
    }),
    [
      "--remap-path-prefix=/home/user/flows=/flows",
      "--remap-path-prefix=/home/user/.cargo=/cargo",
      "--remap-path-prefix=" +
        join(
          "/home/user/.rustup/toolchains/1.89.0-x86_64-unknown-linux-gnu",
          "lib",
          "rustlib",
          "src",
          "rust"
        ) +
        "=/rustc/abc123"
    ]
  )
})

test("buildEnvironment authors encoded rustflags from the remap flags alone", () => {
  const environment = buildEnvironment(
    { PATH: "/usr/bin", RUSTFLAGS: "-C target-cpu=native" },
    ["--remap-path-prefix=/a=/flows"]
  )
  assert.equal(environment.CARGO_ENCODED_RUSTFLAGS, "--remap-path-prefix=/a=/flows")
  assert.equal("RUSTFLAGS" in environment, false)
  assert.equal(environment.PATH, "/usr/bin")
})

test("buildEnvironment replaces ambient encoded rustflags", () => {
  const environment = buildEnvironment(
    { CARGO_ENCODED_RUSTFLAGS: "-Clto", PATH: "/usr/bin" },
    ["--remap-path-prefix=/a=/flows"]
  )
  assert.equal(environment.CARGO_ENCODED_RUSTFLAGS, "--remap-path-prefix=/a=/flows")
})

test("reproductionFailure accepts byte-identical artifacts", () => {
  assert.equal(
    reproductionFailure(Buffer.from([0, 1, 2]), Buffer.from([0, 1, 2])),
    undefined
  )
})

test("reproductionFailure names the canonical host and both sizes on drift", () => {
  const failure = reproductionFailure(Buffer.from([0, 1, 2]), Buffer.from([0, 1]))
  assert.match(failure, /does not reproduce from source/)
  assert.match(failure, /committed 3 bytes, rebuilt 2 bytes/)
  assert.match(failure, new RegExp(canonicalHost))
})

test("buildEnvironment removes compiler and linker overrides without mutating its input", () => {
  const overrides = {
    RUSTC: "/ambient/rustc",
    RUSTC_WRAPPER: "/ambient/wrapper",
    RUSTC_WORKSPACE_WRAPPER: "/ambient/workspace-wrapper",
    CARGO_BUILD_RUSTC: "/ambient/cargo-rustc",
    CARGO_BUILD_RUSTC_WRAPPER: "/ambient/cargo-wrapper",
    CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: "/ambient/cargo-workspace-wrapper",
    CARGO_TARGET_WASM32_WASIP1_LINKER: "/ambient/wasm-linker",
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "/ambient/host-linker"
  }
  const input = Object.freeze({
    ...overrides,
    PATH: "/trusted/bin",
    CARGO_HOME: "/cache/cargo",
    CARGO_TARGET_DIR: "/cache/target",
    CARGO_BUILD_JOBS: "2"
  })
  const environment = buildEnvironment(input, ["--remap-path-prefix=/repo=/flows"])
  for (const name of Object.keys(overrides)) {
    assert.equal(name in environment, false, `${name} must not select an ambient build tool`)
    assert.equal(input[name], overrides[name])
  }
  assert.equal(environment.PATH, input.PATH)
  assert.equal(environment.CARGO_HOME, input.CARGO_HOME)
  assert.equal(environment.CARGO_TARGET_DIR, input.CARGO_TARGET_DIR)
  assert.equal(environment.CARGO_BUILD_JOBS, "2")
  assert.equal(environment.CARGO_ENCODED_RUSTFLAGS, "--remap-path-prefix=/repo=/flows")
})

test("buildEnvironment preserves remap flags through Cargo when paths contain spaces", () => {
  const directory = mkdtempSync(join(tmpdir(), "flows jj remap "))
  try {
    mkdirSync(join(directory, "src"))
    writeFileSync(
      join(directory, "Cargo.toml"),
      '[package]\nname = "remap-fixture"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n'
    )
    writeFileSync(join(directory, "src", "main.rs"), `include!(${JSON.stringify(join(directory, "included.rs"))});\n`)
    writeFileSync(join(directory, "included.rs"), 'fn main() { println!("{}", file!()); }\n')
    const args = ["run", "--offline", "--jobs", "2", "--manifest-path", join(directory, "Cargo.toml")]
    const control = spawnSync("cargo", args, {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      env: buildEnvironment({ ...process.env, CARGO_TARGET_DIR: join(directory, "target") }, []),
      encoding: "utf8",
      timeout: 60000
    })
    assert.equal(control.error, undefined)
    assert.equal(control.status, 0, `Cargo fixture must work before testing remapping: ${control.stderr}`)
    assert.equal(control.stdout.trim(), join(directory, "included.rs"))
    // Use real Cargo and rustc: inspecting the environment alone cannot prove
    // that Cargo delivers each argument intact to the compiler.
    const result = spawnSync("cargo", args, {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      env: buildEnvironment({ ...process.env, CARGO_TARGET_DIR: join(directory, "target") }, [
        `--remap-path-prefix=${directory}=/flows`,
        "--cfg=flows_remap_fixture"
      ]),
      encoding: "utf8",
      timeout: 60000
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal
    }))
    assert.equal(result.stdout.trim(), "/flows/included.rs")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("buildEnvironment lets the repository pin select the Rustup toolchain", () => {
  const input = Object.freeze({ ...process.env, RUSTUP_TOOLCHAIN: "flows-jj-invalid-toolchain" })
  const environment = buildEnvironment(input, [])
  // The nonexistent override must never reach rustup or trigger a toolchain
  // installation; the repository's already-installed pinned compiler is used.
  for (const tool of ["rustc", "cargo"]) {
    const result = spawnSync(tool, ["--version"], {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      env: environment,
      encoding: "utf8",
      timeout: 60000
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.startsWith(`${tool} `), result.stdout)
  }
  assert.equal("RUSTUP_TOOLCHAIN" in environment, false)
  assert.equal(input.RUSTUP_TOOLCHAIN, "flows-jj-invalid-toolchain")
})
