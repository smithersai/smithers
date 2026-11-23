import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { hostPath, probeEnvironment } from "../../src/inventory/HostPath.ts"
import { read, readHere } from "../../src/inventory/index.vibe"
import { repository } from "./run.ts"

afterEach(() => vi.unstubAllEnvs())

describe("host program lookup", () => {
  it("excludes checkout directories and executable links, including through a checkout alias", () => {
    const base = mkdtempSync(join(tmpdir(), "inventory-path-"))
    try {
      const root = join(base, "repo")
      const alias = join(base, "checkout")
      const first = join(base, "first")
      const second = join(base, "second")
      const unusual = join(base, "two:entries")
      for (const directory of [root, first, second, unusual]) mkdirSync(directory)
      symlinkSync(root, alias)
      symlinkSync(first, join(root, "out"))
      symlinkSync(unusual, join(base, "combined"))
      symlinkSync(root, join(base, "back"))
      writeFileSync(join(root, "linked"), "", { mode: 0o755 })
      symlinkSync(join(root, "linked"), join(first, "linked"))
      writeFileSync(join(first, "plain"), "", { mode: 0o600 })
      mkdirSync(join(first, "directory"))
      writeFileSync(join(second, "linked"), "", { mode: 0o755 })
      const entries = [
        "",
        ".",
        alias,
        root,
        join(root, "out"),
        join(base, "back"),
        join(base, "combined"),
        first,
        second
      ]
      const search = hostPath(alias, entries.join(delimiter))
      expect(search.path).toBe([first, second].map((path) => realpathSync(path)).join(delimiter))
      expect(search.program("linked")).toBe(realpathSync(join(second, "linked")))
      for (const name of ["plain", "directory", "absent"]) expect(search.program(name)).toBeUndefined()
      expect(hostPath(root, join(base, "back")).program("linked")).toBeUndefined()
      expect(hostPath(join(base, "missing"), first).path).toBe("")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("uses the checkout root throughout readHere and fails closed without a host Git", async () => {
    const name = "inventory-test-checkout-tool"
    const repo = repository({
      [`bin/${name}`]: "",
      ".github/workflows/ci.yml": `on: push
jobs:
  ci:
    runs-on: ${process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"}
    steps:
      - uses: taiki-e/install-action@${name}
      - run: echo ok
`
    })
    try {
      const bin = join(repo.root, "bin")
      chmodSync(join(bin, name), 0o755)
      const alias = join(repo.temp, "bin")
      symlinkSync(bin, alias)
      symlinkSync(join(bin, name), join(repo.temp, name))
      vi.stubEnv("PATH", [bin, alias, repo.temp, process.env["PATH"]].join(delimiter))
      const result = await Effect.runPromise(readHere(repo.root).pipe(Effect.provide(NodeServices.layer)))
      expect(result.jobs[0]?.unsupported).toContainEqual({ feature: "missing-tool", detail: name })
      vi.stubEnv("PATH", bin)
      const failure = await Effect.runPromise(Effect.flip(read(repo.root)).pipe(Effect.provide(NodeServices.layer)))
      expect(failure.code).toBe("not-a-repository")
    } finally {
      repo.remove()
    }
  })

  it("passes only the host settings required by package and tool probes", () => {
    for (const name of ["HOME", "USER", "TMPDIR", "RUSTUP_HOME", "CARGO_HOME"]) vi.stubEnv(name, `test-${name}`)
    vi.stubEnv("BASH_ENV", "fixture")
    expect(probeEnvironment()).toEqual({
      HOME: "test-HOME",
      USER: "test-USER",
      TMPDIR: "test-TMPDIR",
      RUSTUP_HOME: "test-RUSTUP_HOME",
      CARGO_HOME: "test-CARGO_HOME"
    })
  })
})
