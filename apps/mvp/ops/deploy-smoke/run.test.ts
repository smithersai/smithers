// The deploy smoke's command (ops/deploy-smoke/run.ts): it finds the stage's one Neon project, runs every spec whatever
// the last did, prints a line per spec, and fails on any failure. The specs themselves run against production.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { roleAgeArgs } from "../role-age/command.ts"
import { findProject, PROJECTS, ranForReal, run, serverErrorsOf, smoke, specArgs, SPECS } from "./run.ts"

const neon = (projects: ReadonlyArray<{ id: string; name: string }>, status = 200) =>
  (async () => new Response(JSON.stringify({ projects }), { status })) as unknown as typeof globalThis.fetch
const PROD = { id: "p1", name: "smithers-mvp-ChatPostgres-prod-abc123" }
const options = { key: "k", orgId: "o", stage: "prod" }

test("finds the stage's one project, and never guesses", async () => {
  expect(await findProject(options, neon([PROD, { id: "x", name: "other" }, { id: "s", name: "smithers-mvp-ChatPostgres-staging-abc" }]))).toBe("p1")
  await expect(findProject(options, neon([]))).rejects.toThrow("found 0")
  await expect(findProject(options, neon([PROD, { ...PROD, id: "p2" }]))).rejects.toThrow("found 2")
  await expect(findProject(options, neon([], 401))).rejects.toThrow("Neon answered 401")
})

test("runs every spec whatever the last did, a line each, and fails on any failure", async () => {
  const lines: Array<string> = []
  const ran: Array<string> = []
  const code = await smoke(["a", "b"], async (spec, project) => {
    ran.push(`${project} ${spec}`)
    return { code: spec === "a" ? 1 : 0, log: `/tmp/${spec}`, seconds: 3 }
  }, (line) => lines.push(line), ["one"])
  expect([code, ran]).toEqual([1, ["one a", "one b"]])
  expect(lines).toEqual(["FAIL  one  a  3 s  exit 1, log /tmp/a", "pass  one  b  3 s", "deploy smoke FAILED: 1 of 2 runs"])
  lines.length = 0
  expect(await smoke(["b"], async () => ({ code: 0, log: "", seconds: 1 }), (line) => lines.push(line))).toBe(0)
  expect(lines.at(-1)).toBe(`deploy smoke passed: ${PROJECTS.length} runs`)
})

test("the command refuses TLS checks turned off before any request with the Neon key", async () => {
  const errors: Array<string> = []
  let asked = 0
  const fetch = (async () => { asked++; return new Response("{}") }) as unknown as typeof globalThis.fetch
  const code = await run({ NODE_TLS_REJECT_UNAUTHORIZED: "0", APP_DOMAIN: "x.test", NEON_API_KEY: "k", NEON_ORG_ID: "o" }, () => {}, (line) => errors.push(line), fetch)
  expect(code).toBe(2)
  expect(asked).toBe(0)
  expect(errors.join()).toContain("TLS checks are turned off")
})

test("a spec that names a project runs there alone; the others still run in every project", async () => {
  const ran: Array<string> = []
  const lines: Array<string> = []
  const specs = ["both", { spec: "one", project: "second" }]
  expect(await smoke(specs, async (spec, project) => {
    ran.push(`${project} ${spec}`)
    return { code: 0, log: "", seconds: 1 }
  }, (line) => lines.push(line), ["first", "second"])).toBe(0)
  expect(ran).toEqual(["first both", "second both", "second one"])
  expect(lines.at(-1)).toBe("deploy smoke passed: 3 runs")
})

test("a spec naming a project the smoke doesn't run is an error, and nothing runs", async () => {
  const ran: Array<string> = []
  await expect(smoke(["both", { spec: "nowhere", project: "third" }], async (spec) => {
    ran.push(spec)
    return { code: 0, log: "", seconds: 1 }
  }, () => {}, ["first"])).rejects.toThrow("nowhere names project third, not one of first")
  expect(ran).toEqual([])
})

test("the smoke's browser specs still run in both browsers, and only registration names one", () => {
  expect(PROJECTS).toEqual(["deployment", "webkit"])
  expect(SPECS.filter((each) => typeof each === "string")).toEqual(["e2e/cold-path.spec.ts", "e2e/first-paint.spec.ts"])
  expect(SPECS.filter((each) => typeof each !== "string")).toEqual([{ spec: "e2e/runner-registration.spec.ts", project: "deployment" }])
})

