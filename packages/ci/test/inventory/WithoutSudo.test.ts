import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { changesIn } from "../../src/inventory/MachineChanges.vibe"
import { withoutSudo } from "../../src/inventory/WithoutSudo.vibe"

/** What a script does to the machine where `sudo` refuses, as the reader of machine changes words it. */
const changes = (script: string): ReadonlyArray<string> =>
  changesIn(withoutSudo(script)).map((change) => change.kind === "install" ? `install ${change.packages}` : change.what)

const lines = (...text: ReadonlyArray<string>): string => text.join("\n")

/** The guard, and the part of a script it keeps from running. */
const guard = "if ! sudo -n true; then\n  exit 0\nfi\n"
const answered = "if ! false; then\n  exit 0\nfi\n"
const rest = "sudo tee /etc/x\n"

const home = mkdtempSync(join(tmpdir(), "smithers-ci-without-sudo-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

/**
 * Runs a script in real bash where the first `sudo` on PATH refuses, as a replay's stand-in does, and gives every
 * call it got.
 */
const calls = (script: string, shell: ReadonlyArray<string> = ["bash", "-c"]): ReadonlyArray<string> => {
  const bin = join(home, "bin")
  const log = join(home, "sudo.log")
  mkdirSync(bin, { recursive: true })
  rmSync(log, { force: true })
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "$*" >> ${log}\nexit 1\n`)
  chmodSync(join(bin, "sudo"), 0o755)
  spawnSync(shell[0] as string, [...shell.slice(1), script], {
    cwd: home,
    env: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: home },
    encoding: "utf8"
  })
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []
}

// The stand-in a replay puts first on PATH answers every `sudo` with a refusal, so `sudo -n true` is false there.
describe("a script that asks before it uses sudo", () => {
  // elizaOS/eliza, .github/actions/setup-bun-workspace, "Let apt wait for the dpkg lock", as written.
  const dpkgLock = lines(
    `if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then`,
    `  echo "::warning::passwordless sudo unavailable; apt lock contention stays fatal for this job"`,
    `  exit 0`,
    `fi`,
    `if [ ! -d /etc/apt/apt.conf.d ]; then`,
    `  echo "::notice::no apt configuration directory; nothing to configure on this runner"`,
    `  exit 0`,
    `fi`,
    `# A runner this cannot be written on still installs fine whenever the`,
    `# lock is free, so warn rather than fail the whole setup here.`,
    `if printf 'DPkg::Lock::Timeout "600";\\n' \\`,
    `  | sudo tee /etc/apt/apt.conf.d/99-eliza-ci-dpkg-lock-timeout >/dev/null; then`,
    `  echo "apt will wait up to 600s for the dpkg frontend lock"`,
    `else`,
    `  echo "::warning::could not write the apt dpkg lock timeout; apt lock contention stays fatal for this job"`,
    `fi`
  )

  it("is the guard alone: bash ends there and never reads the rest", () => {
    expect(changesIn(dpkgLock).map((change) => change.kind === "other" && change.what)).toEqual([
      "sudo true",
      "sudo tee"
    ])
    expect(changes(dpkgLock)).toEqual([])
    expect(withoutSudo(dpkgLock)).toBe(lines(
      `if ! command -v sudo >/dev/null 2>&1 || ! false 2>/dev/null; then`,
      `  echo "::warning::passwordless sudo unavailable; apt lock contention stays fatal for this job"`,
      `  exit 0`,
      `fi`,
      ``
    ))
    // In real bash, with a sudo that refuses, the only call is the question.
    expect(calls(dpkgLock)).toEqual(["-n true"])
  })

  it.each<[string, string]>([
    ["the question alone", `if ! sudo -n true; then\nexit 0\nfi\n`],
    ["the question with its output sent nowhere", `if ! sudo -n true >/dev/null 2>&1; then\n  exit 0\nfi\n`],
    ["the question asked the long way", `if ! sudo --non-interactive true &> /dev/null; then\n  exit\nfi\n`],
    ["the question asked for a ticket", `if ! sudo -n -v 2> /dev/null; then\n  exit 1\nfi\n`],
    [
      "then on a line of its own",
      `if ! command -v sudo > /dev/null || ! sudo -n true 1>/dev/null\nthen\n\texit 0\nfi\n`
    ],
    [
      "lines that say why, a comment and a blank line",
      `if ! sudo -n true; then\n  # no sudo\n\n  echo "no sudo: skipped" 'as is' plain-words 1,2 >&2\n  echo\n  exit 0\nfi\n`
    ],
    ["flags and comments before it", `#!/bin/bash\n# setup\n\nset -euo pipefail\nset -x +u -o errexit\n${guard}`],
    ["nothing after it, not even a line end", `if ! sudo -n true; then\n  exit 0\nfi`]
  ])("reads %s", (_name, script) => {
    const whole = `${script}${script.endsWith("\n") ? "" : "\n"}${rest}`
    expect(changes(whole)).toEqual([])
    expect(withoutSudo(whole)).toBe(
      script.replace(/sudo (-n true|-n -v|--non-interactive true)/, "false") + (script.endsWith("\n") ? "" : "\n")
    )
    expect(calls(whole).filter((call) => call.startsWith("tee"))).toEqual([])
    // `sh` reads the shape as bash does.
    expect(calls(whole, ["sh", "-c"]).filter((call) => call.startsWith("tee"))).toEqual([])
  })

  it("leaves out whatever follows, without reading it", () => {
    for (
      const after of [
        rest,
        "case x in\n",
        "echo \"open\n",
        "fi; done }\n",
        "cat <<EOF\n",
        "exit() { :; }\nsudo tee /etc/x\n"
      ]
    ) {
      expect(withoutSudo(`${guard}${after}`)).toBe(answered)
      expect(calls(`${guard}${after}`)).toEqual(["-n true"])
    }
  })
})

