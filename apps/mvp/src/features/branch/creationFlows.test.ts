import { WebCrypto } from "@smthrs/crypto"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { beforeEach, describe, expect, test } from "vitest"
import { runFlow } from "../../../worker/test/flowHost.ts"
import { branchHarness, gitHost, resetBranches, shaOf } from "../../../worker/test/branch.ts"
import { testFile } from "../../../worker/test/harness.ts"
import builtin from "../../../plugins/branches/src/create"
import { CREATION } from "../../plugins/builtinFlows"
import { BranchClient } from "./api.vibe"
import { CreationStart } from "./creationFlows"
import { registration, run } from "./creationSteps.vibe"
import { BranchCreate, TrackFailure } from "./flows"
import { registrationAt } from "./steps.vibe"
import { Tracked } from "./schema"

const runtime = testFile("creation-flow")
beforeEach(() => resetBranches(runtime))
const request = { owner: "octo", name: "hello", ref: "topic", request: "b56e9ad0-4e67-4b4b-9952-0fbdb119174e" }
const New = Action.make("test/new", { payload: { explicit: Schema.Boolean }, success: Tracked, error: TrackFailure })
const Caller = Flow.make("test/create", { payload: { explicit: Schema.Boolean }, success: Tracked, error: TrackFailure,
  body: Node.capture({ create: New.name }, (input) => New.call(input)) })

const open = async (custom: boolean) => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const key = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`
  const github = gitHost()
  github.publish("octo", "hello", { defaultBranch: "main", branches: { main: shaOf("main") } })
  const h = await branchHarness(runtime, { actor: { subject: { kind: "person", id: "member" }, role: "member" }, github,
    config: { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: key } })
  if (custom) {
    h.forge.files.set(".smithers/branch.json", JSON.stringify({ plugin: "team-branches", flow: "create" }))
    h.forge.files.set(".smithers/plugins/team-branches/plugin.json", JSON.stringify({ ...CREATION.manifest, id: "team-branches" }))
    h.forge.files.set(".smithers/flows/team-branches/create/flow.ts", CREATION.source.replace('"branches/create"', '"team-branches/create"').replace('Create.call({ ref })', 'Create.call({ ref: `team/${ref}` })'))
  }
  const requests = { selections: 0, writes: 0 }
  const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    if (req.method === "GET") requests.selections++
    else requests.writes++
    const response = await h.fetch(url.pathname + url.search, { method: req.method, headers: req.headers, ...(req.method === "GET" ? {} : { body: await req.text() }) })
    if (custom && req.method === "POST") h.forge.files.set(".smithers/flows/team-branches/create/flow.ts", "throw Error('changed after selection')")
    return response
  })))
  const registrations = Layer.merge(registration("http://chat.test"), Interpreter.layerWithImplementations(Caller,
    New.toLayer(({ explicit }) => run({ owner: "octo", name: "hello", ref: "topic", ...(explicit ? { request: request.request } : {}) })),
  )).pipe(Layer.provide(BranchClient.layer({ origin: "http://chat.test" }).pipe(Layer.provide(http))), Layer.provide(http), Layer.provide(WebCrypto.layer))
  return { h, http, registrations, requests }
}

describe("repository branch creation on the durable engine", () => {
  test("the compiled default declares exactly the public ephemeral action", () => {
    const graph = Graph.build(builtin, { ref: "topic" })
    expect(graph.diagnostics).toEqual([])
    expect(Graph.inspect(builtin).steps.map((step) => step.label)).toEqual(["branches/ephemeral"])
  })
  test.each([false, true])("runs selected source through real routes and stores only an ephemeral branch (override=%s)", async (custom) => {
    const { h, registrations, requests } = await open(custom)
    const ran = await runFlow(CreationStart, request, registrations)
    expect(ran.exit).toMatchObject({ _tag: "Success" })
    if (!Exit.isSuccess(ran.exit)) return
    expect(ran.exit.value).toMatchObject({ name: custom ? "team/topic" : "topic", repoId: "github/octo/hello", access: "owner" })
    expect(requests).toEqual({ selections: 1, writes: 1 })
    expect(h.github.seen.filter((entry) => entry.path.includes("receive-pack"))).toEqual([])
    const again = await h.fetch("/api/branches", { method: "POST", body: JSON.stringify({ ...request, ref: ran.exit.value.name, create: true }) })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(ran.exit.value)
  }, 120_000)
  test.each([false, true])("a durable caller creates with a stable child request (explicit=%s)", async (explicit) => {
    const { registrations } = await open(false)
    const ran = await runFlow(Caller, { explicit }, registrations)
    expect(ran.exit).toMatchObject({ _tag: "Success" })
    if (Exit.isSuccess(ran.exit)) expect(ran.exit.value).toMatchObject({ name: "topic", access: "owner" })
  }, 120_000)
  test("branch/create runs its registered child for the requested repository and branch", async () => {
    const { http, registrations, requests } = await open(false)
    const steps = registrationAt("http://chat.test").pipe(Layer.provide(http), Layer.provide(WebCrypto.layer))
    const ran = await runFlow(BranchCreate, { repo: "octo/hello", branch: "new-topic" }, Layer.merge(registrations, steps))

    expect(ran.exit).toMatchObject({
      _tag: "Success",
      value: { name: "new-topic", repoId: "github/octo/hello", access: "owner" },
    })
    expect(requests).toEqual({ selections: 1, writes: 1 })
  }, 120_000)
})
