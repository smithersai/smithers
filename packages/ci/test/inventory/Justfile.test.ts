import { describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.ts"
import { readJustfile } from "../../src/inventory/Justfile.ts"
import { shellQuote } from "../../src/inventory/Values.ts"

const read = (text: string) => readJustfile("Justfile", text)

const jobOf = (text: string, name: string): Job => {
  const job = read(text).jobs.find((candidate) => candidate.name === name)
  if (job === undefined) throw new Error(`no recipe ${name}`)
  return job
}

/** The line each step runs, without any `sh -cu` around it. */
const commands = (job: Job) =>
  job.steps.map(({ command }) => {
    if (!command.startsWith("sh -cu ")) return command
    const word = command.slice("sh -cu ".length)
    return word.startsWith("'") ? word.slice(1, -1).replaceAll(`'\\''`, "'") : word
  })
const features = (job: Job) => job.unsupported.map((entry) => entry.feature)
const inSh = (line: string) => `sh -cu ${shellQuote(line)}`

describe("readJustfile recipes", () => {
  it("reads recipes, their lines and their dependencies", () => {
    const { jobs, toolchains } = read(`# a comment

alias t := test

default:
    @just --list

# Build
build:
    zig build

    # a note for the reader
    zig build docs

test: build (lint "src") # runs after build
    zig build test

ci: t build
`)
    expect(toolchains).toEqual([{ name: "just", source: "Justfile" }])
    expect(jobs.map((job) => job.id)).toEqual(["justfile:default", "justfile:build", "justfile:test", "justfile:ci"])
    expect(jobs[1]).toEqual({
      id: "justfile:build",
      source: "justfile",
      file: "Justfile",
      name: "build",
      needs: [],
      triggers: [],
      matrix: [],
      steps: [
        { id: "justfile:build:1", command: "zig build", cwd: "", env: {}, secrets: [] },
        { id: "justfile:build:2", command: "zig build docs", cwd: "", env: {}, secrets: [] }
      ],
      unsupported: []
    })
    expect(commands(jobs[0] as Job)).toEqual(["just --list"])
    expect(jobs[2]?.needs).toEqual(["justfile:build"])
    expect(features(jobs[2] as Job)).toEqual(["dependency-arguments"])
    expect(jobs[3]?.needs).toEqual(["justfile:test", "justfile:build"])
    expect(jobs[3]?.steps).toEqual([])
  })

  it("reads quiet recipe headers and CRLF files", () => {
    expect(commands(jobOf("@quiet:\r\n  echo hi\r\n", "quiet"))).toEqual(["echo hi"])
  })

  it("joins continued lines the way just does", () => {
    const job = jobOf(
      `run:
    docker run --rm \\
      alpine sh -c 'a && \\
      b'
    tail \\
`,
      "run"
    )
    expect(commands(job)).toEqual(["docker run --rm alpine sh -c 'a && b'", "tail"])
    expect(commands(jobOf("run:\n  tail \\", "run"))).toEqual(["tail"])
  })

  it("reports a line allowed to fail and keeps it", () => {
    const job = jobOf("clean:\n  -@rm -rf out\n", "clean")
    expect(commands(job)).toEqual(["rm -rf out"])
    expect(job.unsupported).toEqual([{
      feature: "ignored-failure",
      detail: "Justfile: clean line 2 may fail without failing the recipe"
    }])
  })

  it("reports recipes that run others afterwards", () => {
    const job = jobOf("a: b && c\n  echo a\n", "a")
    expect(job.needs).toEqual(["justfile:b"])
    expect(features(job)).toEqual(["subsequent-recipes"])
  })
})

describe("readJustfile values", () => {
  it("fills in literal variables and parameter defaults", () => {
    const job = jobOf(
      `mode := 'fast'
name := "zig" # the tool
test filter='' *rest count="3":
    {{ name }} build -Dmode={{mode}} -Dfilter={{ filter }} {{ rest }} -Dcount={{ count }} {{{{raw}}
`,
      "test"
    )
    expect(commands(job)).toEqual(["zig build -Dmode=fast -Dfilter=  -Dcount=3 {{raw}}"])
    expect(job.unsupported).toEqual([])
  })

  it("reports what just would have to evaluate", () => {
    const text = `computed := \`git rev-parse HEAD\`
joined := "a" + "b"
escaped := "a\\tb"
one seed:
  run {{ seed }}
two:
  run {{ computed }}
  run {{ joined }}
  run {{ escaped }}
  run {{ os() }}
  echo fine
three value=computed plus="x":
  run {{ value }} {{ plus }}
four +items:
  run {{ items }}
`
    const one = jobOf(text, "one")
    expect(one.steps).toEqual([])
    expect(features(one)).toEqual(["recipe-argument", "expression"])
    expect(one.unsupported[0]?.detail).toBe("Justfile: one needs a value for seed")
    expect(one.unsupported[1]?.detail).toBe("Justfile: one line 5 depends on seed")
    const two = jobOf(text, "two")
    expect(commands(two)).toEqual(["echo fine"])
    expect(two.unsupported.map((entry) => entry.detail)).toEqual([
      "Justfile: two line 7 depends on computed",
      "Justfile: two line 8 depends on joined",
      "Justfile: two line 9 depends on escaped",
      "Justfile: two line 10 depends on os()"
    ])
    expect(features(jobOf(text, "three"))).toEqual(["recipe-argument", "expression"])
    expect(features(jobOf(text, "four"))).toEqual(["recipe-argument", "expression"])
  })

  it("exports what the file exports", () => {
    const text = `export LEVEL := "debug"
OTHER := "x"
export DYNAMIC := env_var("HOME")
run $PORT="80" plain="y":
  serve
`
    const job = jobOf(text, "run")
    expect(job.steps[0]?.env).toEqual({ LEVEL: "debug", PORT: "80" })
    expect(job.unsupported[0]?.detail).toBe("Justfile: run exports DYNAMIC, which just must evaluate")
    const all = jobOf(`set export\nA := "1"\nrun b="2":\n  go\n`, "run")
    expect(all.steps[0]?.env).toEqual({ A: "1", b: "2" })
    const off = jobOf(`set export := false\nA := "1"\nrun:\n  go\n`, "run")
    expect(off.steps[0]?.env).toEqual({})
  })

  it("keeps a literal credential out of the step", () => {
    const job = jobOf(`export API_TOKEN := "abc123"\nrun:\n  go\n`, "run")
    expect(job.steps[0]).toMatchObject({ env: {}, secrets: ["API_TOKEN"] })
    expect(JSON.stringify(job)).not.toContain("abc123")
  })
})

describe("readJustfile scripts", () => {
  it("runs a shebang recipe with its interpreter", () => {
    const job = jobOf(
      `test filter='x':
    #!/usr/bin/env bash
    set -euo pipefail

    if true; then
      echo "{{ filter }}'s"
    fi
`,
      "test"
    )
    expect(commands(job)).toEqual([
      `bash -c 'set -euo pipefail\n\nif true; then\n  echo "x'\\''s"\nfi'`
    ])
  })

  it.each([
    ["#!/bin/sh -eu", "sh -eu -c 'echo a'"],
    ["#!/usr/bin/env -S bash -e -u", "bash -e -u -c 'echo a'"],
    ["#!/usr/bin/env sh", "sh -c 'echo a'"]
  ])("keeps the flags of %s", (shebang, command) => {
    expect(commands(jobOf(`run:\n  ${shebang}\n  echo a\n`, "run"))).toEqual([command])
  })

  it("reports other interpreters and values it cannot fill in", () => {
    const python = jobOf("run:\n  #!/usr/bin/env python3\n  print(1)\n", "run")
    expect(python.steps).toEqual([])
    expect(python.unsupported[0]).toEqual({
      feature: "interpreter",
      detail: "Justfile: run runs in /usr/bin/env python3"
    })
    const unknown = jobOf("run arg:\n  #!/bin/bash\n  echo {{ arg }}\n", "run")
    expect(features(unknown)).toEqual(["recipe-argument", "expression"])
  })
})

describe("readJustfile attributes and settings", () => {
  it("applies attributes", () => {
    const text = `[private]
[doc("Has, a comma")]
quiet:
  echo a

[working-directory: 'packages/a']
place:
  echo b

[working-directory('packages/c')]
[group('x')]
other:
  echo c

[confirm]
danger:
  echo d

[no-cd]
stay:
  echo e
`
    expect(jobOf(text, "quiet").unsupported).toEqual([])
    expect(jobOf(text, "place").steps[0]?.cwd).toBe("packages/a")
    expect(jobOf(text, "other").steps[0]?.cwd).toBe("packages/c")
    expect(features(jobOf(text, "danger"))).toEqual(["attribute"])
    expect(features(jobOf(text, "stay"))).toEqual(["attribute"])
  })

  it("keeps the Linux recipe of a name defined per platform", () => {
    const { jobs } = read(`[macos]
open:
  mac-open

[linux]
open:
  xdg-open

[windows]
only-windows:
  start

[unix]
[macos]
both:
  run
`)
    expect(jobs.map((job) => job.name)).toEqual(["open", "both", "only-windows"])
    expect(commands(jobs[0] as Job)).toEqual(["xdg-open"])
    expect(features(jobs[0] as Job)).toEqual(["duplicate-recipe"])
    expect(commands(jobs[1] as Job)).toEqual(["run"])
    expect(jobs[2]?.steps).toEqual([])
    expect(features(jobs[2] as Job)).toEqual(["platform"])
  })

  it("reports settings that change how recipes run and ignores the rest", () => {
    const job = jobOf(
      `set shell := ["bash", "-c"]
set dotenv-load
set positional-arguments := true
set quiet
run:
  echo a
`,
      "run"
    )
    expect(commands(job)).toEqual(["bash -c 'echo a'"])
    expect(job.unsupported.map((entry) => entry.detail)).toEqual([
      "Justfile: set dotenv-load changes how recipes run"
    ])
  })

  it("reports modules and imports it did not read", () => {
    const { jobs, unsupported } = read(`mod devnet 'etc/devnet.just' # the devnet
mod? bare
import 'other.just'
import 'more.just'
run: devnet::up
  echo a
`)
    expect(jobs.map((job) => job.id)).toEqual(["justfile:run"])
    expect(jobs[0]?.needs).toEqual([])
    expect(features(jobs[0] as Job)).toEqual(["module"])
    expect(unsupported).toEqual([
      { feature: "module", detail: "Justfile: the recipes of module devnet in 'etc/devnet.just' were not read" },
      { feature: "module", detail: "Justfile: the recipes of module bare were not read" },
      { feature: "module", detail: "Justfile: the recipes imported from 'other.just' were not read" },
      { feature: "module", detail: "Justfile: the recipes imported from 'more.just' were not read" }
    ])
  })
})

describe("readJustfile exactness", () => {
  it("names sh for a line the two shells could read differently", () => {
    const job = jobOf(`run:\n  false; echo ok\n  echo -e hi\n  source env.sh\n  zig build test\n`, "run")
    expect(job.steps.map((step) => step.command)).toEqual([
      inSh("false; echo ok"),
      inSh("echo -e hi"),
      inSh("source env.sh"),
      "zig build test"
    ])
  })

  it("does not let a line that starts with a dash read as a flag of sh", () => {
    expect(jobOf("run:\n  --version\n", "run").steps[0]?.command).toBe("sh -cu '-version'")
  })

  it("fills in a variable whose name only resembles a secret word", () => {
    expect(commands(jobOf(`auth := "none"\nrun:\n  t --auth={{auth}}\n`, "run"))).toEqual(["t --auth=none"])
  })

  it("runs every line in the shell the file sets", () => {
    const job = jobOf(`set shell := ['bash', "-euo", "pipefail", "-c"] # strict\nrun:\n  zig build\n`, "run")
    expect(commands(job)).toEqual(["bash -euo pipefail -c 'zig build'"])
  })

  it.each([
    ["set shell := SOME_SHELL", "shell"],
    ["set shell", "shell"],
    ["set working-directory := 'sub'", "working-directory"]
  ])("states no command under %s", (setting, name) => {
    const job = jobOf(`${setting}\nrun:\n  go\n`, "run")
    expect(job.steps).toEqual([])
    expect(job.unsupported[0]?.detail).toBe(`Justfile: set ${name} changes how recipes run`)
  })

  it("never fills a literal secret into a command", () => {
    const job = jobOf(`export API_TOKEN := "abc123"\nrun:\n  curl -H "t: {{API_TOKEN}}" x.test\n`, "run")
    expect(job.steps).toEqual([])
    expect(job.unsupported[0]?.detail).toBe("Justfile: run line 3 depends on API_TOKEN")
    expect(JSON.stringify(job)).not.toContain("abc123")
  })

  it("lets a comment swallow the line it continues onto", () => {
    expect(commands(jobOf("run:\n  # note \\\n  echo hi\n  echo after\n", "run"))).toEqual(["echo after"])
    const ignored = "set ignore-comments\nrun:\n  # note \\\n  echo hi\n"
    expect(commands(jobOf(ignored, "run"))).toEqual(["echo hi"])
  })

  it("does not read a backslash followed by a space as a continuation", () => {
    expect(commands(jobOf("run:\n  echo a \\ \n  echo b\n", "run"))).toEqual(["echo a \\ ", "echo b"])
  })

  it.each([
    ["--version", "-version", ["ignored-failure"]],
    ["@@scope/x", "@scope/x", []],
    ["-@-y", "-y", ["ignored-failure"]],
    ["@-z", "z", ["ignored-failure"]]
  ])("strips one of each prefix from %s", (line, command, expected) => {
    const job = jobOf(`run:\n  ${line}\n`, "run")
    expect(commands(job)).toEqual([command])
    expect(features(job)).toEqual(expected)
  })

  it("reports a line that only held a prefix or an empty value", () => {
    expect(features(jobOf("run *a:\n  @{{ a }}\n", "run"))).toEqual(["empty-command"])
  })

  it("reads a recipe header continued on the next line", () => {
    const job = jobOf("r: a \\\n  b\n  echo r\n", "r")
    expect(job.needs).toEqual(["justfile:a", "justfile:b"])
    expect(commands(job)).toEqual(["echo r"])
  })

  it("keeps the last recipe when the file allows duplicates", () => {
    const { jobs } = read("set allow-duplicate-recipes\nr:\n  echo first\nr:\n  echo second\n")
    expect(commands(jobs[0] as Job)).toEqual(["echo second"])
    expect(jobs[0]?.unsupported).toEqual([])
  })

  it("reports lines that read positional arguments", () => {
    const set = jobOf(`set positional-arguments\nr a="x":\n  echo "$1"\n  echo ok\n`, "r")
    expect(commands(set)).toEqual(["echo ok"])
    expect(features(set)).toEqual(["positional-arguments"])
    const attribute = jobOf(`[positional-arguments]\nr:\n  #!/bin/sh\n  echo "\${1}"\n`, "r")
    expect(attribute.steps).toEqual([])
    expect(features(attribute)).toEqual(["positional-arguments"])
    expect(commands(jobOf(`set positional-arguments := false\nr:\n  echo "$1"\n`, "r"))).toHaveLength(1)
  })

  it("reads a set export with a comment", () => {
    const job = jobOf(`set export := false # off\nA := "1"\nr:\n  go\n`, "r")
    expect(job.steps[0]?.env).toEqual({})
  })

  it("does not read attribute arguments as attributes", () => {
    const text = `[metadata("x", "windows")]\nr:\n  go\n`
    const job = jobOf(text, "r")
    expect(commands(job)).toEqual(["go"])
    expect(job.unsupported).toEqual([])
    expect(read(text).unsupported).toEqual([])
  })

  it("applies an attribute line with a comment and reports one it cannot read", () => {
    const mac = jobOf("[macos] # only there\nr:\n  echo mac\n", "r")
    expect(mac.steps).toEqual([])
    expect(features(mac)).toEqual(["platform"])
    for (const line of ["[unclosed", "[a] trailing", "[!bad]"]) {
      expect(read(`${line}\nr:\n  go\n`).unsupported[0]?.feature).toBe("malformed-file")
    }
  })

  it("reports a recipe directory outside the repository", () => {
    for (const attribute of [`[working-directory("../x")]`, "[working-directory]"]) {
      const job = jobOf(`${attribute}\nr:\n  go\n`, "r")
      expect(job.steps).toEqual([])
      expect(features(job)).toEqual(["working-directory"])
    }
  })

  it("reads [script] recipes as one script", () => {
    expect(commands(jobOf("[script]\nr:\n  a=1\n  echo $a\n", "r"))).toEqual([`sh -eu -c 'a=1\necho $a'`])
    expect(commands(jobOf(`[script("bash", "-e")]\nr:\n  a\n`, "r"))).toEqual(["bash -e -c a"])
    expect(jobOf("[script]\nr:\n", "r").steps).toEqual([])
    const python = jobOf(`[script("python3")]\nr:\n  x = 1\n  print(x)\n`, "r")
    expect(python.steps).toEqual([])
    expect(python.unsupported).toEqual([{ feature: "interpreter", detail: "Justfile: r runs in python3" }])
    const custom = jobOf(`set script-interpreter := ['python3']\n[script]\nr:\n  x\n`, "r")
    expect(custom.steps).toEqual([])
    expect(features(custom)).toEqual(["interpreter"])
  })

  it("removes only the shebang's indent from a script", () => {
    const job = jobOf("r:\n  #!/bin/sh\n    cat <<X\n    X\n", "r")
    expect(commands(job)).toEqual([`sh -c ${shellQuote("cat <<X\n  X")}`])
  })

  it("does not read flags from an env shebang Linux would pass as one argument", () => {
    const job = jobOf("r:\n  #!/usr/bin/env bash -e\n  go\n", "r")
    expect(job.steps).toEqual([])
    expect(features(job)).toEqual(["interpreter"])
  })
})

describe("readJustfile malformed files", () => {
  it("keeps what it read and reports the lines it could not", () => {
    const { jobs, unsupported } = read(`good:
  echo a

what is this
  stray body
???
bad !param:
  echo b
`)
    expect(jobs.map((job) => job.id)).toEqual(["justfile:good"])
    expect(unsupported).toEqual([{
      feature: "malformed-file",
      detail: "Justfile: line 4 cannot be read (5 such lines)"
    }])
  })

  it("reads an empty file as no jobs", () => {
    expect(read("").jobs).toEqual([])
  })

  it("does not take a colon in a quoted default or in parentheses for the end of a header", () => {
    const job = jobOf(`run url='a:b' other=("x:y"):\n  echo {{ url }}\n`, "run")
    expect(commands(job)).toEqual(["echo a:b"])
    expect(features(job)).toEqual(["recipe-argument"])
  })
})
