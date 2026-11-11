import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { preflight } from "./preflight.mjs"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { environment, run } from "./run.mjs"

const env = Object.fromEntries([
  "APP_DOMAIN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "ALCHEMY_PASSWORD", "NEON_API_KEY", "CEREBRAS_API_KEY"
].map((name) => [name, "credential-value-never-print"]))
const healthy = { env, probe: () => true, dependencies: () => {}, nodeVersion: "26.5.0" }
test("all prerequisites resolve before publication", () => {
  assert.equal(preflight(healthy).status, "passed")
})
test("a stopped engine refuses both packing and Alchemy, without exposing credentials", () => {
  const calls = []
  const check = () => preflight({ ...healthy, probe: (name, args) => !(name === "docker" && args[0] === "info") })
  assert.throws(() => run(["deploy", "--yes"], {
    check, command: (...args) => { calls.push(args); return { status: 0 } }
  }), (error) => /container engine is stopped/.test(error.message) && !error.message.includes(env.CLOUDFLARE_API_TOKEN))
  assert.deepEqual(calls, [])
})
test("missing tools, builder and credentials are reported together using names only", () => {
  for (const failing of ["pnpm", "npm", "docker", "buildx", "builder"]) {
    const probe = (name, args) => {
      if (failing === "buildx") return args.join(" ") !== "buildx version"
      if (failing === "builder") return args.join(" ") !== "buildx inspect --bootstrap"
      return name !== failing
    }
    assert.throws(() => preflight({ ...healthy, env: {}, probe }), (error) =>
      /CLOUDFLARE_API_TOKEN is unresolved/.test(error.message) && /NEON_API_KEY is unresolved/.test(error.message))
  }
})
test("node version, blank keys, partial integrations and dependency gaps fail closed", () => {
  for (const version of ["24.0.0", "26.3.9"]) {
    assert.throws(() => preflight({ ...healthy, nodeVersion: version }), /Node 26.4/)
  }
  assert.throws(() => preflight({ ...healthy, env: { ...env, ALCHEMY_PASSWORD: " " } }), /ALCHEMY_PASSWORD is unresolved/)
  for (const name of ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_ID", "CODE_STORAGE_ORG"]) {
    assert.throws(() => preflight({ ...healthy, env: { ...env, [name]: "set" } }), /must resolve together/)
  }
  assert.throws(() => preflight({ ...healthy, dependencies: () => { throw new Error("install missing") } }), /install missing/)
})
test("custom models resolve their own credential names without exposing model configuration", () => {
  assert.equal(preflight({ ...healthy, env: {
    ...env, CEREBRAS_API_KEY: "", CHAT_MODEL: JSON.stringify({ credential: "MODEL_KEY" }), MODEL_KEY: "secret"
  } }).status, "passed")
  assert.throws(() => preflight({ ...healthy, env: {
    ...env, TIER_MODELS: JSON.stringify({ fast: { credential: "TIER_KEY" } })
  } }), /TIER_KEY is unresolved/)
  assert.throws(() => preflight({ ...healthy, env: { ...env, CHAT_MODEL: "bad private input" } }), (error) =>
    /CHAT_MODEL is invalid JSON/.test(error.message) && !error.message.includes("private input"))
  assert.throws(() => preflight({ ...healthy, env: {
    ...env, SUMMARY_MODEL: JSON.stringify({ credential: "not-an-env-name" })
  } }), /model credential must name/)
})
test("the preflight-only command starts no build or publication", () => {
  const calls = []
  assert.equal(run(["preflight"], { check: () => {}, command: (...args) => calls.push(args) }), 0)
  assert.deepEqual(calls, [])
  assert.throws(() => run(["destroy"]), /Expected plan/)
})
test("packing must finish before Alchemy starts, and all exit statuses propagate", () => {
  const calls = []
  const command = (program, argv) => { calls.push([program, argv]); return { status: 0 } }
  assert.equal(run(["deploy", "--yes"], { check: () => {}, command }), 0)
  assert.deepEqual(calls.map((each) => each[1]), [
    ["infra/sandbox/pack-cli.mjs"], ["exec", "alchemy", "deploy", "--stage", "prod", "--yes"]
  ])
  assert.equal(run(["plan"], { check: () => {}, command: () => ({ status: 7 }) }), 7)
  assert.equal(run(["deploy"], { check: () => {}, command: () => ({ status: null }) }), 1)
  let count = 0
  assert.equal(run(["deploy"], { check: () => {}, command: () => ({ status: ++count === 1 ? 0 : 9 }) }), 9)
})


test("the real deploy command refuses missing prerequisites before its first build", () => {
  const secret = "must-never-appear-in-diagnostics"
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run.mjs", import.meta.url)), "deploy", "--yes"], {
    env: { PATH: "", CLOUDFLARE_API_TOKEN: secret }, encoding: "utf8", timeout: 30_000
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Deploy preflight failed before publication/)
  assert.doesNotMatch(result.stdout, /deploy.pack|deploy.deploy/)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret))
})

test("preflight reads the same dotenv file and precedence as Alchemy, without changing process.env", () => {
  const cwd = mkdtempSync(join(tmpdir(), "deploy-env-"))
  try {
    const env = { CLOUDFLARE_ACCOUNT_ID: "shell", CLOUDFLARE_API_TOKEN: "shell-secret" }
    writeFileSync(join(cwd, ".env"), 'CLOUDFLARE_ACCOUNT_ID=file\nNEON_API_KEY="file-secret"\n')
    writeFileSync(join(cwd, "selected.env"), 'CLOUDFLARE_ACCOUNT_ID=explicit\n')
    assert.deepEqual(environment([], { env, cwd }), { ...env, NEON_API_KEY: "file-secret" })
    for (const args of [["--env-file", "selected.env"], ["--env-file=selected.env"]]) {
      assert.deepEqual(environment(args, { env, cwd }), { ...env, CLOUDFLARE_ACCOUNT_ID: "explicit" })
    }
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, "shell")
    assert.throws(() => environment(["--env-file", "missing.env"], { env, cwd }), /Cannot read deployment environment/)
    assert.throws(() => environment(["--env-file"], { env, cwd }), /needs a file/)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
