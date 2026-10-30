/** Shared real-process fixtures for the binary contract files. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { spawnNodeSync } from "./node-child.ts"

export const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
export const scriptedHost = fileURLToPath(new URL("../fixtures/scripted-native-host.ts", import.meta.url))
export const executable = fileURLToPath(new URL("../../src/bin.ts", import.meta.url))
export const binDirectory = fileURLToPath(new URL("../../bin", import.meta.url))
export const shim = join(binDirectory, "smithers.mjs")
// Outside the repository on purpose. `Project.root` walks up for `.flows/`,
// and this checkout grows one the moment any command runs in it, so a working
// directory under `packages/` would resolve the repository as the project root
// and every case would read the repository's own run state instead of the
// empty one it staged.
export const temporaryDirectoryPrefix = join(tmpdir(), "smithers-cli-bin-")

/**
 * Every case here starts at least one real `smithers`, and starting one means
 * parsing the whole module graph through Node's type stripping. That is
 * seconds on an idle machine and much longer under a loaded one, so these
 * describes carry their own budget rather than the package's 30 s default.
 * The budget stays finite: a genuine hang still fails the run.
 */
export const processBudget = { timeout: 240_000 }

/**
 * Blocks this thread for a real wall-clock interval.
 *
 * A retention window is compared against the host clock inside a spawned
 * process, so a case that sweeps a run it just settled has to let the window
 * actually elapse. These cases drive `spawnSync`, so the wait is synchronous
 * too.
 */
export const waitOut = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export const run = (args: ReadonlyArray<string>, environment: Readonly<Record<string, string>> = {}) => {
  const cwd = mkdtempSync(temporaryDirectoryPrefix)
  try {
    return spawnNodeSync(["--no-warnings", "--import", scriptedHost, executable, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, ...environment }
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

export const runIn = (
  cwd: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {}
) =>
  spawnNodeSync(["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    // `HOME` points at the same empty directory so a fallback that writes to
    // the home tree instead of the working directory is caught by the same
    // assertion.
    env: { ...process.env, HOME: cwd, ...environment }
  })

export const inEmptyDirectory = <A>(use: (cwd: string) => A): A => {
  const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
  try {
    return use(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

/**
 * A real process with no judge preloaded and no gateway key.
 *
 * Every `run`/`runIn` above preloads `scripted-native-host.ts`, which binds an
 * explicit offline judge, so this whole file was blind to which verbs the
 * startup contract refuses: on the landed tree `ls`, `ps`, `status` and
 * `runs list` all exited 2 asking for a gateway key in an empty directory, and
 * nothing here could see it. These cases are deliberately the raw executable,
 * and `NODE_OPTIONS` is cleared so no ambient preload can put a judge back.
 */
export const keyless = (cwd: string, args: ReadonlyArray<string>) =>
  spawnNodeSync(["--no-warnings", executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, HOME: cwd, NODE_OPTIONS: "", AI_GATEWAY_API_KEY: "", SMITHERS_REMOTE: "" }
  })

export const refusal = "smithers run/serve needs AI_GATEWAY_API_KEY,"

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("expected a TCP test server"))
        return
      }
      server.close((error) => error === undefined ? resolve(address.port) : reject(error))
    })
  })

/**
 * Stages a Smithers 0.x project whose runs are all terminal, so the 0.x-project guard
 * refusal has nothing to hold and the verb gets as far as the migration tool.
 */
export const stageLegacyProject = (directory: string): string => {
  mkdirSync(join(directory, ".smithers", "workflows"), { recursive: true })
  writeFileSync(join(directory, ".smithers", "workflows", "ship.tsx"), "export default null\n")
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "legacy" }))
  const database = new DatabaseSync(join(directory, "smithers.db"))
  // The 0.x run table with the columns the migration tool's run-state scan
  // reads. A three-column stand-in made every scan report the database as one
  // it "could not open read only", which is the message for a lock and reads
  // as a defect in the project rather than in the fixture.
  database.exec(
    `CREATE TABLE _smithers_runs (
       run_id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, workflow_path TEXT, status TEXT NOT NULL,
       heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
       pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
     )`
  )
  database.exec(
    "INSERT INTO _smithers_runs (run_id, workflow_name, workflow_path, status) " +
      "VALUES ('run-old-1','ship','.smithers/workflows/ship.tsx','finished')"
  )
  database.close()
  return directory
}

