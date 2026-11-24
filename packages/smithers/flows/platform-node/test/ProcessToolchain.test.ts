/**
 * The tools a confined run finds on `PATH`, layout by layout.
 *
 * Each layout is built with real directories and links under a temporary
 * home, with small shell scripts where the real installation has binaries.
 * A version manager's shim is a script that looks its version up the way the
 * real shim does. On a host with a kernel sandbox each layout also runs
 * confined: the tool answers, and the rest of the home stays unreadable.
 */
import { spawnSync } from "node:child_process"
import NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as ProcessSandbox from "../src/ProcessSandbox.ts"

const scratch = () => {
  const directory = process.env.SMITHERS_TEST_SCRATCH ?? NodeOs.tmpdir()
  NodeFs.mkdirSync(directory, { recursive: true })
  return NodeFs.realpathSync(NodeFs.mkdtempSync(NodePath.join(directory, "smthrs-toolchain-")))
}

let base: string
let home: string
let workspace: string

const write = (path: string, text: string, mode = 0o644): void => {
  NodeFs.mkdirSync(NodePath.dirname(path), { recursive: true })
  NodeFs.writeFileSync(path, text, { mode })
}
const program = (path: string, body: string): void => write(path, `#!/bin/sh\n${body}\n`, 0o755)
const link = (target: string, path: string): void => {
  NodeFs.mkdirSync(NodePath.dirname(path), { recursive: true })
  NodeFs.symlinkSync(target, path)
}

/** A Node installation: `bin/node`, and `bin/npm` linked into its package, which reads a sibling file. */
const nodeInstallation = (prefix: string, version: string): void => {
  program(`${prefix}/bin/node`, `echo node-${version}`)
  program(
    `${prefix}/lib/node_modules/npm/bin/npm-cli.js`,
    `echo npm-of-${version} $(cat "$(dirname "$(readlink -f "$0")")/../lib/cli.txt")`
  )
  write(`${prefix}/lib/node_modules/npm/lib/cli.txt`, "cli")
  write(`${prefix}/lib/node_modules/npm/package.json`, JSON.stringify({ name: "npm" }))
  link("../lib/node_modules/npm/bin/npm-cli.js", `${prefix}/bin/npm`)
}

/** Everything in the home that is no tool: none of it may be read. */
const secrets = (): ReadonlyArray<string> => [
  `${home}/.ssh/id_ed25519`,
  `${home}/.npmrc`,
  `${home}/.cargo/credentials.toml`,
  `${home}/.config/app/token`,
  `${home}/.local/share/keyrings/login.keyring`,
  `${home}/.local/notes.txt`,
  `${home}/Documents/plan.md`,
  `${home}/.secret`,
  `${home}/elsewhere/notes.txt`,
  `${home}/plain/notes.txt`
]

const p = (...parts: ReadonlyArray<string>): string => NodePath.join(...parts)

