// Person-only acts (worker/Actor.ts, decision 0017 slice 0): every flow of the registry with a `userOnlyReason`, and
// every server-only protected act, is the person's own. Each one's route refuses a request anyone acts for the person
// in (`act`), and counts it, through that route's real handler on this file's schema of the compose Postgres. The cases
// are keyed by the list itself, so a person-only flow added to the registry fails the compiler here until its route is
// held to it.
import { Effect, Option, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { secretRoute } from "../src/features/secrets/contract.ts"
import { stackRoute } from "../src/features/todos/contract.ts"
import { writesRoute } from "../src/features/issues/contract.ts"
import { type Act, type Actor, PERSON_ONLY_FLOWS, type PersonOnlyAct, personOnlyRefusals, PROTECTED_ACTS } from "./Actor.ts"
import { REPOSITORY } from "./github/test/fixtures.ts"
import { githubHarness } from "./github/test/harness.ts"
import { domainRoute, domainsRoute } from "../src/features/domains/contract.ts"
import { domainsHarness, switchable } from "./domains/test/harness.ts"
import { REPO, secretsHarness } from "./secrets/test/harness.ts"
import { PERSONAL_MODEL_ROUTE } from "../src/features/personal-model/contract.ts"
import { personalHarness, SAVE } from "./personal/test/harness.ts"
import { stackHarness } from "./stack/test/stack.ts"
import { branchHarness } from "./test/branch.ts"
import { harness, testFile } from "./test/harness.ts"

const runtime = testFile("person_only")

/** Someone acting for an Admin, who may do anything in person: only the `act` can refuse them. */
const actingFor = (kind: Act["kind"]): Actor => ({
  subject: { kind: "person", id: "person-admin" },
  role: "admin",
  login: "admin",
  session: crypto.randomUUID(),
  act: { kind, id: `run-${kind}` },
})

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

interface Refused {
  readonly status: number
  /** The refusals the route counted for this act. */
  readonly counted: number
}

type Case = (actor: Actor, act: PersonOnlyAct) => Promise<Refused>

/** A ChatApi route: the request `request` makes. */
const chat = (request: (h: Awaited<ReturnType<typeof harness>>) => Promise<Response>): Case => async (actor, act) => {
  const h = await harness(runtime, () => Stream.empty, { actor })
  const { status } = await request(h)
  return { status, counted: h.count(personOnlyRefusals, { act, by: actor.act!.kind }) }
}

/** A git write of `op` with a valid body. */
const gitWrite = (body: Record<string, unknown>): Case => async (actor, act) => {
  const h = await githubHarness(runtime, { actor })
  const { status } = await h.fetch(
    writesRoute(REPOSITORY.owner, REPOSITORY.name),
    json({ writeId: crypto.randomUUID(), ...body }),
  )
  return { status, counted: h.count(personOnlyRefusals, { act, by: actor.act!.kind }) }
}

/** A change to a stack with a valid body. */
const stackChange = (body: Record<string, unknown>): Case => async (actor, act) => {
  const h = await stackHarness(runtime, { actor })
  const { status } = await h.fetch(stackRoute("acme", "widgets"), json({ opId: crypto.randomUUID(), ...body }))
  return { status, counted: h.count(personOnlyRefusals, { act, by: actor.act!.kind }) }
}

/** A route of the branch workspace. */
const branch = (path: string, body: unknown): Case => async (actor, act) => {
  const h = await branchHarness(runtime, { actor })
  const { status } = await h.fetch(path, json(body))
  return { status, counted: h.count(personOnlyRefusals, { act, by: actor.act!.kind }) }
}

/** A custom-domain route: `init` at `path`, with a provider on and a starter that is never reached. */
const domain = (path: string, init: RequestInit): Case => async (actor, act) => {
  const h = await domainsHarness(runtime, {
    actor,
    starter: { start: () => Effect.die(new Error("never started")) },
    provider: Option.some(switchable(globalThis.fetch).provider),
    fetch: globalThis.fetch,
  })
  const { status } = await h.fetch(path, init)
  return { status, counted: h.count(personOnlyRefusals, { act, by: actor.act!.kind }) }
}

type Routed = {
  readonly [N in keyof typeof PERSON_ONLY_FLOWS as (typeof PERSON_ONLY_FLOWS)[N] extends { readonly device: string } ? never
    : N]: Case
}

/** How each person-only flow's route is reached, by the flow: the registry's list, less the device-only ones. */
const flows: Routed = {
  "chat/Answer": chat((h) => h.ask({ id: crypto.randomUUID(), answerId: crypto.randomUUID(), text: "Hi" })),
  "run/answer": chat((h) => h.fetch(`/api/runs/${crypto.randomUUID()}/answer`, json({ version: 1, value: "main" }))),
  "flow/answer": chat((h) =>
    h.fetch(`/api/flow-drafts/${crypto.randomUUID()}/answers`, json({ round: 0, answers: [] }))
  ),
  "notification/ack": chat((h) => h.fetch("/api/notifications/ack", json({ subject: "x", version: 1, act: "read" }))),
  "branch/share": branch(`/api/branches/${crypto.randomUUID()}/shares`, { login: "someone", access: "view" }),
  "terminal/open": branch("/api/terminals", {
    branchId: crypto.randomUUID(),
    terminalId: crypto.randomUUID(),
    cols: 80,
    rows: 24,
  }),
  "issue/commitment": gitWrite({ op: "issue/commitment", number: 1, commitment: "now" }),
  "issue/triage": gitWrite({ op: "issue/triage", number: 1, decision: "accept" }),
  "triage/run": gitWrite({ op: "triage/run", number: 1 }),
  "triage/enable": gitWrite({ op: "triage/enable" }),
  "triage/pause": gitWrite({ op: "triage/pause" }),
  "todo/commit": stackChange({ op: "commit", title: "Fix the crash", prompt: "Fix it" }),
  "todo/drop": stackChange({ op: "drop", number: 1 }),
  "alert/channel": chat((h) => h.fetch("/api/alert-channels", json({ channel: "email", destinations: [] }))),
  "sandbox/limits": chat((h) => h.fetch("/api/sandbox-limits", json({ awake: 20, perPerson: 2, monthlyAlertUsd: 100 }))),
  "domain/add": domain(domainsRoute(REPO.owner, REPO.name), json({ hostname: "docs.example.com" })),
  "domain/remove": domain(domainRoute(REPO.owner, REPO.name, "docs.example.com"), { method: "DELETE" }),
}

/** How each protected act's route is reached. */
const protectedActs: { readonly [A in keyof typeof PROTECTED_ACTS]: Case } = {
  secret: async (actor, act) => {
    const h = await secretsHarness(runtime, { start: () => Promise.reject() } as never, { actor })
    const { status } = await h.fetch(secretRoute(REPO.owner, REPO.name, "API_KEY"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "never-stored", hosts: ["api.example.com"] }),
    })
    return { status, counted: h.count(personOnlyRefusals, { act, by: actor.act!.kind }) }
  },
  "pr/merge": gitWrite({ op: "pr/merge", number: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40) }),
  model: async (actor, act) => {
    const h = await personalHarness(runtime, { start: () => Effect.die(new Error("never started")) }, { actor })
    const { status } = await h.fetch(PERSONAL_MODEL_ROUTE, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(SAVE),
    })
    return { status, counted: h.count(personOnlyRefusals, { act, by: actor.act!.kind }) }
  },
}

describe("person-only acts refuse anyone acting for the person", () => {
  test("the cases are the registry's person-only flows with a route, and the protected acts", () => {
    expect(Object.keys(flows).sort()).toEqual(
      Object.entries(PERSON_ONLY_FLOWS).filter(([, enforcement]) => !("device" in enforcement)).map(([flow]) => flow)
        .sort(),
    )
    expect(Object.keys(protectedActs)).toEqual(Object.keys(PROTECTED_ACTS))
  })

  for (const [act, refused] of [...Object.entries(flows), ...Object.entries(protectedActs)] as Array<[PersonOnlyAct, Case]>) {
    test(`${act}: an agent's, a flow's or a frame's request is refused 403 and counted`, async () => {
      for (const kind of ["agent", "flow", "app"] as const) {
        expect(await refused(actingFor(kind), act), `${act} as ${kind}`).toEqual({ status: 403, counted: 1 })
      }
    })
  }
})
