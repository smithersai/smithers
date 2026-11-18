import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.ts"
import * as Inventory from "../../src/contract/Inventory.ts"
import type { Job } from "../../src/contract/Inventory.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { readMakefile } from "../../src/inventory/Makefile.ts"
import { read as readRepository } from "../../src/inventory/Read.vibe"
import { bin, commit, git, read as readFile, remove, spawn, temporary } from "../cli/repo.ts"

const read = (text: string, tracked: ReadonlyArray<string> = []) => readMakefile("Makefile", text, tracked)

const jobOf = (text: string, name = "ci", tracked: ReadonlyArray<string> = []): Job => {
  const job = read(text, tracked).jobs.find((candidate) => candidate.name === name)
  if (job === undefined) throw new Error(`no rule ${name}`)
  return job
}

const commands = (job: Job) => job.steps.map((step) => step.command)
const features = (job: Job) => job.unsupported.map((entry) => entry.feature)
const details = (job: Job) => job.unsupported.map((entry) => entry.detail)
const inventoryOf = (text: string, tracked: ReadonlyArray<string> = []): Inventory.Inventory => ({
  version: 1,
  repository: "acme/widgets",
  commit: "abc",
  toolchains: [],
  jobs: read(text, tracked).jobs
})

describe("readMakefile rules", () => {
  it("reads each rule as a job and the rules a rule lists as what it needs, in order", () => {
    const { jobs, toolchains, unsupported } = read(`.PHONY: ci lint test
ci: lint test
lint:
\tzig fmt --check src
test:
\tzig build test
`)
    expect(toolchains).toEqual([])
    expect(unsupported).toEqual([])
    expect(jobs.map((job) => job.id)).toEqual(["makefile:ci", "makefile:lint", "makefile:test"])
    expect(jobs[0]).toEqual({
      id: "makefile:ci",
      source: "makefile",
      file: "Makefile",
      name: "ci",
      needs: ["makefile:lint", "makefile:test"],
      triggers: [],
      matrix: [],
      steps: [],
      unsupported: []
    })
    expect(jobs[1]?.steps).toEqual([
      { id: "makefile:lint:1", command: "zig fmt --check src", cwd: "", env: {}, secrets: [] }
    ])
  })

  it("makes the ci rule the CI, run in the order it lists, in one working tree", () => {
    const inventory = inventoryOf("ci: test lint\ntest: build\n\tt\nbuild:\n\tb\nlint: build\n\tl\nother:\n\to\n")
    expect(Inventory.treeOf(inventory.jobs[0] as Job)).toBe("Makefile")
    expect(Inventory.ci(inventory).jobs.map((job) => job.id)).toEqual([
      "makefile:build",
      "makefile:test",
      "makefile:lint"
    ])
    expect(Inventory.notReplayed(inventory)).toEqual([])
  })

  it("gives no CI without a ci rule, as a Justfile without a ci recipe does", () => {
    const inventory = inventoryOf("build:\n\tb\ntest:\n\tt\n")
    expect(inventory.jobs.map((job) => job.name)).toEqual(["build", "test"])
    expect(Inventory.ciJobs(inventory)).toEqual([])
    expect(Inventory.refusal(inventory)).toContain("no `ci` recipe or script")
  })

  it("does not take a file prerequisite for a job", () => {
    const job = jobOf("ci: src/a.c lint\n\tcc src/a.c\nlint:\n\tl\n", "ci", ["src/a.c"])
    expect(job.needs).toEqual(["makefile:lint"])
    expect(job.unsupported).toEqual([])
  })

  it("accepts a phony prerequisite with no rule", () => {
    const job = jobOf(".PHONY: nothing\nci: nothing\n\tgo\n")
    expect(job.needs).toEqual([])
    expect(job.unsupported).toEqual([])
  })

  it("needs order-only prerequisites after the others, each once, and never itself", () => {
    expect(jobOf("ci: a ci a | b\n\tgo\na:\nb:\n").needs).toEqual(["makefile:a", "makefile:b"])
  })

  it("merges rules for one name, with the prerequisites of the rule with the recipe first", () => {
    const job = jobOf("ci: a | x\nci: b | y\n\techo $^ $|\na:\nb:\nx:\ny:\n")
    expect(job.needs).toEqual(["makefile:b", "makefile:a", "makefile:y", "makefile:x"])
    expect(commands(job)).toEqual(["sh -c 'echo b a y x'"])
  })

  it("keeps the last recipe of a name", () => {
    expect(commands(jobOf("ci:\n\told\nci:\n\tnew\n"))).toEqual(["new"])
  })

  it("gives every name of a rule its recipe", () => {
    const { jobs } = read("a b: c\n\tgo $@\nc:\n")
    expect(jobs.map((job) => commands(job))).toEqual([["go a"], ["go b"], []])
    expect(jobs[0]?.needs).toEqual(["makefile:c"])
  })

  it("reads a recipe after a semicolon, with its comment, and the lines after it", () => {
    expect(commands(jobOf("ci: a ; @first # kept\n\tsecond\na:\n"))).toEqual(["sh -c 'first # kept'", "second"])
    expect(jobOf("empty: ;\n", "empty", ["empty.sh"]).unsupported).toEqual([])
  })

  it("reads a rule continued on the next line and stops at its comment", () => {
    expect(jobOf("ci: a \\\n   b # c\n\tgo\na:\nb:\n").needs).toEqual(["makefile:a", "makefile:b"])
  })

  it("expands prerequisites where the rule stands, and recipes after the whole file", () => {
    const job = jobOf("X = a\nY = early\nci: $(X)\n\tgo $(Y)\nX = b\nY = late\na:\nb:\n")
    expect(job.needs).toEqual(["makefile:a"])
    expect(commands(job)).toEqual(["go late"])
  })

  it("reads a file with Windows line ends", () => {
    expect(commands(jobOf("ci: a\r\n\tgo\r\na:\r\n"))).toEqual(["go"])
  })

  it("reads an empty file as no jobs", () => {
    expect(read("")).toEqual({ jobs: [], toolchains: [], unsupported: [] })
  })

  it("treats a dot file as a rule and not as a special name", () => {
    expect(jobOf("ci: .env\n.env:\n\tcp a .env\n").needs).toEqual(["makefile:.env"])
  })

  it("reads names that only start like directives as rules", () => {
    expect(jobOf("exporter:\n\tgo\n", "exporter").steps).toHaveLength(1)
    expect(jobOf("export: a\n\tgo\na:\n", "export").needs).toEqual(["makefile:a"])
    expect(jobOf("export : a\n\tgo\na:\n", "export").needs).toEqual(["makefile:a"])
    expect(commands(jobOf("include = 1\nci:\n\tgo $(include)\n"))).toEqual(["go 1"])
  })
})