beforeAll(() => {
  base = scratch()
  home = p(base, "home")
  workspace = p(base, "ws")
  NodeFs.mkdirSync(workspace, { recursive: true })
  for (const secret of secrets()) write(secret, "private")

  // A plain installation, ~/.local/node/bin on PATH.
  nodeInstallation(`${home}/.local/node`, "plain")

  // nvm: ~/.nvm/versions/node/<version>/bin on PATH.
  nodeInstallation(`${home}/.nvm/versions/node/v22.1.0`, "nvm")

  // fnm: PATH names a per-shell link to the installation.
  nodeInstallation(`${home}/.local/share/fnm/node-versions/v22.1.0/installation`, "fnm")
  link(
    p(home, ".local/share/fnm/node-versions/v22.1.0/installation"),
    p(home, ".local/state/fnm_multishells/4242_1700000000000")
  )

  // Volta: every tool is a link to one shim, which reads the default platform under VOLTA_HOME or HOME.
  program(
    `${home}/.volta/bin/volta-shim`,
    "volta=\"${VOLTA_HOME:-$HOME/.volta}\"\n" +
      "exec \"$volta/tools/image/node/$(cat \"$volta/tools/user/platform.json\")/bin/$(basename \"$0\")\" \"$@\""
  )
  link("volta-shim", `${home}/.volta/bin/node`)
  write(`${home}/.volta/tools/user/platform.json`, "22.1.0")
  program(`${home}/.volta/tools/image/node/22.1.0/bin/node`, "echo node-volta")

  // asdf: a shim script that reads .tool-versions here, else in the home, and runs the install under the data directory.
  program(
    `${home}/.asdf/shims/node`,
    "version=$(sed -n 's/^nodejs //p' .tool-versions 2>/dev/null)\n" +
      "[ -n \"$version\" ] || version=$(sed -n 's/^nodejs //p' \"$HOME/.tool-versions\")\n" +
      "exec \"${ASDF_DATA_DIR:-$HOME/.asdf}/installs/nodejs/$version/bin/node\" \"$@\""
  )
  program(`${home}/.asdf/installs/nodejs/22.1.0/bin/node`, "echo node-asdf")
  write(`${home}/.tool-versions`, "nodejs 22.1.0\n")

  // mise: an activated shell puts the install on PATH through a version alias; a shim is a link to mise itself.
  nodeInstallation(`${home}/.local/share/mise/installs/node/22.1.0`, "mise")
  link("./22.1.0", `${home}/.local/share/mise/installs/node/22`)
  program(
    `${home}/.local/bin/mise`,
    "data=\"${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}\"\n" +
      "exec \"$data/installs/$(basename \"$0\")/22.1.0/bin/$(basename \"$0\")\" \"$@\""
  )
  link(`${home}/.local/bin/mise`, `${home}/.local/share/mise/shims/node`)

  // Bun: one binary, bunx linked to it, and a global package linked into its install tree.
  program(`${home}/.bun/bin/bun`, "echo bun-as-$(basename \"$0\")")
  link("bun", `${home}/.bun/bin/bunx`)
  program(`${home}/.bun/install/global/node_modules/cowsay/cli.js`, "echo moo")
  write(`${home}/.bun/install/global/node_modules/cowsay/package.json`, JSON.stringify({ name: "cowsay" }))
  link("../install/global/node_modules/cowsay/cli.js", `${home}/.bun/bin/cowsay`)

  // Zig: a link in ~/.local/bin to an unpacked release, which reads its lib directory.
  program(`${home}/.local/zig-0.17.1/zig`, "cat \"$(dirname \"$(readlink -f \"$0\")\")/lib/std.zig\"")
  write(`${home}/.local/zig-0.17.1/lib/std.zig`, "zig-std\n")
  link(`${home}/.local/zig-0.17.1/zig`, `${home}/.local/bin/zig`)
  // And an unpacked release that is itself on PATH.
  program(`${home}/zig-linux-0.13.0/zig`, "cat \"$(dirname \"$0\")/lib/std.zig\"")
  write(`${home}/zig-linux-0.13.0/lib/std.zig`, "zig-std-13\n")

  // rustup: proxies in ~/.cargo/bin run the toolchain ~/.rustup names.
  program(
    `${home}/.cargo/bin/rustup`,
    "rustup=\"${RUSTUP_HOME:-$HOME/.rustup}\"\n" +
      "exec \"$rustup/toolchains/$(cat \"$rustup/settings.toml\")/bin/$(basename \"$0\")\" \"$@\""
  )
  link("rustup", `${home}/.cargo/bin/cargo`)
  write(`${home}/.rustup/settings.toml`, "stable")
  program(`${home}/.rustup/toolchains/stable/bin/cargo`, "echo cargo-stable")

  // A tool no layout above describes: its shim runs another file of its own directory, through the home.
  program(`${home}/.vm/shims/tool`, "exec \"$HOME/.vm/toolchains/1/bin/tool\" \"$@\"")
  program(`${home}/.vm/toolchains/1/bin/tool`, "echo tool-1 $(cat \"$(dirname \"$0\")/../share/words.txt\")")
  write(`${home}/.vm/toolchains/1/share/words.txt`, "words")
  // The same by the home's own path, with the version added as the script runs.
  program(
    `${home}/.byname/bin/tool`,
    `exec "${home}/.byname/kept/$(cat "${home}/.byname/chosen")/tool" "$@"`
  )
  write(`${home}/.byname/chosen`, "2")
  program(`${home}/.byname/kept/2/tool`, "echo tool-2")
  // A wrapper that runs a tool kept in another directory of the home, where other things are kept too.
  program(`${home}/wrappers/bin/far`, "exec \"$HOME/elsewhere/tool\" \"$@\"")
  program(`${home}/elsewhere/tool`, "echo far")
  // A script that names its own program directory, the directory above it, what is not there, and a path outside
  // the home: none of them shows that the directory above is one tool's.
  program(
    `${home}/plain/bin/one`,
    "exec \"$HOME/plain/bin/two\" \"$@\"\n: \"${HOME}/plain\" ~/plain/gone/x \"$HOME\"/../outside a~/plain/notes.txt"
  )
  program(`${home}/plain/bin/two`, "echo two")

  // What a PATH directory may hold beside programs, and links that lead where no run may read.
  NodeFs.mkdirSync(`${base}/opt/odd/bin/subdirectory`, { recursive: true })
  link(`${base}/nowhere`, `${base}/opt/odd/bin/dangling`)
  write(`${home}/loose-tool`, "#!/bin/sh\necho loose\n", 0o755)
  link(`${home}/loose-tool`, `${base}/opt/odd/bin/loose`)
  write(`${home}/.ssh/agent-tool`, "#!/bin/sh\necho agent\n", 0o755)
  link(`${home}/.ssh/agent-tool`, `${base}/opt/odd/bin/agent`)
  write(`${base}/ws/tool.sh`, "#!/bin/sh\necho workspace\n", 0o755)
  link(`${base}/ws/tool.sh`, `${base}/opt/odd/bin/inside`)
  link(`${base}/opt/impl/mawk`, `${base}/ws/hop`)
  link(`${base}/ws/hop`, `${base}/opt/odd/bin/through-workspace`)
  link(`${base}/opt/impl/mawk`, `${home}/.ssh/hop`)
  link(`${home}/.ssh/hop`, `${base}/opt/odd/bin/through-credentials`)

  // pnpm's cmd-shim: a script that names the program it runs, in a package elsewhere.
  program(`${base}/opt/store/pnpm/bin/pnpm.cjs`, "echo pnpm")
  write(`${base}/opt/store/pnpm/package.json`, JSON.stringify({ name: "pnpm" }))
  program(
    `${base}/opt/pnpm-home/pnpm`,
    `exec "${base}/opt/store/pnpm/bin/pnpm.cjs" "$@"\n# cmd-shim-target=${base}/opt/store/pnpm/bin/pnpm.cjs`
  )
  program(`${base}/opt/pnpm-home/stale`, `exit 1\n# cmd-shim-target=${base}/opt/store/gone/bin/gone.cjs`)

  // A version manager outside the home, and one in a home with no version file.
  program(`${base}/opt/asdf/shims/node`, "echo node")
  NodeFs.mkdirSync(`${base}/opt/asdf/installs`, { recursive: true })
  program(`${base}/bare-home/.asdf/shims/node`, "echo node")
  NodeFs.mkdirSync(`${base}/bare-home/.asdf/installs`, { recursive: true })
  program(`${base}/bare-home/.cargo/bin/rustup`, "echo rustup")
  program(`${base}/bare-home/with-rustup/bin/rustup`, "echo rustup")
  NodeFs.mkdirSync(`${base}/bare-home/with-rustup/home/.rustup`, { recursive: true })

  // A tool reached through a link in a directory the run cannot read, as /etc/alternatives is.
  program(`${base}/opt/impl/mawk`, "echo mawk")
  link(`${base}/opt/impl/mawk`, `${base}/alternatives/awk`)
  write(`${base}/alternatives/README`, "private")
  link(`${base}/alternatives/awk`, `${base}/opt/tools/bin/awk`)
})

