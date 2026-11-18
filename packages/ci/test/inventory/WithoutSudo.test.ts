import { describe, expect, it } from "vitest"
import { changesIn } from "../../src/inventory/MachineChanges.ts"
import { withoutSudo } from "../../src/inventory/WithoutSudo.ts"

/** What a script does to the machine where `sudo` refuses, as the reader of machine changes words it. */
const changes = (script: string): ReadonlyArray<string> =>
  changesIn(withoutSudo(script)).map((change) => change.kind === "install" ? `install ${change.packages}` : change.what)

const lines = (...text: ReadonlyArray<string>): string => text.join("\n")

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

  it("leaves out what follows an if that ends the script when sudo refuses", () => {
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
  })

  // The same action, "Install native dependencies": the branch for a machine without sudo, then the other.
  it("leaves out the branch that runs only when sudo works", () => {
    const script = lines(
      `if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then`,
      `  echo "::warning::passwordless sudo unavailable; skipping native apt deps"`,
      `else`,
      `  while IFS= read -r source_file; do`,
      `    sudo mv "\${source_file}" "\${source_file}.disabled"`,
      `  done < <(grep -RIl "packages.microsoft.com" /etc/apt/sources.list.d 2>/dev/null || true)`,
      `  APT_ARGS=(-o Acquire::ForceIPv4=true -o DPkg::Lock::Timeout=600)`,
      `  for attempt in 1 2 3; do`,
      `    if sudo apt-get "\${APT_ARGS[@]}" update && sudo apt-get install -y --fix-missing libcairo2-dev; then`,
      `      break`,
      `    fi`,
      `    sleep $((attempt * 10))`,
      `  done`,
      `fi`,
      `echo done`
    )
    expect(changes(script)).toEqual([])
    expect(withoutSudo(script)).toContain("echo done")
  })

  // The same action, "Install protoc": the question is the test of an `elif`.
  it("leaves out an elif branch whose test needs sudo to work", () => {
    const script = lines(
      `apt_ok=""`,
      `if [ "\${FORCE_PROTOC_GITHUB_FALLBACK}" = "true" ]; then`,
      `  echo "forcing protoc GitHub fallback"`,
      `elif [ "\${RUNNER_ENVIRONMENT}" != "self-hosted" ]; then`,
      `  echo "using pinned protoc release on GitHub-hosted runner"`,
      `elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then`,
      `  for attempt in 1 2 3; do`,
      `    if sudo apt-get update && sudo apt-get install -y protobuf-compiler; then apt_ok=1; break; fi`,
      `  done`,
      `fi`,
      `if [ -z "$apt_ok" ]; then curl -fsSL "$URL" -o protoc.zip; fi`
    )
    expect(changes(script)).toEqual([])
    expect(withoutSudo(script)).toContain(`curl -fsSL "$URL" -o protoc.zip`)
  })

  it("leaves out every later branch of an if whose test is true where sudo refuses", () => {
    const script = lines(
      `if ! sudo -n true; then echo plain`,
      `elif [ -f /etc/debian_version ]; then sudo apt-get install -y zsh`,
      `else sudo dnf install -y zsh`,
      `fi`,
      `make`
    )
    expect(changes(script)).toEqual([])
    expect(withoutSudo(script)).toBe(lines(`if ! false; then echo plain`, ``, `fi`, `make`))
  })

  it.each([
    "sudo -n true",
    "sudo -n -v",
    "sudo -nv",
    "sudo -v -n",
    "sudo -n /bin/true",
    "sudo -n /usr/bin/true",
    "sudo -n --validate",
    "sudo --non-interactive true",
    "sudo --non-interactive -v",
    "sudo --non-interactive --validate"
  ])("reads %s as the question, which changes nothing", (question) => {
    expect(changes(`if ${question} >/dev/null 2>&1; then sudo systemctl restart docker; fi`)).toEqual([])
    expect(changes(`${question} && echo yes`)).toEqual([])
  })

  it.each<[string, string]>([
    ["sudo with a command", "sudo -n apt-get update"],
    ["sudo that may ask for a password", "sudo true"],
    ["sudo as another user", "sudo -n -u postgres true"],
    ["a question built from a variable", "sudo -n \"$probe\""],
    ["sudo by its path", "/usr/bin/sudo -n true"]
  ])("does not read %s as the question", (_name, command) => {
    expect(changes(`if ${command}; then echo yes; fi`)).not.toEqual([])
  })
})