describe("readMakefile recipe lines", () => {
  it.each([
    ["@go", "go"],
    ["+go", "go"],
    ["@+go", "go"],
    [" @ go", "go"],
    ["--go", "go || true"],
    ["-go", "go || true"],
    ["-@go", "go || true"],
    ["@-go", "go || true"]
  ])("reads the prefixes of %s", (line, command) => {
    expect(commands(jobOf(`ci:\n\t${line}\n`))).toEqual([command])
    expect(jobOf(`ci:\n\t${line}\n`).unsupported).toEqual([])
  })

  it("reads prefixes that come from a variable", () => {
    expect(commands(jobOf("Q = @\nI = -\nci:\n\t$(Q)a\n\t$(I)b\n"))).toEqual(["a", "b || true"])
  })

  it("keeps a continued line for the shell, without the tab of the next line", () => {
    expect(commands(jobOf("ci:\n\tgo a \\\n\t  b\n\tgo c \\\nd\n"))).toEqual([
      "sh -c 'go a \\\n  b'",
      "sh -c 'go c \\\nd'"
    ])
  })

  it("does not read two backslashes as a continuation", () => {
    expect(commands(jobOf("ci:\n\tgo \\\\\n\tnext\n"))).toEqual(["sh -c 'go \\\\'", "next"])
  })

  it("keeps a final backslash that has nothing to continue onto", () => {
    expect(commands(jobOf("ci:\n\tgo \\"))).toEqual(["sh -c 'go \\'"])
    expect(features(jobOf("ci: \\"))).toEqual(["missing-prerequisite"])
  })

  it("leaves out lines that do nothing", () => {
    const job = jobOf("E =\nci:\n\t\n\t$(E)\n\t@$(E)\n\t# a note\n\t@# another\n\n# between\n\tgo\n")
    expect(commands(job)).toEqual(["go"])
    expect(job.unsupported).toEqual([])
  })

  it("keeps a comment that continues, since the shell runs the next line", () => {
    expect(commands(jobOf("ci:\n\t# note \\\n\tgo\n"))).toEqual(["sh -c '# note \\\ngo'"])
  })

  it("names sh for a line the two shells could read differently", () => {
    expect(commands(jobOf("ci:\n\tfalse; echo ok\n\techo hi\n\tzig build test\n\tcd sub\n"))).toEqual([
      "sh -c 'false; echo ok'",
      "sh -c 'echo hi'",
      "zig build test",
      "sh -c 'cd sub'"
    ])
  })

  it("keeps a dollar for the shell", () => {
    expect(commands(jobOf("ci:\n\techo $$HOME $${X} 5$\n"))).toEqual([`sh -c 'echo $HOME \${X} 5$'`])
  })

  it("reports a line that holds a credential and keeps it out", () => {
    const job = jobOf("ci:\n\tcurl -H 'Authorization: Bearer abc123' x.test\n")
    expect(job.steps).toEqual([])
    expect(features(job)).toEqual(["secret-value"])
  })
})

