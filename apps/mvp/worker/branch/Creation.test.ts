import { RealmFlow } from "@smthrs/harness"
import { digestSync } from "@smthrs/crypto"
import { CodeStorage } from "@smthrs/effect-code-storage"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { BRANCH_FLOWS, CREATION } from "../../src/plugins/builtinFlows.ts"
import type { Actor } from "../Actor.ts"
import { branchHarness, gitHost } from "../test/branch.ts"
import { fixture, scripted } from "../test/codeStorage.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { BranchRoles } from "./Access.ts"
import { selections, select } from "./Creation.ts"
import { CreateRefused } from "./Forge.ts"

const repository = { owner: "octocat", name: "spoon-knife" }
const sha = "a".repeat(40)
const customSource = CREATION.source.replaceAll('"branches/create"', '"custom/create"')
const customManifest = () => ({ ...CREATION.manifest, id: "custom" })
type Files = Record<string, string | Uint8Array>
const installation = (manifest: unknown = customManifest(), source: string | Uint8Array = customSource): Files => ({
  ".smithers/branch.json": JSON.stringify({ plugin: "custom", flow: "create" }),
  ".smithers/plugins/custom/plugin.json": JSON.stringify(manifest),
  ".smithers/flows/custom/create/flow.ts": source,
})

/** The existing scripted provider keeps immutable snapshots and supplies the full CodeStorage.Client API. */
const storage = async (files: Files) => {
  const host = scripted({ syncPolls: 0 })
  host.publish(repository.owner, repository.name, fixture({ files, commit: { ...fixture().commit, sha } }))
  await Effect.runPromise(host.client.createRepo({ name: "github/octocat/spoon-knife", github: repository }))
  await Effect.runPromise(host.client.pullUpstream("github/octocat/spoon-knife"))
  return host
}
const refused = async (files: Files, code = "invalid") => {
  const host = await storage(files)
  const result = await Effect.runPromiseExit(select(host.client, repository, sha))
  expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ _tag: "CreationRefused", code })
  return host
}

describe("public branch creation selection", () => {
  test("without a provider selects the built-in public plugin without a repository read", async () => {
    expect(await Effect.runPromise(select(undefined, repository, "builtin"))).toMatchObject({
      ...repository, tag: "branches/create", revision: "builtin", source: CREATION.source,
      digest: digestSync(CREATION.source), allowed: ["branches/ephemeral"],
    })
  })

  test("a missing configuration selects the same built-in plugin at the pinned revision", async () => {
    const host = await storage({})
    const selected = await Effect.runPromise(select(host.client, repository, sha))
    expect(selected).toMatchObject({ tag: "branches/create", revision: sha, source: CREATION.source, allowed: ["branches/ephemeral"] })
    expect(host.calls.filter((call) => call.startsWith("readFile:"))).toEqual(["readFile:github/octocat/spoon-knife:.smithers/branch.json"])
  })

  test("pins all repository installation reads, including source bytes and digest, to one SHA", async () => {
    const host = await storage(installation())
    const reads: Array<{ repo: string; input: CodeStorage.ReadFileOptions }> = []
    const client: CodeStorage.Client = { ...host.client, readFile: (repo, input) => {
      reads.push({ repo, input })
      return host.client.readFile(repo, input)
    } }
    expect(await Effect.runPromise(select(client, repository, sha))).toEqual({
      ...repository, tag: "custom/create", revision: sha, source: customSource,
      digest: digestSync(customSource), runtime: RealmFlow.version, allowed: ["branches/ephemeral"],
    })
    expect(reads).toEqual([
      ".smithers/branch.json", ".smithers/plugins/custom/plugin.json", ".smithers/flows/custom/create/flow.ts",
    ].map((path) => ({ repo: "github/octocat/spoon-knife", input: { path, ref: sha, maxBytes: 65_536 } })))
  })

  test.each(["not json", "null", "{}", '{"plugin":"../secret","flow":"create"}', '{"plugin":"custom","flow":"../../secret"}', '{"plugin":"custom","flow":"Create"}'])(
    "refuses invalid config %s before reading an installation path", async (config) => {
      const host = await refused({ ".smithers/branch.json": config })
      expect(host.calls.filter((call) => call.startsWith("readFile:"))).toHaveLength(1)
    },
  )

  test.each([".smithers/plugins/custom/plugin.json", ".smithers/flows/custom/create/flow.ts"])("missing %s does not fall back to default", async (path) => {
    const files = installation()
    delete files[path]
    await refused(files)
  })

  test.each([".smithers/branch.json", ".smithers/plugins/custom/plugin.json", ".smithers/flows/custom/create/flow.ts"])("refuses invalid UTF-8 at %s", async (path) => {
    await refused({ ...installation(), [path]: new Uint8Array([0xff]) })
  })

  test.each([
    null,
    { ...customManifest(), id: "different" },
    { ...customManifest(), owns: [] },
    { ...customManifest(), owns: undefined },
    { ...customManifest(), capabilities: ["secrets:read"] },
    { ...customManifest(), capabilities: [] },
    { ...customManifest(), uses: ["unknown/action"] },
    { ...customManifest(), userOnly: { "custom/create": "Person only." } },
    { ...customManifest(), contributes: { commands: [{ id: "custom/create", title: "Create", flow: "custom/create", minimum: "member" }] } },
  ])("refuses mismatched or unauthorized manifest %#", async (manifest) => {
    await refused(installation(manifest))
  })

  test("refuses malformed manifest JSON", async () => {
    await refused({ ...installation(), ".smithers/plugins/custom/plugin.json": "{" })
  })

  test.each(["export default 1", customSource.replace('"custom/create"', '"custom/other"'), customSource.replace('Flow.make("custom/create"', 'Flow.make(dynamicTag')])(
    "refuses unreadable or mismatched flow metadata %#", async (source) => { await refused(installation(customManifest(), source)) },
  )

  test("repository code cannot own a privileged system action", async () => {
    await refused({
      ".smithers/branch.json": JSON.stringify({ plugin: "branches", flow: "ephemeral" }),
      ".smithers/plugins/branches/plugin.json": JSON.stringify({ ...CREATION.manifest, owns: ["ephemeral"], userOnly: { "branches/ephemeral": "Person only." } }),
      ".smithers/flows/branches/ephemeral/flow.ts": CREATION.source.replace('"branches/create"', '"branches/ephemeral"'),
    })
  })

  test("a repository may explicitly select the supported GitHub write action", async () => {
    const source = customSource.replaceAll("branches/ephemeral", "branches/github").replaceAll("git:write", "github:write")
    const host = await storage(installation({ ...customManifest(), capabilities: ["github:write"], uses: ["branches/github"] }, source))
    expect(await Effect.runPromise(select(host.client, repository, sha))).toMatchObject({
      source, digest: digestSync(source), allowed: ["branches/github"], runtime: RealmFlow.version,
    })
  })

  test("an absent uses list grants no privileged action", async () => {
    const host = await storage(installation({ ...customManifest(), uses: undefined }))
    expect((await Effect.runPromise(select(host.client, repository, sha))).allowed).toEqual([])
  })

  test.each(["transport", "forbidden", "too_large"])("upstream %s never selects a fallback", async (code) => {
    const host = await storage({})
    host.fail("readFile", new CodeStorage.CodeStorageError({ operation: "readFile", code }))
    const exit = await Effect.runPromiseExit(select(host.client, repository, sha))
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: "CreationRefused", code: "unavailable" })
  })
})