afterAll(() => {
  NodeFs.rmSync(base, { recursive: true, force: true })
})

/** The real host with the temporary home and one PATH. */
const facts = (searchPath: string): ProcessSandbox.Host => {
  const real = ProcessSandbox.host({ PATH: searchPath })
  // The sandbox's own program is found wherever this machine keeps it.
  return { ...real, home, executable: (name) => real.executable(name) ?? ProcessSandbox.host().executable(name) }
}

const systemPath = "/usr/bin:/bin"

/** Runs a script confined to what the toolchain of `searchPath` opens; nothing on a host with no kernel sandbox. */
const confined = (searchPath: string, script: string): { status: number | null; stdout: string; stderr: string } => {
  const hostFacts = facts(`${searchPath}:${systemPath}`)
  const found = ProcessSandbox.toolchain(searchPath, workspace, hostFacts)
  const tmp = NodeFs.mkdtempSync(NodePath.join(base, "run-"))
  const plan = ProcessSandbox.plan(
    {
      network: "none",
      reads: [],
      writes: [],
      externalReads: found.reads,
      externalLinks: found.links,
      privateLinks: found.privateLinks
    },
    { workspaceRoot: workspace, cwd: workspace, tmp },
    hostFacts
  )
  if (ProcessSandbox.isUnenforceable(plan)) throw new Error(plan.message)
  NodeFs.mkdirSync(`${tmp}/home`, { recursive: true })
  // Seatbelt runs on the host's files, so its private links are made here.
  for (const placed of plan.privateLinks ?? []) link(placed.target, `${tmp}/${placed.path}`)
  const wrapped = ProcessSandbox.wrap(
    plan,
    ["/bin/sh", "-c", script],
    { PATH: `${searchPath}:${systemPath}` },
    hostFacts
  )
  const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
    cwd: workspace,
    encoding: "utf8",
    timeout: 20_000,
    env: { PATH: `${searchPath}:${systemPath}`, ...wrapped.env }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const sandboxed = process.platform === "linux"
  ? ProcessSandbox.host().executable("bwrap") !== undefined
  : process.platform === "darwin"

interface Layout {
  readonly name: string
  /** `PATH`, relative to the temporary home unless absolute. */
  readonly path: ReadonlyArray<string>
  /** What the toolchain reads, relative to the temporary base. */
  readonly reads: ReadonlyArray<string>
  readonly links?: ReadonlyArray<readonly [path: string, target: string]>
  readonly privateLinks?: ReadonlyArray<readonly [path: string, target: string]>
  readonly selections?: ReadonlyArray<string>
  /** A script the confined run executes, and what it prints. */
  readonly script: string
  readonly prints: string
}

const layouts: ReadonlyArray<Layout> = [
  {
    name: "a tool whose shim runs another file of its own directory",
    path: [".vm/shims"],
    reads: ["home/.vm"],
    privateLinks: [["home/.vm", "home/.vm"]],
    script: "tool",
    prints: "tool-1 words\n"
  },
  {
    name: "a tool whose script names its own directory by the home's path",
    path: [".byname/bin"],
    reads: ["home/.byname"],
    privateLinks: [["home/.byname", "home/.byname"]],
    script: "tool",
    prints: "tool-2\n"
  },
  {
    name: "a plain ~/.local/<tool>/bin",
    path: [".local/node/bin"],
    reads: ["home/.local/node"],
    script: "node; npm",
    prints: "node-plain\nnpm-of-plain cli\n"
  },
  {
    name: "nvm",
    path: [".nvm/versions/node/v22.1.0/bin"],
    reads: ["home/.nvm/versions/node/v22.1.0"],
    script: "node; npm",
    prints: "node-nvm\nnpm-of-nvm cli\n"
  },
  {
    name: "fnm",
    path: [".local/state/fnm_multishells/4242_1700000000000/bin"],
    reads: ["home/.local/share/fnm/node-versions/v22.1.0/installation"],
    links: [[
      "home/.local/state/fnm_multishells/4242_1700000000000",
      "home/.local/share/fnm/node-versions/v22.1.0/installation"
    ]],
    script: "node; npm",
    prints: "node-fnm\nnpm-of-fnm cli\n"
  },
  {
    name: "Volta",
    path: [".volta/bin"],
    reads: ["home/.volta"],
    privateLinks: [["home/.volta", "home/.volta"]],
    selections: ["home/.volta/tools/user/platform.json"],
    script: "node",
    prints: "node-volta\n"
  },
  {
    name: "asdf",
    path: [".asdf/shims"],
    reads: ["home/.asdf", "home/.tool-versions"],
    privateLinks: [["home/.asdf", "home/.asdf"], ["home/.tool-versions", "home/.tool-versions"]],
    selections: ["home/.tool-versions"],
    script: "node",
    prints: "node-asdf\n"
  },
  {
    name: "mise in an activated shell",
    path: [".local/share/mise/installs/node/22/bin"],
    reads: ["home/.local/share/mise/installs/node/22.1.0"],
    links: [["home/.local/share/mise/installs/node/22", "./22.1.0"]],
    script: "node; npm",
    prints: "node-mise\nnpm-of-mise cli\n"
  },
  {
    name: "mise shims",
    path: [".local/share/mise/shims"],
    reads: ["home/.local/bin", "home/.tool-versions", "home/.local/share/mise"],
    privateLinks: [
      ["home/.local/share/mise", "home/.local/share/mise"],
      ["data/mise", "home/.local/share/mise"],
      ["home/.tool-versions", "home/.tool-versions"]
    ],
    selections: ["home/.tool-versions"],
    script: "node",
    prints: "node-mise\n"
  },
  {
    name: "Bun under ~/.bun",
    path: [".bun/bin"],
    reads: ["home/.bun/bin", "home/.bun/install/global/node_modules/cowsay"],
    script: "bun; bunx; cowsay",
    prints: "bun-as-bun\nbun-as-bunx\nmoo\n"
  },
  {
    name: "Zig linked from ~/.local/bin",
    path: [".local/bin"],
    reads: ["home/.local/bin", "home/.local/zig-0.17.1"],
    script: "zig",
    prints: "zig-std\n"
  },
  {
    name: "Zig unpacked onto PATH",
    path: ["zig-linux-0.13.0"],
    reads: ["home/zig-linux-0.13.0"],
    script: "zig",
    prints: "zig-std-13\n"
  },
  {
    name: "rustup",
    path: [".cargo/bin"],
    reads: ["home/.cargo/bin", "home/.rustup"],
    privateLinks: [["home/.rustup", "home/.rustup"]],
    selections: ["home/.rustup/settings.toml"],
    script: "cargo",
    prints: "cargo-stable\n"
  }
]

describe("the tools on PATH under a home directory", () => {
  it.each(layouts)("reads $name and its install root, and nothing else of the home", (layout) => {
    const searchPath = layout.path.map((entry) => p(home, entry)).join(NodePath.delimiter)
    const found = ProcessSandbox.toolchain(searchPath, workspace, facts(searchPath))
    const absolute = (path: string) => (path.startsWith(".") ? path : p(base, path))
    expect([...found.reads].sort()).toEqual(layout.reads.map(absolute).sort())
    expect(found.links).toEqual((layout.links ?? []).map(([path, target]) => ({
      path: absolute(path),
      target: absolute(target)
    })))
    expect(found.privateLinks).toEqual(
      (layout.privateLinks ?? []).map(([path, target]) => ({ path, target: absolute(target) }))
    )
    expect(found.selections).toEqual((layout.selections ?? []).map(absolute))
    // No read is, holds, or sits inside anything private.
    for (const secret of secrets().map((entry) => NodePath.normalize(entry))) {
      for (const read of found.reads) {
        expect(secret === read || secret.startsWith(`${read}${NodePath.sep}`), `${read} opens ${secret}`).toBe(false)
      }
    }
  })

  it.skipIf(!sandboxed).each(layouts)("runs $name confined, with the rest of the home unreadable", (layout) => {
    const searchPath = layout.path.map((entry) => `${home}/${entry}`).join(":")
    const run = confined(searchPath, layout.script)
    expect(run.stdout, run.stderr).toBe(layout.prints)
    expect(run.status).toBe(0)
    for (const secret of secrets()) {
      const read = confined(searchPath, `cat '${secret}'`)
      expect(read.status, secret).not.toBe(0)
      expect(read.stdout).not.toContain("private")
    }
  })

  it.skipIf(!sandboxed)("reaches a tool through a link in a directory the run cannot read", () => {
    const searchPath = `${base}/opt/tools/bin`
    const found = ProcessSandbox.toolchain(searchPath, workspace, facts(searchPath))
    expect(found.reads).toEqual([`${base}/opt/impl`, `${base}/opt/tools/bin`])
    // The first link sits in a directory the run reads; only the second needs placing.
    expect(found.links).toEqual([{ path: `${base}/alternatives/awk`, target: `${base}/opt/impl/mawk` }])
    expect(confined(searchPath, "awk").stdout).toBe("mawk\n")
    // The link is placed; the directory it sits in is not opened.
    expect(confined(searchPath, `cat '${base}/alternatives/README'`).status).not.toBe(0)
  })

  it.skipIf(!sandboxed)("keeps a tool the host does not have missing", () => {
    const run = confined(`${home}/.bun/bin`, "node")
    expect(run.status).toBe(127)
    expect(run.stderr).toContain("node")
  })
})

describe("what the toolchain never opens", () => {
  const found = (searchPath: string, overrides: Partial<ProcessSandbox.Host> = {}) =>
    ProcessSandbox.toolchain(searchPath, workspace, { ...facts(searchPath), ...overrides })

  it("skips an entry that is empty, relative, missing, a file, or named twice", () => {
    const bin = `${home}/.bun/bin`
    const once = found(bin)
    expect(found(`:relative/bin:${base}/missing:${bin}/bun:${bin}:${bin}`)).toEqual(once)
    // No PATH at all opens nothing.
    expect(ProcessSandbox.toolchain(undefined, workspace, facts(""))).toEqual({
      reads: [],
      links: [],
      privateLinks: [],
      selections: []
    })
  })

  it("never opens the home, an ancestor of it, a credential location, or the workspace", () => {
    link(home, `${base}/home-alias`)
    link(`${base}/opt/impl`, `${base}/ws/linked-bin`)
    const closed = [
      home,
      base,
      `${home}/.ssh`,
      `${base}/home-alias`,
      workspace,
      `${workspace}/linked-bin`
    ]
    expect(found(closed.join(":"))).toEqual({ reads: [], links: [], privateLinks: [], selections: [] })
  })

  it("brings nothing for a script that runs a file in another directory of the home", () => {
    const far = found(p(home, "wrappers/bin"))
    expect(far.reads).toEqual([p(home, "wrappers/bin")])
    expect(far.privateLinks).toEqual([])
  })

  it.skipIf(!sandboxed)("leaves that file missing in a confined run, and what lies beside it unread", () => {
    const searchPath = `${home}/wrappers/bin`
    const run = confined(searchPath, "far")
    expect(run.status).not.toBe(0)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain("/home/elsewhere/tool")
    expect(confined(searchPath, `cat '${home}/elsewhere/notes.txt'`).status).not.toBe(0)
  })

  it("takes no directory for one tool's on a script that names only its program directory, the directory itself, what is not there, or a path outside the home", () => {
    const plain = found(p(home, "plain/bin"))
    expect(plain.reads).toEqual([p(home, "plain/bin")])
    expect(plain.privateLinks).toEqual([])
  })

  it("reads no script on a host that cannot read or list one, and names no path of a home it does not know", () => {
    const shims = p(home, ".vm/shims")
    expect(found(shims, { scriptText: undefined }).reads).toEqual([shims])
    expect(found(shims, { entries: undefined }).reads).toEqual([shims])
    const homeless = found(shims, { home: undefined })
    expect(homeless.reads).toEqual([shims])
    expect(homeless.privateLinks).toEqual([])
  })

  it("reads nothing a system directory already holds", () => {
    const system = found("/usr/bin")
    expect(system.reads.filter((read) => read === "/usr/bin" || read.startsWith("/usr/"))).toEqual([])
  })

  it("opens the one file when the directory holding a linked program may not be opened, and nothing when the file may not", () => {
    const odd = found(p(base, "opt/odd/bin"))
    // `loose` is a file in the home itself; `agent` is in a credential location; `inside` is in the workspace.
    expect([...odd.reads].sort()).toEqual([p(home, "loose-tool"), p(base, "opt/impl"), p(base, "opt/odd/bin")].sort())
    // A link that sits in the workspace or in a credential location is never placed.
    expect(odd.links).toEqual([])
  })

  it("follows a package manager's shim script to the package it runs", () => {
    const pnpm = found(p(base, "opt/pnpm-home"))
    // `stale` names a program that is gone, so it brings nothing.
    expect(pnpm.reads).toEqual([p(base, "opt/pnpm-home"), p(base, "opt/store/pnpm")])
  })

  it("places a version manager's home under the private one only when it is under the real one", () => {
    const outside = found(p(base, "opt/asdf/shims"))
    expect(outside.reads).toEqual([p(base, "opt/asdf")])
    expect(outside.privateLinks).toEqual([])
    expect(outside.selections).toEqual([])
  })

  it("adds a version file and a rustup home only where they exist", () => {
    const bare = p(base, "bare-home")
    const asdf = found(p(bare, ".asdf/shims"), { home: bare })
    expect(asdf.reads).toEqual([p(bare, ".asdf")])
    expect(asdf.privateLinks).toEqual([{ path: "home/.asdf", target: p(bare, ".asdf") }])
    expect(asdf.selections).toEqual([])
    const rustless = found(p(bare, ".cargo/bin"), { home: bare })
    expect(rustless.reads).toEqual([p(bare, ".cargo/bin")])
    expect(rustless.privateLinks).toEqual([])
    // A rustup home with no settings chooses nothing yet.
    const unset = found(p(bare, "with-rustup/bin"), { home: p(bare, "with-rustup/home") })
    expect(unset.reads).toEqual([p(bare, "with-rustup/bin"), p(bare, "with-rustup/home/.rustup")])
    expect(unset.privateLinks).toEqual([{ path: "home/.rustup", target: p(bare, "with-rustup/home/.rustup") }])
    expect(unset.selections).toEqual([])
  })

  it("takes no directory at the top of the filesystem, and no shared home directory, for a prefix", () => {
    const top: ProcessSandbox.Host = {
      platform: "linux",
      home: "/home/u",
      executable: () => undefined,
      exists: (path) =>
        ["/snap/bin", "/snap", "/snap/lib", "/home/u/.local/bin", "/home/u/.local", "/home/u/.local/lib"].includes(
          path
        ),
      isDirectory: () => true,
      uid: 1,
      gid: 1
    }
    // With no listing, no link probe and no real paths, each directory still opens as spelled.
    expect(ProcessSandbox.toolchain("/snap/bin:/home/u/.local/bin", "/work/ws", top).reads).toEqual([
      "/snap/bin",
      "/home/u/.local/bin"
    ])
    const { home: _, ...homeless } = top
    expect(ProcessSandbox.toolchain("/snap/bin", "/work/ws", homeless)).toEqual({
      reads: ["/snap/bin"],
      links: [],
      privateLinks: [],
      selections: []
    })
  })

  it("places the link a system program is reached through, and stops at a chain it cannot read", () => {
    const links: Readonly<Record<string, string>> = {
      "/usr/bin/awk": "/etc/alternatives/awk",
      "/etc/alternatives/awk": "/usr/bin//mawk/",
      "/usr/bin/broken": "/etc/alternatives/unreadable"
    }
    const system: ProcessSandbox.Host = {
      platform: "linux",
      home: "/home/u",
      executable: () => undefined,
      exists: (path) => ["/usr", "/usr/bin", "/usr/bin/awk", "/usr/bin/broken", "/usr/bin/mawk"].includes(path),
      isDirectory: (path) => path === "/usr/bin",
      isSymbolicLink: (path) => path in links || path === "/etc/alternatives/unreadable",
      readlink: (path) => links[path],
      entries: () => ["awk", "broken", "mawk"],
      realpath: (path) => (path === "/usr/bin/awk" || path === "/usr/bin/broken" ? "/usr/bin/mawk" : path),
      uid: 1,
      gid: 1
    }
    expect(ProcessSandbox.toolchain("/usr/bin", "/work/ws", system)).toEqual({
      reads: [],
      links: [{ path: "/etc/alternatives/awk", target: "/usr/bin//mawk/" }],
      privateLinks: [],
      selections: []
    })
    // A chain of links with no end is not followed past the limit a kernel sets.
    const endless: ProcessSandbox.Host = {
      ...system,
      isSymbolicLink: (path) => path.startsWith("/loop/") || path === "/usr/bin/awk",
      readlink: (path) => path === "/usr/bin/awk" ? "/loop/0" : `/loop/${Number(path.slice(6)) + 1}`,
      entries: () => ["awk"]
    }
    expect(ProcessSandbox.toolchain("/usr/bin", "/work/ws", endless).links).toEqual([])
  })

  it("reads links with the real host when the host facts carry no probe", () => {
    const searchPath = p(home, ".local/state/fnm_multishells/4242_1700000000000/bin")
    const { isSymbolicLink: _, readlink: __, ...bare } = facts(searchPath)
    expect(ProcessSandbox.toolchain(searchPath, workspace, bare).links).toEqual([{
      path: p(home, ".local/state/fnm_multishells/4242_1700000000000"),
      target: p(home, ".local/share/fnm/node-versions/v22.1.0/installation")
    }])
    // A path the probe calls a link and the host cannot read as one is left out.
    const confused = { ...bare, isSymbolicLink: (path: string) => path === p(home, ".local") }
    expect(ProcessSandbox.toolchain(searchPath, workspace, confused).links).toEqual([])
  })
})

describe("placing host links", () => {
  const root = "/work/ws"
  const fake = (platform: NodeJS.Platform, sandbox: Readonly<Record<string, string>>): ProcessSandbox.Host => ({
    platform,
    executable: (name) => sandbox[name],
    exists: (path) => path === "/home/u/.volta" || path === "/opt/real",
    isDirectory: () => true,
    isSymbolicLink: () => false,
    realpath: (path) => path,
    uid: 501,
    gid: 20
  })
  const linux = fake("linux", { bwrap: "/usr/bin/bwrap" })
  const darwin = fake("darwin", { "/usr/bin/sandbox-exec": "/usr/bin/sandbox-exec" })
  const request: ProcessSandbox.Request = {
    network: "none",
    reads: [],
    writes: [],
    externalReads: ["/home/u/.volta", "/opt/real"],
    externalLinks: [
      { path: "/opt/link", target: "/opt/real" },
      { path: "/home/u/.volta/bin/node", target: "volta-shim" },
      { path: "relative/link", target: "x" },
      { path: `${root}/inside`, target: "/opt/real" }
    ],
    privateLinks: [
      { path: "home/.volta", target: "/home/u/.volta" },
      { path: "/abs", target: "/home/u/.volta" },
      { path: "home/../../escape", target: "/home/u/.volta" }
    ]
  }
  const planned = (hostFacts: ProcessSandbox.Host, override: Partial<ProcessSandbox.Request> = {}) => {
    const plan = ProcessSandbox.plan({ ...request, ...override }, {
      workspaceRoot: root,
      cwd: root,
      tmp: "/private/run1"
    }, hostFacts)
    if (ProcessSandbox.isUnenforceable(plan)) throw new Error(plan.message)
    return plan
  }

  it("keeps a host link outside the workspace and a private link inside its private directory", () => {
    const plan = planned(linux)
    expect(plan.externalLinks).toEqual([
      { path: "/opt/link", target: "/opt/real" },
      { path: "/home/u/.volta/bin/node", target: "volta-shim" }
    ])
    expect(plan.privateLinks).toEqual([{ path: "home/.volta", target: "/home/u/.volta" }])
    const none = planned(linux, { externalLinks: undefined, privateLinks: undefined })
    expect(none).not.toHaveProperty("externalLinks")
    expect(none).not.toHaveProperty("privateLinks")
  })

  it("has bubblewrap create each link no bind holds, and the private links in its own home", () => {
    const argv = ProcessSandbox.bubblewrap(planned(linux), ["true"], linux)
    const symlinks = argv.flatMap((entry, index) => entry === "--symlink" ? [argv.slice(index + 1, index + 3)] : [])
    expect(symlinks).toEqual([["/opt/real", "/opt/link"], ["/home/u/.volta", "/smthrs/home/.volta"]])
    // After the binds, before the root is closed.
    expect(argv.indexOf("--symlink")).toBeGreaterThan(argv.indexOf("/opt/real"))
    expect(argv.indexOf("--symlink")).toBeLessThan(argv.lastIndexOf("--remount-ro"))
    expect(ProcessSandbox.bubblewrap(planned(linux, { externalLinks: [], privateLinks: [] }), ["true"], linux))
      .not.toContain("--symlink")
  })

  it("grants seatbelt each host link as itself, with the directories above it", () => {
    const profile = ProcessSandbox.seatbelt(planned(darwin), darwin)
    expect(profile).toContain(
      "(allow file-read* (literal \"/opt/link\") (literal \"/home/u/.volta/bin/node\"))"
    )
    expect(profile).toMatch(/\(allow file-read-metadata [^\n]*\(literal "\/opt"\)/)
    expect(profile).not.toContain("(subpath \"/opt/link\")")
    expect(ProcessSandbox.seatbelt(planned(darwin, { externalLinks: [] }), darwin)).not.toContain("/opt/link")
  })
})

describe("the Windows drives WSL mounts", () => {
  it("are read from the mount table: a drvfs mount, a 9p mount of drvfs, and a mount whose source is a drive", () => {
    const table = `${base}/mountinfo`
    write(
      table,
      [
        "28 34 0:25 / /sys rw,nosuid,nodev shared:7 - sysfs sysfs rw",
        "89 75 0:58 / /mnt/c rw,noatime - 9p C:\\134 rw,dirsync,aname=drvfs;path=C:\;uid=1000;gid=1000",
        "90 75 0:59 / /mnt/d rw,noatime - drvfs D: rw",
        "91 75 0:60 / /mnt/my\\040drive rw,noatime - virtiofs E:\\134 rw",
        "92 34 0:61 / /mnt/data rw,noatime - 9p data rw,trans=virtio",
        "93 34 0:62 / /truncated rw - 9p",
        ""
      ].join("\n")
    )
    expect(ProcessSandbox.windowsDrives(table)).toEqual(["/mnt/c", "/mnt/d", "/mnt/my drive"])
    expect(ProcessSandbox.windowsDrives(`${base}/no-mount-table`)).toEqual([])
  })

  it("hold no PATH entry the toolchain lists, named directly or through a link", () => {
    // WSL appends the Windows PATH; listing System32 over the drive mount took minutes per run.
    const drive = p(base, "wsl/mnt/c")
    const system32 = p(drive, "Windows/System32")
    const linked = p(base, "wsl/system32")
    program(p(system32, "where.exe"), "echo windows")
    link(system32, linked)
    const bin = p(home, ".bun/bin")
    const searchPath = [system32, linked, bin].join(NodePath.delimiter)
    const hostFacts = facts(searchPath)
    const listed: Array<string> = []
    const found = ProcessSandbox.toolchain(searchPath, workspace, {
      ...hostFacts,
      windowsDrives: [drive],
      entries: (directory) => {
        listed.push(directory)
        return hostFacts.entries!(directory)
      }
    })
    expect(found).toEqual(ProcessSandbox.toolchain(bin, workspace, facts(bin)))
    expect(listed.filter((directory) => directory.startsWith(drive))).toEqual([])
    // Without the fact, the same PATH lists the drive.
    expect(ProcessSandbox.toolchain(searchPath, workspace, hostFacts).reads).toContain(system32)
  })
})
