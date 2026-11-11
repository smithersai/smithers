import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { type AlchemyDeployment, alchemyHost, formatVersions, parseVersions } from "../rollout/alchemy.ts"
import { rollout, type RolloutReceipt } from "../rollout/runtime.ts"

const token = "cloudflare-token"
const site = "smithers-mvp-site-prod-a"
const api = "smithers-mvp-api-prod-b"
const tags = ["alchemy:stack:smithers-mvp", "alchemy:stage:prod"]

interface Deployment {
  created_on: string
  versions: Array<{ version_id: string; percentage: number }>
}

/**
 * Cloudflare's Workers API and the deployed site, over loopback. `POST /deploy` is what `alchemy deploy` does to it:
 * every script of the stack serves a new version, and the site's new version a new build. `POST /deploy-half` stops
 * after the API Worker.
 */
const cloudflare = async () => {
  let clock = 0
  const at = () => new Date(Date.UTC(2026, 10, 10, 0, 0, clock++)).toISOString()
  const scripts: Record<string, { tags: Array<string>; deployments: Array<Deployment> }> = {
    [site]: { tags, deployments: [{ created_on: at(), versions: [{ version_id: "site-1", percentage: 100 }] }] },
    [api]: { tags, deployments: [{ created_on: at(), versions: [{ version_id: "api-1", percentage: 100 }] }] },
    // Another stage of the same stack: never captured, never restored.
    "smithers-mvp-site-dev-c": {
      tags: ["alchemy:stack:smithers-mvp", "alchemy:stage:dev"],
      deployments: [{ created_on: at(), versions: [{ version_id: "dev-1", percentage: 100 }] }]
    }
  }
  const builds: Record<string, string> = { "site-1": "aaaaaaaaaaaa", "site-2": "bbbbbbbbbbbb" }
  const posted: Array<{ script: string; body: unknown }> = []
  const newest = (name: string) =>
    [...scripts[name]!.deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))[0]!
  const deploy = (name: string, version_id: string) =>
    scripts[name]!.deployments.unshift({ created_on: at(), versions: [{ version_id, percentage: 100 }] })
  const server: Server = createServer((request, response) => {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    let text = ""
    request.on("data", (chunk) => text += chunk)
    request.on("end", () => {
      const url = request.url!
      if (url === "/version.json") return json(200, { build: builds[newest(site).versions[0]!.version_id] })
      if (url === "/deploy-half" && request.method === "POST") {
        deploy(api, "api-2")
        return json(200, {})
      }
      if (url === "/deploy" && request.method === "POST") {
        deploy(site, "site-2")
        deploy(api, "api-2")
        return json(200, {})
      }
      if (request.headers.authorization !== `Bearer ${token}`) return json(403, {})
      if (url === "/client/v4/accounts/account/workers/scripts") {
        return json(200, { result: Object.entries(scripts).map(([id, script]) => ({ id, tags: script.tags })) })
      }
      const match = /^\/client\/v4\/accounts\/account\/workers\/scripts\/([^/]+)\/deployments$/.exec(url)
      if (match === null || scripts[match[1]!] === undefined) return json(404, {})
      const name = match[1]!
      if (request.method === "GET") return json(200, { result: { deployments: scripts[name]!.deployments } })
      const body = JSON.parse(text) as { versions: Array<{ version_id: string; percentage: number }> }
      posted.push({ script: name, body })
      scripts[name]!.deployments.unshift({ created_on: at(), versions: body.versions })
      return json(200, { result: {} })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  servers.push(server)
  return { origin, scripts, posted, newest, deploy }
}

const servers: Array<Server> = []
const scratch: Array<string> = []
after(() => {
  for (const server of servers) server.close()
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

const exit = (code: number) => ["node", "-e", `process.exit(${code})`]
const deployment = (
  origin: string,
  options: { deploy?: ReadonlyArray<string>; smoke?: ReadonlyArray<string>; token?: string } = {}
): AlchemyDeployment => {
  const directory = mkdtempSync(join(tmpdir(), "alchemy-rollout-"))
  scratch.push(directory)
  return {
    stack: "smithers-mvp",
    stage: "prod",
    directory,
    deploy: options.deploy ??
      [
        "node",
        "-e",
        "fetch(process.env.ORIGIN + '/deploy', { method: 'POST' }).then((r) => process.exit(r.ok ? 0 : 1))"
      ],
    checks: { "deploy-smoke": options.smoke ?? exit(0) },
    site: origin,
    cloudflare: { api: `${origin}/client/v4`, account: "account", token: options.token ?? token },
    receipts: join(directory, "receipts", "prod.json"),
    env: { ...process.env, ORIGIN: origin },
    serving: { attempts: 1, delay: 0 }
  }
}

test("a passing smoke leaves the new release serving and records the passed receipt", async () => {
  const fake = await cloudflare()
  const options = deployment(fake.origin)
  const receipt = await rollout(alchemyHost(options))
  assert.equal(receipt.status, "passed")
  assert.deepEqual(receipt.previous, { version: `${api}=api-1,${site}=site-1`, revision: "aaaaaaaaaaaa" })
  assert.deepEqual(receipt.candidate, { version: `${api}=api-2,${site}=site-2`, revision: "bbbbbbbbbbbb" })
  assert.deepEqual(receipt.baseline, [{ name: "serving", status: "passed" }])
  assert.deepEqual(receipt.checks, [{ name: "serving", status: "passed" }, { name: "deploy-smoke", status: "passed" }])
  assert.deepEqual(fake.posted, [])
  assert.deepEqual(JSON.parse(readFileSync(options.receipts, "utf8")), receipt)
})

test("a failing smoke restores every Worker of the stack to the version it served, and re-verifies it", async () => {
  const fake = await cloudflare()
  const receipt = await rollout(alchemyHost(deployment(fake.origin, { smoke: exit(1) })))
  assert.equal(receipt.status, "rolled-back")
  assert.deepEqual(receipt.failedChecks, ["deploy-smoke"])
  assert.equal(receipt.rollback, "succeeded")
  assert.deepEqual(receipt.reverification, [{ name: "serving", status: "passed" }])
  assert.deepEqual(fake.posted.map((post) => [post.script, post.body]), [
    [api, {
      strategy: "percentage",
      versions: [{ version_id: "api-1", percentage: 100 }],
      annotations: { "workers/message": "rollout restore aaaaaaaaaaaa" }
    }],
    [site, {
      strategy: "percentage",
      versions: [{ version_id: "site-1", percentage: 100 }],
      annotations: { "workers/message": "rollout restore aaaaaaaaaaaa" }
    }]
  ])
  assert.equal(fake.newest("smithers-mvp-site-dev-c").versions[0]!.version_id, "dev-1")
})

test("a smoke that cannot start is a failed check", async () => {
  const fake = await cloudflare()
  const receipt = await rollout(alchemyHost(deployment(fake.origin, { smoke: ["/nonexistent/smoke"] })))
  assert.equal(receipt.status, "rolled-back")
  assert.deepEqual(receipt.failedChecks, ["deploy-smoke"])
})

test("a failed deploy restores only the Workers it changed", async () => {
  const fake = await cloudflare()
  // The deploy got as far as the API Worker, then failed.
  const half = [
    "node",
    "-e",
    "fetch(process.env.ORIGIN + '/deploy-half', { method: 'POST' }).then(() => process.exit(1))"
  ]
  const host = alchemyHost(deployment(fake.origin, { deploy: half }))
  const receipt = await rollout(host)
  assert.equal(receipt.status, "rolled-back")
  assert.deepEqual(receipt.failedChecks, ["publish"])
  assert.deepEqual(fake.posted.map((post) => post.script), [api])
})

test("a split deployment has no version to come back to: the rollout is refused before it deploys", async () => {
  const fake = await cloudflare()
  fake.scripts[api]!.deployments.unshift({
    created_on: "2026-11-11T00:00:00.000Z",
    versions: [{ version_id: "api-1", percentage: 90 }, { version_id: "api-0", percentage: 10 }]
  })
  const receipt = await rollout(alchemyHost(deployment(fake.origin)))
  assert.equal(receipt.status, "refused")
  assert.deepEqual(receipt.failedChecks, ["capture"])
  assert.equal(fake.newest(site).versions[0]!.version_id, "site-1")
})

test("a token Cloudflare refuses is refused before anything deploys", async () => {
  const fake = await cloudflare()
  const receipt = await rollout(alchemyHost(deployment(fake.origin, { token: "wrong" })))
  assert.equal(receipt.status, "refused")
  assert.equal(fake.newest(site).versions[0]!.version_id, "site-1")
})

test("a site still serving the old build fails the serving check", async () => {
  const fake = await cloudflare()
  const host = alchemyHost(deployment(fake.origin))
  assert.deepEqual(
    await host.check("serving", { version: `${api}=api-1,${site}=site-1`, revision: "bbbbbbbbbbbb" }, "candidate"),
    { status: "failed" }
  )
  assert.deepEqual(
    await host.check("serving", { version: `${api}=api-2,${site}=site-1`, revision: "aaaaaaaaaaaa" }, "candidate"),
    { status: "failed" }
  )
})

test("a run interrupted after publishing is restored by the next run", async () => {
  const fake = await cloudflare()
  const options = deployment(fake.origin)
  fake.deploy(site, "site-2")
  fake.deploy(api, "api-2")
  const interrupted: RolloutReceipt = {
    startedAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:01.000Z",
    status: "checking",
    previous: { version: `${api}=api-1,${site}=site-1`, revision: "aaaaaaaaaaaa" },
    candidate: { version: `${api}=api-2,${site}=site-2`, revision: "bbbbbbbbbbbb" },
    baseline: [{ name: "serving", status: "passed" }],
    checks: [],
    failedChecks: [],
    skippedChecks: [],
    rollback: "not-needed",
    reverification: []
  }
  const host = alchemyHost(options)
  await host.record(interrupted)
  const receipt = await rollout(host)
  assert.equal(receipt.status, "rolled-back")
  assert.deepEqual(receipt.failedChecks, ["interrupted"])
  assert.equal(fake.newest(site).versions[0]!.version_id, "site-1")
})

test("an unreadable receipt store refuses the rollout", async () => {
  const fake = await cloudflare()
  const options = deployment(fake.origin)
  const host = alchemyHost(options)
  await host.record({} as RolloutReceipt)
  writeFileSync(options.receipts, "{")
  assert.equal((await rollout(host)).status, "refused")
})

test("serving is the host's own check", async () => {
  const fake = await cloudflare()
  assert.throws(
    () => alchemyHost({ ...deployment(fake.origin), checks: { serving: exit(0) } }),
    /needs checks other than serving/
  )
  assert.throws(() => alchemyHost({ ...deployment(fake.origin), checks: {} }), /needs checks other than serving/)
})

test("a release version names each Worker and its version", () => {
  assert.equal(formatVersions({ b: "2", a: "1" }), "a=1,b=2")
  assert.deepEqual(parseVersions("a=1,b=2"), { a: "1", b: "2" })
  assert.throws(() => parseVersions("a"), /Malformed/)
  assert.throws(() => parseVersions("a="), /Malformed/)
})

test("smthrs flow start rollout: the default host needs production's credentials and changes nothing without them", async () => {
  const [{ default: Rollout, layer }, { Interpreter }, { FlowEngine }, NodeCrypto, { ConfigProvider, Effect, Layer }] =
    await Promise.all([
      import("../rollout/flow.ts"),
      import("@smthrs/flow"),
      import("@smthrs/engine"),
      import("@effect/platform-node/NodeCrypto"),
      import("effect")
    ])
  const result = await Effect.runPromise(
    Rollout.execute({}, { executionId: "rollout-without-credentials" }).pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: (receipt) => receipt }),
      Effect.provide(
        Interpreter.layerWithImplementations(Rollout, layer).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
        )
      )
    )
  )
  assert.equal(result, "Rollout needs APP_DOMAIN, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")
})

test("smthrs flow start rollout on an Alchemy host: the run's output is the deploy receipt", async () => {
  const fake = await cloudflare()
  const [{ default: Rollout }, { executionLayer }, { FlowEngine }, NodeCrypto, { Effect, Layer }] = await Promise.all([
    import("../rollout/flow.ts"),
    import("../rollout/host.vibe"),
    import("@smthrs/engine"),
    import("@effect/platform-node/NodeCrypto"),
    import("effect")
  ])
  const receipt = await Effect.runPromise(
    Rollout.execute({}, { executionId: "rollout-alchemy" }).pipe(
      Effect.provide(
        executionLayer(alchemyHost(deployment(fake.origin))).pipe(
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )
  assert.equal(receipt.status, "passed")
  assert.equal(receipt.candidate?.revision, "bbbbbbbbbbbb")
})
