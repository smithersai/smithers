import { describe, expect, it } from "vitest"
import { readSetup } from "../../src/inventory/Setup.ts"

const toolOf = (uses: string, inputs?: unknown) => readSetup(uses, inputs)?.tools

describe("readSetup", () => {
  it("reads the tool from each form of a setup action's name", () => {
    const tools = (uses: string) => toolOf(uses)?.map((tool) => tool.name)
    expect(tools("actions/setup-node@v4")).toEqual(["node"])
    expect(tools("ruby/setup-ruby@95ef2b042f9d7a56d8268cba8559e2842e2ad01b")).toEqual(["ruby"])
    expect(tools("astral-sh/setup-uv@v9")).toEqual(["uv"])
    expect(tools("docker/setup-buildx-action@v3")).toEqual(["buildx"])
    expect(tools("bufbuild/buf-setup-action@v1")).toEqual(["buf"])
    expect(tools("snok/install-poetry@v1")).toEqual(["poetry"])
    expect(tools("DeterminateSystems/nix-installer-action@main")).toEqual(["nix"])
    expect(tools("dtolnay/rust-toolchain@stable")).toEqual(["rust"])
    expect(tools("r-lib/actions/setup-r@v2")).toEqual(["r"])
  })

  it("names the tool after the action's owner when the name says none", () => {
    expect(toolOf("pnpm/action-setup@v4")).toEqual([{ name: "pnpm" }])
    expect(toolOf("supabase/setup-cli@v1")).toEqual([{ name: "supabase" }])
    expect(toolOf("acme-actions/setup-tool@v2")).toEqual([{ name: "acme" }])
  })

  it("gives one tool one name however the action spells it", () => {
    expect(toolOf("some/setup-golang@v1")).toEqual([{ name: "go" }])
    expect(toolOf("actions-rust-lang/setup-rust-toolchain@v1")).toEqual([{ name: "rust" }])
    expect(toolOf("Homebrew/actions/setup-homebrew@master")).toEqual([{ name: "brew" }])
  })

  it("reads the actions that set a tool up under another name", () => {
    expect(toolOf("actions-rs/toolchain@v1", { toolchain: "1.80.0" })).toEqual([{ name: "rust", version: "1.80.0" }])
    expect(toolOf("jdx/mise-action@v2")).toEqual([{ name: "mise" }])
    expect(toolOf("subosito/flutter-action@v2", { "flutter-version": "3.24.0" })).toEqual([
      { name: "flutter", version: "3.24.0" }
    ])
    expect(toolOf("taiki-e/install-action@v2", { tool: "cargo-nextest@0.9.72, just,,cargo-deny@" })).toEqual([
      { name: "cargo-nextest", version: "0.9.72" },
      { name: "just" },
      { name: "cargo-deny" }
    ])
    // Its release names the one tool when it is no version of the action itself.
    expect(toolOf("taiki-e/install-action@nextest")).toEqual([{ name: "nextest" }])
    expect(toolOf("taiki-e/install-action@v2")).toEqual([])
    expect(toolOf("taiki-e/install-action")).toEqual([])
    expect(toolOf("taiki-e/install-action@0a5b3c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b")).toEqual([])
  })

  it("reads the version from the tool's own input, then the general ones", () => {
    expect(toolOf("actions/setup-go@v5", { "go-version": "1.23" })).toEqual([{ name: "go", version: "1.23" }])
    expect(toolOf("actions/setup-node@v4", { "node-version": 22 })).toEqual([{ name: "node", version: "22" }])
    expect(toolOf("hashicorp/setup-terraform@v3", { terraform_version: "1.9.0" })).toEqual([
      { name: "terraform", version: "1.9.0" }
    ])
    expect(toolOf("mlugg/setup-zig@v2", { version: "0.15.1" })).toEqual([{ name: "zig", version: "0.15.1" }])
    expect(toolOf("dtolnay/rust-toolchain@master", { toolchain: "nightly" })).toEqual([
      { name: "rust", version: "nightly" }
    ])
    // An input that is empty, a list, or a file to read the version from gives no version.
    expect(toolOf("mlugg/setup-zig@v2", { version: "" })).toEqual([{ name: "zig" }])
    expect(toolOf("actions/setup-python@v5", { "python-version": ["3.12"] })).toEqual([{ name: "python" }])
    expect(toolOf("actions/setup-python@v5", { "python-version-file": "pyproject.toml" })).toEqual([{ name: "python" }])
    expect(toolOf("actions/setup-node@v4", "not a mapping")).toEqual([{ name: "node" }])
  })

  it("reads a Rust version from the release dtolnay/rust-toolchain is pinned to, and from no other release", () => {
    expect(toolOf("dtolnay/rust-toolchain@1.85.0")).toEqual([{ name: "rust", version: "1.85.0" }])
    expect(toolOf("dtolnay/rust-toolchain@nightly")).toEqual([{ name: "rust", version: "nightly" }])
    expect(toolOf("dtolnay/rust-toolchain@master")).toEqual([{ name: "rust" }])
    expect(toolOf("dtolnay/rust-toolchain")).toEqual([{ name: "rust" }])
    // A commit names the action, not a version of Rust.
    expect(toolOf("dtolnay/rust-toolchain@4305c38b25d97ef35a8ad1f985ccf2d2242004f2")).toEqual([{ name: "rust" }])
    // Another action's release is its own version.
    expect(toolOf("actions-rs/toolchain@v1.0.6")).toEqual([{ name: "rust" }])
    expect(toolOf("actions-rust-lang/setup-rust-toolchain@v1.10.1")).toEqual([{ name: "rust" }])
    expect(toolOf("actions/setup-node@22")).toEqual([{ name: "node" }])
  })

  it("is no setup action when what its name says is a server, a cluster, an environment or the job's own preparation", () => {
    for (
      const uses of [
        "medyagh/setup-minikube@v0.0.19",
        "engineerd/setup-kind@v0.6.2",
        "ankane/setup-postgres@v1",
        "ankane/setup-mysql@v1",
        "conda-incubator/setup-miniconda@v3",
        "mamba-org/setup-micromamba@v2",
        "docker/setup-qemu-action@v3",
        "docker/setup-docker-action@v4",
        "msys2/setup-msys2@v2",
        "acme/setup-env@v1",
        "acme/setup-ci@v1",
        "r-lib/actions/setup-r-dependencies@v2",
        "acme/setup-python-env@v1"
      ]
    ) {
      expect(readSetup(uses, undefined), uses).toBeUndefined()
    }
  })

  it("reads what a setup action sets up besides the tool it is named for", () => {
    // uv is told which Python to run: a version of Python the job asks for.
    expect(toolOf("astral-sh/setup-uv@v9", { version: "0.9.7", "python-version": "3.11" })).toEqual([
      { name: "uv", version: "0.9.7" },
      { name: "python", version: "3.11" }
    ])
    expect(toolOf("astral-sh/setup-uv@v9", { "enable-cache": true })).toEqual([{ name: "uv" }])
    // The Gradle action keeps a cache; it installs Gradle only when asked for a version.
    expect(readSetup("gradle/actions/setup-gradle@v4", undefined)).toEqual({ tools: [] })
    expect(readSetup("gradle/actions/setup-gradle@v4", { "gradle-version": "8.10" })).toEqual({
      tools: [{ name: "gradle", version: "8.10" }]
    })
  })

  it("is not a setup action when the name says no such thing, or the action is local or a container", () => {
    expect(readSetup("actions/checkout@v4", undefined)).toBeUndefined()
    expect(readSetup("github/codeql-action/init@v4", undefined)).toBeUndefined()
    expect(readSetup("./.github/actions/setup-node", undefined)).toBeUndefined()
    expect(readSetup("docker://ghcr.io/acme/setup-node:1", undefined)).toBeUndefined()
    expect(readSetup("setup-node", undefined)).toBeUndefined()
  })

  it("reads the command a setup action also runs", () => {
    const gems = "bundle config set --local path vendor/bundle\nbundle install --jobs 4"
    expect(readSetup("ruby/setup-ruby@v1", { "ruby-version": "3.4.6", "bundler-cache": true })).toEqual({
      tools: [{ name: "ruby", version: "3.4.6" }],
      command: gems
    })
    expect(readSetup("ruby/setup-ruby@v1", { "bundler-cache": "true" })?.command).toBe(gems)
    for (const off of [false, "false", null]) {
      expect(readSetup("ruby/setup-ruby@v1", { "bundler-cache": off })).toEqual({ tools: [{ name: "ruby" }] })
    }
    expect(readSetup("pnpm/action-setup@v4", { run_install: true })).toEqual({
      tools: [{ name: "pnpm" }],
      command: "pnpm install"
    })
    expect(readSetup("pnpm/action-setup@v4", { run_install: false })).toEqual({ tools: [{ name: "pnpm" }] })
  })

  it("says so when a setup action runs something that was not read", () => {
    expect(readSetup("ruby/setup-ruby@v1", { "bundler-cache": true, "working-directory": "docs" })).toEqual({
      tools: [{ name: "ruby" }],
      problem: "installs gems in a way that was not read (bundler-cache)"
    })
    expect(readSetup("ruby/setup-ruby@v1", { "bundler-cache": "${{ matrix.cache }}" })?.problem).toContain("gems")
    expect(readSetup("pnpm/action-setup@v4", { run_install: [{ args: ["--frozen-lockfile"] }] })).toEqual({
      tools: [{ name: "pnpm" }],
      problem: "installs packages with its own arguments (run_install)"
    })
    expect(readSetup("astral-sh/setup-uv@v9", { "activate-environment": true })).toEqual({
      tools: [{ name: "uv" }],
      problem: "makes an environment the steps after it run in (activate-environment)"
    })
    expect(readSetup("astral-sh/setup-uv@v9", { "activate-environment": false })).toEqual({ tools: [{ name: "uv" }] })
    // It turns warnings into errors for the steps after it, unless told to set no flags.
    expect(readSetup("actions-rust-lang/setup-rust-toolchain@v1", { toolchain: "1.85.0" })).toEqual({
      tools: [{ name: "rust", version: "1.85.0" }],
      problem: "sets RUSTFLAGS for the steps after it"
    })
    expect(readSetup("actions-rust-lang/setup-rust-toolchain@v1", { rustflags: "" })).toEqual({
      tools: [{ name: "rust" }]
    })
  })
})
