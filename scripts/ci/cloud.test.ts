import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const workflow = readFileSync(new URL("../../.smithers/workflows/ci.tsx", import.meta.url), "utf8")
const shell = readFileSync(new URL("cloud.sh", import.meta.url), "utf8")
const github = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")
const section = (from: string, to: string) => shell.slice(shell.indexOf(from), shell.indexOf(to))
const toolsBlock = section("gate_tools() {", "bootstrap_for() {")
// Gate -> toolchains, one gate per line in gate_tools.
const tools = new Map(
  Array.from(toolsBlock.matchAll(/^ {4}([a-z][a-z0-9-]*)\) echo '([a-z ]+)' ;;$/gm),
    ([, name, list]) => [name!, list!.split(" ")] as const))
const dispatch = section("run_gate() {", "run_group() {")
const gates = Array.from(dispatch.matchAll(/^ {4}([a-z][a-z0-9-]*)\)\n([\s\S]*?)^ {6};;$/gm),
  ([, name, body]) => ({ name: name!, body: body! }))
// Task id -> the gates that task's group runs.
const groups = Array.from(workflow.matchAll(/<Task\b([^>]*?)>([\s\S]*?)<\/Task>/g), ([, props, body]) => ({
  props: props!,
  id: props!.match(/\bid="([^"]+)"/)?.[1],
  gates: body!.trim().match(/^\{`SMITHERS_CLOUD_CI=1 bash scripts\/ci\/cloud\.sh group ([a-z][a-z0-9- ]*)`\}$/)?.[1]
    ?.split(" ")
}))