describe("a script that is not that shape", () => {
  const kept = ["sudo true", "sudo tee"]

  it.each<[string, string]>([
    // What comes before the guard could give a word of it another meaning.
    ["a command before it", `echo start\n${guard}`],
    ["PATH set before it", `PATH=/usr/bin:$PATH\n${guard}`],
    ["a function named exit before it", `exit() { :; }\n${guard}`],
    ["an alias before it", `shopt -s expand_aliases\nalias exit=:\n${guard}`],
    ["a sourced file before it", `. ./env.sh\n${guard}`],
    ["a trap before it", `trap 'exit() { :; }' USR1\n${guard}`],
    ["another set flag before it", `set -o posix\n${guard}`],
    ["a set flag that changes what words mean", `set -ek\n${guard}`],
    ["an if around it", `if true; then\n${guard}fi\n`],
    ["a time before it", `time ${guard}`],
    ["a denial before it", `! ${guard}`],
    // The test must be the question and nothing else.
    ["a test that something else decides", `if ! sudo -n true || [ -n "$CI" ]; then\n  exit 0\nfi\n`],
    ["a test that asks without denying", `if sudo -n true; then\n  exit 0\nfi\n`],
    ["a test for sudo with no question", `if ! command -v sudo >/dev/null; then\n  exit 0\nfi\n`],
    ["a test joined the other way", `if ! command -v sudo >/dev/null && ! sudo -n true; then\n  exit 0\nfi\n`],
    ["a question that runs a command", `if ! sudo -n apt-get update; then\n  exit 0\nfi\n`],
    ["a question that may ask for a password", `if ! sudo true; then\n  exit 0\nfi\n`],
    ["a question as another user", `if ! sudo -n -u postgres true; then\n  exit 0\nfi\n`],
    ["a sudo by its path", `if ! /usr/bin/sudo -n true; then\n  exit 0\nfi\n`],
    ["a question whose output goes to a file", `if ! sudo -n true > "$LOG"; then\n  exit 0\nfi\n`],
    ["a question with a word after it", `if ! sudo -n true extra; then\n  exit 0\nfi\n`],
    // The branch must say and exit, and nothing else.
    ["a branch that does not exit", `if ! sudo -n true; then\n  echo no\nfi\n`],
    ["a branch that runs a command", `if ! sudo -n true; then\n  touch skipped\n  exit 0\nfi\n`],
    ["a branch that says a variable", `if ! sudo -n true; then\n  echo "no sudo for $USER"\n  exit 0\nfi\n`],
    ["a branch that says a substitution", "if ! sudo -n true; then\n  echo \"`date`\"\n  exit 0\nfi\n"],
    ["a branch that says an escape", `if ! sudo -n true; then\n  echo "a\\"b"\n  exit 0\nfi\n`],
    ["a branch that writes a file", `if ! sudo -n true; then\n  echo no > /nonexistent/x\n  exit 0\nfi\n`],
    ["an exit with a word that is no number", `if ! sudo -n true; then\n  exit "$code"\nfi\n`],
    ["an exit with two numbers", `if ! sudo -n true; then\n  exit 0 0\nfi\n`],
    ["an exit sent somewhere", `if ! sudo -n true; then\n  exit 0 >&9\nfi\n`],
    ["an exit that is one side of a list", `if ! sudo -n true; then\n  exit 0 || true\nfi\n`],
    ["an exit on the line of then", `if ! sudo -n true; then exit 0; fi\n`],
    ["an else", `if ! sudo -n true; then\n  exit 0\nelse\n  echo yes\nfi\n`],
    ["an elif", `if ! sudo -n true; then\n  exit 0\nelif true; then\n  echo yes\nfi\n`],
    // The `fi` must end the statement.
    ["a redirection on fi", `if ! sudo -n true; then\n  exit 0\nfi >/nonexistent/x\n`],
    ["a pipe after fi", `if ! sudo -n true; then\n  exit 0\nfi | cat\n`],
    ["a fi left running", `if ! sudo -n true; then\n  exit 0\nfi &\n`],
    ["a command after fi on its line", `if ! sudo -n true; then\n  exit 0\nfi; true\n`],
    // No line of the shape may go on at the next, and its spaces are spaces.
    ["a line that goes on at the next", `if ! sudo -n true; then\n  exit 0\nf\\\ni\n`],
    ["a test that goes on at the next line", `if ! sudo -n \\\ntrue; then\n  exit 0\nfi\n`],
    ["lines that end in a carriage return", `if ! sudo -n true; then\r\n  exit 0\r\nfi\r\n`],
    ["a space that is none to bash", `if ! sudo -n true; then\n  exit 0\nfi\n`],
    ["two spaces where the shape has one", `if !  sudo -n true; then\n  exit 0\nfi\n`]
  ])("is read as written: %s", (_name, script) => {
    const whole = `${script}${rest}`
    expect(withoutSudo(whole)).toBe(whole)
    expect(changes(whole)).toContain("sudo tee")
  })

  it("is read as written when it asks in the middle", () => {
    const script = `make\n${guard}${rest}`
    expect(withoutSudo(script)).toBe(script)
    expect(changes(script)).toEqual(kept)
  })
})