describe("what decides a test", () => {
  const guarded = (test: string): ReadonlyArray<string> => changes(`if ${test}; then sudo tee /etc/x; fi`)
  const kept = ["sudo tee"]

  it.each<[string, string, ReadonlyArray<string>]>([
    ["the question alone", "sudo -n true", []],
    ["the question and something else", `[ -n "$CI" ] && sudo -n true`, []],
    ["something else and the question, in that order", `sudo -n true && [ -n "$CI" ]`, []],
    ["the question denied twice", "! ! sudo -n true", []],
    ["the question or something else", `sudo -n true || [ -n "$CI" ]`, kept],
    ["something else or the question", `[ -n "$CI" ] || sudo -n true`, kept],
    ["a denied question and something else", `! sudo -n true && [ -n "$CI" ]`, kept],
    ["something else alone", `[ -n "$CI" ]`, kept],
    ["the question piped on", "sudo -n true | cat", kept],
    ["two statements", "true; sudo -n true", kept],
    ["the question left running", "sudo -n true & wait", kept]
  ])("%s", (_name, test, expected) => {
    expect(guarded(test)).toEqual(expected)
  })

  it("keeps the then branch of a test that is true where sudo refuses", () => {
    expect(changes(`if ! sudo -n true || [ -n "$CI" ]; then npm install -g x; else sudo tee /etc/x; fi`)).toEqual([
      "npm install -g"
    ])
    expect(changes(`if [ -n "$CI" ] || ! sudo -n true; then echo plain; else sudo tee /etc/x; fi`)).toEqual([])
  })

  it("keeps every branch of a test that something else decides", () => {
    expect(changes(`if [ -n "$CI" ]; then sudo -n true && echo yes; else sudo tee /etc/x; fi`)).toEqual(["sudo tee"])
    expect(changes(`if [ -n "$CI" ]; then sudo rm -rf /opt/x; elif [ -n "$Y" ]; then sudo tee /etc/x; fi`)).toEqual([
      "sudo rm",
      "sudo tee"
    ])
  })
})

describe("what follows the if", () => {
  const after = "\nsudo tee /etc/x"
  const kept = ["sudo tee"]

  it.each<[string, string]>([
    ["does not end the script", `if ! sudo -n true; then echo no; fi`],
    ["has nothing in its branch", `if ! sudo -n true; then\nfi`],
    ["ends the script before its last command", `if ! sudo -n true; then exit 0; echo no; fi`],
    ["ends the script only in a branch of its own", `if ! sudo -n true; then if [ -n "$X" ]; then exit 0; fi; fi`],
    ["ends the script unless that fails", `if ! sudo -n true; then exit 0 || true; fi`],
    ["leaves its exit running", `if ! sudo -n true; then exit 0 & fi`],
    ["denies its exit", `if ! sudo -n true; then ! exit 0; fi`],
    ["pipes its exit", `if ! sudo -n true; then exit 0 | cat; fi`],
    ["ends the script from a word a variable gives", `if ! sudo -n true; then "$stop" 0; fi`],
    ["is true only after another test", `if [ -n "$X" ]; then echo x; elif ! sudo -n true; then exit 0; fi`],
    ["may be false", `if ! sudo -n true || [ -n "$X" ] && [ -n "$Y" ]; then exit 0; fi`],
    ["is in a function", `skip() { if ! sudo -n true; then exit 0; fi; }`],
    ["is in a function written with the keyword", `function skip { if ! sudo -n true; then exit 0; fi; }`],
    ["is in a function written both ways", `function skip() {\n if ! sudo -n true; then exit 0; fi\n}`],
    ["is the whole body of a function", `skip()\nif ! sudo -n true; then exit 0; fi`],
    ["is in a loop", `for x in 1 2; do if ! sudo -n true; then exit 0; fi; done`],
    ["is in a while loop", `while read -r x; do if ! sudo -n true; then exit 0; fi; done`],
    ["is in a subshell", `( if ! sudo -n true; then exit 0; fi )`],
    ["is in a group", `{ if ! sudo -n true; then exit 0; fi; }`],
    ["is one side of a list", `[ -n "$X" ] && if ! sudo -n true; then exit 0; fi`],
    ["is piped on", `if ! sudo -n true; then exit 0; fi | cat`],
    ["is left running", `if ! sudo -n true; then exit 0; fi &`]
  ])("stays when the if %s", (_name, script) => {
    expect(changes(`${script}${after}`)).toEqual(kept)
  })

  it("is left out after an if with nothing after it but line ends", () => {
    expect(withoutSudo(`if ! sudo -n true; then exit 0; fi\n\n`)).toBe(`if ! false; then exit 0; fi\n`)
    expect(withoutSudo(`if ! sudo -n true; then exit 0; fi`)).toBe(`if ! false; then exit 0; fi`)
  })

  it("is left out when the if comes after other commands", () => {
    expect(changes(`set -euo pipefail\necho start\nif ! sudo -n true; then echo no; exit 0; fi${after}`)).toEqual([])
  })
})