describe("Smithers Cloud CI", () => {
  test("runs CI on main pushes and manual dispatch in parallel", () => {
    expect(workflow).toContain('<Workflow name="CI"')
    expect(workflow).toContain('triggers={[on.push({ branches: ["main"] }), on.manualDispatch({})]}')
    expect(workflow).toContain("<Parallel>")
    expect(workflow).toContain("</Parallel>")
  })

  test("batches every gate into a handful of tasks, sized for the 5-runner pool", () => {
    // An unparsed/self-closing Task must not disappear from the inventory.
    expect(groups.length).toBe((workflow.match(/<Task\b/g) ?? []).length)
    // Bootstrap is ~11 minutes per sandbox, so stay within one scheduling wave
    // or a little over it; one task per gate is what this replaced.
    expect(groups.length).toBeGreaterThanOrEqual(5)
    expect(groups.length).toBeLessThanOrEqual(7)
    for (const { props, id, gates: grouped } of groups) {
      expect(id).toBeDefined()
      expect(props).toContain("secrets={[]}")
      expect(grouped).toBeDefined()
      expect(grouped!.length).toBeGreaterThan(0)
    }
    expect(new Set(groups.map(({ id }) => id)).size).toBe(groups.length)
  })

  test("the groups partition cloud.sh's gates: each gate runs in exactly one task", () => {
    const declared = gates.map(({ name }) => name)
    expect(new Set(declared).size).toBe(declared.length)
    const grouped = groups.flatMap(({ gates: names }) => names ?? [])
    // Every gate is covered, none twice, and no task names a missing gate.
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(grouped.slice().sort()).toEqual(declared.slice().sort())
  })

  test("every gate declares its toolchains and retains its exact GitHub CI command", () => {
    expect(Array.from(tools.keys()).sort()).toEqual(gates.map(({ name }) => name).sort())
    for (const { name, body } of gates) {
      // Bootstrap lives in bootstrap_for now, keyed off gate_tools.
      expect(tools.get(name)).toContain("js")
      expect(body).not.toContain("ensure_")
      if (name === "cloud-contract") {
        expect(body).toContain("bun test scripts/ci/cloud.test.ts")
      } else {
        const commands = Array.from(body.matchAll(/^ {6,8}(pnpm exec .+)$/gm), ([, command]) => command!)
        expect(commands.length).toBe(1)
        expect(github).toContain(`run: "${commands[0]}"`)
      }
    }
    for (const toolchain of tools.values()) {
      for (const tool of toolchain) expect(["js", "jj", "foundry", "rust"]).toContain(tool)
    }
    expect(shell).toContain('require("./package.json").packageManager')
    expect(shell).toContain('"$package_manager" --ignore-scripts')
    expect(shell).toContain("pnpm install --frozen-lockfile --ignore-scripts")
    expect(shell).toContain("set -euo pipefail")
    expect(shell.trimEnd().endsWith(`printf 'GATE-OK %s\\n' "$1"`)).toBe(true)
  })

  test("covers all non-publishing Linux commands except canonical-host wasm rebuild", () => {
    const excluded = new Set([
      "pnpm exec smthrs review '//...' --verbose",
      "pnpm exec smthrs test '//crates/flows-jj:wasmReproducibility' --verbose"
    ])
    const commands = Array.from(github.matchAll(/run: "(pnpm exec [^"]+)"/g), ([, command]) => command!)
    for (const command of new Set(commands)) {
      if (!excluded.has(command)) expect(dispatch).toContain(command)
    }
  })

  test("gives jj and git a CI identity, because a Cloud sandbox configures none", () => {
    // Run 11727: `//evals/swebench:offline` warned "Name and email not
    // configured" and then failed on a predicate over the trees it committed.
    for (const name of ["JJ_USER", "JJ_EMAIL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL"]) {
      expect(shell).toMatch(new RegExp(`^export ${name}="\\$\\{${name}:-`, "m"))
    }
    // Environment, not a config file some later gate would inherit.
    expect(shell).not.toContain("git config --global")
  })

  test("installs Rust into the homes the environment already names", () => {
    // Overriding them put the bootstrap's toolchain where no gate looked, so
    // run 11727's rust gates re-resolved channel 1.89.0 and timed out.
    const rust = section("ensure_rust() {", "# Toolchains each gate needs")
    expect(rust).toContain('export CARGO_HOME="${CARGO_HOME:-$tools_dir/cargo}"')
    expect(rust).toContain('RUSTUP_HOME="${RUSTUP_HOME:-$tools_dir/rustup}"')
  })

  test("every task marks itself as a Cloud runner, which is what enables the skips", () => {
    for (const { props } of groups) expect(props).toBeDefined()
    expect(workflow.match(/SMITHERS_CLOUD_CI=1 bash scripts\/ci\/cloud\.sh group /g)?.length).toBe(groups.length)
    expect(shell).toContain('on_cloud() { [ "${SMITHERS_CLOUD_CI:-}" = 1 ]; }')
  })

  test("a gate that cannot run on this tier skips explicitly, and only on a Cloud runner", () => {
    // Playwright installs browser system libraries as root; a Cloud task has
    // no sudo, so run 11727 got an authentication failure before any test ran.
    const skipped = gates.filter(({ body }) => body.includes("skip_gate"))
    expect(skipped.map(({ name }) => name)).toEqual(["ui-browser"])
    for (const { body } of skipped) {
      expect(body).toContain("if on_cloud; then")
      // The reason is not optional: a bare skip is an unexplained hole.
      expect(body).toMatch(/skip_gate [a-z-]+ '[^']+'/)
    }
  })

  test("bash accepts the runner syntax", () => {
    const result = spawnSync("bash", ["-n", "scripts/ci/cloud.sh"], { cwd: root, encoding: "utf8" })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  test("missing and unknown gates fail before installing tools or reporting success", () => {
    for (const args of [[], ["not-a-gate"], ["group"], ["group", "script-lint", "not-a-gate"]]) {
      const result = spawnSync("bash", ["scripts/ci/cloud.sh", ...args], { cwd: root, encoding: "utf8" })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Unknown Cloud CI gate:")
      expect(result.stdout).toBe("")
    }
  })

  describe("node bootstrap", () => {
    // Debian bookworm's distro node is 18 and npm@11 rejects it with
    // EBADENGINE, so ensure_js has to install a supported Node first. The
    // runner is an unprivileged container: no root, no sudo, no apt, no xz.
    const probe = new URL("cloud.node-probe.tmp.sh", import.meta.url)
    const marker = 'if [ "${1:-}" = group ]; then'
    type Probe = { node: string, machine?: string, realApt?: boolean, extra?: string[] }
    const stubs = ({ node, machine = "x86_64", realApt = false, extra = [] }: Probe) => [
      `uname() { case "$1" in -m) echo ${machine} ;; *) echo Linux ;; esac; }`,
      `node() { echo ${node}; }`,
      // Kept real when the probe is about apt_install's own elevation check.
      ...(realApt ? [] : ['apt_install() { echo "APT $*"; }']),
      'download() { echo "DOWNLOAD $1 -> $2"; }',
      'sha256sum() { cat > /dev/null; echo "SHA256SUM $*"; }',
      'tar() { echo "TAR $*"; }',
      'mkdir() { echo "MKDIR $*"; }',
      ...extra,
      "ensure_node",
      'echo "PATH=$PATH"',
      "exit 0",
      ""
    ].join("\n")
    afterAll(() => rmSync(probe, { force: true }))
    const run = (options: Probe) => {
      writeFileSync(probe, shell.replace(marker, `${stubs(options)}${marker}`))
      const result = spawnSync("bash", ["scripts/ci/cloud.node-probe.tmp.sh"], { cwd: root, encoding: "utf8" })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      return result
    }
    const pinned = shell.match(/^node_version=(\S+)$/m)?.[1]
    const tools = ".flows/cloud-tools"
    const ensureNode = shell.slice(shell.indexOf("ensure_node() {"), shell.indexOf("ensure_js() {"))

    test("pins an exact Node version whose digests come from that release", () => {
      expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
      expect(shell).toContain(`https://nodejs.org/dist/v${pinned}/SHASUMS256.txt`)
      for (const arch of ["x64", "arm64"]) {
        expect(shell).toMatch(new RegExp(`^node_sha256_${arch}=[0-9a-f]{64}$`, "m"))
      }
      // The npm bootstrap has to run on the Node this installs, not before it.
      const js = shell.slice(shell.indexOf("ensure_js() {"))
      expect(js.indexOf("ensure_node")).toBeLessThan(js.indexOf("npm install --global"))
      expect(js).toContain("$(node --version) npm $(npm --version)")
    })

    test("takes the gzip tarball so it needs neither xz nor apt", () => {
      // xz-utils is not installable on the runner, so .tar.xz is unusable.
      expect(shell).not.toContain(".tar.xz")
      expect(ensureNode).toContain("tar -xzf")
      expect(ensureNode).not.toContain("apt_install")
    })

    test("downloads and verifies the pinned tarball when node is too old", () => {
      const result = run({ node: "v18.19.0" })
      expect(result.stdout).toContain(
        `DOWNLOAD https://nodejs.org/dist/v${pinned}/node-v${pinned}-linux-x64.tar.gz -> `)
      expect(result.stdout).toContain("SHA256SUM -c -")
      expect(result.stdout).toContain("TAR -xzf")
      expect(result.stdout).not.toContain("APT")
      expect(result.stderr).toContain("does not satisfy engines.node")
      // node/bin goes on the front of PATH, behind only the npm global prefix.
      const path = result.stdout.match(/^PATH=(.*)$/m)?.[1]
      expect(path?.startsWith(`${root}${tools}/bin:${root}${tools}/node/bin:`)).toBe(true)
    })

    test("picks the arm64 tarball on arm64 runners", () => {
      const result = run({ node: "v18.19.0", machine: "aarch64" })
      expect(result.stdout).toContain(`node-v${pinned}-linux-arm64.tar.gz`)
      expect(result.stdout).not.toContain("linux-x64")
    })

    test("installs nothing when node already satisfies engines.node", () => {
      const result = run({ node: "v24.0.0" })
      for (const absent of ["DOWNLOAD", "TAR ", "APT", "SHA256SUM"]) {
        expect(result.stdout).not.toContain(absent)
      }
      expect(result.stderr).toContain("satisfies engines.node")
      expect(result.stdout).not.toContain(`${tools}/node/bin`)
    })

    test("bootstraps as a non-root user with no sudo, and apt skips instead of dying", () => {
      // Run 11706 died at `sudo: command not found` (127) on every task.
      const result = run({
        node: "v18.19.0",
        realApt: true,
        extra: [
          "id() { echo 1000; }",
          'apt-get() { echo "APT-GET $*"; }',
          'command() { case "${1:-} ${2:-}" in "-v sudo") return 1 ;; "-v apt-get") echo apt-get; return 0 ;; esac; builtin command "$@"; }',
          "apt_install xz-utils ca-certificates curl"
        ]
      })
      expect(result.stderr).toContain("Skipping apt packages: not root and no sudo")
      expect(result.stdout).not.toContain("APT-GET")
      expect(result.stdout).toContain(`node-v${pinned}-linux-x64.tar.gz`)
      expect(result.stdout).toContain("TAR -xzf")
    })
  })

  describe("group mode", () => {
    // The real gate_tools, bootstrap_for, run_gate and run_group run; only the
    // installers and the gate commands themselves are stubbed out.
    const probe = new URL("cloud.group-probe.tmp.sh", import.meta.url)
    const marker = 'if [ "${1:-}" = group ]; then'
    const stubs = [
      "ensure_js() { echo BOOTSTRAP-js; }",
      "ensure_jj() { echo BOOTSTRAP-jj; }",
      "ensure_foundry() { echo BOOTSTRAP-foundry; }",
      "ensure_rust() { echo BOOTSTRAP-rust; }",
      // jsdocTree is the gate that fails in this probe.
      "pnpm() { echo \"RAN $*\"; case \"$*\" in *jsdocTree*) return 3 ;; esac; }",
      "bun() { echo \"RAN $*\"; }",
      ""
    ].join("\n")
    expect(shell).toContain(marker)
    writeFileSync(probe, shell.replace(marker, `${stubs}${marker}`))
    afterAll(() => rmSync(probe, { force: true }))
    const run = (...args: string[]) =>
      spawnSync("bash", ["scripts/ci/cloud.group-probe.tmp.sh", ...args], { cwd: root, encoding: "utf8" })

    test("bootstraps the union of the group's toolchains exactly once", () => {
      const result = run("group", "workspace", "script-lint", "rust-test", "server")
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      for (const tool of ["js", "jj", "foundry", "rust"]) {
        expect(result.stdout.match(new RegExp(`^BOOTSTRAP-${tool}$`, "gm"))?.length).toBe(1)
      }
      // JS first: every other installer runs pnpm or needs the checkout ready.
      expect(result.stdout.indexOf("BOOTSTRAP-js")).toBeLessThan(result.stdout.indexOf("BOOTSTRAP-jj"))
    })

    test("marks each gate, keeps going past a failure, and fails the task", () => {
      const result = run("group", "script-lint", "jsdoc", "jsdoc-rules")
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      const markers = Array.from(result.stdout.matchAll(/^::gate (\S+) (\S+)$/gm), ([, gate, state]) => `${gate} ${state}`)
      expect(markers).toEqual([
        "script-lint start",
        "script-lint ok",
        "jsdoc start",
        "jsdoc fail",
        "jsdoc-rules start",
        "jsdoc-rules ok"
      ])
      expect(result.stderr).toContain("GATE-FAIL jsdoc")
      expect(result.stdout).not.toContain("GROUP-OK")
    })

    test("reports the whole group when every gate passes", () => {
      const result = run("group", "script-lint", "jsdoc-rules")
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("::gate script-lint ok")
      expect(result.stdout).toContain("::gate jsdoc-rules ok")
      expect(result.stdout).toContain("GROUP-OK script-lint jsdoc-rules")
    })

    test("single-gate mode still bootstraps and runs one gate", () => {
      const result = run("script-lint")
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("BOOTSTRAP-js")
      expect(result.stdout).toContain("RAN exec smthrs lint //scripts:lint --verbose")
      expect(result.stdout.trimEnd().endsWith("GATE-OK script-lint")).toBe(true)
      expect(result.stdout).not.toContain("::gate")
    })
  })
})
