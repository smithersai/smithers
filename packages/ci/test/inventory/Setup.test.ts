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
    expect(toolOf("haskell-actions/setup-tool@v2")).toEqual([{ name: "haskell" }])
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
    expect(toolOf("taiki-e/install-action@nextest")).toEqual([])
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

  it("reads a Rust version from the release the action is pinned to, unless that names the action's own", () => {
    expect(toolOf("dtolnay/rust-toolchain@1.85.0")).toEqual([{ name: "rust", version: "1.85.0" }])
    expect(toolOf("dtolnay/rust-toolchain@master")).toEqual([{ name: "rust" }])
    expect(toolOf("actions-rs/toolchain@v1")).toEqual([{ name: "rust" }])
    expect(toolOf("dtolnay/rust-toolchain")).toEqual([{ name: "rust" }])
    // No other tool's version is read from the release of its action.
    expect(toolOf("actions/setup-node@22")).toEqual([{ name: "node" }])
  })

  it("is not a setup action when the name says no such thing, or the action is local or a container", () => {
    expect(readSetup("actions/checkout@v4", undefined)).toBeUndefined()
    expect(readSetup("github/codeql-action/init@v4", undefined)).toBeUndefined()
    expect(readSetup("./.github/actions/setup-node", undefined)).toBeUndefined()
    expect(readSetup("docker://ghcr.io/acme/setup-node:1", undefined)).toBeUndefined()
    expect(readSetup("setup-node", undefined)).toBeUndefined()
  })

  it("reads an action that only keeps a cache as needing no tool", () => {
    expect(readSetup("gradle/actions/setup-gradle@v4", undefined)).toEqual({ tools: [] })
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
  })
})
