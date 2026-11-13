/**
 * The relocation table, against the flow schemas it rewrites for.
 *
 * `Checkpoints.test.ts` pins the git store; this pins the half that decides what
 * a checkpoint can be pointed at, which is the part a wrong answer would
 * silently corrupt. The last case decodes every rewritten input with the flow's
 * own `Input` schema, so renaming a field in `Bash`, `Read`, `Ls`, `Grep` or
 * `Glob` without moving the table fails here instead of relocating nothing.
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import type * as Checkpoints from "../src/Checkpoints.ts"
import * as Glob from "../src/Glob.ts"
import * as Grep from "../src/Grep.ts"
import * as Ls from "../src/Ls.ts"
import * as Read from "../src/Read.ts"
import * as Relocate from "../src/Relocate.ts"

const materialized: Checkpoints.Materialized = {
  id: "cp-0-1",
  host: "/work/repo/.flows-checkpoints/cp-0-1",
  guest: "/testbed/.flows-checkpoints/cp-0-1",
  root: "/work/repo",
  guestRoot: "/testbed"
}

/** The workspace-relative directory a reader is rebased onto. */
const scratch = ".flows-checkpoints/cp-0-1"

const rewritten = (flow: string, input: Schema.Json): Schema.Json => {
  const relocation = Relocate.relocate(flow, input, materialized)
  expect(relocation).toMatchObject({ _tag: "Relocated" })
  if (relocation._tag !== "Relocated") throw new Error("not relocated")
  return relocation.input
}

describe("precheck", () => {
  it("refuses unsupported flows without a materialized tree", () => {
    expect(Relocate.precheck("apply_patch", {})).toEqual({ _tag: "UnsupportedFlow" })
  })

  for (const [flow, field] of [["read", "path"], ["ls", "path"], ["grep", "root"], ["glob", "root"]] as const) {
    it(`validates ${flow} paths before checkout`, () => {
      for (const path of ["/absolute/file", "/"]) {
        expect(Relocate.precheck(flow, { [field]: path })).toEqual({ _tag: "AbsolutePath", path })
      }
      for (const path of ["../outside", "a/../../outside", "./../"]) {
        expect(Relocate.precheck(flow, { [field]: path })).toEqual({ _tag: "OutsideTree", path })
      }
      for (const path of [null, 1, true, [], {}]) {
        expect(Relocate.precheck(flow, { [field]: path })).toEqual({ _tag: "UnsupportedFlow" })
      }
      for (const path of ["", ".", "file", "a/../file", "a/.."]) {
        expect(Relocate.precheck(flow, { [field]: path })).toBeUndefined()
      }
      for (const input of [{}, null, [], "file"]) {
        expect(Relocate.precheck(flow, input)).toBeUndefined()
      }
    })
  }

  it("leaves shell command checks to relocation with the real roots", () => {
    const input = { command: "cat /work/repo/file" }
    expect(Relocate.precheck("bash", input)).toBeUndefined()
    expect(Relocate.relocate("bash", input, materialized)).toEqual({ _tag: "OutsideTree", path: "/work/repo/file" })
  })
})

