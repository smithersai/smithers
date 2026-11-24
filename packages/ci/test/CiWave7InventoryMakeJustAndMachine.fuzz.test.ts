import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { describe, expect, it } from "@effect/vitest"
import { Arbitrary, Effect, Schema } from "effect"
import type { Inventory } from "../src/contract/Inventory.vibe"
import * as GithubActions from "../src/inventory/GithubActions.vibe"
import * as Justfile from "../src/inventory/Justfile.vibe"
import * as LeftRunning from "../src/inventory/LeftRunning.vibe"
import * as Machine from "../src/inventory/Machine.vibe"
import * as MachineChanges from "../src/inventory/MachineChanges.vibe"
import * as Makefile from "../src/inventory/Makefile.vibe"
import * as Tools from "../src/inventory/Tools.ts"

const seed = 7072
const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? 50)

const SeedSchema = Schema.Struct({
  salt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
  tag: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{1,8}$/))
})

const makefiles = (tag: string): ReadonlyArray<{ readonly text: string; readonly tracked: ReadonlyArray<string> }> => [
  {
    tracked: ["app.c", "existing-target"],
    text: [
      ".POSIX:",
      ".EXPORT_ALL_VARIABLES:",
      ".SUFFIXES: .foo .bar",
      ".SILENT:",
      ".DEFAULT_GOAL := build",
      "MAKEFLAGS := -j4",
      "SH_VAR != echo hi",
      "SELF = $(SELF)",
      "A = $(B)$(B)",
      "B = $(A)",
      "SUB = foo.c bar.c",
      "OBJ = $(SUB:.c=.o)",
      "export",
      "export FOO BAR",
      "unexport BAR",
      "unexport",
      "undefine SH_VAR",
      "$(DYNAMIC) = 1",
      "SHELL := /bin/zsh",
      ".ONESHELL:",
      "%.o: %.c",
      "\techo compile $@ $< $$HOME \\#comment $(UNCLOSED",
      "t-var: CFLAGS = -O2",
      "%.pat: CFLAGS = -O1",
      "g1 g2 &: dep",
      "\techo grouped",
      "inline: ; echo one \\",
      "\techo two",
      "define MY_BLOCK",
      "define NESTED",
      "endef",
      "endef",
      "build: existing-target app.o sub-call t-var",
      "\techo $(OBJ) $(SELF) $(SH_VAR) $(MY_BLOCK)",
      "existing-target:",
      "\techo exists",
      "sub-call:",
      "\t$(MAKE) -s leaf",
      "\t$(MAKE) sub-call",
      "leaf:",
      `\techo ${tag}`,
      "t-var: leaf",
      "\techo tvar",
      "dep:",
      "\techo dep"
    ].join("\n")
  },
  {
    tracked: ["foo.c"],
    text: [
      "ifdef DEBUG",
      "X = 1",
      "endif",
      "bad-recipe-cond:",
      "\techo start",
      "ifeq (1,1)",
      "\techo mid",
      "endif",
      "-include extra.mk",
      "sinclude more.mk",
      "define UNCLOSED_DEF",
      "line 1"
    ].join("\n")
  },
  {
    tracked: [],
    text: [
      "ifdef UNCLOSED_IF",
      "a:",
      "\techo hi",
      "not a valid line at all",
      "deep:",
      "\t$(MAKE) deep2",
      "deep2:",
      "\t$(MAKE) deep3",
      "deep3:",
      "\t$(MAKE) deep"
    ].join("\n")
  },
  {
    tracked: [],
    text: [
      "A = x$(B)$(B)$(B)$(B)",
      "B = x$(C)$(C)$(C)$(C)",
      "C = x$(D)$(D)$(D)$(D)",
      "D = x$(E)$(E)$(E)$(E)",
      "E = x$(F)$(F)$(F)$(F)",
      "F = xxxxxxxxxxxxxxxxxxxxx",
      "boom:",
      "\techo $(A)",
      ".c:",
      "\techo suffix",
      "bad-target $(UNCLOSED: dep",
      "\techo x"
    ].join("\n")
  }
]