describe("readMakefile variables", () => {
  const value = (lines: string, reference = "$(A)") => commands(jobOf(`${lines}\nci:\n\tgo [${reference}]\n`))[0]

  it.each([
    ["A = 1", "1"],
    ["A=1", "1"],
    ["A := 1", "1"],
    ["A ::= 1", "1"],
    ["A :::= 1", "1"],
    ["A ?= 1", "1"],
    ["A = 1\nA ?= 2", "1"],
    ["A = 1\nA += 2", "1 2"],
    ["A =\nA += 2", "2"],
    ["A += 2", "2"],
    ["override A = 1", "1"],
    ["private A = 1", "1"],
    ["\tA = 1", "1"],
    ["A = 1\\#2", "1#2"],
    ["A = 1 \\\n   2", "1 2"]
  ])("reads %j", (lines, expected) => {
    expect(value(lines)).toBe(`sh -c 'go [${expected}]'`)
  })

  it("expands = at each use and := where it stands", () => {
    expect(value("B = 1\nA = $(B)\nB = 2")).toBe("sh -c 'go [2]'")
    expect(value("B = 1\nA := $(B)\nB = 2")).toBe("sh -c 'go [1]'")
    expect(value("B = 1\nA := x\nA += $(B)\nB = 2")).toBe("sh -c 'go [x 1]'")
    expect(value("B = 1\nA = x\nA += $(B)\nB = 2")).toBe("sh -c 'go [x 2]'")
  })

  it("keeps the space at the end of a value, as Make does", () => {
    expect(value("A = 1 # note")).toBe("sh -c 'go [1 ]'")
    expect(value("A = 1  ")).toBe("sh -c 'go [1  ]'")
    expect(value("override A = 1 ")).toBe("sh -c 'go [1 ]'")
    expect(commands(jobOf("export A = 1 \nci:\n\tgo\n"))).toEqual(["go"])
    expect(jobOf("export A = 1 \nci:\n\tgo\n").steps[0]?.env).toEqual({ A: "1 " })
  })

  it("does not expand a simple variable's value again", () => {
    expect(value("A := $$HOME")).toBe(`sh -c 'go [$HOME]'`)
  })

  it("reads every form of reference", () => {
    expect(value("A = 1", "${A}")).toBe("sh -c 'go [1]'")
    expect(value("A = 1", "$A")).toBe("sh -c 'go [1]'")
    expect(value("A = 1\nN = A", "$($(N))")).toBe("sh -c 'go [1]'")
    expect(value("A = (1)", "$(A)")).toBe("sh -c 'go [(1)]'")
  })

  it("does not take a comment sign in a reference for a comment", () => {
    expect(features(jobOf("A = $(B #)\nci:\n\tgo $(A)\n"))).toEqual(["function"])
    expect(commands(jobOf("A = $(B #\nci:\n\tgo\n"))).toEqual(["go"])
  })

  it("forgets a variable after undefine", () => {
    expect(features(jobOf("A = 1\nundefine A\nci:\n\tgo $(A)\n"))).toEqual(["variable"])
  })

  it("fills in the automatic variables", () => {
    expect(commands(jobOf("ci: a b a | c c\n\tgo $@ $< $^ $+ $| $(@)\na:\nb:\nc:\n"))).toEqual([
      "go ci a a b a b a c ci"
    ])
    expect(commands(jobOf("ci:\n\tgo [$<]\n"))).toEqual(["sh -c 'go []'"])
  })

  it.each([
    ["go $(HOME)", "variable", "Makefile: ci line 2 reads HOME, which the file does not set"],
    ["go $(shell date)", "function", "Makefile: ci line 2 calls the Make function shell"],
    ["go $(wildcard *.c)", "function", "Makefile: ci line 2 calls the Make function wildcard"],
    ["go $(subst a,b,c)", "function", "Makefile: ci line 2 calls the Make function subst"],
    ["go $(A:.c=.o)", "substitution", "Makefile: ci line 2 rewrites a value with $(A:.c=.o)"],
    ["go $?", "automatic-variable", "Makefile: ci line 2 reads $?"],
    ["go $(@D)", "automatic-variable", "Makefile: ci line 2 reads $@D"],
    ["go $(A", "syntax", "Makefile: ci line 2 has a variable reference with no end"]
  ])("reports %s and states no command for it", (line, feature, detail) => {
    const job = jobOf(`ci:\n\t${line}\n\tnext\n`)
    expect(commands(job)).toEqual(["next"])
    expect(job.unsupported).toEqual([{ feature, detail }])
  })

  it("reports a variable that refers to itself", () => {
    expect(details(jobOf("A = $(A)\nci:\n\tgo $(A)\n"))).toEqual([
      "Makefile: ci line 3 reads A, which refers to itself"
    ])
  })

  it("reports a value Make must compute, only where it is read", () => {
    const text =
      "A != date\nB := $(shell date)\nC := x\nC += $(shell date)\nci:\n\tgo $(A)\n\tgo $(B)\n\tgo $(C)\nok:\n\tgo\n"
    expect(details(jobOf(text))).toEqual([
      "Makefile: ci line 6 reads A, which comes from a shell command",
      "Makefile: ci line 7 calls the Make function shell",
      "Makefile: ci line 8 calls the Make function shell"
    ])
    expect(jobOf(text, "ok").unsupported).toEqual([])
  })

  it("never fills a secret into a command", () => {
    const job = jobOf("API_TOKEN = abc123\nci:\n\tcurl -H \"t: $(API_TOKEN)\" x.test\n")
    expect(job.steps).toEqual([])
    expect(details(job)).toEqual(["Makefile: ci line 3 reads API_TOKEN, which holds a secret"])
    expect(JSON.stringify(job)).not.toContain("abc123")
  })

  it("lets the file set MAKE", () => {
    expect(commands(jobOf("MAKE = gmake\nci:\n\t$(MAKE) a\na:\n"))).toEqual(["gmake a"])
  })
})