const member: Actor = { subject: { kind: "person", id: "creation-member" }, role: "member" }
const path = "/api/branches/creation"
const pem = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  return `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----\n`
}
const served = { files: {} as Files, status: 200 }
const apiReads: Array<URL> = []
const server = createServer((request, response) => {
  const url = new URL(request.url!, "http://storage")
  apiReads.push(url)
  const file = served.files[url.searchParams.get("path")!]
  response.writeHead(served.status !== 200 ? served.status : file === undefined ? 404 : 200, { "content-type": "application/octet-stream" })
  response.end(served.status !== 200 ? JSON.stringify({ code: "unavailable" }) : file === undefined ? JSON.stringify({ code: "not_found" }) : file)
})
let apiUrl: string
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
const configured = async () => ({ CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: await pem(), CODE_STORAGE_API_URL: apiUrl })
const upstream = {
  upstream: () => Effect.succeed({ url: "https://github.com/octocat/spoon-knife.git" }),
  create: () => Effect.fail(new CreateRefused({ code: "not_configured" })),
}
const hostWithHead = () => {
  const host = gitHost()
  host.publish(repository.owner, repository.name, { defaultBranch: "main", branches: { main: sha } })
  return host
}

describe("Publish's and Update branch's selection", () => {
  test.each(["publish", "update"] as const)("without a configuration, %s runs the first-party plugin's flow, allowed only its action", async (operation) => {
    const host = await storage({})
    expect(await Effect.runPromise(select(host.client, repository, sha, operation))).toEqual({
      ...repository, tag: BRANCH_FLOWS[operation].tag, revision: sha, source: BRANCH_FLOWS[operation].source,
      digest: digestSync(BRANCH_FLOWS[operation].source), runtime: RealmFlow.version,
      allowed: [operation === "publish" ? "branches/github-publish" : "branches/github-update"], operation,
    })
  })

  test("a configuration names a flow per operation; one it doesn't name runs the first-party flow", async () => {
    const publishSource = BRANCH_FLOWS.publish.source.replaceAll('"branches/publish"', '"custom/ship"')
    const host = await storage({
      ".smithers/branch.json": JSON.stringify({ plugin: "custom", publish: "ship" }),
      ".smithers/plugins/custom/plugin.json": JSON.stringify({ ...CREATION.manifest, id: "custom", owns: ["ship"] }),
      ".smithers/flows/custom/ship/flow.ts": publishSource,
    })
    expect(await Effect.runPromise(select(host.client, repository, sha, "publish"))).toMatchObject({
      tag: "custom/ship", source: publishSource, allowed: ["branches/github-publish"], operation: "publish",
    })
    expect(await Effect.runPromise(select(host.client, repository, sha, "update"))).toMatchObject({ tag: "branches/update" })
    expect(await Effect.runPromise(select(host.client, repository, sha))).toMatchObject({ tag: "branches/create" })
  })

  test("a flow its plugin doesn't own is refused, never the first-party one", async () => {
    const host = await storage({
      ".smithers/branch.json": JSON.stringify({ plugin: "custom", update: "sync" }),
      ".smithers/plugins/custom/plugin.json": JSON.stringify({ ...CREATION.manifest, id: "custom", owns: ["create"] }),
      ".smithers/flows/custom/sync/flow.ts": BRANCH_FLOWS.update.source.replaceAll('"branches/update"', '"custom/sync"'),
    })
    const result = await Effect.runPromiseExit(select(host.client, repository, sha, "update"))
    expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ _tag: "CreationRefused", code: "invalid" })
  })
})