const justfiles = (tag: string): ReadonlyArray<string> => [
  [
    "set shell := []",
    "set export := true",
    "set positional-arguments := true",
    "set ignore-comments := true",
    "set script-interpreter := ['python3']",
    "set working-directory := 'sub'",
    "mod helper 'helper.just'",
    "import 'extra.just'",
    "API_KEY := 'literal-secret-value-1234567890'",
    "export DYN := `echo hi`",
    `val := "a\\"b" \\`,
    `  + "${tag}"`,
    "[working-directory('../outside')]",
    "out:",
    "  echo out",
    "[working-directory('sub')]",
    "[positional-arguments]",
    "[script('bash', '-eu')]",
    "run-script arg='x':",
    "  echo $1 {{val}} {{{{escaped}}}}",
    "[script]",
    "py-script:",
    "  print(1)",
    "[script('ruby')]",
    "rb-script:",
    "  puts 1",
    "shebang-py:",
    "  #!/usr/bin/env python3",
    "  print(1)",
    "shebang-sh:",
    "  #!/bin/sh",
    "  echo ok \\",
    "  more",
    "empty-cmd:",
    "  @",
    "chain: && shebang-sh",
    "  echo {{unclosed",
    "mod-dep: helper::build",
    "  echo dep",
    "dup:",
    "  echo first",
    "dup:",
    "  echo second"
  ].join("\n")
]

