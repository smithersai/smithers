import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

// Everything the box writes, including /home/runner, belongs to this case. The
// provisioning doubles represent apt, the release install, and the remote repo.
const shell = join(import.meta.dirname, "../scripts/box-replay.sh")
const available = process.platform === "linux" &&
  spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "--", "true"]).status === 0

const provision = String.raw`
chown() { [[ "$stage" != "ownership" && ( "$stage" != "packs owner" || "$1" != "-R" ) ]]; }
chmod() { [[ "$stage" != "permissions" ]]; }
mkdir() {
  [[ "$stage" != "output" && ( "$stage" != "install dir" || "$1" != "-p" ) ]] && /bin/mkdir "$@"
}
cp() { [[ "$stage" != "packs" ]] && /bin/cp "$@"; }
command() {
  if [[ "$1" == "-v" ]]; then
    [[ ( "$stage" != "update" && "$stage" != "apt" && "$stage" != "install tools" ) || "$2" != bwrap ]] &&
      [[ "$stage" != "no strace" || "$2" != strace ]]
  else builtin command "$@"; fi
}
apt-get() { [[ "$stage" != "$1" && ( "$stage" != "apt" || "$1" != install ) ]]; }
useradd() { [[ "$stage" != user ]]; }
runuser() {
  shift 9
  case "$1" in
    bwrap) [[ "$stage" != jail ]] ;;
    node)
      shift
      /home/fixture-node "$@" || return 1
      if [[ "$stage" == "missing install directory" ]]; then mv /home/runner/inst /home/runner/moved; fi ;;
    npm) [[ "$stage" != npm ]] ;;
    git)
      case "$2" in
        clone) [[ "$stage" != clone ]] && { [[ "$stage" == "missing checkout" ]] || /bin/mkdir /home/runner/repo; } ;;
        symbolic-ref) [[ "$stage" == "no default branch" ]] || echo origin/trunk ;;
        checkout) [[ "$stage" != checkout ]] ;;
        rev-parse) echo abcdef012345 ;;
      esac ;;
    env)
      echo '{"commits":[]}'
      echo replay-output >&2
      case "$stage" in
        "missing report") ;;
        "linked report") ln -s /dev/null /home/runner/report.html ;;
        *) echo report > /home/runner/report.html ;;
      esac
      [[ "$stage" != mismatch ]] ;;
    */smithers-ci)
      echo apply-output
      /bin/mkdir -p .smithers/ci
      echo notes > .smithers/ci/NOT-REPRODUCED.txt
      [[ "$stage" != "apply failure" ]] ;;
    sh)
      shift; /bin/sh "$@" ;;
    *) return 99 ;;
  esac
}
`

it.skipIf(!available)("exercises box provisioning, replay receipts, and both apply outcomes", () => {
  const cases: ReadonlyArray<readonly [string, number]> = [
    ["ownership", 4],
    ["permissions", 4],
    ["output", 4],
    ["update", 4],
    ["apt", 4],
    ["user", 4],
    ["jail", 4],
    ["packs", 4],
    ["install dir", 4],
    ["packs owner", 4],
    ["manifest", 4],
    ["npm", 4],
    ["missing install directory", 4],
    ["clone", 3],
    ["missing checkout", 3],
    ["checkout", 3],
    ["mismatch", 1],
    ["apply failure", 0],
    ["missing report", 0],
    ["linked report", 0],
    ["install tools", 0],
    ["no strace", 0],
    ["no default branch", 0],
    ["ready", 0]
  ]
  for (const [stage, status] of cases) {
    const root = mkdtempSync(join(tmpdir(), "box-shell-"))
    try {
      mkdirSync(join(root, "packs"))
      writeFileSync(
        join(root, "packs", "manifest.json"),
        stage === "manifest" ? "invalid" : JSON.stringify([
          { name: "smithers-ci", filename: "ci.tgz" },
          { name: "fixture-dependency", filename: "dep.tgz" }
        ])
      )
      copyFileSync(shell, join(root, "box.sh"))
      writeFileSync(join(root, "setup"), provision)
      const seen = spawnSync("bwrap", [
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/home",
        "--dir",
        "/home/runner",
        "--ro-bind",
        process.execPath,
        "/home/fixture-node",
        "--bind",
        root,
        root,
        "--chdir",
        root,
        "--setenv",
        "BASH_ENV",
        join(root, "setup"),
        "--unsetenv",
        "NODE_OPTIONS",
        "--setenv",
        "stage",
        stage,
        "--",
        "/bin/bash",
        "./box.sh",
        "https://example.invalid/repo",
        "123abcd",
        "2"
      ], { encoding: "utf8" })
      expect(seen.status, stage + " " + seen.stderr + seen.stdout).toBe(status)
      if (status >= 3) continue
      const out = join(root, "out")
      expect(readFileSync(join(out, "exit"), "utf8").trim(), stage).toBe(String(status))
      expect(readFileSync(join(out, "replay.json"), "utf8").trim()).toBe("{\"commits\":[]}")
      expect(readFileSync(join(out, "replay.log"), "utf8")).toBe("replay-output\napply-output\n")
      expect(existsSync(join(out, "report.html.txt"))).toBe(stage !== "missing report" && stage !== "linked report")
      expect(existsSync(join(out, "NOT-REPRODUCED.txt"))).toBe(stage !== "apply failure")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})