describe("readMakefile shells", () => {
  it.each([
    ["SHELL = /bin/sh", "go a", "/bin/sh -c"],
    ["SHELL := /bin/bash", "go a", "/bin/bash -c"],
    ["SHELL = bash\n.SHELLFLAGS = -eu -o pipefail -c", "go a", "bash -eu -o pipefail -c"],
    ["SHELL = /usr/bin/env bash", "go a", "/usr/bin/env bash -c"],
    ["SHELL =", "go a", "sh -c"],
    [".POSIX:", "go a", "sh -ec"]
  ])("keeps a plain command plain under %j and names the shell for others", (lines, plain, start) => {
    expect(commands(jobOf(`${lines}\nci:\n\tgo a\n\ta; b\n`))).toEqual([plain, `${start} 'a; b'`])
  })

  it("always names a shell that is not a POSIX one, or flags that change a command", () => {
    expect(commands(jobOf("SHELL = python3\nci:\n\tgo\n"))).toEqual(["python3 -c go"])
    expect(commands(jobOf("SHELL = bash\n.SHELLFLAGS = -lc\nci:\n\tgo\n"))).toEqual(["bash -lc go"])
    expect(commands(jobOf(".SHELLFLAGS =\nci:\n\tgo\n"))).toEqual(["sh go"])
  })

  it("states no command when the shell cannot be read", () => {
    const job = jobOf("SHELL = $(shell which bash)\nci:\n\tgo\n")
    expect(job.steps).toEqual([])
    expect(details(job)).toEqual(["Makefile: ci calls the Make function shell"])
  })

  it("runs a .ONESHELL recipe as one script, with only the first prefix counting", () => {
    expect(commands(jobOf(".ONESHELL:\nci:\n\t@cd sub\n\t-false\n\t@pwd\n"))).toEqual(["sh -c 'cd sub\nfalse\npwd'"])
    expect(commands(jobOf(".ONESHELL:\nci:\n\t-@a\n\tb\n"))).toEqual(["sh -c 'a\nb' || true"])
    expect(commands(jobOf(".ONESHELL:\nci:\n\t@go\n"))).toEqual(["go"])
    expect(jobOf(".ONESHELL:\nE =\nci:\n\t$(E)\n").steps).toEqual([])
  })

  it("reports what it cannot state about a .ONESHELL recipe", () => {
    const unknown = jobOf(".ONESHELL:\nci:\n\ta\n\t$(B)\n")
    expect(unknown.steps).toEqual([])
    expect(features(unknown)).toEqual(["variable"])
    const other = jobOf(".ONESHELL:\nSHELL = python3\nci:\n\tprint(1)\n")
    expect(other.steps).toEqual([])
    expect(features(other)).toEqual(["interpreter"])
  })
})