describe("relocate", () => {
  it("points a shell call at the checkpoint's own directory", () => {
    expect(Relocate.relocate("bash", { mode: "unhermetic", command: "bin/test" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { mode: "unhermetic", command: "bin/test", cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("gives a containerised shell call the path the container will resolve", () => {
    // The container reaches the workspace through a mount, so it reaches the
    // scratch checkout at the same subpath under that mount. `bash` says which
    // side it is on by naming a container, so this reads the same field.
    expect(
      Relocate.relocate(
        "bash",
        { mode: "unhermetic", command: "bin/test", container: "swebench-1" },
        materialized
      )
    ).toEqual({
      _tag: "Relocated",
      input: {
        mode: "unhermetic",
        command: "bin/test",
        container: "swebench-1",
        cwd: "/testbed/.flows-checkpoints/cp-0-1"
      }
    })
  })

  it("overrides a cwd the caller supplied, because at is where the call runs", () => {
    expect(Relocate.relocate("bash", { command: "x", cwd: "/elsewhere" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { command: "x", cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
    // Including one that climbs out of the workspace: a checkpoint is a copy of
    // the tree and holds no copy of anywhere else, so there is no subpath to
    // keep and the tree itself is the whole of what can be offered.
    expect(Relocate.relocate("bash", { command: "x", cwd: "../sibling" }, materialized)).toMatchObject({
      input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("keeps the subdirectory a shell call named, on both sides of the mount", () => {
    // The failure this closes is a false baseline. django's suite is run as
    // `./runtests.py` from `tests/`; dropping that `tests/` runs it at the
    // repository top, where the script does not exist, and the non-zero exit
    // reads as "the check fails on the pinned tree" when nothing was checked at
    // all. A checkpoint that manufactures a failing baseline is worse than no
    // checkpoint.
    expect(
      Relocate.relocate("bash", { command: "./runtests.py", cwd: "tests" }, materialized)
    ).toMatchObject({ input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1/tests" } })
    // The same directory named absolutely, from inside the container.
    expect(
      Relocate.relocate(
        "bash",
        { command: "./runtests.py", cwd: "/testbed/tests", container: "swebench-1" },
        materialized
      )
    ).toMatchObject({ input: { cwd: "/testbed/.flows-checkpoints/cp-0-1/tests" } })
    // And named absolutely on the host, which is the same question asked of the
    // other of the two names.
    expect(
      Relocate.relocate("bash", { command: "x", cwd: "/work/repo/sympy/stats" }, materialized)
    ).toMatchObject({ input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1/sympy/stats" } })
    // The workspace root itself names no subdirectory, under either name.
    for (const cwd of ["/work/repo", "/work/repo/", ".", "./"]) {
      expect(Relocate.relocate("bash", { command: "x", cwd }, materialized)).toMatchObject({
        input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
      })
    }
  })

  it("treats an empty container name as no container", () => {
    expect(Relocate.relocate("bash", { command: "x", container: "" }, materialized)).toMatchObject({
      input: { cwd: "/work/repo/.flows-checkpoints/cp-0-1" }
    })
  })

  it("prefixes a reader's relative path with the checkpoint's directory", () => {
    // These flows resolve their subject against the workspace root, and the
    // checkpoint is a directory under it, so the prefix is workspace-relative.
    expect(Relocate.relocate("read", { path: "sympy/stats/crv_types.py" }, materialized)).toEqual({
      _tag: "Relocated",
      input: { path: ".flows-checkpoints/cp-0-1/sympy/stats/crv_types.py" }
    })
    expect(Relocate.relocate("ls", { path: "sympy" }, materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1/sympy" }
    })
    expect(Relocate.relocate("grep", { pattern: "def _cdf", root: "sympy/stats" }, materialized)).toMatchObject({
      input: { pattern: "def _cdf", root: ".flows-checkpoints/cp-0-1/sympy/stats" }
    })
    expect(Relocate.relocate("glob", { pattern: "**/*.py", root: "sympy/" }, materialized)).toMatchObject({
      input: { pattern: "**/*.py", root: ".flows-checkpoints/cp-0-1/sympy" }
    })
  })

  it("takes the checkpoint's own directory when the reader names no root", () => {
    for (const named of [{}, { root: "" }, { root: "." }]) {
      expect(Relocate.relocate("grep", { pattern: "x", ...named }, materialized)).toMatchObject({
        input: { root: ".flows-checkpoints/cp-0-1" }
      })
    }
  })

  it("refuses an absolute path rather than guessing which prefix names the tree", () => {
    // An absolute path in these runs is a container path, and the host cannot
    // know which part of it is the repository.
    expect(Relocate.relocate("read", { path: "/testbed/a.py" }, materialized)).toEqual({
      _tag: "AbsolutePath",
      path: "/testbed/a.py"
    })
  })

  it("refuses a reader's path that climbs back out into the live tree", () => {
    // `.flows-checkpoints/cp-0-1/../../mod.py` is `mod.py` in the live tree.
    // Rewriting it would hand the cell the very work it took the reading to
    // avoid, under the checkpoint's own name — and because the checkpoint is
    // folded into the call key, that live reading would replay as a pinned one
    // for the rest of the run.
    for (const path of ["../../mod.py", "../..", "a/../../../mod.py", "./../../mod.py"]) {
      expect(Relocate.relocate("read", { path }, materialized)).toEqual({ _tag: "OutsideTree", path })
    }
    expect(Relocate.relocate("grep", { pattern: "x", root: "../.." }, materialized)).toEqual({
      _tag: "OutsideTree",
      path: "../.."
    })
    // A `..` that stays inside is arithmetic, not an escape, and resolves.
    expect(Relocate.relocate("read", { path: "sympy/../mod.py" }, materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1/mod.py" }
    })
  })

  it("refuses a shell call whose command names the live tree by absolute path", () => {
    // `cd /testbed && pytest` leaves the checkout at once, so the "before"
    // reading would test the agent's edited tree under the checkpoint's name,
    // and a fix that passes both readings would read as "never failed".
    const container = { mode: "unhermetic", container: "swebench-1" } as const
    expect(
      Relocate.relocate(
        "bash",
        { ...container, command: "cd /testbed && python -m pytest tests/test_x.py" },
        materialized
      )
    ).toEqual({ _tag: "OutsideTree", path: "/testbed" })
    expect(Relocate.relocate("bash", { ...container, command: "pytest /testbed/tests/test_x.py" }, materialized))
      .toEqual({ _tag: "OutsideTree", path: "/testbed/tests/test_x.py" })
    expect(Relocate.relocate("bash", { ...container, command: "pytest --rootdir=/testbed" }, materialized))
      .toEqual({ _tag: "OutsideTree", path: "/testbed" })
    // Every text the shell or its program reads, on the host side too.
    expect(Relocate.relocate("bash", { script: "import os; os.chdir('/work/repo')" }, materialized))
      .toEqual({ _tag: "OutsideTree", path: "/work/repo" })
    expect(Relocate.relocate("bash", { script: "cat \"$1\"", args: ["/work/repo/mod.py"] }, materialized))
      .toEqual({ _tag: "OutsideTree", path: "/work/repo/mod.py" })
    expect(Relocate.relocate("bash", { command: "make", env: { SRC: "/work/repo/src" } }, materialized))
      .toEqual({ _tag: "OutsideTree", path: "/work/repo/src" })
    // A path that climbs out of the checkout is the live tree too.
    expect(
      Relocate.relocate(
        "bash",
        { ...container, command: "cat /testbed/.flows-checkpoints/cp-0-1/../mod.py" },
        materialized
      )
    ).toEqual({ _tag: "OutsideTree", path: "/testbed/.flows-checkpoints/cp-0-1/../mod.py" })
  })

  it("runs a shell call that names the checkout itself or a longer path sharing the root's name", () => {
    for (
      const command of [
        "cat /testbed/.flows-checkpoints/cp-0-1/mod.py",
        "cd /testbed/.flows-checkpoints/cp-0-1 && ./runtests.py",
        "ls /testbedx /opt/testbed /work/repository",
        "pytest tests/test_x.py"
      ]
    ) {
      expect(Relocate.relocate("bash", { command, container: "swebench-1" }, materialized), command).toMatchObject({
        _tag: "Relocated"
      })
    }
  })

  it("refuses a flow that names what it touches with something other than a path", () => {
    expect(Relocate.relocate("read", { path: 7 }, materialized)).toEqual({ _tag: "UnsupportedFlow" })
  })

  it("treats an input that is not an object as naming nothing, and takes the checkpoint itself", () => {
    expect(Relocate.relocate("read", "a.py", materialized)).toMatchObject({
      input: { path: ".flows-checkpoints/cp-0-1" }
    })
  })

  it("refuses every flow the table does not name, `test` included", () => {
    for (const flow of ["edit", "write", "apply_patch", "remember", "webfetch"]) {
      expect(Relocate.relocate(flow, {}, materialized)).toEqual({ _tag: "UnsupportedFlow" })
    }
    // `test` answers this exact question already, with `against: "base"`. Two
    // mechanisms pointed at one tree are two answers that can disagree.
    expect(Relocate.relocate("test", { selection: [] }, materialized)).toEqual({ _tag: "UnsupportedFlow" })
  })
})

describe("relocate against the flow schemas", () => {
  it("rewrites a field each flow's own Input schema keeps", () => {
    // The table names `cwd`, `path`, `path`, `root` and `root` by hand. A
    // Struct drops keys it does not declare, so a field renamed in a flow and
    // not here would relocate into a key the decode throws away: the call would
    // run against the live tree under a checkpoint's name. Decoding the
    // rewritten input with the flow's own schema is what makes that loud.
    expect(
      Schema.decodeUnknownSync(Bash.Input)(
        rewritten("bash", { mode: "unhermetic", command: "./runtests.py", cwd: "tests" })
      ).cwd
    ).toBe(`${materialized.host}/tests`)

    expect(
      Schema.decodeUnknownSync(Read.Input)(
        rewritten("read", { path: "sympy/stats/crv_types.py" })
      ).path
    ).toBe(`${scratch}/sympy/stats/crv_types.py`)

    expect(Schema.decodeUnknownSync(Ls.Input)(rewritten("ls", { path: "sympy" })).path)
      .toBe(`${scratch}/sympy`)

    expect(
      Schema.decodeUnknownSync(Grep.Input)(
        rewritten("grep", { pattern: "def _cdf", root: "sympy/stats" })
      ).root
    ).toBe(`${scratch}/sympy/stats`)

    expect(
      Schema.decodeUnknownSync(Glob.Input)(
        rewritten("glob", { pattern: "**/*.py", root: "sympy" })
      ).root
    ).toBe(`${scratch}/sympy`)
  })
})