describe("packages/ci Wave-7 Makefile, Justfile, MachineChanges, LeftRunning, Tools, Machine fuzz", () => {
  it.effect("fuzzes Makefile.readMakefile across directives, expansion limits, patterns, conditionals, and recursion", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(
        Arbitrary.schema(SeedSchema),
        ({ salt, tag }) =>
          Effect.sync(() => {
            const list = makefiles(tag)
            for (let i = 0; i < list.length; i++) {
              const item = list[(salt + i) % list.length]!
              const parsed = Makefile.readMakefile("Makefile", item.text, item.tracked)
              expect(Array.isArray(parsed.jobs)).toBe(true)
            }
            return true
          }),
        { seed, executions }
      )
      expect(report._tag).toBe("Passed")
    }))

  it.effect("fuzzes Justfile.readJustfile across settings, modules, attributes, scripts, and duplicates", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(
        Arbitrary.schema(SeedSchema),
        ({ tag }) =>
          Effect.sync(() => {
            for (const text of justfiles(tag)) {
              const parsed = Justfile.readJustfile("justfile", text, "linux")
              expect(Array.isArray(parsed.jobs)).toBe(true)
              expect(parsed.unsupported.length).toBeGreaterThan(0)
            }
            return true
          }),
        { seed, executions }
      )
      expect(report._tag).toBe("Passed")
    }))

  it.effect("fuzzes MachineChanges and LeftRunning across package managers, quoting, heredocs, traps, and daemons", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(
        Arbitrary.schema(SeedSchema),
        ({ salt, tag }) =>
          Effect.sync(() => {
            const scripts = [
              "apt-get -o Dpkg::Options::=--force-confdef update && apt-get install -y jq curl",
              "apt-cache search jq",
              "pacman -Q jq; pacman -Si jq; pacman -Su; pacman -Sy; pacman -S jq",
              "service --status-all; service nginx status; service nginx restart",
              "npm install -g typescript && npm link",
              "corepack enable && corepack disable",
              "gem install rails && gem install --user-install bundler",
              "pip install --break-system-packages ruff && python3 -m pip install --break-system-packages black",
              "uv pip install --system pytest",
              "env -S 'apt-get install -y vim' extra",
              "sudo su",
              "function f() { rpm --eval '%(id)'; }\ncoproc myp { echo hi; }",
              `echo $'\\cA\\101\\x41\\'' "a\\"b" \${FOO:-bar} \`apt-get install -y ${tag}\``,
              "sh <<EOF\napt-get install -y git\nEOF\ncat <<-END\n\t$(apt-get install -y make)\nEND",
              "set -e\napt-get update\napt-get install -y jq"
            ]
            for (let i = 0; i < scripts.length; i++) {
              const cmd = scripts[(salt + i) % scripts.length]!
              const env: Record<string, string> = i % 2 === 0 ? { PIP_BREAK_SYSTEM_PACKAGES: "1" } : { GEM_HOME: "/tmp/gem" }
              const ch = MachineChanges.changesIn(cmd, env)
              expect(Array.isArray(ch)).toBe(true)
              MachineChanges.installsOf(cmd)
            }

            const daemons = [
              "mongod --fork --logpath /tmp/m.log",
              "pg_ctl start -D /tmp/pg",
              "pg_ctlcluster 16 main start",
              "start-stop-daemon --start --exec /usr/bin/sleep -- 10",
              "echo $'a\\nb' \"x\\\"y\" # comment\ncat <<-EOF\n\tbg &\nEOF\nsleep 10 &\nPID=$!\nkill -0 $PID\nkill $PID",
              "sleep 10 &\nwait",
              "sleep 10 &\nkill %1",
              "trap -- 'kill $PID' EXIT\nsleep 10 &\nPID=$!",
              "trap 'kill $!' 0\n(FOO=1 /usr/bin/sleep 10) &"
            ]
            for (let i = 0; i < daemons.length; i++) {
              const lr = LeftRunning.leftRunningIn(daemons[(salt + i) % daemons.length]!)
              expect(Array.isArray(lr)).toBe(true)
            }
            return true
          }),
        { seed, executions }
      )
      expect(report._tag).toBe("Passed")
    }))

  it.effect("fuzzes Tools version comparison, onMachine, and Machine.onThisMachine", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(
        Arbitrary.schema(SeedSchema),
        ({ salt, tag }) =>
          Effect.gen(function*() {
            expect(Tools.differs("1.2.3", "1.2.3")).toBe(false)
            expect(Tools.differs("1.2.3", "1.2.4")).toBe(true)
            expect(Tools.differs("^1.2.0", "1.5.0")).toBe(false)
            expect(Tools.differs("^1.2.0", "1.1.9")).toBe(true)
            expect(Tools.differs("^0.0.3", "0.0.4")).toBe(true)
            expect(Tools.differs("^0.2.0", "0.3.0")).toBe(true)
            expect(Tools.differs("~1.2.0", "1.2.9")).toBe(false)
            expect(Tools.differs(">=2.0.0", "1.9.9")).toBe(false)
            expect(Tools.differs("not-a-ver", "1.0.0")).toBe(false)
            expect(Tools.versionIn(`tool v1.${salt % 10}.2`)).toBe(`1.${salt % 10}.2`)

            const parsed = GithubActions.readWorkflow(
              ".github/workflows/ci.yml",
              [
                "on: push",
                "jobs:",
                "  win:",
                "    runs-on: windows-latest",
                "    steps:",
                "      - run: echo win",
                "  own:",
                "    runs-on: [self-hosted, custom-gpu]",
                "    steps:",
                "      - run: echo own",
                "  lin:",
                "    runs-on: ubuntu-latest",
                "    steps:",
                "      - uses: actions/setup-node@v4",
                "        with:",
                "          node-version: '22.0.0'",
                "      - uses: actions/setup-go@v5",
                "        with:",
                "          go-version: '1.22'",
                "      - run: sudo apt-get install -y jq",
                `      - run: echo ${tag}`
              ].join("\n"),
              { repository: `acme/${tag}` }
            )
            const inv: Inventory = {
              version: 1, repository: `acme/${tag}`, commit: "0".repeat(40),
              jobs: parsed.jobs,
              toolchains: parsed.toolchains,
              unsupported: parsed.unsupported
            }
            const found = new Map<string, Tools.Found>([
              ["node", { program: "node", version: "20.0.0" }],
              ["go", { program: "go" }]
            ])
            const mapped = Tools.onMachine(inv, "linux", found)
            expect(mapped.jobs.length).toBe(parsed.jobs.length)

            const m1 = yield* Machine.onThisMachine(inv, { host: "linux", path: "" })
            expect(m1.jobs.length).toBe(parsed.jobs.length)
            if (salt % 10 === 0) {
              const m2 = yield* Machine.onThisMachine(inv, Tools.thisMachine())
              expect(m2.jobs.length).toBe(parsed.jobs.length)
            }
            return true
          }).pipe(Effect.provide(NodeServices.layer)),
        { seed, executions: Math.min(executions, 20) }
      )
      expect(report._tag).toBe("Passed")
    }))
})