describe("readMakefile exports", () => {
  const envOf = (lines: string) => jobOf(`${lines}\nci:\n\tgo\n`).steps[0]?.env

  it("gives a step what the file exports", () => {
    expect(envOf("export A = 1\nB = 2\nC = 3\nexport B")).toEqual({ A: "1", B: "2" })
    expect(envOf("A = 1\nB = 2\nexport A B\nunexport B")).toEqual({ A: "1" })
    expect(envOf("N = A\nA = 1\nexport $(N)")).toEqual({ A: "1" })
  })

  it("exports every plain name after a bare export", () => {
    expect(envOf("export\nA = 1\nB = 2\nunexport B\nSHELL = /bin/bash\n.X = 1")).toEqual({ A: "1" })
    expect(envOf(".EXPORT_ALL_VARIABLES:\nA = 1")).toEqual({ A: "1" })
    expect(envOf("export\nunexport\nA = 1")).toEqual({})
    expect(envOf("export\nunexport A\nexport A\nA = 1")).toEqual({ A: "1" })
  })

  it("reports an export whose value it cannot state", () => {
    const job = jobOf("export FROM_CI\nci:\n\tgo\n")
    expect(job.steps).toEqual([])
    expect(details(job)).toEqual(["Makefile: ci reads FROM_CI, which the file does not set"])
  })

  it("keeps an exported credential by name", () => {
    const job = jobOf("export API_TOKEN = abc123\nA = $(API_TOKEN)\nunexport A\nci:\n\tgo\n")
    expect(job.steps).toEqual([])
    expect(features(job)).toEqual(["secret-value"])
    expect(JSON.stringify(job)).not.toContain("abc123")
  })

  it("stops every job when the exported names cannot be read", () => {
    for (const line of ["export $(shell ls)", "unexport $(shell ls)"]) {
      expect(features(jobOf(`${line}\nci:\n\tgo\n`))).toEqual(["function"])
    }
  })
})

describe("readMakefile runs of Make inside a recipe", () => {
  it("puts the steps of the rules a line builds in place of the line", () => {
    const { jobs, toolchains } = read(`ci:
\t@before
\t$(MAKE) lint test
\t\${MAKE} --no-print-directory -s --silent --quiet test
\tmake lint
\tafter
lint:
\tl
test: lint
\tt
`)
    expect(commands(jobs[0] as Job)).toEqual(["before", "l", "t", "l", "t", "l", "after"])
    expect(jobs[0]?.needs).toEqual([])
    expect(toolchains).toEqual([])
  })

  it("builds the first rule when a line names none", () => {
    expect(commands(jobOf(".hidden:\nfirst:\n\tf\nci:\n\t$(MAKE)\n"))).toEqual(["f"])
  })

  it("builds the rule .DEFAULT_GOAL names", () => {
    expect(commands(jobOf(".DEFAULT_GOAL := two\none:\n\to\ntwo:\n\tt\nci:\n\t$(MAKE)\n"))).toEqual(["t"])
    expect(commands(jobOf(".DEFAULT_GOAL :=\none:\n\to\nci:\n\t$(MAKE)\n"))).toEqual(["o"])
  })

  it("runs Make itself when the line does more than build rules of this file", () => {
    const text = `ci:
\t$(MAKE) -C sub test
\t$(MAKE) X=1 a
\tcd sub && make a
\tmake a; echo done
\tmake unknown
\t-$(MAKE) a
a:
\tgo
`
    const { jobs, toolchains } = read(text)
    expect(commands(jobs[0] as Job)).toEqual([
      "make -C sub test",
      "make X=1 a",
      "sh -c 'cd sub && make a'",
      "sh -c 'make a; echo done'",
      "make unknown",
      "make a || true"
    ])
    expect(toolchains).toEqual([{ name: "make", source: "Makefile" }])
  })

  it("runs Make itself when no rule can be the default", () => {
    expect(commands(jobOf(".hidden:\n\tmake\n", ".hidden"))).toEqual(["make"])
    expect(commands(jobOf(".DEFAULT_GOAL = $(shell x)\nci:\n\t$(MAKE)\n"))).toEqual(["make"])
  })

  it("carries what stops a rule it runs into the job that runs it", () => {
    expect(features(jobOf("ci:\n\t$(MAKE) a\na:\n\tgo $(NOPE)\n"))).toEqual(["variable"])
  })

  it("reports a rule that runs Make on itself", () => {
    const direct = jobOf("ci:\n\t$(MAKE) ci\n")
    expect(direct.steps).toEqual([])
    expect(details(direct)).toEqual(["Makefile: ci runs Make on itself"])
    expect(features(jobOf("ci:\n\t$(MAKE) a\na: ci\n"))).toEqual(["recursive-make"])
  })

  it("runs each rule once in one run of Make, through a cycle of prerequisites", () => {
    expect(commands(jobOf("ci:\n\t$(MAKE) a b a\na: b\n\tx\nb: a\n\ty\n"))).toEqual(["y", "x"])
  })
})