test("the command needs production's environment, finds the project, and hands both to each spec", async () => {
  const errors: Array<string> = []
  const err = (line: string) => void errors.push(line)
  const out = () => {}
  const fetch = neon([PROD])
  expect(await run({}, out, err, fetch)).toBe(2)
  expect(await run({ APP_DOMAIN: "x.test" }, out, err, fetch)).toBe(2)
  expect(await run({ APP_DOMAIN: "x.test", NEON_API_KEY: "secret-key" }, out, err, fetch)).toBe(2)
  const full = { APP_DOMAIN: "x.test", NEON_API_KEY: "secret-key", NEON_ORG_ID: "o" }
  expect(await run(full, out, err, neon([]))).toBe(2)
  expect(errors.join("\n")).not.toContain("secret-key")
  const seen: Array<[string, string, string | undefined, string | undefined]> = []
  const code = await run(full, out, err, fetch, (env) => async (spec, project) => {
    seen.push([project, spec, env.E2E_PROD_URL, env.E2E_ROLE_EXPIRE_PROJECT])
    return { code: 0, log: "", seconds: 0 }
  })
  expect(code).toBe(0)
  expect(seen).toEqual(PROJECTS.flatMap((project) =>
    SPECS.flatMap((each) =>
      typeof each === "string"
        ? [[project, each, "https://x.test", "p1"]]
        : each.project === project ? [[project, each.spec, "https://x.test", "p1"]] : []
    )
  ))
})

test("every 5xx a spec's report names reaches the smoke's own output, passing or not", async () => {
  const log = "  ✓  7 [webkit] › e2e/x.spec.ts\nserver error: 503 GET /api/repos/a/b/role code=unavailable x-smithers-ray=0123456789abcdef-SJC ×1\nserver error: 503 GET /api/repos/a/b/role code=unavailable x-smithers-ray=0123456789abcdef-SJC ×1\nother line\n"
  expect(serverErrorsOf(log)).toEqual(["503 GET /api/repos/a/b/role code=unavailable x-smithers-ray=0123456789abcdef-SJC ×1"])
  const lines: Array<string> = []
  await smoke(["a"], async () => ({ code: 0, log: "/tmp/a", seconds: 1, serverErrors: serverErrorsOf(log) }), (line) => lines.push(line), ["one"])
  expect(lines).toEqual(["pass  one  a  1 s", "      503 GET /api/repos/a/b/role code=unavailable x-smithers-ray=0123456789abcdef-SJC ×1", "deploy smoke passed: 1 runs"])
})

test("a spec counts only if it ran for real: a skipped or missing one proves nothing", () => {
  const summary = (row: string) => `spec                     passed      failed      broken       fixed     skipped     blocked  undeclared\nsign-in.setup.ts              6           ·           ·           ·           ·           ·           ·\n${row}\ntotal 1\n`
  const spec = "e2e/first-paint.spec.ts"
  expect(ranForReal(summary("first-paint.spec.ts           3           ·           ·           ·           ·           ·           ·"), spec)).toBe(true)
  expect(ranForReal(summary("first-paint.spec.ts           ·           ·           ·           ·           3           ·           ·"), spec)).toBe(false)
  expect(ranForReal(summary("first-paint.spec.ts           2           ·           ·           ·           1           ·           ·"), spec)).toBe(false)
  expect(ranForReal(summary("other.spec.ts                 3           ·           ·           ·           ·           ·           ·"), spec)).toBe(false)
  expect(ranForReal("", spec)).toBe(false)
})

// The smoke's own setup, as the smoke starts it: plain node in apps/mvp, nothing from this test's loader. Each stops at the
// environment it lacks, past every import, so a module node can't load fails here before a deploy and not on production.
const plainNode = (args: ReadonlyArray<string>) => {
  const { status, stderr } = spawnSync("node", [...args], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  })
  return { status, stderr: stderr.trim() }
}

test("node loads what the smoke starts", () => {
  expect(plainNode(["ops/deploy-smoke/run.ts"])).toEqual({ status: 2, stderr: "deploy smoke not run: APP_DOMAIN is not set: run under mvp-prod-env" })
  expect(plainNode(specArgs(SPECS[0]!, PROJECTS[0]!)).status).toBe(2)
  expect(plainNode(roleAgeArgs("owner/repo", "person", "project"))).toEqual({ status: 1, stderr: "role row not aged: NEON_API_KEY is not set: run under mvp-prod-env" })
}, 60_000)
