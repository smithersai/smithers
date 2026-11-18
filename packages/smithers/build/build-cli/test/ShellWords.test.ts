import { describe, expect, it } from "vitest"
import * as ShellWords from "../src/internal/ShellWords.ts"

describe("the programs a shell command names", () => {
  it.each([
    ["npm test", ["npm"]],
    ["  exec npm test", ["npm"]],
    ["cd packages/a && npm run build; pnpm test || true", ["cd", "npm", "pnpm", "true"]],
    ["FOO=1 BAR+=2 env -i PATH=/bin node x.js | tee out.log", ["node", "tee"]],
    ["if [ -f x ]; then npm ci; elif ! test -d y; then make; else time -p zig build; fi", [
      "npm",
      "test",
      "make",
      "zig",
      "fi"
    ]],
    ["for f in a b; do nohup cargo test; done", ["for", "cargo", "done"]],
    ["while true; do command -v git; done; until false; do builtin echo; done", [
      "true",
      "git",
      "done",
      "false",
      "echo"
    ]],
    ["{ go vet ./...; }\n(ruby -v)", ["go", "ruby"]],
    ["./gradlew build", ["./gradlew"]],
    ["npm test # then npx playwright\nbun test", ["npm", "bun"]],
    ["npm test # trailing comment", ["npm"]],
    ["echo a#b", ["echo"]],
    ["npm \\\n  run test", ["npm"]],
    ["\\npm test\\", ["npm"]],
    ["'npm' test", ["npm"]],
    ["\"pnpm\" run \"a b\"", ["pnpm"]],
    ["npm run 'unterminated", ["npm"]],
    ["echo \"unterminated", ["echo"]],
    ["echo \"ends in a backslash\\", ["echo"]],
    ["npm test > out.log 2>&1", ["npm"]]
  ])("reads %j", (text, programs) => {
    expect(ShellWords.commands(text)).toEqual(programs)
  })

  it("reads the text a shell is given to run, and no script file", () => {
    expect(ShellWords.commands("bash -e -c 'npm run test --workspace=a --if-present'")).toEqual(["bash", "npm"])
    expect(ShellWords.commands("/bin/sh -ec \"cd a && pnpm test\"")).toEqual(["/bin/sh", "cd", "pnpm"])
    expect(ShellWords.commands("bash -euo pipefail -c 'zig build'")).toEqual(["bash", "zig"])
    expect(ShellWords.commands("bash -e -o pipefail -c \"make \\\"all\\\"\"")).toEqual(["bash", "make"])
    expect(ShellWords.commands("bash -c")).toEqual(["bash"])
    expect(ShellWords.commands("bash -e script.sh -c 'npm test'")).toEqual(["bash"])
    expect(ShellWords.commands("bash --norc -c 'npm test'")).toEqual(["bash"])
    expect(ShellWords.commands("bash")).toEqual(["bash"])
  })

  it("stops reading shells inside shells at the fifth", () => {
    const nested = (depth: number): string => depth === 0 ? "npm" : `sh -c ${JSON.stringify(nested(depth - 1))}`
    expect(ShellWords.commands(nested(4))).toEqual(["sh", "npm"])
    expect(ShellWords.commands(nested(6))).toEqual(["sh"])
  })

  it("names no program the shell computes, and reads the command a substitution runs", () => {
    expect(ShellWords.commands("$TOOL build")).toEqual([])
    expect(ShellWords.commands("${TOOL} build; ${UNTERMINATED")).toEqual([])
    expect(ShellWords.commands("\"$HOME/bin/tool\" build")).toEqual([])
    expect(ShellWords.commands("\"`which tool`\" build")).toEqual([])
    expect(ShellWords.commands("version=$(node --version) npm test")).toEqual(["node", "npm"])
    expect(ShellWords.commands("echo `git rev-parse HEAD` $HOME")).toEqual(["echo", "git"])
    expect(ShellWords.commands("x=$((1 + 2)); a=1")).toEqual([])
    expect(ShellWords.commands("[ -n \"$CI\" ] && npm ci")).toEqual(["npm"])
    expect(ShellWords.commands("")).toEqual([])
  })

  it("names each program once, in the order the text names them", () => {
    expect(ShellWords.commands("npm ci && npm test && node x.js && npm pack")).toEqual(["npm", "node"])
  })
})