describe("readMakefile files", () => {
  it("reports a rule Make may skip because a file has its name", () => {
    for (const tracked of [["test"], ["test/unit.c"]]) {
      expect(details(jobOf("ci: test\ntest:\n\tgo\n", "test", tracked))).toEqual([
        "Makefile: test is also a file in the repository, so Make may skip its recipe"
      ])
    }
    expect(jobOf(".PHONY: test\ntest:\n\tgo\n", "test", ["test/unit.c"]).unsupported).toEqual([])
    expect(jobOf("test: a\na:\n", "test", ["test/unit.c"]).unsupported).toEqual([])
  })

  it("reports a prerequisite nothing provides", () => {
    expect(details(jobOf("ci: nope\n\tgo\n"))).toEqual([
      "Makefile: ci needs nope, which no rule builds and no file provides"
    ])
  })

  it.each([
    ["ci", "ci.sh"],
    ["ci", "ci.c"],
    ["ci", "ci,v"],
    ["ci", "RCS/ci,v"],
    ["ci", "RCS/ci"],
    ["ci", "s.ci"],
    ["ci", "SCCS/s.ci"],
    ["out/a.o", "out/a.c"],
    ["a.c", "a.y"],
    ["a.out", "a"]
  ])("reports that Make builds %s, which has no recipe, from %s", (name, file) => {
    const job = jobOf(`.PHONY: top\ntop: ${name}\n${name}:\n`, name, [file])
    expect(job.unsupported).toEqual([{
      feature: "implicit-rule",
      detail: `Makefile: ${name} depends on Make building ${name} from ${file}`
    }])
    const needing = jobOf(`.PHONY: top\ntop: ${name}\n\tgo\n`, "top", [file])
    expect(features(needing)).toEqual(["implicit-rule"])
  })

  it("does not look for a source of a file Make has no rule to build", () => {
    expect(jobOf("ci: a.h\n\tgo\n", "ci", ["a.h", "a.c"]).unsupported).toEqual([])
    expect(jobOf("ci: .c-ish\n\tgo\n", "ci", [".c-ish"]).unsupported).toEqual([])
  })

  it("ignores a file that only has the name being looked for", () => {
    expect(jobOf("ci: a.c\n\tgo\n", "ci", ["a.c"]).unsupported).toEqual([])
  })
})

describe("readMakefile rules that are not written out", () => {
  it("reports a pattern rule only where the CI depends on it", () => {
    const text = "%.o: %.c\n\tcc $<\nci: main.o lint\nlint:\n\tl\nmain.o:\nother:\n\tgo\n"
    expect(details(jobOf(text, "main.o"))).toEqual(["Makefile: main.o depends on the pattern rule %.o"])
    expect(jobOf(text).unsupported).toEqual([])
    expect(features(jobOf("%.o:\n\tcc\nci: a.o\n\tgo\n"))).toEqual(["pattern-rule"])
    expect(jobOf(text, "other").unsupported).toEqual([])
    expect(Inventory.notReplayed(inventoryOf(text)).map((row) => row.job)).toEqual(["makefile:ci", "makefile:main.o"])
  })

  it("matches a pattern on the file name, or on the path when it names a directory", () => {
    expect(features(jobOf("%.o:\n\tc\nci: out/a.o\n\tgo\n"))).toEqual(["pattern-rule"])
    expect(features(jobOf("out/%.o:\n\tc\nci: out/a.o\n\tgo\n"))).toEqual(["pattern-rule"])
    expect(features(jobOf("out/%.o:\n\tc\nci: lib/a.o\n\tgo\n"))).toEqual(["missing-prerequisite"])
    expect(features(jobOf("ab%ba:\n\tc\nci: aba\n\tgo\n"))).toEqual(["missing-prerequisite"])
  })

  it("reads suffix rules as pattern rules", () => {
    expect(details(jobOf(".c.o:\n\tcc\nci: a.o\n\tgo\n"))).toEqual(["Makefile: ci depends on the pattern rule %.o"])
    expect(details(jobOf(".sh:\n\tcp\nci: a\n\tgo\n"))).toEqual(["Makefile: ci depends on the pattern rule %"])
    expect(jobOf(".c.o: x\n\tgo\nx:\n", ".c.o").needs).toEqual(["makefile:x"])
  })

  it.each([
    ["ci:: a\n\tgo\na:\n", "double-colon", "Makefile: ci has a double-colon rule"],
    ["ci a &: b\n\tgo\nb:\n", "grouped-targets", "Makefile: ci is built together with other files"],
    ["ci: %: %.c\n\tgo\n", "pattern-rule", "Makefile: ci comes from a static pattern rule"],
    ["ci: ; a \\\n  b\n", "syntax", "Makefile: ci continues a recipe written after a semicolon"],
    ["ci: $(shell ls)\n\tgo\n", "function", "Makefile: ci at line 1 calls the Make function shell"],
    ["ci: a | $(NOPE)\n\tgo\na:\n", "variable", "Makefile: ci at line 1 reads NOPE, which the file does not set"]
  ])("reports the rule in %j", (text, feature, detail) => {
    expect(jobOf(text).unsupported).toContainEqual({ feature, detail })
  })

  it("reports a variable set for one rule on that rule and everything it builds", () => {
    const text = "ci: X = 1\nci: a\n\tgo\na: b\nb: a\nother:\n\tgo\nnobody: Y := 1\n%.o: Z = 1\n"
    const reason = "target-variable"
    const blocked = read(text.replace("%.o: Z = 1\n", ""))
    expect(blocked.jobs.map((job) => [job.name, features(job)])).toEqual([
      ["ci", [reason]],
      ["a", [reason]],
      ["b", [reason]],
      ["other", []]
    ])
    expect(details(blocked.jobs[1] as Job)).toEqual(["Makefile: a runs with a variable set for ci"])
    expect(features(jobOf(text, "other"))).toEqual([reason])
  })
})

