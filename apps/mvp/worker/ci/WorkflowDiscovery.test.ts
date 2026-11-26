import * as fs from "node:fs"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Result } from "effect"
import { afterAll, describe, expect, test } from "vitest"
import { type CheckoutFiles, discoverWorkflow, listWorkflows, loadJevConfig } from "./WorkflowDiscovery.ts"

// Real directories, real symlinks and the real `fs.realpathSync`: no lookup table stands in for the filesystem.
const scratch = mkdtempSync(join(tmpdir(), "workflow-discovery-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let count = 0
/** A fresh checkout beside a directory outside it, both under the module's scratch directory. */
const fixture = () => {
  const base = join(scratch, String(count++))
  const checkout = join(base, "checkout")
  const outside = join(base, "outside")
  mkdirSync(checkout, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(checkout, path)), { recursive: true })
    writeFileSync(join(checkout, path), text)
  }
  const link = (path: string, target: string) => {
    mkdirSync(dirname(join(checkout, path)), { recursive: true })
    symlinkSync(target, join(checkout, path))
  }
  writeFileSync(join(outside, "secret.ts"), "export default 'outside'")
  return { checkout, outside, write, link }
}

// `node:fs` itself is the adapter a runner passes.
const nodeFiles: CheckoutFiles = fs

const failureOf = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error("expected a failure")
  return result.failure
}

const successOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected a success: ${String(result.failure)}`)
  return result.success
}

describe("discoverWorkflow", () => {
  test("reads .smithers/workflows/<name>.vibe before .ts before the older flows layout", () => {
    const { checkout, write } = fixture()
    write(".smithers/flows/ci/flow.ts", "flow")
    expect(successOf(discoverWorkflow(checkout, "ci", nodeFiles))).toMatchObject({ source: "flows", path: "./.smithers/flows/ci/flow.ts" })
    write(".smithers/workflows/ci.ts", "ts")
    expect(successOf(discoverWorkflow(checkout, "ci", nodeFiles))).toMatchObject({ source: "workflows", path: "./.smithers/workflows/ci.ts" })
    write(".smithers/workflows/ci.vibe", "vibe")
    const found = successOf(discoverWorkflow(checkout, "ci", nodeFiles))
    expect(found).toMatchObject({ source: "workflows", path: "./.smithers/workflows/ci.vibe" })
    expect(found.file).toBe(join(realpathSync(checkout), ".smithers/workflows/ci.vibe"))
  })

  test("refuses a name that is not a workflow name, and one with no file", () => {
    const { checkout } = fixture()
    expect(failureOf(discoverWorkflow(checkout, "../etc", nodeFiles)).code).toBe("invalid_name")
    expect(failureOf(discoverWorkflow(checkout, "Ci", nodeFiles)).code).toBe("invalid_name")
    expect(failureOf(discoverWorkflow(checkout, "missing", nodeFiles)).code).toBe("not_found")
  })

  test("refuses a workflow symlinked outside the checkout, and does not fall back to the flows layout", () => {
    const { checkout, outside, write, link } = fixture()
    write(".smithers/flows/ci/flow.ts", "flow")
    link(".smithers/workflows/ci.ts", join(outside, "secret.ts"))
    const refused = failureOf(discoverWorkflow(checkout, "ci", nodeFiles))
    expect(refused.code).toBe("path_escape")
    expect(refused.path).toBe("./.smithers/workflows/ci.ts")
  })

  test("refuses a workflow whose directory is symlinked outside the checkout", () => {
    const { checkout, outside, link } = fixture()
    mkdirSync(join(outside, "flows/ci"), { recursive: true })
    writeFileSync(join(outside, "flows/ci/flow.ts"), "flow")
    link(".smithers/flows", join(outside, "flows"))
    expect(failureOf(discoverWorkflow(checkout, "ci", nodeFiles)).code).toBe("path_escape")
  })

  test("follows a symlink that stays inside the checkout", () => {
    const { checkout, write, link } = fixture()
    write("shared/ci.ts", "shared")
    link(".smithers/workflows/ci.ts", "../../shared/ci.ts")
    expect(successOf(discoverWorkflow(checkout, "ci", nodeFiles)).file).toBe(join(realpathSync(checkout), "shared/ci.ts"))
  })

  test("returns the text it read, so a loader never reopens the path", () => {
    const { checkout, write } = fixture()
    write(".smithers/workflows/ci.ts", "export default 'ci'")
    expect(successOf(discoverWorkflow(checkout, "ci", nodeFiles)).text).toBe("export default 'ci'")
  })
})

describe("listWorkflows", () => {
  test("lists both layouts by name, the workflows layout winning, and skips tests and declarations", () => {
    const { checkout, write } = fixture()
    write(".smithers/workflows/fast-check.ts", "")
    write(".smithers/workflows/fast-check.test.ts", "")
    write(".smithers/workflows/types.d.ts", "")
    write(".smithers/workflows/notes.md", "")
    write(".smithers/workflows/ci.vibe", "")
    write(".smithers/flows/ci/flow.ts", "")
    write(".smithers/flows/bench/flow.ts", "")
    write(".smithers/flows/README.md", "")
    const names = successOf(listWorkflows(checkout, nodeFiles)).map((workflow) => `${workflow.name}:${workflow.source}`)
    expect(names).toEqual(["bench:flows", "ci:workflows", "fast-check:workflows"])
  })

  test("refuses the whole listing when one workflow escapes", () => {
    const { checkout, outside, write, link } = fixture()
    write(".smithers/workflows/ok.ts", "")
    link(".smithers/workflows/leak.ts", join(outside, "secret.ts"))
    expect(failureOf(listWorkflows(checkout, nodeFiles)).code).toBe("path_escape")
  })

  test("lists nothing in a checkout without .smithers", () => {
    expect(successOf(listWorkflows(fixture().checkout, nodeFiles))).toEqual([])
  })
})

describe("this repository's own checkout", () => {
  // The Smithers checkout itself, as a runner reads it: no fixture stands in for the files.
  const repo = realpathSync(new URL("../../../../", import.meta.url))

  test("discovers the gate from .smithers/workflows/gate.vibe, ahead of the older flow.ts", () => {
    const gate = successOf(discoverWorkflow(repo, "gate", nodeFiles))
    expect(gate).toMatchObject({ name: "gate", source: "workflows", path: "./.smithers/workflows/gate.vibe" })
    expect(gate.file).toBe(join(repo, ".smithers/workflows/gate.vibe"))
    expect(gate.text).toBe(fs.readFileSync(gate.file, "utf8"))
    expect(gate.text).toContain('Flow.make("gate", {')
  })

  test("lists the gate once, from the workflows layout", () => {
    const listed = successOf(listWorkflows(repo, nodeFiles))
    const gates = listed.filter((workflow) => workflow.name === "gate")
    expect(gates).toHaveLength(1)
    expect(gates[0]).toMatchObject({ source: "workflows", path: "./.smithers/workflows/gate.vibe" })
  })
})

const config = (decision: Record<string, unknown> = {}) => JSON.stringify({
  seats: {},
  decisions: {
    "issue.kind": {
      kind: "classify",
      labels: ["bug", "docs"],
      evaluators: [
        { use: "template", field: "body", template: "./jev/bug.md", label: "bug" },
        { use: "schema", field: "body", schema: "./jev/docs.schema.json", label: "docs" },
        { use: "script", script: "./jev/classify.sh" },
      ],
      onUnsure: { action: "request-human", who: "maintainers" },
      onFailure: { action: "fail", surface: "triage" },
      examples: "./jev/examples.jsonl",
      ...decision,
    },
  },
})

const writeJevFiles = (write: (path: string, text: string) => void) => {
  write("jev/bug.md", "## Steps")
  write("jev/docs.schema.json", "{}")
  write("jev/classify.sh", "echo unsure")
  write("jev/examples.jsonl", "{}")
}

describe("loadJevConfig", () => {
  test("decodes the config, then reads every named file from its real path", () => {
    const { checkout, write } = fixture()
    write(".smithers/jev.config.json", config())
    writeJevFiles(write)
    const loaded = successOf(loadJevConfig(checkout, nodeFiles))!
    expect(loaded.path).toBe("./.smithers/jev.config.json")
    expect(Object.keys(loaded.config.decisions)).toEqual(["issue.kind"])
    expect(loaded.files).toEqual({
      "./jev/bug.md": "## Steps",
      "./jev/classify.sh": "echo unsure",
      "./jev/docs.schema.json": "{}",
      "./jev/examples.jsonl": "{}",
    })
  })

  test("is undefined for a repository that declares no config", () => {
    expect(successOf(loadJevConfig(fixture().checkout, nodeFiles))).toBeUndefined()
  })

  test("refuses an evaluator script symlinked outside the checkout without reading it", () => {
    const { checkout, outside, write, link } = fixture()
    write(".smithers/jev.config.json", config())
    writeJevFiles(write)
    rmSync(join(checkout, "jev/classify.sh"))
    writeFileSync(join(outside, "run.sh"), "curl attacker")
    link("jev/classify.sh", join(outside, "run.sh"))
    const opened: Array<string> = []
    const watched: CheckoutFiles = { ...nodeFiles, openSync: (path, flags) => (opened.push(path), fs.openSync(path, flags)) }
    const refused = failureOf(loadJevConfig(checkout, watched))
    // resolveRepoPath refuses it first, with the typed Jev error, before the loader opens anything but the config.
    expect(refused).toMatchObject({ _tag: "JevConfigError", code: "path_escape", path: "./jev/classify.sh" })
    expect(opened.some((path) => path.includes("run.sh") || path.endsWith("classify.sh"))).toBe(false)
  })

  test("refuses each named path kind through resolveRepoPath when it escapes by symlink", () => {
    for (const [patch, named] of [
      [{ examples: "./jev/examples.jsonl" }, "./jev/examples.jsonl"],
      [{}, "./jev/bug.md"],
      [{}, "./jev/docs.schema.json"],
    ] as const) {
      const { checkout, outside, write, link } = fixture()
      write(".smithers/jev.config.json", config(patch))
      writeJevFiles(write)
      rmSync(join(checkout, named))
      writeFileSync(join(outside, "leak"), "secret")
      link(named.slice(2), join(outside, "leak"))
      const refused = failureOf(loadJevConfig(checkout, nodeFiles))
      expect(refused).toMatchObject({ _tag: "JevConfigError", code: "path_escape", path: named })
      expect(JSON.stringify(refused)).not.toContain(outside)
    }
  })

  test("refuses a directory of examples symlinked outside the checkout", () => {
    const { checkout, outside, write, link } = fixture()
    write(".smithers/jev.config.json", config({ examples: "./data/examples.jsonl" }))
    writeJevFiles(write)
    writeFileSync(join(outside, "examples.jsonl"), "{}")
    link("data", outside)
    expect(failureOf(loadJevConfig(checkout, nodeFiles))).toMatchObject({ _tag: "JevConfigError", code: "path_escape", path: "./data/examples.jsonl" })
  })

  test("refuses a config file symlinked outside the checkout", () => {
    const { checkout, outside, link } = fixture()
    writeFileSync(join(outside, "jev.json"), config())
    link(".smithers/jev.config.json", join(outside, "jev.json"))
    expect(failureOf(loadJevConfig(checkout, nodeFiles))).toMatchObject({ _tag: "WorkflowDiscoveryError", code: "path_escape" })
  })

  test("refuses a .. segment at decode, before any file is read", () => {
    const { checkout, write } = fixture()
    write(".smithers/jev.config.json", config({ examples: "./../outside/secret.ts" }))
    const opened: Array<string> = []
    const watched: CheckoutFiles = { ...nodeFiles, openSync: (path, flags) => (opened.push(path), fs.openSync(path, flags)) }
    expect(failureOf(loadJevConfig(checkout, watched))).toMatchObject({ code: "invalid_shape" })
    expect(opened).toEqual([join(realpathSync(checkout), ".smithers/jev.config.json")])
  })

  test("refuses a config that does not parse or does not decode", () => {
    const broken = fixture()
    broken.write(".smithers/jev.config.json", "{")
    expect(failureOf(loadJevConfig(broken.checkout, nodeFiles))).toMatchObject({ _tag: "JevConfigUnreadable" })
    const misspelled = fixture()
    misspelled.write(".smithers/jev.config.json", config({ onUnsre: { action: "fail", surface: "x" } }))
    expect(failureOf(loadJevConfig(misspelled.checkout, nodeFiles))).toMatchObject({ code: "invalid_shape" })
  })

  test("loads a .ts config only through the caller's evaluator", () => {
    const { checkout, write } = fixture()
    write(".smithers/jev.config.ts", `export default ${config()}`)
    writeJevFiles(write)
    expect(failureOf(loadJevConfig(checkout, nodeFiles))).toMatchObject({ _tag: "JevConfigUnreadable" })
    const evaluated: Array<string> = []
    const evaluate = (source: string, path: string) => {
      evaluated.push(path)
      return JSON.parse(source.replace(/^export default /, ""))
    }
    expect(successOf(loadJevConfig(checkout, nodeFiles, { evaluate }))!.path).toBe("./.smithers/jev.config.ts")
    expect(evaluated).toEqual(["./.smithers/jev.config.ts"])
  })
})

// Regressions for the W2-I review (scratch/w2/astra-review-i.md): one test or more per finding.

/** Every absolute path a refusal could leak. */
const leaksFrom = (error: unknown, ...fragments: ReadonlyArray<string>) => {
  const text = JSON.stringify(error)
  return fragments.filter((fragment) => text.includes(fragment))
}

describe("High 1: a file is consumed from the one descriptor that was checked", () => {
  test("readFileSync gets the checked descriptor, never a path, and opens use O_NOFOLLOW", () => {
    const { checkout, write } = fixture()
    write(".smithers/workflows/ci.ts", "ci")
    const reads: Array<unknown> = []
    const flags: Array<number> = []
    const watched: CheckoutFiles = {
      ...nodeFiles,
      openSync: (path, flag) => (flags.push(flag), fs.openSync(path, flag)),
      readFileSync: (fd, encoding) => (reads.push(fd), fs.readFileSync(fd, encoding)),
    }
    expect(successOf(discoverWorkflow(checkout, "ci", watched)).text).toBe("ci")
    expect(reads).toHaveLength(1)
    expect(typeof reads[0]).toBe("number")
    expect(flags[0]! & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
  })

  test("a file swapped for a symlink outside between the check and the open is refused", () => {
    const { checkout, outside, write } = fixture()
    write(".smithers/workflows/ci.ts", "ci")
    const swapping: CheckoutFiles = {
      ...nodeFiles,
      openSync: (path, flag) => {
        rmSync(path)
        symlinkSync(join(outside, "secret.ts"), path)
        return fs.openSync(path, flag)
      },
    }
    const refused = failureOf(discoverWorkflow(checkout, "ci", swapping))
    expect(refused.code).toBe("changed")
    expect(leaksFrom(refused, outside, checkout, "outside")).toEqual([])
  })

  test("an ancestor swapped outside and back around the open is refused by inode", () => {
    const { checkout, outside, write } = fixture()
    write(".smithers/workflows/ci.ts", "ci")
    mkdirSync(join(outside, "workflows"))
    writeFileSync(join(outside, "workflows/ci.ts"), "export default 'outside'")
    const dir = join(realpathSync(checkout), ".smithers/workflows")
    const swapping: CheckoutFiles = {
      ...nodeFiles,
      openSync: (path, flag) => {
        renameSync(dir, `${dir}.kept`)
        symlinkSync(join(outside, "workflows"), dir)
        try {
          return fs.openSync(path, flag)
        } finally {
          rmSync(dir)
          renameSync(`${dir}.kept`, dir)
        }
      },
    }
    expect(failureOf(discoverWorkflow(checkout, "ci", swapping)).code).toBe("changed")
  })

  test("a Jev evaluator gets the source text read once, and a swap before its open is refused", () => {
    const { checkout, outside, write } = fixture()
    write(".smithers/jev.config.ts", `export default ${config()}`)
    writeJevFiles(write)
    const evaluate = (source: string) => JSON.parse(source.replace(/^export default /, ""))
    const swapping: CheckoutFiles = {
      ...nodeFiles,
      openSync: (path, flag) => {
        if (path.endsWith("jev.config.ts")) {
          rmSync(path)
          symlinkSync(join(outside, "secret.ts"), path)
        }
        return fs.openSync(path, flag)
      },
    }
    expect(failureOf(loadJevConfig(checkout, swapping, { evaluate }))).toMatchObject({ code: "changed", path: "./.smithers/jev.config.ts" })
  })
})

describe("Low 2: a Jev named file that is not a regular file or fails to read is a typed, redacted error", () => {
  test("a named directory is refused not_regular", () => {
    const { checkout, write } = fixture()
    write(".smithers/jev.config.json", config())
    writeJevFiles(write)
    rmSync(join(checkout, "jev/bug.md"))
    mkdirSync(join(checkout, "jev/bug.md"))
    const refused = failureOf(loadJevConfig(checkout, nodeFiles))
    expect(refused).toMatchObject({ _tag: "WorkflowDiscoveryError", code: "not_regular", path: "./jev/bug.md" })
    expect(leaksFrom(refused, checkout, realpathSync(checkout))).toEqual([])
  })

  test("a read failure is refused unreadable with no path in the detail", () => {
    const { checkout, write } = fixture()
    write(".smithers/jev.config.json", config())
    writeJevFiles(write)
    const failing: CheckoutFiles = {
      ...nodeFiles,
      readFileSync: (fd, encoding) => {
        const text = fs.readFileSync(fd, encoding)
        if (text === "echo unsure") throw Object.assign(new Error(`EIO: i/o error, read ${checkout}/jev/classify.sh`), { code: "EIO" })
        return text
      },
    }
    const refused = failureOf(loadJevConfig(checkout, failing))
    expect(refused).toMatchObject({ code: "unreadable", path: "./jev/classify.sh", detail: "cannot read (EIO)" })
    expect(leaksFrom(refused, checkout)).toEqual([])
  })

  test("a named file that does not exist is refused not_found", () => {
    const { checkout, write } = fixture()
    write(".smithers/jev.config.json", config())
    writeJevFiles(write)
    rmSync(join(checkout, "jev/examples.jsonl"))
    expect(failureOf(loadJevConfig(checkout, nodeFiles))).toMatchObject({ code: "not_found", path: "./jev/examples.jsonl" })
  })
})

describe("Medium 1: only a genuinely missing preferred entry falls back", () => {
  test("a dangling preferred symlink refuses instead of selecting the flows layout", () => {
    const { checkout, write, link } = fixture()
    link(".smithers/workflows/ci.ts", "./nowhere.ts")
    write(".smithers/flows/ci/flow.ts", "flow")
    expect(failureOf(discoverWorkflow(checkout, "ci", nodeFiles))).toMatchObject({ code: "invalid_entry", path: "./.smithers/workflows/ci.ts" })
  })

  test("a looping preferred symlink refuses", () => {
    const { checkout, write, link } = fixture()
    link(".smithers/workflows/ci.vibe", "./ci.ts")
    link(".smithers/workflows/ci.ts", "./ci.vibe")
    write(".smithers/flows/ci/flow.ts", "flow")
    expect(failureOf(discoverWorkflow(checkout, "ci", nodeFiles))).toMatchObject({ code: "invalid_entry", path: "./.smithers/workflows/ci.vibe" })
  })

  test("a preferred entry of the wrong type refuses", () => {
    const { checkout, write } = fixture()
    mkdirSync(join(checkout, ".smithers/workflows/ci.ts"), { recursive: true })
    write(".smithers/flows/ci/flow.ts", "flow")
    expect(failureOf(discoverWorkflow(checkout, "ci", nodeFiles))).toMatchObject({ code: "not_regular", path: "./.smithers/workflows/ci.ts" })
    const fileAncestor = fixture()
    fileAncestor.write(".smithers/workflows", "not a directory")
    fileAncestor.write(".smithers/flows/ci/flow.ts", "flow")
    expect(failureOf(discoverWorkflow(fileAncestor.checkout, "ci", nodeFiles))).toMatchObject({ code: "invalid_entry" })
  })

  test("an unreadable preferred directory refuses instead of falling back", () => {
    const { checkout, write } = fixture()
    write(".smithers/workflows/other.ts", "")
    write(".smithers/flows/ci/flow.ts", "flow")
    const dir = join(checkout, ".smithers/workflows")
    chmodSync(dir, 0o000)
    try {
      expect(failureOf(discoverWorkflow(checkout, "ci", nodeFiles))).toMatchObject({ code: "unreadable", detail: "cannot inspect an entry (EACCES)" })
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  test("an lstat failure other than ENOENT is never absence", () => {
    const { checkout, write } = fixture()
    write(".smithers/workflows/other.ts", "")
    write(".smithers/flows/ci/flow.ts", "flow")
    const failing: CheckoutFiles = {
      ...nodeFiles,
      lstatSync: (path) => {
        if (path.endsWith("ci.vibe")) throw Object.assign(new Error("EIO"), { code: "EIO" })
        return fs.lstatSync(path)
      },
    }
    expect(failureOf(discoverWorkflow(checkout, "ci", failing))).toMatchObject({ code: "unreadable", path: "./.smithers/workflows/ci.vibe" })
  })

  test("a dangling JSON config refuses and never runs the executable .ts config", () => {
    const { checkout, write, link } = fixture()
    link(".smithers/jev.config.json", "./gone.json")
    write(".smithers/jev.config.ts", `export default ${config()}`)
    writeJevFiles(write)
    const evaluated: Array<string> = []
    const evaluate = (source: string, path: string) => (evaluated.push(path), JSON.parse(source.replace(/^export default /, "")))
    expect(failureOf(loadJevConfig(checkout, nodeFiles, { evaluate }))).toMatchObject({ code: "invalid_entry", path: "./.smithers/jev.config.json" })
    expect(evaluated).toEqual([])
  })

  test("a JSON config of the wrong type refuses and never runs the .ts config", () => {
    const { checkout, write } = fixture()
    mkdirSync(join(checkout, ".smithers/jev.config.json"), { recursive: true })
    write(".smithers/jev.config.ts", `export default ${config()}`)
    const evaluated: Array<string> = []
    const evaluate = (source: string, path: string) => (evaluated.push(path), JSON.parse(source))
    expect(failureOf(loadJevConfig(checkout, nodeFiles, { evaluate }))).toMatchObject({ code: "not_regular" })
    expect(evaluated).toEqual([])
  })
})

describe("Medium 2: a directory is confined before it is listed", () => {
  test("a .smithers/workflows symlinked outside is refused before readdir, with no outside name in the error", () => {
    const { checkout, outside, link } = fixture()
    mkdirSync(join(outside, "wf"))
    writeFileSync(join(outside, "wf/exfiltrated-name.ts"), "")
    link(".smithers/workflows", join(outside, "wf"))
    const listed: Array<string> = []
    const watched: CheckoutFiles = { ...nodeFiles, readdirSync: (path) => (listed.push(path), fs.readdirSync(path)) }
    const refused = failureOf(listWorkflows(checkout, watched))
    expect(refused).toMatchObject({ code: "path_escape", path: "./.smithers/workflows" })
    expect(listed).toEqual([])
    expect(leaksFrom(refused, "exfiltrated-name", outside)).toEqual([])
  })

  test("a .smithers/flows symlinked outside is refused before readdir", () => {
    const { checkout, outside, link } = fixture()
    mkdirSync(join(outside, "flows/ci"), { recursive: true })
    writeFileSync(join(outside, "flows/ci/flow.ts"), "")
    link(".smithers/flows", join(outside, "flows"))
    const listed: Array<string> = []
    const watched: CheckoutFiles = { ...nodeFiles, readdirSync: (path) => (listed.push(path), fs.readdirSync(path)) }
    expect(failureOf(listWorkflows(checkout, watched))).toMatchObject({ code: "path_escape", path: "./.smithers/flows" })
    expect(listed).toEqual([])
  })

  test("a legacy flow directory symlinked outside refuses the listing", () => {
    const { checkout, outside, write, link } = fixture()
    write(".smithers/flows/ok/flow.ts", "")
    mkdirSync(join(outside, "ci"))
    writeFileSync(join(outside, "ci/flow.ts"), "")
    link(".smithers/flows/ci", join(outside, "ci"))
    expect(failureOf(listWorkflows(checkout, nodeFiles))).toMatchObject({ code: "path_escape", path: "./.smithers/flows/ci/flow.ts" })
  })

  test("a .smithers directory symlinked inside the checkout still lists", () => {
    const { checkout, write, link } = fixture()
    write("config/smithers/workflows/ci.ts", "ci")
    link(".smithers", "./config/smithers")
    expect(successOf(listWorkflows(checkout, nodeFiles)).map((workflow) => workflow.name)).toEqual(["ci"])
  })
})