describe("the shell a script is written in", () => {
  // Everything here stands between the reader and the `if`, or inside a branch it leaves out.
  it("reads past comments, quotes, expansions, redirections and here-documents", () => {
    const script = lines(
      `# if this then that; fi`,
      `echo "then fi 'else' \\"fi\\" \\\\" 'if "x" then' $(echo ')' \\) "(" x) \\`,
      `  continued \\"word $(echo "a)b" | tr a b) \${HOME:-"}"} \`echo fi\` $# $HOME`,
      `echo text >&2 2>&1 >>log 2>/dev/null &>all &>>all >&- <<<"here string" < input <(echo in) >(cat)`,
      `cat <<EOF | tee out |& cat`,
      `if then else fi sudo tee /etc/x`,
      `EOF`,
      `cat <<-'TABS' > file`,
      `\tfi`,
      `\tTABS`,
      `list=(a b "c d") && more+=(e)`,
      `[[ -n $x && ( $y == a || $y > b ) ]] || echo no`,
      `case $1 in`,
      `  if) echo "a pattern named if";;`,
      `  *) case $2 in fi) echo inner;; esac`,
      `esac`,
      `for ((i = 0; i < 3; i++)); do echo "$i"; done`,
      `select x in a b; do echo "$x"; done`,
      `until [ -f ready ]; do sleep 1; done`,
      `time ((count += 1))`,
      `if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null`,
      `then`,
      `  echo "no sudo"`,
      `  exit 0`,
      `fi`,
      `sudo tee /etc/x`
    )
    expect(changes(script)).toEqual([])
    expect(withoutSudo(script).endsWith(`  exit 0\nfi\n`)).toBe(true)
  })

  it("reads a here-document that ends with the script, and a number that is a word", () => {
    expect(changes(`if ! sudo -n true; then echo 2 ; exit 0; fi\nsudo python3 - <<'PY'\nprint(1)`)).toEqual([])
    expect(changes(`sudo python3 - <<'PY'\nprint(1)`)).toEqual(["sudo python3"])
  })

  it.each<[string, string]>([
    ["an if with no fi", `if ! sudo -n true; then exit 0\nsudo tee /etc/x`],
    ["an if with no then", `if ! sudo -n true; exit 0; fi\nsudo tee /etc/x`],
    ["a bracket that closes nothing", `echo a )\nif ! sudo -n true; then exit 0; fi\nsudo tee /etc/x`],
    ["a subshell that never closes", `( echo a\nif ! sudo -n true; then exit 0; fi\nsudo tee /etc/x`],
    ["a list with nothing after its joint", `if ! sudo -n true; then exit 0; fi\nsudo tee /etc/x &&`],
    ["a loop with no body", `for x in 1 2\nsudo tee /etc/x`],
    ["a case with no end", `case $x in a) sudo tee /etc/x;;`],
    ["a test with no end", `[[ -n $x\nsudo tee /etc/x`]
  ])("returns a script with %s as written", (_name, script) => {
    expect(withoutSudo(script)).toBe(script)
    expect(changes(script)).toContain("sudo tee")
  })

  // Each could make `sudo -n true` or `exit` do something other than what this reader takes it to do.
  it.each<[string, string]>([
    ["sets PATH", `PATH=/usr/bin:$PATH`],
    ["exports PATH", `export PATH="/opt/tools/bin:$PATH"`],
    ["adds to PATH", `PATH+=:/usr/local/sbin`],
    ["defines an alias", `shopt -s expand_aliases; alias sudo=/usr/bin/sudo`],
    ["defines a function named sudo", `sudo() { /usr/bin/sudo "$@"; }`],
    ["defines a function named exit", `exit() { echo staying; }`],
    ["defines a function named exit with the keyword", `function exit { echo staying; }`]
  ])("returns a script that %s as written", (_name, line) => {
    const script = `${line}\nif ! sudo -n true; then exit 0; fi\nsudo tee /etc/x`
    expect(withoutSudo(script)).toBe(script)
    expect(changes(script)).toContain("sudo tee")
  })

  it("reads a script that only names PATH, or a function of another name", () => {
    expect(changes(`echo "$PATH"\nskip() { echo no; }\nif ! sudo -n true; then skip; exit 0; fi\nsudo tee /etc/x`))
      .toEqual([])
  })

  it("reads a script that ends inside an escape or an expansion", () => {
    expect(withoutSudo("echo a\\")).toBe("echo a\\")
    expect(withoutSudo("echo $(date")).toBe("echo $(date")
    expect(withoutSudo("")).toBe("")
  })

  it("returns a script that nests deeper than it reads as written", () => {
    const script = `${"(".repeat(50_000)} sudo tee /etc/x`
    expect(withoutSudo(script)).toBe(script)
  })
})
