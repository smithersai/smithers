/**
 * The hermetic pre-check, read directly rather than through a spawner.
 *
 * The scan has its own security history: three independent bypasses, each
 * sufficient on its own to defeat it, are closed in it. Exercising it through
 * `Bash.run` proves only that nothing spawned; these cases state what the scan
 * itself classifies, which is the property the bypasses broke.
 */
import { Effect, Path } from "effect"
import { describe, expect, it } from "vitest"
import { commandReferences, outsideEnvelope } from "../src/internal/EnvelopePrecheck.ts"

const path = Effect.runSync(Effect.provide(
  Effect.gen(function*() {
    return yield* Path.Path
  }),
  Path.layer
))

interface Refusal {
  readonly code: string
  readonly path: string
}

interface Case {
  readonly name: string
  readonly text: string
  readonly cwd?: string
  readonly reads: ReadonlyArray<string>
  readonly writes: ReadonlyArray<string>
  readonly refusal: Refusal | undefined
}

const refused: ReadonlyArray<Case> = [
  // A newline ends a command, so line two is classified on its own rather than
  // under line one's `echo`.
  {
    name: "an rm on the second script line",
    text: "echo hi\nrm -rf /work/target\n",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  {
    name: "an mv destination on the second script line",
    text: "echo hi\nmv /work/a /work/b\n",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/b" }
  },
  {
    name: "a tee destination on the second script line",
    text: "echo hi\ntee /work/out\n",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/out" }
  },
  // A prefix wrapper does not lend its own read classification to the command
  // it wraps.
  {
    name: "an rm behind an env prefix",
    text: "env FOO=bar rm /work/target",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  {
    name: "an rm behind a sudo prefix",
    text: "sudo rm /work/target",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  {
    name: "an rm behind a quoted assignment whose value holds whitespace",
    text: `FOO="a b" rm /work/target`,
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  },
  // Every token and every declared entry is resolved before comparison.
  {
    name: "a dot-dot escape from a declared read",
    text: "cat /work/../outside/secret.txt",
    reads: ["/work"],
    writes: [],
    refusal: { code: "outside_declared_reads", path: "/outside/secret.txt" }
  },
  {
    name: "an ordinary path disguised as process plumbing",
    text: "cat /dev/../etc/passwd",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_reads", path: "/etc/passwd" }
  },
  {
    name: "a redirection into an undeclared file",
    text: "echo hi > /work/out",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/out" }
  },
  // Every bash output redirection writes its target. `&` and `|` are command
  // separators, so a scan that split `>|` or `&>` into two tokens saw the
  // target as the next command's name and skipped it.
  ...[
    "echo hi >| /work/out",
    "echo hi &> /work/out",
    "echo hi &>> /work/out",
    "echo hi >& /work/out",
    "echo hi <> /work/out",
    "> /work/out echo hi"
  ].map((text): Case => ({
    name: `the redirection target in ${text}`,
    text,
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/out" }
  })),
  // Grouping, substitution, and reserved words run the command they wrap, so
  // the wrapped command is classified, not the punctuation or keyword.
  ...[
    "(rm /work/target)",
    "{ rm /work/target; }",
    "if true; then rm /work/target; fi",
    "if rm /work/target; then :; fi",
    "for f in a; do rm /work/target; done",
    "while false; do :; done; ! rm /work/target",
    "`rm /work/target`",
    "x=$(rm /work/target)",
    `echo "$(rm /work/target)"`,
    "echo \"`rm /work/target`\"",
    "case a in a) rm /work/target;; esac",
    // A file-descriptor number belongs to its redirection, so the command
    // after it is `rm`, not `2`.
    "2>/dev/null rm /work/target",
    "echo \"$(cat \"$(rm /work/target)\")\"",
    "cat <(rm /work/target)",
    // A shell's `-c` argument and `eval`'s arguments are shell text, so the
    // command inside them is classified, not read as one quoted path.
    "sh -c 'rm /work/target'",
    "bash -lc \"rm /work/target\"",
    "env FOO=1 /bin/zsh -ec 'cd /work/sub && rm /work/target'",
    "eval 'rm /work/target'",
    "eval rm /work/target",
    "sh -c 'sh -c \"rm /work/target\"'"
  ].map((text): Case => ({
    name: `the delete in ${text}`,
    text,
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: "/work/target" }
  })),
  // Quotes are removed before a word is read as a path: `"/outs"ide/x` names
  // `/outside/x`, not a relative path under the working directory.
  {
    name: "a path split by quotes",
    text: `cat "/outs"ide/secret`,
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_reads", path: "/outside/secret" }
  },
  {
    name: "a path with an escaped space",
    text: "cat /outside/a\\ b",
    reads: ["/work/**"],
    writes: [],
    refusal: { code: "outside_declared_reads", path: "/outside/a b" }
  },
  // Issue #4889: a write names its target whatever the word's shape, an option
  // value or `key=value` names a path, and `~` is not the working directory.
  // Each of these spawned under `cwd: "/work"` with `writes: []`.
  ...([
    ["rm target", "/work/target"],
    ["rm -rf notes.txt src", "/work/notes.txt"],
    ["rm -- -target", "/work/-target"],
    ["echo x > out.txt", "/work/out.txt"],
    ["tee -a notes.txt", "/work/notes.txt"],
    ["tee out.txt", "/work/out.txt"],
    ["dd if=/work/a of=/etc/cron.d/x", "/etc/cron.d/x"],
    ["dd if=/work/a of=/work/target", "/work/target"],
    ["sed -i s/a/b/ /work/a", "/work/a"],
    ["sed -n -e p --in-place=.bak target", "/work/target"],
    ["sort -o/work/target /work/a", "/work/target"],
    ["sort --output target /work/a", "/work/target"],
    ["ln -sf /work/a /work/target", "/work/target"],
    ["cp -t /work/dir /work/a", "/work/dir"],
    ["install --target-directory=dir -m 644 /work/a", "/work/dir"],
    ["chmod 644 target", "/work/target"],
    ["truncate -s 0 target", "/work/target"],
    ["xargs -I{} rm {}", "/work/{}"],
    ["echo x > ~/.bashrc", "~/.bashrc"]
  ] as const).map(([text, written]): Case => ({
    name: `the write in ${text}`,
    text,
    cwd: "/work",
    reads: ["/work/**", "/work"],
    writes: [],
    refusal: { code: "outside_declared_writes", path: written }
  })),
  ...([
    ["cat ~/.ssh/id_rsa", "~/.ssh/id_rsa"],
    ["cat ~", "~"],
    ["cat $HOME/.ssh/id_rsa", "$HOME/.ssh/id_rsa"],
    ["cat ${HOME}/.ssh/id_rsa", "${HOME}/.ssh/id_rsa"],
    ["git -C/outside log", "/outside"],
    ["cat --files-from=/outside/secret", "/outside/secret"],
    ["env KEY=/outside/secret cat", "/outside/secret"],
    ["sed -f /outside/script /work/a", "/outside/script"],
    ["touch -r /outside/stamp /work/a", "/outside/stamp"]
  ] as const).map(([text, read]): Case => ({
    name: `the read in ${text}`,
    text,
    cwd: "/work",
    reads: ["/work/**", "/work"],
    writes: ["/work/**"],
    refusal: { code: "outside_declared_reads", path: read }
  }))
]

const accepted: ReadonlyArray<Case> = [
  {
    name: "a declared read",
    text: "cat /work/input",
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a declared write behind a wrapper",
    text: "env FOO=bar rm /work/target",
    reads: ["/work/**"],
    writes: ["/work/target"],
    refusal: undefined
  },
  {
    name: "process plumbing",
    text: "cat /work/input 2>/dev/null",
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a quoted path holding whitespace",
    text: `cat "/work/a b.txt"`,
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a path named only inside a comment",
    text: "cat /work/input # /outside/secret.txt",
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "stderr duplicated onto stdout",
    text: "cat /work/input 2>&1 | grep x",
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a read inside a shell's -c argument",
    text: `bash -c "cat /work/input | wc -l"`,
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  {
    name: "a read inside a command substitution",
    text: `echo "$(cat /work/input)"`,
    reads: ["/work/**"],
    writes: [],
    refusal: undefined
  },
  // An option's value and a mode are text, not paths the command writes.
  ...([
    ["chmod 644 /work/target", ["/work/target"]],
    ["chown --from=root builder /work/target", ["/work/target"]],
    ["truncate -s 0 /work/target", ["/work/target"]],
    ["mkdir -m 755 /work/target", ["/work/target"]],
    ["touch -d tomorrow /work/target", ["/work/target"]],
    ["sed s/a/b/ /work/input", []],
    ["sed -e s/a/b/ -i.bak /work/target", ["/work/target"]],
    ["sort -k 2 -o /work/target /work/input", ["/work/target"]],
    ["dd if=/work/input of=/work/target bs=1M", ["/work/target"]],
    ["cp -rt /work/target /work/input", ["/work/target/**", "/work/target"]],
    ["install -m 644 -o root /work/input /work/target", ["/work/target"]],
    ["ln -s /work/input /work/target", ["/work/target"]],
    ["mv --suffix .old /work/input /work/target", ["/work/target"]],
    ["echo x 2>&1 >&2 <&0- >&-", []]
  ] as const).map(([text, writes]): Case => ({
    name: `the declared paths in ${text}`,
    text,
    cwd: "/work",
    reads: ["/work/**", "/work"],
    writes,
    refusal: undefined
  }))
]

// Each nesting level costs the scan a pass and a stack frame; 50,000 levels
// used to run for half a minute and then throw a RangeError out of the
// pre-check instead of refusing.
describe("nesting depth", () => {
  const envelope = { reads: ["/work/**"], writes: [] }

  it.each([
    ["dollar substitutions", "$(".repeat(50_000) + "rm /work/a"],
    ["substitutions inside double quotes", "echo \"$(" + "\"$(".repeat(50_000)],
    ["one level past the bound", "$(".repeat(33) + "rm /work/a"],
    ["eval chains", "eval ".repeat(40) + "rm /work/a"]
  ])("refuses %s nested past the bound", (_, text) => {
    const refusal = outsideEnvelope(envelope, text, path)
    expect(refusal?.code).toBe("invalid_input")
    expect(refusal?.message).toContain("deeper than 32 levels")
  })

  it("classifies a command nested exactly at the bound", () => {
    expect(outsideEnvelope(envelope, "$(".repeat(32) + "rm /work/a", path)).toMatchObject({
      code: "outside_declared_writes",
      path: "/work/a"
    })
  })

  it("throws the refusal from the scan itself", () => {
    expect(() => commandReferences(path, "$(".repeat(40))).toThrow("deeper than 32 levels")
  })
})

describe("outsideEnvelope", () => {
  for (const { cwd, name, reads, refusal, text, writes } of [...refused, ...accepted]) {
    it(`${refusal === undefined ? "admits" : "refuses"} ${name}`, () => {
      const violation = outsideEnvelope({ cwd, reads, writes }, text, path)
      if (refusal === undefined) {
        expect(violation).toBeUndefined()
        return
      }
      expect(violation).toMatchObject(refusal)
    })
  }

  it("refuses a working directory outside the declared reads", () => {
    const violation = outsideEnvelope({ cwd: "/outside", reads: ["/work/**"], writes: [] }, "echo hi", path)
    expect(violation).toMatchObject({ code: "outside_declared_reads", path: "/outside" })
  })
})

describe("commandReferences", () => {
  it.each(
    [
      ["", []],
      ["# /outside/ignored", []],
      ["env NAME=value --verbose", []],
      ["sudo -u builder cat ./input", [{ access: "read", value: "./input" }]],
      ["sudo -u builder touch ../output", [{ access: "write", value: "../output" }]],
      ["cat . .. ./a ../b nested/file C:\\work\\input", [
        { access: "read", value: "." },
        { access: "read", value: ".." },
        { access: "read", value: "./a" },
        { access: "read", value: "../b" },
        { access: "read", value: "nested/file" },
        { access: "read", value: "C:\\work\\input" }
      ]],
      ["cat '' '/work/a b' >> /work/output", [
        { access: "read", value: "/work/a b" },
        { access: "write", value: "/work/output" }
      ]],
      ["cp", []],
      ["cat < /work/input", [{ access: "read", value: "/work/input" }]],
      ["cat /work/a && touch /work/b || cat /work/c; rm /work/d | tee /work/e & cat /work/f", [
        { access: "read", value: "/work/a" },
        { access: "write", value: "/work/b" },
        { access: "read", value: "/work/c" },
        { access: "write", value: "/work/d" },
        { access: "write", value: "/work/e" },
        { access: "read", value: "/work/f" }
      ]]
    ] as const
  )("classifies boundary command %s", (command, expected) => {
    expect(commandReferences(path, command)).toEqual(expected)
  })

  it.each([
    {
      name: "classifies a delete on the second line as a write",
      command: "echo hi\nrm -rf /work/target",
      expected: [{ access: "write", value: "/work/target" }]
    },
    {
      name: "classifies a copy's last path as its destination",
      command: "cp /work/a /work/b",
      expected: [{ access: "read", value: "/work/a" }, { access: "write", value: "/work/b" }]
    },
    {
      name: "classifies a redirection target as a write",
      command: "cat /work/in > /work/out",
      expected: [{ access: "read", value: "/work/in" }, { access: "write", value: "/work/out" }]
    },
    {
      name: "keeps a quoted path holding whitespace as one reference",
      command: `cat "/work/a b.txt"`,
      expected: [{ access: "read", value: "/work/a b.txt" }]
    },
    {
      name: "drops a path named only inside a comment",
      command: "cat /work/in # /outside/secret.txt",
      expected: [{ access: "read", value: "/work/in" }]
    },
    {
      name: "reads a here-string and a here-document delimiter as text",
      command: "cat <<< /outside/a; cat <<- /outside/b",
      expected: []
    },
    {
      name: "reads a duplicated input descriptor's target",
      command: "cat <& /work/in",
      expected: [{ access: "read", value: "/work/in" }]
    },
    {
      name: "takes a copy's destination from its arguments, not its redirection",
      command: "cp /work/a /work/b 2> /work/log",
      expected: [
        { access: "read", value: "/work/a" },
        { access: "write", value: "/work/b" },
        { access: "write", value: "/work/log" }
      ]
    },
    {
      name: "reads an unclosed substitution to the end of the text",
      command: "echo $(rm /work/a",
      expected: [{ access: "write", value: "/work/a" }]
    },
    {
      name: "reads an arithmetic expansion as no command",
      command: "echo $((1 + 2)) /work/a",
      expected: [{ access: "read", value: "/work/a" }]
    },
    {
      name: "joins a line continuation into one command",
      command: "rm \\\n  /work/a",
      expected: [{ access: "write", value: "/work/a" }]
    },
    {
      name: "keeps a quoted backslash and an escaped quote in the word",
      command: `cat "/work/a\\\"b" '/work/c\\d' /work/e\\`,
      expected: [
        { access: "read", value: "/work/a\"b" },
        { access: "read", value: "/work/c\\d" },
        { access: "read", value: "/work/e\\" }
      ]
    },
    {
      name: "reads every substitution in a double-quoted word",
      command: "echo \"`cat /work/a` $(cat '/work/(b)') \\$x\"",
      expected: [{ access: "read", value: "/work/a" }, { access: "read", value: "/work/(b)" }]
    },
    {
      name: "skips an escaped parenthesis and a quoted span inside a substitution",
      command: `x=$(rm "/work/a" \\) ')' )`,
      expected: [
        { access: "write", value: "/work/a" },
        { access: "write", value: ")" },
        { access: "write", value: ")" }
      ]
    },
    {
      name: "reads a backtick substitution nested in a dollar substitution",
      command: "echo $(cat `rm /work/a)`)",
      expected: [{ access: "write", value: "/work/a" }]
    },
    {
      name: "skips an escaped backtick inside a backtick substitution",
      command: "`rm /work/a \\` x`",
      expected: [
        { access: "write", value: "/work/a" },
        { access: "write", value: "`" },
        { access: "write", value: "x" }
      ]
    },
    {
      name: "reads an unclosed quote inside a substitution to the end of the text",
      command: "echo $(rm /work/a 'x",
      expected: [{ access: "write", value: "/work/a" }, { access: "write", value: "x" }]
    },
    {
      name: "joins a line continuation inside a word and inside double quotes",
      command: "rm /work/a\\\nb \"/work/c\\\nd\"",
      expected: [{ access: "write", value: "/work/ab" }, { access: "write", value: "/work/cd" }]
    },
    {
      name: "reads an unclosed quote to the end of the text",
      command: "cat '/work/a",
      expected: [{ access: "read", value: "/work/a" }]
    },
    {
      name: "keeps a trailing backslash in an unclosed double quote",
      command: "cat \"/work/a\\",
      expected: [{ access: "read", value: "/work/a\\" }]
    },
    {
      name: "separates words at any blank",
      command: "rm\v/work/a\f/work/b\u00a0/work/c",
      expected: [
        { access: "write", value: "/work/a" },
        { access: "write", value: "/work/b" },
        { access: "write", value: "/work/c" }
      ]
    },
    {
      name: "reads a shell's positional arguments after its -c argument as paths",
      command: "sh -c 'rm /work/a' sh /work/b",
      expected: [{ access: "read", value: "/work/b" }, { access: "write", value: "/work/a" }]
    },
    {
      name: "reads a shell script operand as a path, not as shell text",
      command: "bash /work/script.sh --flag",
      expected: [{ access: "read", value: "/work/script.sh" }]
    },
    {
      name: "reads a shell's long option as no -c flag",
      command: "bash --rcfile /work/rc -i",
      expected: [{ access: "read", value: "/work/rc" }]
    },
    {
      name: "reads a -c flag followed by a redirection as no command",
      command: "sh -c >/work/out",
      expected: [{ access: "write", value: "/work/out" }]
    },
    {
      name: "keeps a redirection after eval's arguments out of the evaluated text",
      command: "eval rm /work/a > /work/b",
      expected: [{ access: "write", value: "/work/b" }, { access: "write", value: "/work/a" }]
    },
    {
      name: "reads a -c flag with no argument as no command",
      command: "sh -c",
      expected: []
    },
    {
      name: "reads a redirection target whatever its shape",
      command: "cat < in.txt",
      expected: [{ access: "read", value: "in.txt" }]
    },
    {
      name: "reads dd's of= value as the written path and a bare if= value as no path",
      command: "dd if=a of=b",
      expected: [{ access: "write", value: "b" }]
    },
    {
      name: "classifies a copy's -t directory as its destination and every operand as a source",
      command: "cp -t /work/dir /work/a /work/b",
      expected: [
        { access: "write", value: "/work/dir" },
        { access: "read", value: "/work/a" },
        { access: "read", value: "/work/b" }
      ]
    },
    {
      name: "reads a file named after -- as an operand, not an option",
      command: "rm -f -- -x",
      expected: [{ access: "write", value: "-x" }]
    },
    {
      name: "reads no path from a command that names none",
      command: "echo hi",
      expected: []
    }
  ])("$name", ({ command, expected }) => {
    expect(commandReferences(path, command)).toEqual(expected)
  })
})

it("resolves relative declarations against a declared nondefault working directory", () => {
  expect(outsideEnvelope({ cwd: "/work", reads: ["."], writes: ["./out"] }, "cat ./in >> ./out", path))
    .toBeUndefined()
  expect(outsideEnvelope({ cwd: ".", reads: [], writes: [] }, "echo ready", path)).toBeUndefined()
})
