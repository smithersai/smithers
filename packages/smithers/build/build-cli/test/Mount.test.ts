/**
 * Mount acceptance: an overlay repository's `.smithers/config.ts` names an
 * upstream repository and a pinned commit, and every command run from the
 * overlay materializes that pin, applies the declared patches, lays the
 * overlay's `.smithers/` over the checkout, and plans against the checkout.
 *
 * The upstream is a real local git repository and every assertion reads real
 * files and real git state: nothing here stubs git or the loader.
 */
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import { openPackageIndex } from "../src/Cli.ts"
import * as Mount from "../src/Mount.ts"

const executeFile = promisify(execFile)
const cli = NodePath.resolve(import.meta.dirname, "../src/main.js")
const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const git = async (root: string, args: ReadonlyArray<string>): Promise<string> =>
  (await executeFile("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout
    .trim()

const write = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, contents] of Object.entries(files)) {
    const absolute = NodePath.join(root, ...path.split("/"))
    await Fs.mkdir(NodePath.dirname(absolute), { recursive: true })
    await Fs.writeFile(absolute, contents)
  }
}

const read = (root: string, path: string): Promise<string> =>
  Fs.readFile(NodePath.join(root, ...path.split("/")), "utf8")

const exists = (root: string, path: string): Promise<boolean> =>
  Fs.lstat(NodePath.join(root, ...path.split("/"))).then(() => true, () => false)

const commit = async (root: string, files: Readonly<Record<string, string>>, message: string): Promise<string> => {
  await write(root, files)
  await git(root, ["add", "-A"])
  await git(root, ["commit", "--quiet", "--no-verify", "-m", message])
  return git(root, ["rev-parse", "HEAD"])
}

/** An upstream repository with two commits on main: `value.txt` reads one, then two. */
const upstream = async (extra: Readonly<Record<string, string>> = {}) => {
  const root = await temporary("smthrs-mount-upstream-")
  await git(root, ["init", "--quiet", "--initial-branch=main"])
  await git(root, ["config", "user.name", "Upstream"])
  await git(root, ["config", "user.email", "upstream@example.invalid"])
  await git(root, ["config", "commit.gpgsign", "false"])
  const first = await commit(root, {
    "src/value.txt": "one\n",
    "README.md": "upstream\n",
    "package.json": `{ "name": "upstream", "private": true }\n`,
    ...extra
  }, "one")
  const second = await commit(root, { "src/value.txt": "two\n" }, "two")
  return { root, first, second }
}

const workspaceFile = `import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })

export const Workspace = S.Workspace("mounted", {
  repository: "git+https://example.invalid/mounted.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
`

/** A target that passes only when the materialized upstream file reads `expected`. */
const packageFile = (expected: string): string =>
  `import { Smithers as S } from "@smthrs/targets"

export const Package = S.Package({
  targets: {
    value: S.Shell.Test({
      bin: S.Runtime.bin,
      args: [
        "-e",
        "const text = require('node:fs').readFileSync('src/value.txt', 'utf8').trim(); " +
          "if (text !== '${expected}') { console.error('value is ' + text); process.exit(3) }"
      ],
      data: [S.file("//src/value.txt")]
    })
  }
})
`

interface MountOptions {
  readonly ref: string
  readonly track?: string
  readonly drift?: string
  readonly patches?: ReadonlyArray<string>
  readonly overlay?: string
}

const configFile = (repository: string, mounts: Readonly<Record<string, MountOptions>>): string => {
  const entries = Object.entries(mounts).map(([name, options]) =>
    `  ${JSON.stringify(name)}: S.Mount(${JSON.stringify({ repository, ...options })})`
  )
  return `import { Smithers as S } from "@smthrs/targets"\n\nexport default S.Mounts({\n${entries.join(",\n")}\n})\n`
}

/** An overlay repository: `.smithers/` and nothing else. */
const overlay = async (
  repository: string,
  mounts: Readonly<Record<string, MountOptions>>,
  files: Readonly<Record<string, string>> = {
    ".smithers/WORKSPACE.ts": workspaceFile,
    ".smithers/check/PACKAGE.ts": packageFile("one")
  }
): Promise<string> => {
  const root = await temporary("smthrs-mount-overlay-")
  await write(root, { ".smithers/config.ts": configFile(repository, mounts), ...files })
  return root
}

const silent = { environment: process.env, report: () => {} }

const runCli = async (cwd: string, args: ReadonlyArray<string>) => {
  try {
    const result = await executeFile(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 4 * 1024 * 1024
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (cause) {
    const failed = cause as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown }
    return {
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? "")
    }
  }
}