describe("readMakefile what stops the whole file", () => {
  it.each([
    ["include other.mk", "include", "line 1 includes other.mk, which was not read"],
    ["-include other.mk", "include", "line 1 includes other.mk, which was not read"],
    ["sinclude other.mk", "include", "line 1 includes other.mk, which was not read"],
    ["vpath %.c src", "vpath", "line 1 uses vpath"],
    ["load x.so", "load", "line 1 uses load"],
    ["-load x.so", "load", "line 1 uses -load"],
    ["MAKEFLAGS += -j4", "make-setting", "sets MAKEFLAGS, which changes how Make runs"],
    ["VPATH = src", "make-setting", "sets VPATH, which changes how Make runs"],
    [".RECIPEPREFIX = >", "make-setting", "sets .RECIPEPREFIX, which changes how Make runs"],
    [".DEFAULT:\n\tgo", "default-rule", "line 1 uses .DEFAULT"],
    [".IGNORE:", "ignored-failure", "line 1 uses .IGNORE"],
    [".SECONDEXPANSION:", "second-expansion", "line 1 uses .SECONDEXPANSION"],
    [".SUFFIXES: .x", "suffix-rule", "line 1 adds suffixes"],
    ["$(N) = 1", "computed-name", "line 1 sets a variable whose name is computed"],
    ["$(eval X = 1)", "expansion", "line 1 expands to something Make reads as more of the file"],
    ["$(shell ls): a", "function", "line 1 calls the Make function shell"],
    ["this is not make", "malformed-file", "line 1 cannot be read"],
    ["= 1", "malformed-file", "line 1 cannot be read"],
    ["a b = 1", "malformed-file", "line 1 cannot be read"],
    ["a; b: c", "malformed-file", "line 1 cannot be read"],
    ["\tstray: x", "malformed-file", "line 1 cannot be read"],
    ["else", "malformed-file", "line 1 cannot be read"],
    ["endif", "malformed-file", "line 1 cannot be read"],
    ["define A\nx", "malformed-file", "the define block at line 1 has no end"],
    ["ifdef A", "malformed-file", "a conditional has no endif"],
    ["ifdef A\nbuild:\nendif", "conditional", "line 2 is inside a conditional"],
    ["ifdef A\ninclude x\nendif", "conditional", "line 2 is inside a conditional"],
    ["ifdef A\n$(N) = 1\nendif", "conditional", "line 2 is inside a conditional"]
  ])("reports %j on every job and on the file", (lines, feature, reason) => {
    const { jobs, unsupported } = read(`${lines}\nci:\n\tgo\nlint:\n\tgo\n`)
    const detail = `Makefile: ${reason}`
    expect(unsupported).toContainEqual({ feature, detail })
    for (const job of jobs) {
      expect(job.steps).toEqual([])
      expect(job.unsupported).toContainEqual({ feature, detail })
    }
  })

  it("reports the same setting once", () => {
    expect(read("MAKEFLAGS += -s\nMAKEFLAGS += -k\n").unsupported).toHaveLength(1)
  })

  it("leaves special names that change nothing out of the jobs", () => {
    const text =
      ".SILENT:\n.NOTPARALLEL:\n.DELETE_ON_ERROR:\n.SECONDARY:\n.SUFFIXES:\n.PHONY: ci\n\tignored\nci:\n\tgo\n"
    const { jobs, unsupported } = read(text)
    expect(jobs.map((job) => job.name)).toEqual(["ci"])
    expect(commands(jobs[0] as Job)).toEqual(["go"])
    expect(unsupported).toEqual([])
  })

  it("reads a recipe's tab line after an assignment as outside the rule", () => {
    expect(read("ci:\n\tgo\nX = 1\n\tstray\n").unsupported).toEqual([{
      feature: "malformed-file",
      detail: "Makefile: line 4 cannot be read"
    }])
  })
})

