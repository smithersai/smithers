import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { stripComments } from "./effect-policy"

const guide = readFileSync(new URL("../DEPLOY.md", import.meta.url), "utf8")
const reference = readFileSync(new URL("../../site/src/content/docs/docs/reference/http-api.mdx", import.meta.url), "utf8")
const deploy = readFileSync(new URL("./deploy.ts", import.meta.url), "utf8")
const preflight = readFileSync(new URL("./adopt-durable-objects.ts", import.meta.url), "utf8")
const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
const workflow = readFileSync(new URL("../../../.github/workflows/apps-deploy.yml", import.meta.url), "utf8")
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>
  scripts: Record<string, string>
}

test("deployment guide has one gateway migration and one upstream section", () => {
  expect(guide.match(/^### 1\.0 gateway migration$/gm)).toHaveLength(1)
  expect(guide.match(/^### Other upstream services$/gm)).toHaveLength(1)
})

test("frozen identity warning names every configured Durable Object binding", () => {
  const warning = guide.split("## Frozen identity")[1]!.split("Never edit")[0]!
  const bindings = [...config.matchAll(/"name":\s*"([A-Z_]+)",\s*"class_name":/g)]
  expect(bindings.length).toBeGreaterThan(0)
  for (const [, binding] of bindings) expect(warning).toContain(`\`${binding}\``)
})

for (const [name, source] of [["deployment guide", guide], ["HTTP reference", reference]] as const) {
  test(`${name} documents retired Worker mounts and the authenticated replacement`, () => {
    expect(source).not.toMatch(/When (?:the web Worker's )?`GATEWAY_UPSTREAM_URL` (?:is configured|is set)/)
    expect(source).not.toMatch(/relay (?:answers|fails closed with) `?501/)
    expect(source).not.toMatch(/Only ordinary `GET`|Ordinary `GET`/)
    for (const route of ["/rpc", "/projections", "/sync", "/health", "/api/workflow/provision", "/api/workflow/rpc"]) {
      expect(source).toContain(`\`${route}\``)
    }
    expect(source).toContain("gateway_proxy_removed")
    expect(source).toContain("HTTP 410")
    expect(source).toContain("validated, allowlisted session")
  })
}

test("receipt troubleshooting explains the publish-without-receipt failure and recovery", () => {
  expect(guide).not.toContain("does not guard either one")
  expect(guide).not.toContain("Either turns a real deploy into a receipt")
  expect(guide).toContain("exits with status 1 after publishing")
  expect(guide).toContain("no fresh receipt")
  expect(guide).toContain("latest.json` still describes the previous deployment")
  expect(guide).toContain("re-run the scripted deploy")
})

test("the deploy tool is the pinned alchemy, and the guide names the pin", () => {
  const pin = manifest.dependencies.alchemy
  expect(pin).toMatch(/^2\.\d+\.\d+/)
  expect(guide).toContain(`alchemy@${pin}`)
  expect(deploy).not.toMatch(/wrangler@[\d.]+"?\s*,\s*"deploy"/)
  expect(manifest.scripts["check:effect"]).toBe("bun scripts/effect-policy.ts")
  expect(manifest.scripts["deploy:preflight"]).toBe("bun scripts/adopt-durable-objects.ts")
})

/*
 * `node_modules/.bin/alchemy` re-execs the CLI under node unless the caller's
 * environment names bun (alchemy bin/cli.js:98-116), and node cannot resolve
 * this package's extensionless imports: `alchemy plan` then dies with
 * "Cannot find module .../src/Worker imported from alchemy.run.ts" before it
 * reads a single resource. Every path that runs the CLI therefore spawns bun
 * on the CLI's own TypeScript entry.
 */
const CLI_ENTRY = "node_modules/alchemy/bin/alchemy.ts"

test("every path that runs the Alchemy CLI runs it under bun, never through the .bin shim", () => {
  // scripts/deploy.ts is now the only caller: the preflight is read-only and
  // spawns nothing (see "the preflight is documented as read-only" below).
  // Comments name the shim to explain why it is wrong; only code counts.
  const code = stripComments(deploy)
  expect(code).toContain(CLI_ENTRY)
  expect(code).not.toContain("node_modules/.bin/alchemy")
  expect(stripComments(preflight)).not.toContain(CLI_ENTRY)
  expect(manifest.scripts["deploy:plan"]).toBe(`bun ${CLI_ENTRY} plan --stage prod`)
  const section = guide.split("## Run the Alchemy CLI under bun, always")[1]!.split("## Frozen identity")[0]!
  expect(section).toContain(`bun ${CLI_ENTRY} plan --stage prod`)
  expect(section).toContain("bin/cli.js:98-116")
  expect(section).toContain("Cannot find module")
})

/*
 * The plan evaluates the program, not the account: it reads no live script,
 * needs no credential, and always prints `create` from an empty local state.
 * A guide that called it the adoption verdict would send an operator to
 * production on evidence the plan does not carry.
 */
test("the guide says the plan is not the adoption verdict", () => {
  const section = guide.split("### Procedure")[1]!.split("## Secrets")[0]!
  expect(section).toContain("evaluates the program, not the account")
  expect(section).toContain("Plan: 1 to create")
  expect(section).toContain("never a verdict on the adoption")
  expect(guide).not.toContain("expect one Worker update (adopt) and no")
  expect(deploy).toContain("reads no live script")
})

test("the adopting-deploy section names the preflight, --adopt, and every way the deploy loses Durable Object data", () => {
  const section = guide.split("## The adopting deploy")[1]!.split("## Secrets")[0]!
  expect(section).toContain("scripts/adopt-durable-objects.ts")
  expect(section).toContain("--adopt")
  for (const migration of ["new_sqlite_classes", "deleted_classes", "renamed_classes"]) expect(section).toContain(migration)
  expect(section).toContain("by binding name")
})

test("the secrets section names every secret src/Worker.ts declares, and no value", () => {
  const section = guide.split("## Secrets")[1]!.split("## Scripted deploy")[0]!
  for (const name of WORKER_IDENTITY.secrets) expect(section).toContain(`\`${name}\``)
  expect(section).toContain("dropped by the deploy")
  expect(guide).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----\n[A-Za-z0-9+/=]{20,}/)
})

/*
 * Alchemy records every `Config` the init phase reads as a Redacted output,
 * `Config.string` included, so the optional knobs deploy as `secret_text` and
 * are dropped by a deploy that does not export them. An operator who read
 * "plain knobs" would expect them to survive like the frozen vars.
 */
test("the secrets section names every optional knob and says a Config-read knob deploys as a secret", () => {
  const section = guide.split("## Secrets")[1]!.split("## Scripted deploy")[0]!
  for (const name of WORKER_IDENTITY.optionalVars) expect(section).toContain(`\`${name}\``)
  expect(section).toContain("A knob deploys as a secret, not as a var")
  expect(section).toContain("secret_text")
  expect(section).toContain("Platform.ts:572-577")
})

/*
 * CI parity with src/workerIdentity.ts.
 *
 * An Alchemy upload replaces the script's bindings wholesale
 * (`keepBindings: undefined`, alchemy WorkerProvider.ts:3584), and
 * scripts/deploy.ts hands the CLI `process.env`. So a Worker secret that the
 * "Deploy (real)" step does not export is DROPPED from the deployment: the
 * tagged release publishes, every canary that does not touch that seam stays
 * green, and the route answers its honest 501/503 until a human notices.
 * .github/workflows/apps-deploy.yml is hand-maintained (only actionlint runs
 * over it), so this is the gate that keeps it in step with the identity.
 */
const deployRealEnv = (): string => {
  const step = workflow.split("- name: Deploy (real)")[1]!
  return step.split("run:")[0]!
}

test("the CI deploy step exports every Worker secret", () => {
  const env = deployRealEnv()
  for (const name of WORKER_IDENTITY.secrets) {
    expect(`${name}: ${new RegExp(`^\\s+${name}: `, "m").test(env)}`).toBe(`${name}: true`)
  }
  expect(env).toContain("CLOUDFLARE_API_TOKEN:")
  expect(env).toContain("CLOUDFLARE_ACCOUNT_ID:")
})

test("the CI deploy step exports every optional knob except the one the deploy script computes", () => {
  const env = deployRealEnv()
  for (const name of WORKER_IDENTITY.optionalVars) {
    if (name === "SMITHERS_BUILD_SHA") continue
    expect(`${name}: ${new RegExp(`^\\s+${name}: `, "m").test(env)}`).toBe(`${name}: true`)
  }
  // scripts/deploy.ts reads the sha it stamped the site with and passes it to
  // Alchemy itself; a repository secret of the same name would be ignored.
  expect(env).not.toMatch(/^\s+SMITHERS_BUILD_SHA: /m)
  expect(deploy).toContain("SMITHERS_BUILD_SHA: gitSha")
})

/*
 * `secrets.GITHUB_TOKEN` in Actions is the job's own ephemeral token, not a
 * repository secret. Binding it here would deploy it into the Worker, where
 * it expires within the hour and overrides the working GitHub App for the
 * public catalog.
 */
test("the Worker's GITHUB_TOKEN is never the Actions token", () => {
  expect(deployRealEnv()).not.toContain("${{ secrets.GITHUB_TOKEN }}")
  expect(deployRealEnv()).toMatch(/^\s+GITHUB_TOKEN: \$\{\{ secrets\.SMITHERS_CATALOG_GITHUB_TOKEN \}\}$/m)
})

test("the guide says a deploy drops any secret the shell does not carry, and that the preflight fails on it", () => {
  const section = guide.split("## Secrets")[1]!.split("## Scripted deploy")[0]!
  expect(section).toContain("--allow-secret-drop")
  expect(section).toContain(".alchemy/state")
})

test("the preflight is documented as read-only, with no --apply", () => {
  expect(guide).not.toContain("--apply")
  expect(preflight).not.toContain("Bun.spawn")
})

/*
 * P1-5: `Alchemy.localState()` writes the deployed resource graph, secrets
 * included, to apps/server/.alchemy/state/ in cleartext
 * (alchemy StateEncoding.ts:71-91). Committing that directory would publish
 * every Worker secret to the repository.
 */
test("the local Alchemy state store is gitignored", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8")
  expect(ignore.split("\n").map((line) => line.trim())).toContain(".alchemy/")
})