describe("GET /api/branches/creation on the real branch routes and Postgres", () => {
  const runtime = ManagedRuntime.make(TestDatabase.layer("branch_creation_selection"))
  beforeAll(() => runtime.runPromise(Effect.void))
  afterAll(() => runtime.dispose())
  test.each(["POST", "PUT", "DELETE"])("%s is refused before sign-in", async (method) => {
    const h = await branchHarness(runtime)
    const response = await h.fetch(path, { method })
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET")
    expect(h.count(selections, { status: "405" })).toBe(1)
  })

  test("signed out and insufficient roles cannot select code", async () => {
    const signedOut = await branchHarness(runtime)
    expect((await signedOut.fetch(path)).status).toBe(401)
    for (const role of ["guest", null] as const) {
      const h = await branchHarness(runtime, { actor: { ...member, role } })
      expect((await h.fetch(path)).status).toBe(403)
      expect(h.count(selections, { status: "403" })).toBe(1)
    }
  })

  test("on a repository the App is installed on, the role there decides (decision 0079); GitHub down is 503", async () => {
    const sql = (statement: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)))
    await sql(`INSERT INTO github_repositories (repo_id, installation_id) VALUES ('github/acme/widgets', 7)`)
    try {
      /** GitHub, through `RepoRoles`, says `role` on acme/widgets (a test service: worker/branch/Access.test.ts is the real one). */
      const rolesThere = (role: Actor["role"] | "refused") =>
        Layer.succeed(BranchRoles, BranchRoles.of({
          roleOn: () => role === "refused" ? Effect.fail(new RepoRoles.RoleRefused({ code: "rate_limited" })) : Effect.succeed(role),
        }))
      const query = "?owner=acme&name=widgets"
      const outsider = await branchHarness(runtime, { actor: { ...member, role: "admin" }, branchRoles: rolesThere("guest") })
      expect((await outsider.fetch(path + query)).status).toBe(403)
      const down = await branchHarness(runtime, { actor: member, branchRoles: rolesThere("refused") })
      expect((await down.fetch(path + query)).status).toBe(503)
      const insider = await branchHarness(runtime, { actor: { ...member, role: "guest" }, branchRoles: rolesThere("member") })
      const selected = await insider.fetch(path + query)
      expect([selected.status, await selected.json()]).toMatchObject([200, { owner: "acme", name: "widgets", tag: "branches/create" }])
    } finally {
      await sql(`TRUNCATE github_repositories`)
    }
  })

  test.each(["?owner=octocat", "?name=spoon-knife", "?owner=../secret&name=repo", "?owner=&name=repo"])("invalid repository %s is refused", async (query) => {
    const h = await branchHarness(runtime, { actor: member })
    expect((await h.fetch(path + query)).status).toBe(400)
  })

  test("an operation selects its own flow; one that isn't an operation is refused", async () => {
    const h = await branchHarness(runtime, { actor: member })
    const response = await h.fetch(`${path}?operation=update`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ tag: "branches/update", operation: "update", allowed: ["branches/github-update"] })
    expect((await h.fetch(`${path}?operation=push`)).status).toBe(400)
  })

  test("unconfigured home repository selects built-in bytes and records status only", async () => {
    const h = await branchHarness(runtime, { actor: member })
    const response = await h.fetch(path)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({ owner: "smithersai", name: "smithers", revision: "builtin", tag: "branches/create" })
    expect(h.count(selections, { status: "200" })).toBe(1)
    expect(h.only("branch.creation.select")).toMatchObject({ annotations: { status: 200 } })
    expect(h.span("branch.creation.select")[0]!.attributes.get("http.response.status_code")).toBe(200)
  })

  test("configured selection reads real HTTP files at its forge's head SHA", async () => {
    served.files = installation()
    served.status = 200
    apiReads.length = 0
    const h = await branchHarness(runtime, { actor: member, config: await configured(), github: hostWithHead(), forge: upstream })
    const response = await h.fetch(`${path}?owner=octocat&name=spoon-knife`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...repository, tag: "custom/create", source: customSource, revision: sha,
      digest: digestSync(customSource), runtime: RealmFlow.version, allowed: ["branches/ephemeral"] })
    expect(apiReads.map((url) => url.searchParams.get("ref"))).toEqual([sha, sha, sha])
    expect(apiReads.map((url) => url.pathname)).toEqual(Array(3).fill("/api/repos/github%2Foctocat%2Fspoon-knife/file"))
    expect(JSON.stringify(h.logs)).not.toContain(customSource)
  })

  test("configured missing head is a terminal not_found with safe failure telemetry", async () => {
    const h = await branchHarness(runtime, { actor: member, config: await configured(), forge: upstream })
    expect((await h.fetch(`${path}?owner=octocat&name=spoon-knife`)).status).toBe(404)
    expect(h.count(selections, { status: "404" })).toBe(1)
    expect(h.only("branch.creation.select")).toMatchObject({ annotations: {
      status: 404, stage: "head", errorTag: "@smthrs/effect-code-storage/GitRemoteError", errorCode: "not_found",
    } })
  })

  test("invalid repository installation returns 400 without falling back to the built-in", async () => {
    served.files = { ".smithers/branch.json": "invalid secret config" }
    served.status = 200
    const h = await branchHarness(runtime, { actor: member, config: await configured(), github: hostWithHead(), forge: upstream })
    const response = await h.fetch(`${path}?owner=octocat&name=spoon-knife`)
    expect(response.status).toBe(400)
    expect(h.only("branch.creation.select")).toMatchObject({ annotations: {
      status: 400, stage: "installation", errorTag: "CreationRefused", errorCode: "invalid",
    } })
    expect(await response.text()).toBe("")
    expect(JSON.stringify(h.logs)).not.toContain("invalid secret config")
  })

  test.each(["empty", "unavailable", "transport"] as const)("configured head %s is classified without exposing provider text", async (kind) => {
    const github = hostWithHead()
    const pkt = (line: string) => (new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0") + line
    github.fail("GET", kind === "transport" ? "throw" : kind === "empty"
      ? new Response(pkt("# service=git-upload-pack\n") + "00000000", { headers: { "content-type": "application/x-git-upload-pack-advertisement" } })
      : new Response("private upstream text", { status: 503 }))
    const h = await branchHarness(runtime, { actor: member, config: await configured(), github, forge: upstream })
    const status = kind === "empty" ? 404 : 503
    expect((await h.fetch(`${path}?owner=octocat&name=spoon-knife`)).status).toBe(status)
    expect(h.only("branch.creation.select")).toMatchObject({ annotations: {
      status, stage: "head", errorTag: "@smthrs/effect-code-storage/GitRemoteError", errorCode: kind,
    } })
    expect(JSON.stringify(h.logs)).not.toContain("private upstream text")
  })

  test("an unexpected provider defect stays unavailable with a sanitized stage", async () => {
    const h = await branchHarness(runtime, { actor: member, config: await configured(), forge: {
      ...upstream, upstream: () => Effect.die(new Error("private credential and provider cause")),
    } })
    const response = await h.fetch(`${path}?owner=octocat&name=spoon-knife`)
    expect(response.status).toBe(503)
    expect(await response.text()).toBe("")
    expect(h.only("branch.creation.select")).toMatchObject({ annotations: {
      status: 503, stage: "head", errorTag: "unexpected", errorCode: "unexpected",
    } })
    expect(h.span("branch.creation.select")[0]!.attributes.get("stage")).toBe("head")
    expect(JSON.stringify(h.logs)).not.toContain("private credential and provider cause")
  })

  test("repository configuration transport errors return unavailable", async () => {
    served.status = 503
    const h = await branchHarness(runtime, { actor: member, config: await configured(), github: hostWithHead(), forge: upstream })
    expect((await h.fetch(`${path}?owner=octocat&name=spoon-knife`)).status).toBe(503)
    expect(h.only("branch.creation.select")).toMatchObject({ annotations: {
      status: 503, stage: "installation", errorTag: "CreationRefused", errorCode: "unavailable",
    } })
    served.status = 200
  })
})