const mountError = async (operation: Promise<unknown>): Promise<Mount.MountError> => {
  const error = await operation.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(Mount.MountError)
  return error as Mount.MountError
}

describe("a mounted overlay", () => {
  it("materializes the pin, lays the overlay, and plans the overlay's targets against the checkout", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } })

    const index = await openPackageIndex({ workspace: root }, {
      stderr: { write: () => {}, isTTY: false, columns: 80 }
    })
    const checkout = NodePath.join(root, ".mounts", "up")
    expect(index.root).toBe(checkout)
    expect(() => index.resolve("//check:value")).toThrow(/target not found/)
    expect(index.resolve("//.smithers/check:value")).toHaveLength(1)

    expect(await read(checkout, "src/value.txt")).toBe("one\n")
    expect(await read(checkout, ".smithers/WORKSPACE.ts")).toBe(workspaceFile)
    expect(await exists(checkout, ".smithers/config.ts")).toBe(false)
    expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(source.first)
    // The checkout ignores what the overlay laid, so its status shows upstream edits only.
    expect(await git(checkout, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
    // The overlay repository never tracks a checkout.
    expect(await read(root, ".mounts/.gitignore")).toBe("*\n")

    // Upstream is read, never written.
    expect(await git(source.root, ["rev-parse", "HEAD"])).toBe(source.second)
    expect(await git(source.root, ["status", "--porcelain", "--untracked-files=all"])).toBe("")
    expect(await exists(source.root, ".smithers")).toBe(false)
  })

  it("runs an overlay target end to end with one command from the overlay root", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } })

    const passed = await runCli(root, ["test", "//.smithers/check:value", "--no-cache"])
    expect(passed.stderr).toContain(`mount up: ${source.first.slice(0, 12)}`)
    expect(passed.exitCode, passed.stderr).toBe(0)

    await write(root, { ".smithers/check/PACKAGE.ts": packageFile("two") })
    const failed = await runCli(root, ["test", "//.smithers/check:value", "--no-cache"])
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stdout + failed.stderr).toContain("value is one")
  }, 120_000)

  it("applies declared patches in order as commits on the pin", async () => {
    const source = await upstream()
    const scratch = await temporary("smthrs-mount-patch-")
    await executeFile("git", ["clone", "--quiet", source.root, scratch])
    await git(scratch, ["checkout", "--quiet", source.first])
    await write(scratch, { "src/value.txt": "patched\n" })
    const patch = await git(scratch, ["diff"])
    const root = await overlay(source.root, { up: { ref: source.first, patches: ["patches/up/value.patch"] } }, {
      ".smithers/WORKSPACE.ts": workspaceFile,
      ".smithers/patches/up/value.patch": `${patch}\n`
    })

    const result = await Mount.resolveWorkspace(root, silent)
    const checkout = result.workspace
    expect(await read(checkout, "src/value.txt")).toBe("patched\n")
    expect(await git(checkout, ["rev-parse", "HEAD~1"])).toBe(source.first)
    expect(await git(checkout, ["log", "-1", "--format=%s"])).toBe("smithers mount: apply patches/up/value.patch")
    // A declared patch is upstream input, not overlay content.
    expect(await exists(checkout, ".smithers/patches/up/value.patch")).toBe(false)
    expect(result.mount?.patches).toEqual(["patches/up/value.patch"])

    await write(root, {
      ".smithers/patches/up/value.patch": patch.replace("+patched", "+other").replace("-one", "-zero")
    })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_patch_failed")
    expect(error.message).toContain("patches/up/value.patch")
  })

  it.each(
    [
      ["warn", "behind", "one"],
      ["follow", "current", "two"]
    ] as const
  )("measures drift against the tracked branch under %s", async (drift, state, value) => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first, track: "main", drift } })
    const result = await Mount.resolveWorkspace(root, silent)
    expect(result.mount?.drift).toEqual({ state, track: "main", tip: source.second })
    expect(await read(result.workspace, "src/value.txt")).toBe(`${value}\n`)
    expect(Mount.summary(result.mount!)).toContain("main")
  })

  it("refuses to run when refuse drift finds the branch past the pin, and runs when it is current", async () => {
    const source = await upstream()
    const behind = await overlay(source.root, { up: { ref: source.first, track: "main", drift: "refuse" } })
    const error = await mountError(Mount.resolveWorkspace(behind, silent))
    expect(error.code).toBe("mount_drift")
    expect(error.message).toContain(source.second)

    const current = await overlay(source.root, { up: { ref: source.second, track: "main", drift: "refuse" } })
    expect((await Mount.resolveWorkspace(current, silent)).mount?.drift.state).toBe("current")
  })

  it("fails closed when refuse or follow cannot read the tracked branch", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first, track: "missing", drift: "follow" } })
    expect((await mountError(Mount.resolveWorkspace(root, silent))).code).toBe("mount_drift")
  })

  it("keeps edits in the checkout, and refuses to discard them when the pin moves", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } })
    const { workspace: checkout } = await Mount.resolveWorkspace(root, silent)
    await write(checkout, { "src/value.txt": "edited\n" })

    await Mount.resolveWorkspace(root, silent)
    expect(await read(checkout, "src/value.txt")).toBe("edited\n")

    await write(root, { ".smithers/config.ts": configFile(source.root, { up: { ref: source.second } }) })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_dirty")
    expect(error.message).toContain("src/value.txt")
    expect(await read(checkout, "src/value.txt")).toBe("edited\n")

    await git(checkout, ["checkout", "--", "src/value.txt"])
    await Mount.resolveWorkspace(root, silent)
    expect(await read(checkout, "src/value.txt")).toBe("two\n")
  })

  it("keeps commits made in the checkout, and refuses to drop them when the pin moves", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } })
    const { workspace: checkout } = await Mount.resolveWorkspace(root, silent)
    await write(checkout, { "README.md": "my work\n" })
    await git(checkout, ["-c", "user.name=Me", "-c", "user.email=me@example.invalid", "commit", "-qam", "my work"])
    const work = await git(checkout, ["rev-parse", "HEAD"])

    await Mount.resolveWorkspace(root, silent)
    expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(work)
    expect(await read(checkout, "README.md")).toBe("my work\n")

    await write(root, { ".smithers/config.ts": configFile(source.root, { up: { ref: source.second } }) })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_dirty")
    expect(error.message).toContain("my work")
    expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(work)

    await git(checkout, ["reset", "--quiet", "--hard", source.first])
    await Mount.resolveWorkspace(root, silent)
    expect(await git(checkout, ["rev-parse", "HEAD"])).toBe(source.second)
  })

  it.each(
    [
      ["a symbolic link at .smithers", ".smithers", "link"],
      ["a symbolic link under .smithers", ".smithers/check", "link"],
      ["a file at .smithers", ".smithers", "file"],
      ["a directory at a laid file", ".smithers/WORKSPACE.ts", "directory"]
    ] as const
  )("refuses to lay the overlay through %s that upstream tracks", async (_, path, kind) => {
    const source = await upstream()
    const tracked = NodePath.join(source.root, ...path.split("/"))
    await Fs.mkdir(NodePath.dirname(tracked), { recursive: true })
    // The link points from the checkout at `<overlay>/.mounts/up` to `<overlay>/victim`.
    const target = NodePath.posix.join(...path.split("/").map(() => ".."), "..", "victim")
    if (kind === "link") await Fs.symlink(target, tracked)
    else if (kind === "file") await Fs.writeFile(tracked, "upstream\n")
    else await write(tracked, { "upstream.txt": "upstream\n" })
    await git(source.root, ["add", "-A"])
    await git(source.root, ["commit", "--quiet", "--no-verify", "-m", "track .smithers"])
    const pin = await git(source.root, ["rev-parse", "HEAD"])
    const root = await overlay(source.root, { up: { ref: pin } })
    await Fs.mkdir(NodePath.join(root, "victim", "check"), { recursive: true })

    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_overlay_collision")
    expect(error.message).toContain(path)
    expect(await Fs.readdir(NodePath.join(root, "victim"))).toEqual(["check"])
    expect(await Fs.readdir(NodePath.join(root, "victim", "check"))).toEqual([])
  })

  it("re-lays overlay edits and deletions, and refuses to overwrite an edited mounted copy", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } }, {
      ".smithers/WORKSPACE.ts": workspaceFile,
      ".smithers/notes.md": "first\n",
      ".smithers/old.md": "gone soon\n"
    })
    const { workspace: checkout } = await Mount.resolveWorkspace(root, silent)

    await write(root, { ".smithers/notes.md": "second\n" })
    await Fs.rm(NodePath.join(root, ".smithers", "old.md"))
    await Mount.resolveWorkspace(root, silent)
    expect(await read(checkout, ".smithers/notes.md")).toBe("second\n")
    expect(await exists(checkout, ".smithers/old.md")).toBe(false)

    await write(checkout, { ".smithers/notes.md": "edited in the mount\n" })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_overlay_edited")
    expect(error.message).toContain(".smithers/notes.md")
    expect(await read(checkout, ".smithers/notes.md")).toBe("edited in the mount\n")
  })

  it("refuses an overlay file that would replace a file upstream tracks", async () => {
    const source = await upstream({ ".smithers/WORKSPACE.ts": "// upstream adopted smithers\n" })
    const root = await overlay(source.root, { up: { ref: source.first } })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_overlay_collision")
    expect(error.message).toContain(".smithers/WORKSPACE.ts")
  })

  it("lays each mount's own overlay directory, and asks which mount to run when there are several", async () => {
    const source = await upstream()
    const root = await overlay(
      source.root,
      { first: { ref: source.first, overlay: "first" }, second: { ref: source.second, overlay: "second" } },
      {
        ".smithers/first/WORKSPACE.ts": workspaceFile,
        ".smithers/second/WORKSPACE.ts": workspaceFile,
        ".smithers/second/only-second.md": "second\n"
      }
    )
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_ambiguous")
    expect(error.message).toContain("first, second")
    expect((await mountError(Mount.materialize(root, "third", silent))).code).toBe("mount_ambiguous")

    const selected = await Mount.resolveWorkspace(NodePath.join(root, ".smithers", "second"), silent)
    expect(selected.mount?.name).toBe("second")
    const second = selected.mount!
    expect(selected.workspace).toBe(second.root)
    expect(second.root).toBe(NodePath.join(root, ".mounts", "second"))
    expect(await read(second.root, "src/value.txt")).toBe("two\n")
    expect(await exists(second.root, ".smithers/only-second.md")).toBe(true)
    expect(await exists(second.root, ".smithers/second")).toBe(false)

    // Inside a materialized checkout, the checkout is an ordinary workspace.
    const inside = await Mount.resolveWorkspace(NodePath.join(second.root, "src"), silent)
    expect(inside).toEqual({ workspace: NodePath.join(second.root, "src"), mount: undefined })
  })

  it("reports a tracked branch it cannot read under warn, and still materializes the pin", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first, track: "missing" } })
    const result = await Mount.resolveWorkspace(root, silent)
    expect(result.mount?.drift).toEqual({ state: "unknown", track: "missing", tip: undefined })
    expect(Mount.summary(result.mount!)).toContain("missing could not be read")
  })

  it("plans from the matching directory of the checkout", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } })
    const result = await Mount.resolveWorkspace(NodePath.join(root, ".smithers", "check"), silent)
    expect(result.workspace).toBe(NodePath.join(root, ".mounts", "up", ".smithers", "check"))
  })

  it("refuses a pin the upstream repository does not have", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: "0".repeat(40) } })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_fetch_failed")
    expect(error.message).toContain("0".repeat(40))
  })

  it("names every edit it would discard, up to ten", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } })
    const { workspace: checkout } = await Mount.resolveWorkspace(root, silent)
    await write(checkout, Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`new/${index}.txt`, "x"])))
    await write(root, { ".smithers/config.ts": configFile(source.root, { up: { ref: source.second } }) })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_dirty")
    expect(error.message).toContain("and 2 more")
  })

  it.each(
    [
      ["a missing patch file", { patches: ["patches/absent.patch"] }, {}],
      ["a missing overlay directory", { overlay: "absent" }, {}],
      ["a symbolic link in the overlay", {}, { link: true }]
    ] as const
  )("refuses %s", async (_, options, shape) => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first, ...options } })
    if ("link" in shape) {
      await Fs.symlink(NodePath.join(source.root, "README.md"), NodePath.join(root, ".smithers", "link.md"))
    }
    expect((await mountError(Mount.resolveWorkspace(root, silent))).code).toBe("mount_config_invalid")
  })

  it("leaves an ordinary workspace alone", async () => {
    const root = await temporary("smthrs-mount-plain-")
    await write(root, { ".smithers/WORKSPACE.ts": workspaceFile })
    expect(await Mount.resolveWorkspace(root, silent)).toEqual({ workspace: root, mount: undefined })
  })

  it.each([
    ["does not default-export S.Mounts", "export default { mounts: {} }\n", /must default-export S\.Mounts/],
    ["does not evaluate", "export default S.Mounts(\n", /evaluating \.smithers\/config\.ts failed/]
  ])("reports a config.ts that %s", async (_, source, message) => {
    const root = await temporary("smthrs-mount-invalid-")
    await write(root, { ".smithers/config.ts": source })
    const error = await mountError(Mount.resolveWorkspace(root, silent))
    expect(error.code).toBe("mount_config_invalid")
    expect(error.message).toMatch(message)
  })
})

