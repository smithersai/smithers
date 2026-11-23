import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  ci,
  type Inventory,
  type Job,
  keepingPrograms,
  keptOnRunner,
  leftRunning,
  notReplayed,
  reasonsText
} from "../../src/contract/Inventory.vibe"
import { reasonsSentence } from "../../src/contract/Reasons.vibe"
import { files } from "../../src/generate/index.vibe"
import { notesPath, workspacePath } from "../../src/generate/Render.ts"
import { leftRunningIn, markLeftRunning, stepName } from "../../src/inventory/LeftRunning.vibe"

const job = (commands: ReadonlyArray<string>, names: ReadonlyArray<string | undefined> = []): Job => ({
  id: "ci.yml:e2e",
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: "e2e",
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps: commands.map((command, index) => ({
    id: `ci.yml:e2e:${index + 1}`,
    command,
    cwd: "",
    env: {},
    secrets: [],
    ...(names[index] === undefined ? {} : { name: names[index] })
  })),
  unsupported: []
})

const inventory = (jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "r",
  commit: "c",
  toolchains: [],
  jobs: jobs.map(markLeftRunning)
})

describe("a command that leaves a program running", () => {
  it.each([
    ["python3 -m http.server 8767 --bind 127.0.0.1 --directory site > /dev/null 2>&1 &", ["python3"]],
    ["npm start &", ["npm"]],
    ["nohup ./bin/server --port 3000 > server.log 2>&1 &", ["server"]],
    ["PORT=3000 node server.js &\nsleep 1", ["node"]],
    ["(cd site && python3 -m http.server 8000) &", ["python3"]],
    ["Xvfb :99 & echo started", ["Xvfb"]],
    ["redis-server --daemonize yes", ["redis-server"]],
    ["redis-server --port 6380 --daemonize=yes", ["redis-server"]],
    ["valkey-server --daemonize yes", ["valkey-server"]],
    ["mongod --fork --logpath /tmp/m.log", ["mongod"]],
    ["memcached -d -p 11211", ["memcached"]],
    ["memcached --daemon", ["memcached"]],
    ["start-stop-daemon -S -x app", ["start-stop-daemon"]],
    ["setsid --fork ./serve", ["setsid"]],
    ["pg_ctl -D data start", ["pg_ctl"]],
    ["sudo pg_ctlcluster 16 main start", ["pg_ctlcluster"]],
    ["start-stop-daemon --start --exec /usr/bin/app", ["start-stop-daemon"]],
    ["setsid -f ./serve", ["setsid"]],
    ["daemonize /usr/bin/app", ["daemonize"]],
    ["eval \"$(ssh-agent -s)\"", ["ssh-agent"]],
    ["npm start & python3 -m http.server &", ["npm", "python3"]]
  ])("%j leaves %j", (command, programs) => {
    expect(leftRunningIn(command)).toEqual(programs)
  })

  it.each([
    "make test && make lint",
    "make 2>&1 | tee log",
    "make &> log",
    "make |& tee log",
    "make >& log",
    "echo 'a & b'",
    "echo \"a & b\"",
    "echo a \\& b",
    "echo `echo a &`",
    "x=$(sleep 1 &)",
    "# start it with: server &\nmake",
    "cat > page.html <<EOF\n<a href=\"?a=1&b=2\">x</a> &\nEOF\nmake",
    "cat > page.html <<-'EOF'\n\tserver &\n\tEOF\nmake",
    "python3 -m http.server 8768 &\ncurl -sf localhost:8768/x\nkill %1",
    "server & pid=$!\ncurl localhost:3000\nkill $pid",
    "server &\nwait",
    "redis-server --daemonize no",
    "redis-server --daemonize",
    "mongod --port 1",
    "memcached -p 1",
    "start-stop-daemon --stop -x app",
    "pg_ctl -D data stop",
    "setsid ./serve",
    "ssh-agent bash -c 'ssh-add k && git fetch'",
    "if [ -f x ]; then make; fi",
    "case $x in a) make;; esac",
    "echo \"a \\\" & b\"",
    "x=`echo \\` &`",
    "x=$(echo \\) ')' &)",
    "cat <<< 'a & b'"
  ])("%j leaves nothing", (command) => {
    expect(leftRunningIn(command)).toEqual([])
  })

  it("reads a mark that is no comment, and a here-document with no word, as commands", () => {
    expect(leftRunningIn("serve a#b &")).toEqual(["serve"])
    expect(leftRunningIn("cat << $x\nserve &")).toEqual(["serve"])
  })

  it("names a program it cannot read as a program", () => {
    expect(leftRunningIn("( ) &")).toEqual(["a program"])
  })

  it("reads the step's own variables, as its other commands are read", () => {
    expect(leftRunningIn("$SERVER &", { SERVER: "redis-server" })).toEqual(["a program"])
    expect(leftRunningIn("redis-server $FLAGS", { FLAGS: "--daemonize yes" })).toEqual([])
  })

  it("reads a quoted word and an unclosed one to the end of the text", () => {
    expect(leftRunningIn("echo 'unclosed &")).toEqual([])
    expect(leftRunningIn("echo \"unclosed &")).toEqual([])
    expect(leftRunningIn("echo `unclosed &")).toEqual([])
    expect(leftRunningIn("x=$(unclosed &")).toEqual([])
    expect(leftRunningIn("cat <<EOF\nnever ends &")).toEqual([])
    expect(leftRunningIn("echo a 'b' \"c\" && serve &")).toEqual(["serve"])
  })
})

