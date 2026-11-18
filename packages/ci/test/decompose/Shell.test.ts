import { describe, expect, it } from "vitest"
import { type Command, commands, quote } from "../../src/decompose/Shell.ts"

const words = (command: Command | undefined): ReadonlyArray<string> => (command?.words ?? []).map((word) => word.text)

/** The words of each command a script can run. */
const read = (script: string): ReadonlyArray<ReadonlyArray<string>> | undefined => commands(script)?.map(words)

describe("commands", () => {
  it("reads commands separated by newlines, semicolons, && and ||", () => {
    const list = commands("set -e\npnpm install; pnpm build && pnpm test || echo failed")
    expect(list?.map(words)).toEqual([["set", "-e"], ["pnpm", "install"], ["pnpm", "build"], ["pnpm", "test"], [
      "echo",
      "failed"
    ]])
    expect(list?.map((command) => command.joint)).toEqual(["first", ";", ";", "&&", "||"])
    expect(list?.every((command) => !command.piped && !command.background && !command.conditional)).toBe(true)
  })

  it("marks a command whose output is piped, and the command it is piped to", () => {
    const list = commands("bun run test 2>&1 | tee out.log")
    expect(list?.map(words)).toEqual([["bun", "run", "test"], ["tee", "out.log"]])
    expect(list?.map((command) => [command.piped, command.joint])).toEqual([[true, "first"], [false, "|"]])
  })

  it("marks a background command and joins the next one with &", () => {
    const list = commands("turbo run lint &\nturbo run test & wait")
    expect(list?.map((command) => [words(command).join(" "), command.background, command.joint])).toEqual([
      ["turbo run lint", true, "first"],
      ["turbo run test", true, "&"],
      ["wait", false, "&"]
    ])
  })

  it("removes quotes and keeps what they protect", () => {
    expect(read(`echo 'a b' "c d" e\\ f "g\\"h" 'i'"j"k`)).toEqual([["echo", "a b", "c d", "e f", "g\"h", "ijk"]])
    expect(read(`echo "a\\\\b" "c\\$d" "e\\nf"`)).toEqual([["echo", "a\\b", "c$d", "e\\nf"]])
  })

  it("joins a line continued with a backslash", () => {
    expect(read("turbo run test \\\n  --filter=web")).toEqual([["turbo", "run", "test", "--filter=web"]])
    expect(read("echo a\\\nb")).toEqual([["echo", "ab"]])
  })

  it("skips comments and blank lines", () => {
    expect(read("# install\n\npnpm install # all of it\n")).toEqual([["pnpm", "install"]])
    expect(read("echo a#b")).toEqual([["echo", "a#b"]])
  })

  it("keeps a variable unexpanded and marks its word as not literal", () => {
    const list = commands(`tee "$RUNNER_TEMP/out.log" \${HOME} $? plain "$1" $!`)
    expect(list?.[0]?.words).toEqual([
      { text: "tee", literal: true },
      { text: "$RUNNER_TEMP/out.log", literal: false },
      { text: "${HOME}", literal: false },
      { text: "$?", literal: false },
      { text: "plain", literal: true },
      { text: "$1", literal: false },
      { text: "$!", literal: false }
    ])
  })

  it("reads assignments before the words, quoted or not", () => {
    const list = commands(`NODE_OPTIONS='--max-old-space-size=8192' CI=1 turbo run typecheck`)
    expect(list?.[0]?.assignments).toEqual([
      ["NODE_OPTIONS", { text: "--max-old-space-size=8192", literal: true }],
      ["CI", { text: "1", literal: true }]
    ])
    expect(words(list?.[0])).toEqual(["turbo", "run", "typecheck"])
    const only = commands("status=$?\npid=$!")
    expect(only?.map((command) => [command.assignments, command.words])).toEqual([
      [[["status", { text: "$?", literal: false }]], []],
      [[["pid", { text: "$!", literal: false }]], []]
    ])
    // After the first word, `a=b` is an argument.
    expect(read("env A=1 B=2")).toEqual([["env", "A=1", "B=2"]])
  })

  it("gives where a command's words sit, so they can be replaced", () => {
    const script = "set -e\nCI=1 pnpm -r run test > out.log 2>&1\necho done"
    const list = commands(script) as ReadonlyArray<Command>
    const run = list[1] as Command
    expect(script.slice(run.start, run.end)).toBe("pnpm -r run test")
    expect(words(run)).toEqual(["pnpm", "-r", "run", "test"])
  })

  it("does not give a place when a redirection sits between two words", () => {
    const list = commands("pnpm test 2>&1 --coverage\n>out.log pnpm test\npnpm test >> \"$LOG\"")
    expect(list?.map((command) => command.start === undefined)).toEqual([true, false, false])
    expect(list?.map(words)).toEqual([["pnpm", "test", "--coverage"], ["pnpm", "test"], ["pnpm", "test"]])
  })

  it("reads every branch of an if whose test it cannot compute, as conditional", () => {
    const list = commands(
      `if [ -n "$FILTER" ]; then zig build test -Dfilter="$FILTER"; elif [ "$A" = b ]; then echo b; else zig build test; fi\necho after`
    )
    expect(list?.map((command) => [words(command).join(" "), command.conditional])).toEqual([
      ["[ -n $FILTER ]", false],
      ["zig build test -Dfilter=$FILTER", true],
      ["[ $A = b ]", false],
      ["echo b", true],
      ["zig build test", true],
      ["echo after", false]
    ])
  })

  it("computes a test of literal words and keeps only the branch that runs", () => {
    expect(read(`if [ -n "" ]; then zig build test -Dtest-filter=""; else zig build test; fi`)).toEqual([[
      "zig",
      "build",
      "test"
    ]])
    expect(commands(`if [ -n "" ]; then a; else zig build test; fi`)?.[0]?.conditional).toBe(false)
    expect(read(`if [ -z "" ]; then a; else b; fi`)).toEqual([["a"]])
    expect(read(`if [ x = x ]; then a; else b; fi`)).toEqual([["a"]])
    expect(read(`if [ x == y ]; then a; else b; fi`)).toEqual([["b"]])
    expect(read(`if [ x != y ]; then a; fi`)).toEqual([["a"]])
    expect(read(`if test ! -n ""; then a; elif test -z x; then b; else c; fi`)).toEqual([["a"]])
    expect(read(`if [ -n "" ]; then a; fi`)).toEqual([])
    expect(read(`if [ -n "" ]; then a; elif [ -z "" ]; then b; else c; fi`)).toEqual([["b"]])
  })

  it("keeps a branch conditional when an earlier test is not computed", () => {
    const list = commands(`if [ -n "$A" ]; then a; elif [ -z "" ]; then b; else c; fi`)
    expect(list?.map((command) => [words(command).join(" "), command.conditional])).toEqual([
      ["[ -n $A ]", false],
      ["a", true],
      ["b", true]
    ])
  })

  it("does not compute a test it does not know", () => {
    for (
      const test of [`[ -f x ]`, `[ a -lt b ]`, `[ -n ]`, `test a b c d`, `true`, `A=1 [ -n x ]`, `[ -n x ] | cat`]
    ) {
      const list = commands(`if ${test}; then a; else b; fi`)
      expect(list?.map(words).slice(-2), test).toEqual([["a"], ["b"]])
    }
    // Two commands in a condition are not one test.
    expect(read(`if [ -n "" ]; [ -z "" ]; then a; fi`)).toEqual([["[", "-n", "", "]"], ["[", "-z", "", "]"], ["a"]])
    expect(read(`if [ -n "" ] & then a; fi`)).toEqual([["[", "-n", "", "]"], ["a"]])
  })

  it("reads an if inside an if", () => {
    const list = commands(`if [ -z "" ]; then\n  if [ -n "$A" ]; then a; fi\n  b\nfi`)
    expect(list?.map((command) => [words(command).join(" "), command.conditional])).toEqual([
      ["[ -n $A ]", false],
      ["a", true],
      ["b", false]
    ])
  })

  it("reads an if that ends where the if around it ends", () => {
    expect(read(`if [ -n "$A" ]; then if [ -n "$B" ]; then c; fi fi`)).toEqual([
      ["[", "-n", "$A", "]"],
      ["[", "-n", "$B", "]"],
      ["c"]
    ])
  })

  it("reads [[ ]] and bare brackets as words", () => {
    expect(read(`[[ "$A" == b ]] && echo yes`)).toEqual([["[[", "$A", "==", "b", "]]"], ["echo", "yes"]])
    expect(read(`echo '[a]' "x[1]"`)).toEqual([["echo", "[a]", "x[1]"]])
  })

  it("refuses what it does not read", () => {
    const refused = [
      "echo $(date)",
      "echo `date`",
      "echo \"`date`\"",
      "echo \"$(date)\"",
      "echo ${A:-b}",
      "echo $",
      "(cd a && pnpm test)",
      "{ pnpm test; }",
      "ls *.ts",
      "ls a?.ts",
      "ls ~/a",
      "ls [ab].ts",
      "ls a]",
      "cat < in.txt",
      "cat <<EOF\nx\nEOF",
      "echo 'unterminated",
      "echo \"unterminated",
      "echo trailing\\",
      "echo \"inside\\",
      "if true; then a; else b; then c; fi",
      "for f in a b; do echo $f; done",
      "while true; do echo; done",
      "case x in a) ;; esac",
      "a ;; b",
      "a |& b",
      "a &> out",
      "echo >",
      "echo > | b",
      "if true; then a",
      "if true; a; fi",
      "if true; then a; else b",
      "if true; then a; fi | cat",
      "if true; then a; fi extra",
      "a && if true; then b; fi",
      "then a",
      "fi",
      "time pnpm test",
      "function f",
      "&& a",
      "a && && b"
    ]
    for (const script of refused) expect(commands(script), script).toBeUndefined()
  })

  it("reads an empty script as no commands", () => {
    expect(commands("")).toEqual([])
    expect(commands("\n# nothing\n")).toEqual([])
  })

  it("reads a quoted keyword as a word", () => {
    expect(read(`'if' x`)).toEqual([["if", "x"]])
    expect(read(`echo fi then`)).toEqual([["echo", "fi", "then"]])
  })
})

describe("quote", () => {
  it("leaves a plain word bare and quotes anything else", () => {
    expect(quote("--filter=@scope/name")).toBe("--filter=@scope/name")
    expect(quote("a b")).toBe("'a b'")
    expect(quote("it's")).toBe(`'it'\\''s'`)
    expect(quote("")).toBe("''")
    expect(quote("*")).toBe("'*'")
  })
})