describe("readMakefile conditionals and define blocks", () => {
  it("leaves a job alone unless it reads what a conditional sets", () => {
    const text = `ifeq ($(OS),Windows_NT)
EXT = .exe
else ifdef OTHER
override EXT = .bin
else
EXT =
endif
ci: lint
\tbuild$(EXT)
lint:
\tl
`
    const { jobs, unsupported } = read(text)
    expect(unsupported).toEqual([])
    expect(jobs[0]?.steps).toEqual([])
    expect(details(jobs[0] as Job)).toEqual(["Makefile: ci line 9 reads EXT, which a conditional sets"])
    expect(jobs[1]?.unsupported).toEqual([])
    expect(Inventory.notReplayed(inventoryOf(text)).map((row) => row.job)).toEqual(["makefile:ci"])
  })

  it("counts nested conditionals", () => {
    expect(read("ifdef A\nifndef B\nifneq (a,b)\nX = 1\nendif\nendif\nendif\nci:\n\tgo\n").unsupported).toEqual([])
  })

  it("reports a recipe with a conditional in it", () => {
    const job = jobOf("ci:\n\ta\nifdef X\n\tb\nendif\n\tc\n")
    expect(details(job)).toEqual(["Makefile: ci has a recipe with a conditional in it"])
    expect(commands(job)).toEqual(["a", "b", "c"])
  })

  it("reports a define block only where it is read", () => {
    const text = "define A\nline $(x)\ndefine B\nendef\nendef\noverride define C =\nendef\nci:\n\tgo $(A)\nok:\n\tgo\n"
    expect(details(jobOf(text))).toEqual(["Makefile: ci line 9 reads A, which a define block sets"])
    expect(jobOf(text, "ok").unsupported).toEqual([])
    expect(read(text).unsupported).toEqual([])
  })
})

describe("the Makefile of a real repository", () => {
  const made: Array<string> = []
  afterAll(() => made.forEach(remove))

  const repository = (files: Readonly<Record<string, string>>): string => {
    const root = temporary("makefile")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "first", files)
    return root
  }

  const inventoryAt = (root: string) => Effect.runPromise(readRepository(root).pipe(Effect.provide(NodeServices.layer)))

  it.each(["Makefile", "makefile", "GNUmakefile"])("reads a root %s", async (name) => {
    const inventory = await inventoryAt(repository({ [name]: "ci:\n\tgo\n" }))
    expect(inventory.jobs.map((job) => [job.id, job.file])).toEqual([["makefile:ci", name]])
  })

  it("reads only the file Make would read", async () => {
    const inventory = await inventoryAt(repository({ GNUmakefile: "first:\n\tgo\n", Makefile: "second:\n\tgo\n" }))
    expect(inventory.jobs.map((job) => job.name)).toEqual(["first"])
  })

  it("does not read a Makefile below the root", async () => {
    expect((await inventoryAt(repository({ "sub/Makefile": "ci:\n\tgo\n", "a.txt": "x" }))).jobs).toEqual([])
  })

  it("checks a rule's name against the files the repository tracks", async () => {
    const inventory = await inventoryAt(repository({ Makefile: "ci: test\ntest:\n\tgo\n", "test/unit.txt": "x" }))
    expect(inventory.jobs[1]?.unsupported.map((entry) => entry.feature)).toEqual(["file-target"])
    expect(Inventory.refusal(inventory)).toContain("makefile:test")
  })

  const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))
  const makefile = `.PHONY: ci lint test
ci: lint test
lint:
\tmkdir -p out
\techo checked > out/lint
test:
\ttest -f out/lint
\tgrep -q value src/a.txt
`

  it("replays a repository whose only CI is a Makefile, and writes files that keep its order", async () => {
    const root = repository({ Makefile: makefile, ".gitignore": "out\n", "src/a.txt": "value 1\n" })
    commit(root, "second", { "src/a.txt": "value 2\n" })
    commit(root, "third", { "src/b.txt": "more\n" })

    const replay = await spawn(bin, ["replay", "--commits", "2", "--json"], root)
    expect(replay.code, replay.stderr).toBe(exitCodes.ok)
    const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReplayReport))(replay.stdout)
    expect(report.commits).toHaveLength(2)
    expect(report.mismatches).toBe(0)
    expect(report.notReplayed).toBeUndefined()
    expect(report.commits.every((entry) => entry.baseline.ok && entry.normal.ok)).toBe(true)

    const apply = await spawn(bin, ["apply"], root)
    expect(apply.code, apply.stderr).toBe(exitCodes.ok)
    expect(existsSync(join(root, ".github/workflows/smithers-ci.yml"))).toBe(true)
    expect(readFile(join(root, ".github/workflows/smithers-ci.yml"))).toContain("smthrs")
    const planned = spawnSync(process.execPath, [smthrs, "ci", "//...", "--plan", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    })
    expect(planned.status, planned.stderr).toBe(0)
    const targets = (JSON.parse(planned.stdout) as {
      readonly targets: ReadonlyArray<{ readonly label: string; readonly dependencies: ReadonlyArray<string> }>
    }).targets
    const rows = targets.map((target) => [target.label, target.dependencies])
    expect(rows.map(([label]) => label)).toEqual([
      "//:makefile-lint-1",
      "//:makefile-lint-2",
      "//:makefile-test-1",
      "//:makefile-test-2"
    ])
    expect(rows.map(([, dependencies]) => dependencies)).toEqual([
      [],
      ["//:makefile-lint-1"],
      ["//:makefile-lint-2"],
      ["//:makefile-test-1"]
    ])
  }, 540_000)
})