describe("a job with a step that leaves a program running", () => {
  it("is marked once for each such step before its last, with the step and the program", () => {
    const marked = markLeftRunning(job(
      ["python3 -m http.server 8767 &", "redis-server --daemonize yes", "curl -sf localhost:8767/x", "npm start &"],
      ["Start the server", undefined, undefined, undefined]
    ))
    expect(marked.unsupported).toEqual([
      { feature: leftRunning, detail: "\"Start the server\" leaves python3 running" },
      { feature: leftRunning, detail: "\"Run redis-server --daemonize yes\" leaves redis-server running" }
    ])
  })

  it("is returned as it is when only its last step leaves one, as that ends with the job anyway", () => {
    const last = job(["make", "python3 -m http.server &"])
    expect(markLeftRunning(last)).toBe(last)
  })

  it("names a step with no name as GitHub does, by the first line of its command, cut to 60 characters", () => {
    const long = "python3 -m http.server 8767 --bind 127.0.0.1 --directory a/long/path/to/the/site &\ncurl x"
    expect(stepName(job([long]).steps[0]!)).toBe("Run python3 -m http.server 8767 --bind 127.0.0.1 --director…")
    expect(stepName(job(["make"], ["  "]).steps[0]!)).toBe("Run make")
  })

  it("is not replayed, and the reason names the step and says the job stays as it is", () => {
    const read = inventory([job(["python3 -m http.server 8767 &", "curl -sf localhost:8767/x"], ["Serve"])])
    expect(ci(read).jobs).toEqual([])
    const [left] = notReplayed(read)
    expect(reasonsText(left!.reasons)).toBe("left-running (\"Serve\" leaves python3 running)")
    expect(reasonsSentence(left!.reasons)).toBe(
      "leaves a program running for its later steps, which this machine cannot keep until the job ends: " +
        "\"Serve\" leaves python3 running; the job stays in your CI as it is"
    )
  })
})

describe("a machine that keeps a job's programs until the job ends", () => {
  it("replays the job, and every other reason stays", () => {
    const leaves = job(["python3 -m http.server 8767 &", "curl -sf localhost:8767/x"])
    const other = { ...leaves, id: "ci.yml:other", unsupported: [{ feature: "secret", detail: "TOKEN" }] }
    const read = inventory([leaves, other])
    const kept = keepingPrograms(read)
    expect(ci(kept).jobs.map((each) => each.id)).toEqual(["ci.yml:e2e"])
    expect(notReplayed(kept).map((each) => each.job)).toEqual(["ci.yml:other"])
    // Only where `keeps` holds.
    expect(ci(keepingPrograms(read, () => false)).jobs).toEqual([])
  })

  it("is a Linux runner, or none named: a macOS runner keeps nothing", () => {
    const on = (runsOn: string | undefined): Job => {
      const { runsOn: _, ...rest } = job(["make"])
      return runsOn === undefined ? rest : { ...rest, runsOn }
    }
    expect([on("ubuntu-latest"), on(undefined), on("macos-14"), on("windows-latest")].map(keptOnRunner)).toEqual([
      true,
      true,
      false,
      false
    ])
  })

  it("is what the CI `apply` writes: the Linux job as build steps, the macOS one named in the notes with why", () => {
    const linux = job(["python3 -m http.server 8767 &", "curl -sf localhost:8767/x"], ["Start the server"])
    const mac: Job = {
      ...linux,
      id: "ci.yml:mac",
      name: "mac",
      runsOn: "macos-14",
      steps: linux.steps.map((step) => ({ ...step, id: step.id.replace("e2e", "mac") }))
    }
    const kept = keepingPrograms(inventory([linux, mac]), keptOnRunner)
    const left = notReplayed(kept)
    expect(left.map((each) => each.job)).toEqual(["ci.yml:mac"])
    const written = Effect.runSync(files(ci(kept), { left }))
    const read = (path: string): string => written.find((file) => file.path === path)!.content
    expect(read(notesPath)).toContain(`- ci.yml:mac: not in this workflow: ${reasonsSentence(left[0]!.reasons)}\n`)
    expect(read(notesPath)).not.toContain("ci.yml:e2e")
    expect(read(workspacePath)).toContain("ci.yml-e2e-2")
    expect(read(workspacePath)).not.toContain("ci.yml-mac")
  })
})