describe("mount failures and recovery", () => {
  it("reports a host without git as a fetch failure naming the spawn error", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } })
    const empty = await temporary("smthrs-mount-nogit-")
    const error = await mountError(
      Mount.materialize(root, "up", { ...silent, environment: { ...process.env, PATH: empty } })
    )
    expect(error.code).toBe("mount_fetch_failed")
    expect(error.message).toMatch(/^git init failed: spawn git ENOENT/)
  })

  it("names the unreachable upstream when warn drift cannot read the branch and the fetch fails", async () => {
    const missing = NodePath.join(await temporary("smthrs-mount-gone-"), "absent.git")
    const root = await overlay(missing, { up: { ref: "1".repeat(40), track: "main", drift: "warn" } })
    const error = await mountError(Mount.materialize(root, "up", silent))
    expect(error.code).toBe("mount_fetch_failed")
    expect(error.message).toMatch(/^could not fetch 111111111111: git fetch failed: /)
  })

  it("keeps only the tail of a long git failure", async () => {
    const source = await upstream()
    const files = Array.from({ length: 120 }, (_, index) => `src/absent-${String(index).padStart(3, "0")}.txt`)
    const patch = files.map((file) =>
      `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`
    ).join("")
    const root = await overlay(source.root, { up: { ref: source.first, patches: ["patches/long.patch"] } }, {
      ".smithers/WORKSPACE.ts": workspaceFile,
      ".smithers/patches/long.patch": patch
    })
    const error = await mountError(Mount.materialize(root, "up", silent))
    expect(error.code).toBe("mount_patch_failed")
    const detail = error.message.slice(error.message.indexOf("git apply failed: ") + "git apply failed: ".length)
    expect(detail.length).toBe(2048)
    expect(detail).toContain("src/absent-119.txt")
    expect(detail).not.toContain("src/absent-000.txt")
  })

  it("re-materializes a checkout whose receipt has an unknown version", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.second } })
    const first = await Mount.materialize(root, "up", silent)
    const receipt = NodePath.join(first.root, ".git", Mount.receiptFile)
    await Fs.writeFile(receipt, JSON.stringify({ version: 2, head: "unused" }))
    const again = await Mount.materialize(root, "up", silent)
    expect(again.head).toBe(source.second)
    expect(JSON.parse(await Fs.readFile(receipt, "utf8"))).toMatchObject({ version: 1, head: source.second })
  })

  it("re-applies the patches when the checkout was reset behind the materialized head", async () => {
    const source = await upstream()
    const patch = "diff --git a/src/value.txt b/src/value.txt\n--- a/src/value.txt\n+++ b/src/value.txt\n" +
      "@@ -1 +1 @@\n-one\n+patched\n"
    const root = await overlay(source.root, { up: { ref: source.first, patches: ["patches/value.patch"] } }, {
      ".smithers/WORKSPACE.ts": workspaceFile,
      ".smithers/patches/value.patch": patch
    })
    const first = await Mount.materialize(root, "up", silent)
    expect(first.head).not.toBe(source.first)
    await git(first.root, ["reset", "--quiet", "--hard", source.first])
    expect(await read(first.root, "src/value.txt")).toBe("one\n")
    const again = await Mount.materialize(root, "up", silent)
    expect(await git(first.root, ["rev-parse", "HEAD"])).toBe(again.head)
    expect(await git(first.root, ["rev-parse", "HEAD^"])).toBe(source.first)
    expect(await read(first.root, "src/value.txt")).toBe("patched\n")
  })

  it.skipIf(process.platform === "win32")("lays regular overlay files and skips a named pipe", async () => {
    const source = await upstream()
    const root = await overlay(source.root, { up: { ref: source.first } }, {
      ".smithers/WORKSPACE.ts": workspaceFile,
      ".smithers/notes/kept.md": "kept\n"
    })
    await executeFile("mkfifo", [NodePath.join(root, ".smithers", "notes", "pipe")])
    const mounted = await Mount.materialize(root, "up", silent)
    const receipt = JSON.parse(await read(mounted.root, `.git/${Mount.receiptFile}`)) as {
      readonly laid: Readonly<Record<string, string>>
    }
    expect(Object.keys(receipt.laid).sort()).toEqual(["WORKSPACE.ts", "notes/kept.md"])
    expect(await read(mounted.root, ".smithers/notes/kept.md")).toBe("kept\n")
    expect(await exists(mounted.root, ".smithers/notes/pipe")).toBe(false)
  })
})