/**
 * One `smithers` process, run from inside a staged project.
 *
 * `environment` overrides this process's environment for configuration cases.
 * Safety gates run before the migration asks its subscription judge.
 */
export const inProject = (
  cwd: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {}
) =>
  spawnNodeSync(["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, ...environment }
  })

/** Safety gates need no model credentials and must not read local subscriptions. */
export const keylessMigration = { AI_GATEWAY_API_KEY: "", CODEX_HOME: "/nonexistent" }

/** A project whose one flow's seat resolves and whose turns cannot. */
export const stageUnservableSeat = (): string => {
  const cwd = realpathSync(mkdtempSync(temporaryDirectoryPrefix))
  mkdirSync(join(cwd, ".smithers", "flows", "failing"), { recursive: true })
  writeFileSync(
    join(cwd, ".smithers", "flows", "failing", "flow.mdx"),
    [
      "---",
      "name: failing",
      "description: A flow whose seat resolves and whose first turn cannot.",
      "capabilities: []",
      "model: openai:gpt-5-mini",
      "---",
      "",
      "# failing",
      "",
      "Report the repository state.",
      ""
    ].join("\n")
  )
  mkdirSync(join(cwd, "codex"), { recursive: true })
  // Fabricated and expired in 1970: only the expiry of an access token is read.
  const expired = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`
  writeFileSync(
    join(cwd, "codex", "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: expired, refresh_token: "fixture-refresh" } }),
    { mode: 0o600 }
  )
  writeFileSync(join(cwd, "codex", "codex"), "#!/bin/sh\necho \"fixture refresh failed\" >&2\nexit 1\n", {
    mode: 0o755
  })
  return cwd
}

/**
 * The same unservable seat behind a canonical `Flow.make` file flow whose body
 * calls one model-backed `AgentAction`: the engine records the flow's root and
 * the action's child, and both must settle with the control run.
 */
export const stageCanonicalUnservableSeat = (): string => {
  const cwd = stageUnservableSeat()
  rmSync(join(cwd, ".smithers", "flows", "failing", "flow.mdx"))
  writeFileSync(
    join(cwd, ".smithers", "flows", "failing", "flow.ts"),
    [
      "import * as AgentAction from \"@smthrs/agent/AgentAction\"",
      "import { Flow } from \"@smthrs/flow\"",
      "import { Node } from \"@smthrs/plan\"",
      "import { Schema } from \"effect\"",
      "",
      "const payload = { args: Schema.optionalKey(Schema.String) }",
      "const implementationVersion = \"failing/v1\"",
      "const Work = AgentAction.make(\"failing/Work\", {",
      "  implementationVersion,",
      "  payload,",
      "  output: Schema.String,",
      "  seat: \"openai:gpt-5-mini\",",
      "  prompt: () => \"Report the repository state.\"",
      "})",
      "",
      "export const layer = Work.layer",
      "export default Flow.make(\"failing\", {",
      "  description: \"A flow whose seat resolves and whose first turn cannot.\",",
      "  capabilities: [],",
      "  effects: { reads: [], writes: [], mode: \"expected\", onConflict: \"serialize\", tier: \"irreversible\" },",
      "  payload,",
      "  success: Schema.String,",
      "  error: AgentAction.AgentFailure,",
      "  body: Node.capture({ action: Work.name, implementationVersion }, (input) => Work.call(input))",
      "})",
      ""
    ].join("\n")
  )
  return cwd
}

export const launch = (cwd: string, args: ReadonlyArray<string>) =>
  spawnNodeSync(["--no-warnings", "--import", scriptedHost, executable, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      SMITHERS_OPENAI_AUTH: "chatgpt",
      CODEX_HOME: join(cwd, "codex"),
      PATH: `${join(cwd, "codex")}:${process.env["PATH"] ?? ""}`
    }
  })