// An independent review ran these in bash with a `sudo` that refuses. bash reached `sudo echo M1` in each, and
// two readers of general shell had left it out. None is the shape, so each is read as written.
describe("scripts that fooled a reader of shell", () => {
  const short = "if ! sudo -n true; then exit 0; fi"
  const branch = "if sudo -n true; then sudo echo M1; fi"

  it.each<[string, string]>([
    ["a quote inside a command substitution inside a quote", `x="$(printf '%s' "a; ${short}; b")"\nsudo echo M1\n`],
    [
      "a comment with an apostrophe in an array",
      `PK=(\n  curl # don't drop\n)\necho 'x )\n${short}\n: '\nsudo echo M1\n`
    ],
    ["nested back quotes", "x=`echo \\`echo a\\``; y=`\n" + short + "\n: `\nsudo echo M1\n"],
    ["a timed if", `time if false; then\n${guard}fi\nsudo echo M1\n`],
    [
      "a case inside a case",
      `case "$1" in\n  a) if true; then case x in y) ;; esac; fi ;;\n  (b) ${short} ;;\nesac\nsudo echo M1\n`
    ],
    ["a here-document tag with a quote in it", `cat <<'E"OF'\nEOF\n${guard}E"OF\nsudo echo M1 #"\n`],
    ["a process substitution after fi", `if ! sudo -n true; then\n  exit 0\nfi < <(sudo echo M1)\n`],
    ["a function named exit", `exit() { echo "not leaving"; }\n${guard}sudo echo M1\n`],
    ["another sudo first on PATH", `PATH="$FAKE2:$PATH"\n${branch}\n`],
    ["a space that is no space to bash", `if false; then\n fi\n${guard}fi\nsudo echo M1\n`],
    ["a redirection before fi", `if false; then\n  :\n2>/dev/null fi\n${guard}fi\nsudo echo M1\n`],
    ["a line continued inside a word", `if sudo -n true; then\n  :\nf\\\ni\nsudo echo M1\nfi\n`],
    ["the old arithmetic", `if false; then\n  : $[ 0\nfi\n${guard}if false; then\n  : ]\nfi\nsudo echo M1\n`],
    ["a comment sign in arithmetic", `if sudo -n true; then (( x # )); fi\nsudo echo M1\n) ); fi\n`],
    ["a bracket in a pattern", `[[ x =~ ( ]]\n${guard}[[ a == ) ]]\nsudo echo M1\n`],
    ["a redirection on fi that fails", `if ! sudo -n true; then\n  exit 0\nfi >/nonexistent-dir/x\nsudo echo M1\n`],
    ["arithmetic that fails before exit", `if ! sudo -n true; then\n  echo $((1/0))\n  exit 0\nfi\nsudo echo M1\n`],
    ["a variable that cannot be set, before exit", `if ! sudo -n true; then\n  UID=0\n  exit 0\nfi\nsudo echo M1\n`],
    ["PATH set through a quoted word", `export "PATH=$FAKE2:$PATH"\n${branch}\n`],
    ["a trap and a signal", `trap 'exit() { :; }' USR1\nkill -USR1 $$\n${guard}sudo echo M1\n`],
    ["an eval behind command", `e=eval\ncommand $e 'exit() { :; }'\n${guard}sudo echo M1\n`],
    ["an eval out of braces", `{eval,'exit() { :; }'}\n${guard}sudo echo M1\n`]
  ])("keeps the sudo after %s", (_name, script) => {
    expect(withoutSudo(script)).toBe(script)
  })
})
