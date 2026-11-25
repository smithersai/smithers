import { Result, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { MCP_MAX_REQUEST_BYTES } from "../../src/features/mcp/contract.ts"
import type { Actor } from "../Actor.ts"
import {
  type AttachLimits,
  challengeFor,
  CODE_TTL_MS,
  CONSENT_TTL_MS,
  GRANT_TTL_MS,
  type Grant,
  INTENT_TTL_MS,
  makeAttach,
  MAX_PAIRING_ATTEMPTS,
  PAIRING_PATTERN,
  REFERENCE_PATTERN,
  type Target,
} from "./Attach.ts"
import { defineTool, inputSchemaOf, makeMcpRoute, type McpTool } from "./McpRoute.ts"

const HOST = "https://smithers.sh"
const target = { repo: "evmts/voltaire", branch: "main", conversation: "c_1" }

/** A verifier RFC 7636 admits: 51 unreserved characters. */
const VERIFIER = "agent-verifier-0123456789-abcdefghijklmnopqrstuvwxyz"
const OTHER_VERIFIER = "other-verifier-0123456789-abcdefghijklmnopqrstuvwxyz"
const CHALLENGE = await challengeFor(VERIFIER)

/** A person's own session, as `Sessions` resolves it, arriving in a request from `origin`. */
const as = (person: string, origin: string | null = HOST) => ({
  actor: { subject: { kind: "person", id: person }, role: "admin" } satisfies Actor as Actor,
  request: new Request(`${HOST}/api/attach`, { method: "POST", headers: origin === null ? {} : { origin } }),
})

/** The same person's run credential: an agent acting for them. */
const delegated = (person: string) => ({
  ...as(person),
  actor: { subject: { kind: "person", id: person }, role: "admin", act: { kind: "agent", id: "run_1" } } satisfies Actor as Actor,
})

const setup = (limits?: Partial<AttachLimits>) => {
  let clock = 1_000_000
  /** What each person holds, on every target. A person not listed may act nowhere. */
  const held: Record<string, ReadonlyArray<string>> = {
    will: ["flows:run", "deploy", "tamper", "runs:read"],
    mallory: ["flows:run"],
  }
  const asked: Array<{ readonly person: string; readonly target: Target }> = []
  const attach = makeAttach({
    hostOrigin: HOST,
    now: () => clock,
    ...(limits === undefined ? {} : { limits }),
    permissions: (person, at) => {
      asked.push({ person, target: at })
      return held[person]
    },
  })
  const calls: Array<string> = []
  const grants: Array<Grant> = []
  const tools: ReadonlyArray<McpTool> = [
    defineTool({
      name: "run_flow",
      description: "Start a workflow",
      input: Schema.Struct({ flow: Schema.optional(Schema.String), branch: Schema.optional(Schema.String) }),
      capability: "flows:run",
      policy: "agent",
      call: async (grant, args) => {
        grants.push(grant)
        calls.push(`run_flow:${grant.person}:${String(args.flow)}`)
        return { started: true }
      },
    }),
    defineTool({
      name: "merge",
      description: "Merge a change",
      input: Schema.Struct({}),
      capability: "flows:run",
      policy: "person_only",
      call: async () => {
        calls.push("merge")
        return {}
      },
    }),
    defineTool({
      name: "deploy",
      description: "Deploy",
      input: Schema.Struct({}),
      capability: "deploy",
      policy: "agent",
      call: async () => {
        calls.push("deploy")
        return {}
      },
    }),
    defineTool({
      name: "tamper",
      description: "Tries to widen its own grant",
      input: Schema.Struct({}),
      capability: "tamper",
      policy: "agent",
      call: async (grant) => {
        const open = grant as { -readonly [K in keyof Grant]: Grant[K] } & { ceiling: Array<string> }
        const outcomes: Array<string> = []
        for (const change of [
          () => open.ceiling.push("deploy"),
          () => (open.person = "mallory"),
          () => (open.branch = "release"),
        ]) {
          try {
            change()
            outcomes.push("changed")
          } catch {
            outcomes.push("frozen")
          }
        }
        return { outcomes }
      },
    }),
    defineTool({
      name: "open_run",
      description: "Reads a run named inside the arguments",
      input: Schema.Struct({ run: Schema.Struct({ conversation: Schema.String, id: Schema.String }) }),
      capability: "runs:read",
      policy: "agent",
      // The nested resource is the tool's to authorize: the route only sees top-level repo, branch and conversation.
      authorize: (grant, args) => args.run.conversation === grant.conversation,
      call: async (_grant, args) => {
        calls.push(`open_run:${args.run.id}`)
        return { id: args.run.id }
      },
    }),
  ]
  const route = makeMcpRoute({ attach, hostOrigin: HOST, tools })
  const advance = (ms: number) => {
    clock += ms
  }
  return { attach, route, calls, grants, advance, held, asked }
}

const unwrap = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw new Error(`expected success, got ${String(result.failure)}`)
  return result.success
}

/** A JSON-RPC response body, as the tests read it. */
interface RpcBody {
  readonly id: number | null
  readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> } & Record<string, unknown>
  readonly error: { readonly code: number; readonly data: { readonly reason: string } }
}

const read = async (response: Response | Promise<Response>): Promise<RpcBody> => (await (await response).json()) as RpcBody

const failure = <A, E>(result: Result.Result<A, E>): E | undefined =>
  Result.isFailure(result) ? result.failure : undefined

type Env = ReturnType<typeof setup>

const mint = async (env: Env, ceiling: ReadonlyArray<string> = ["flows:run"], person = "will") =>
  unwrap(await env.attach.mintIntent({ ...as(person), ...target, ceiling }))

/** Mints and claims: the agent's side up to the consent card. */
const claimed = async (env: Env, ceiling?: ReadonlyArray<string>, client = "Claude Code") => {
  const { reference } = await mint(env, ceiling)
  const receipt = unwrap(env.attach.claimIntent({ reference, client, challenge: CHALLENGE }))
  return { reference, ...receipt }
}

/** The person opens the consent card and approves the claim it shows with the pairing code their agent shows. */
const approve = async (env: Env, reference: string, pairing: string) => {
  const view = unwrap(env.attach.consentFor({ ...as("will"), reference }))
  return env.attach.approveIntent({ ...as("will"), claim: view.claim, pairing })
}

/** Runs the whole attach for one agent and returns its token and grant. */
const attachAgent = async (env: Env, ceiling?: ReadonlyArray<string>) => {
  const { reference, claim, pairing } = await claimed(env, ceiling)
  const { code } = unwrap(await approve(env, reference, pairing))
  const redeemed = unwrap(await env.attach.redeemCode({ claim, code, verifier: VERIFIER }))
  return { reference, claim, pairing, code, ...redeemed }
}

const rpc = (
  route: (request: Request) => Promise<Response>,
  token: string | undefined,
  body: unknown,
  options: { readonly path?: string; readonly origin?: string; readonly method?: string } = {},
) =>
  route(new Request(`${HOST}${options.path ?? "/mcp/evmts/voltaire/main"}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    ...(options.method === "GET" ? {} : { body: JSON.stringify(body) }),
  }))

const call = (name: string, args: unknown = {}) => ({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name, arguments: args },
})

const reason = async (response: Response | Promise<Response>) => (await read(response)).error.data.reason

describe("attach intent", () => {
  test("mints an opaque reference shaped like K7QF-2MXD that expires in 10 minutes", async () => {
    const env = setup()
    const { reference, expiresAt } = await mint(env, [])
    expect(reference).toMatch(REFERENCE_PATTERN)
    expect(expiresAt).toBe(1_000_000 + INTENT_TTL_MS)
  })

  test("issues a grant bound to person, repo, branch, conversation and ceiling, acting as the agent", async () => {
    const { grant, token } = await attachAgent(setup())
    expect(token).toMatch(/^smat_/)
    expect(grant).toMatchObject({ person: "will", ...target, ceiling: ["flows:run"], act: "agent", client: "Claude Code" })
  })

  test("a leaked reference is not a credential", async () => {
    const env = setup()
    const { reference } = await mint(env)
    const response = await rpc(env.route, reference, { jsonrpc: "2.0", id: 1, method: "initialize" })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("invalid_token")
  })

  test("a stolen reference grants nothing without the minting person's approval on the host origin", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env, undefined, "Thief")
    expect(unwrap(env.attach.consentFor({ ...as("will"), reference })).client).toBe("Thief")
    expect(failure(env.attach.consentFor({ ...as("mallory"), reference }))).toBe("unknown_reference")
    expect(failure(await env.attach.approveIntent({ ...as("mallory"), claim, pairing }))).toBe("wrong_person")
    expect(failure(await env.attach.approveIntent({ ...as("will", "https://evil.example"), claim, pairing })))
      .toBe("wrong_origin")
    expect(failure(await env.attach.approveIntent({ ...as("will", null), claim, pairing }))).toBe("wrong_origin")
  })

  test("a code is useless without the claimant's PKCE verifier", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    const { code } = unwrap(await approve(env, reference, pairing))
    expect(failure(await env.attach.redeemCode({ claim, code, verifier: OTHER_VERIFIER }))).toBe("invalid_verifier")
    expect(failure(await env.attach.redeemCode({ claim, code, verifier: VERIFIER }))).toBe("invalid_code")
  })

  test("a reference is single use: a replayed claim is refused", async () => {
    const env = setup()
    const { reference } = await claimed(env)
    expect(failure(env.attach.claimIntent({ reference, client: "Codex", challenge: CHALLENGE }))).toBe("already_claimed")
  })

  test("a replayed approval and a replayed code are refused, and a redeemed reference is gone", async () => {
    const env = setup()
    const { reference, claim, pairing, code } = await attachAgent(env)
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim, pairing }))).toBe("unknown_reference")
    expect(failure(await env.attach.redeemCode({ claim, code, verifier: VERIFIER }))).toBe("invalid_code")
    expect(failure(env.attach.claimIntent({ reference, client: "Codex", challenge: CHALLENGE }))).toBe("unknown_reference")
  })

  test("a second approval of one claim is refused", async () => {
    const env = setup()
    const { reference, pairing } = await claimed(env)
    unwrap(await approve(env, reference, pairing))
    expect(failure(await approve(env, reference, pairing))).toBe("already_claimed")
  })

  test("consent cannot come before a claim", async () => {
    const env = setup()
    const { reference } = await mint(env)
    expect(failure(env.attach.consentFor({ ...as("will"), reference }))).toBe("not_claimed")
  })

  test("a reference is gone after 10 minutes", async () => {
    const env = setup()
    const { reference } = await mint(env)
    env.advance(INTENT_TTL_MS)
    expect(failure(env.attach.claimIntent({ reference, client: "Codex", challenge: CHALLENGE }))).toBe("unknown_reference")
  })

  test("a code expires after its minute", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    const { code } = unwrap(await approve(env, reference, pairing))
    env.advance(CODE_TTL_MS)
    // The sweep runs before the code is read, so an expired code is simply gone.
    expect(failure(await env.attach.redeemCode({ claim, code, verifier: VERIFIER }))).toBe("invalid_code")
    expect(env.attach.sizes()).toMatchObject({ intents: 0, codes: 0, tokens: 0 })
  })

  test("a pasted reference reads case-insensitively, and garbage reads as unknown", async () => {
    const env = setup()
    const { reference } = await mint(env)
    expect(Result.isSuccess(env.attach.claimIntent({ reference: ` ${reference.toLowerCase()} `, client: "C", challenge: CHALLENGE })))
      .toBe(true)
    expect(failure(env.attach.claimIntent({ reference: "not a reference", client: "C", challenge: CHALLENGE })))
      .toBe("unknown_reference")
  })

  test("only the grant's person can revoke it", async () => {
    const env = setup()
    const { grant } = await attachAgent(env)
    expect(failure(env.attach.revokeGrant({ ...as("mallory"), grant: grant.id }))).toBe("wrong_person")
    expect(failure(env.attach.revokeGrant({ ...as("will"), grant: "nope" }))).toBe("unknown_reference")
  })
})

describe("H6: only the person's own session grants, and only what they hold", () => {
  test("mint, consent, approve and revoke refuse a session carrying act", async () => {
    const env = setup()
    expect(failure(await env.attach.mintIntent({ ...delegated("will"), ...target, ceiling: ["flows:run"] })))
      .toBe("person_only")
    const { reference, claim, pairing } = await claimed(env)
    expect(failure(env.attach.consentFor({ ...delegated("will"), reference }))).toBe("person_only")
    unwrap(env.attach.consentFor({ ...as("will"), reference }))
    expect(failure(await env.attach.approveIntent({ ...delegated("will"), claim, pairing }))).toBe("person_only")
    const { grant } = unwrap(await env.attach.redeemCode({
      claim,
      code: unwrap(await env.attach.approveIntent({ ...as("will"), claim, pairing })).code,
      verifier: VERIFIER,
    }))
    expect(failure(env.attach.revokeGrant({ ...delegated("will"), grant: grant.id }))).toBe("person_only")
    expect(env.attach.sizes().tokens).toBe(1)
  })

  test("mint and revoke read Origin from the request itself", async () => {
    const env = setup()
    for (const origin of ["https://evil.example", null]) {
      expect(failure(await env.attach.mintIntent({ ...as("will", origin), ...target, ceiling: [] }))).toBe("wrong_origin")
    }
    const { grant } = await attachAgent(env)
    expect(failure(env.attach.revokeGrant({ ...as("will", "https://evil.example"), grant: grant.id }))).toBe("wrong_origin")
  })

  test("the ceiling is the requested capabilities the person holds, never more", async () => {
    const env = setup()
    const minted = await mint(env, ["flows:run", "admin:all", "flows:run"])
    expect(minted.ceiling).toEqual(["flows:run"])
    const { grant } = await attachAgent(env, ["flows:run", "admin:all", "secrets:write"])
    expect(grant.ceiling).toEqual(["flows:run"])
  })

  test("a person who holds nothing on the target cannot mint for it, and permissions are asked for that target", async () => {
    const env = setup()
    expect(failure(await env.attach.mintIntent({ ...as("stranger"), ...target, ceiling: ["flows:run"] }))).toBe("forbidden")
    expect(env.asked).toEqual([{ person: "stranger", target }])
    expect(env.attach.sizes().intents).toBe(0)
  })

  test("the intent is built from the named fields, so a stray person or act in the input changes nothing", async () => {
    const env = setup()
    const smuggled = { ...as("will"), ...target, ceiling: ["flows:run"], person: "mallory", act: "person" }
    const { reference } = unwrap(await env.attach.mintIntent(smuggled))
    expect(failure(env.attach.consentFor({ ...as("mallory"), reference }))).toBe("unknown_reference")
    unwrap(env.attach.claimIntent({ reference, client: "C", challenge: CHALLENGE }))
    expect(unwrap(env.attach.consentFor({ ...as("will"), reference }))).toMatchObject(target)
  })

  test("a permission lost between mint and approval is not granted", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env, ["flows:run", "deploy"])
    env.held.will = ["flows:run"]
    const { code } = unwrap(await approve(env, reference, pairing))
    expect(unwrap(await env.attach.redeemCode({ claim, code, verifier: VERIFIER })).grant.ceiling).toEqual(["flows:run"])
  })

  test("a permission lost after the grant is refused at the next call", async () => {
    const env = setup()
    const { token } = await attachAgent(env, ["flows:run", "deploy"])
    expect((await rpc(env.route, token, call("deploy"))).status).toBe(200)
    env.held.will = ["flows:run"]
    expect(await reason(rpc(env.route, token, call("deploy")))).toBe("capability_exceeded")
    delete env.held.will
    const response = await rpc(env.route, token, call("run_flow"))
    expect(response.status).toBe(403)
    expect(await reason(response)).toBe("forbidden")
    expect(env.calls).toEqual(["deploy"])
  })
})

describe("M2: PKCE values are RFC 7636 shaped", () => {
  test.each([
    ["one character", "a"],
    ["empty", ""],
    ["42 characters", "A".repeat(42)],
    ["44 characters", "A".repeat(44)],
    ["padding", `${"A".repeat(42)}=`],
    ["standard base64", `${"A".repeat(41)}+A`],
    ["a last character no 32-byte digest encodes to", `${"A".repeat(42)}B`],
    ["a plain verifier", VERIFIER],
  ])("a claim refuses a challenge with %s", async (_name, challenge) => {
    const env = setup()
    const { reference } = await mint(env)
    expect(failure(env.attach.claimIntent({ reference, client: "C", challenge }))).toBe("invalid_challenge")
    // The refusal claimed nothing: the person's own agent can still claim.
    expect(Result.isSuccess(env.attach.claimIntent({ reference, client: "C", challenge: CHALLENGE }))).toBe(true)
  })

  test.each([
    ["empty", ""],
    ["42 characters", "a".repeat(42)],
    ["129 characters", "a".repeat(129)],
    ["a character outside the unreserved set", `${"a".repeat(42)} `],
  ])("a redeem refuses a verifier that is %s even when its digest matches the challenge", async (_name, verifier) => {
    const env = setup()
    const { reference } = await mint(env)
    const { claim, pairing } = unwrap(env.attach.claimIntent({ reference, client: "C", challenge: await challengeFor(verifier) }))
    const { code } = unwrap(await approve(env, reference, pairing))
    expect(failure(await env.attach.redeemCode({ claim, code, verifier }))).toBe("invalid_verifier")
    expect(env.attach.sizes().tokens).toBe(0)
  })

  test.each([43, 128])("a redeem accepts a %i character verifier", async (length) => {
    const env = setup()
    const verifier = "v".repeat(length)
    const { reference } = await mint(env)
    const { claim, pairing } = unwrap(env.attach.claimIntent({ reference, client: "C", challenge: await challengeFor(verifier) }))
    const { code } = unwrap(await approve(env, reference, pairing))
    expect(Result.isSuccess(await env.attach.redeemCode({ claim, code, verifier }))).toBe(true)
  })
})

describe("M3: nothing leaks before consent, and approval names the reviewed claim", () => {
  test("a claim answers with an opaque receipt and a pairing code only", async () => {
    const env = setup()
    const { reference } = await mint(env)
    const receipt = unwrap(env.attach.claimIntent({ reference, client: "Thief", challenge: CHALLENGE }))
    expect(Object.keys(receipt).sort()).toEqual(["claim", "pairing"])
    expect(receipt.pairing).toMatch(PAIRING_PATTERN)
    const text = JSON.stringify(receipt)
    for (const secret of [target.repo, "voltaire", target.branch, target.conversation, "will", "flows:run", reference]) {
      expect(text).not.toContain(secret)
    }
  })

  test("the consent view names the claim and not its pairing code", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    const view = unwrap(env.attach.consentFor({ ...as("will"), reference }))
    expect(view).toEqual({ ...target, ceiling: ["flows:run"], claim, client: "Claude Code", expiresAt: 1_000_000 + CONSENT_TTL_MS })
    expect(JSON.stringify(view)).not.toContain(pairing)
  })

  test("an approval needs an unexpired consent view", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim, pairing }))).toBe("consent_expired")
    unwrap(env.attach.consentFor({ ...as("will"), reference }))
    env.advance(CONSENT_TTL_MS)
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim, pairing }))).toBe("consent_expired")
    expect(Result.isSuccess(await approve(env, reference, pairing))).toBe(true)
  })

  test("a consent view never outlives its reference", async () => {
    const env = setup()
    const { reference } = await claimed(env)
    env.advance(INTENT_TTL_MS - 1_000)
    expect(unwrap(env.attach.consentFor({ ...as("will"), reference })).expiresAt).toBe(1_000_000 + INTENT_TTL_MS)
  })

  test("an approval is bound to the claim id and its pairing code, not to the reference", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    unwrap(env.attach.consentFor({ ...as("will"), reference }))
    const wrong = pairing === "000000" ? "000001" : "000000"
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim: reference, pairing }))).toBe("unknown_reference")
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim: "someone-elses-claim", pairing })))
      .toBe("unknown_reference")
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim, pairing: wrong }))).toBe("wrong_pairing")
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim, pairing: "" }))).toBe("wrong_pairing")
    expect(Result.isSuccess(await env.attach.approveIntent({ ...as("will"), claim, pairing }))).toBe(true)
  })

  test("a thief's claim cannot be approved with the code another claim shows", async () => {
    const env = setup()
    const mine = await claimed(env)
    const thief = await claimed(env, undefined, "Thief")
    unwrap(env.attach.consentFor({ ...as("will"), reference: thief.reference }))
    if (mine.pairing !== thief.pairing) {
      expect(failure(await env.attach.approveIntent({ ...as("will"), claim: thief.claim, pairing: mine.pairing })))
        .toBe("wrong_pairing")
    }
    expect(env.attach.sizes().codes).toBe(0)
  })

  test("guessing the pairing code burns the reference", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    unwrap(env.attach.consentFor({ ...as("will"), reference }))
    const wrong = pairing === "000000" ? "000001" : "000000"
    for (let attempt = 0; attempt < MAX_PAIRING_ATTEMPTS; attempt += 1) {
      expect(failure(await env.attach.approveIntent({ ...as("will"), claim, pairing: wrong }))).toBe("wrong_pairing")
    }
    expect(failure(await env.attach.approveIntent({ ...as("will"), claim, pairing }))).toBe("unknown_reference")
    expect(env.attach.sizes()).toMatchObject({ intents: 0, claims: 0, codes: 0 })
  })
})

describe("/mcp route", () => {
  test("initialize, tools/list and tools/call work with a valid grant", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    const init = await rpc(env.route, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(init.status).toBe(200)
    expect(await read(init)).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } })
    expect((await rpc(env.route, token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202)
    const list = await read(rpc(env.route, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }))
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["run_flow"])
    const result = await rpc(env.route, token, call("run_flow", { flow: "ci", branch: "main" }))
    expect(result.status).toBe(200)
    expect(await read(result)).toMatchObject({ id: 7, result: { isError: false, structuredContent: { started: true } } })
    expect(env.calls).toEqual(["run_flow:will:ci"])
  })

  test("refuses a person-only tool even when the ceiling covers it", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    const response = await rpc(env.route, token, call("merge"))
    expect(response.status).toBe(403)
    expect(await reason(response)).toBe("person_only")
    expect(env.calls).toEqual([])
  })

  test("refuses a tool outside the grant's ceiling", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    const response = await rpc(env.route, token, call("deploy"))
    expect(response.status).toBe(403)
    expect(await reason(response)).toBe("capability_exceeded")
  })

  test.each([
    ["another branch", "/mcp/evmts/voltaire/feature%2Fx"],
    ["another repository", "/mcp/evmts/guillotine/main"],
  ])("denies a token on %s", async (_name, path) => {
    const env = setup()
    const { token } = await attachAgent(env)
    const response = await rpc(env.route, token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { path })
    expect(response.status).toBe(403)
    expect(await reason(response)).toBe("wrong_target")
  })

  test.each([
    ["branch", { branch: "release" }],
    ["conversation", { conversation: "c_2" }],
    ["repository", { repo: "evmts/guillotine" }],
  ])("denies a call naming another %s in its arguments", async (_name, args) => {
    const env = setup()
    const { token } = await attachAgent(env)
    const response = await rpc(env.route, token, call("run_flow", args))
    expect(response.status).toBe(403)
    expect(await reason(response)).toBe("wrong_target")
    expect(env.calls).toEqual([])
  })

  test("denies every request after revocation", async () => {
    const env = setup()
    const { token, grant } = await attachAgent(env)
    expect((await rpc(env.route, token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200)
    unwrap(env.attach.revokeGrant({ ...as("will"), grant: grant.id }))
    for (const body of [{ jsonrpc: "2.0", id: 1, method: "initialize" }, call("run_flow")]) {
      const response = await rpc(env.route, token, body)
      expect(response.status).toBe(401)
      expect(await reason(response)).toBe("revoked")
    }
    expect(env.calls).toEqual([])
  })

  test("denies an expired grant", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    env.advance(GRANT_TTL_MS)
    const response = await rpc(env.route, token, call("run_flow"))
    expect(response.status).toBe(401)
    expect(await reason(response)).toBe("expired")
  })

  test("denies a missing, malformed or forged token", async () => {
    const env = setup()
    await attachAgent(env)
    for (const token of [undefined, "", "smat_short", `smat_${"A".repeat(43)}`]) {
      const response = await rpc(env.route, token, { jsonrpc: "2.0", id: 1, method: "initialize" })
      expect(response.status).toBe(401)
    }
  })

  test("denies a browser request from a foreign origin", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    const response = await rpc(env.route, token, call("run_flow"), { origin: "https://evil.example" })
    expect(response.status).toBe(403)
    expect(env.calls).toEqual([])
  })

  test("answers GET with 405, bad JSON with a parse error and unknown methods with -32601", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    expect((await rpc(env.route, token, undefined, { method: "GET" })).status).toBe(405)
    const bad = await env.route(new Request(`${HOST}/mcp/evmts/voltaire/main`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{",
    }))
    expect((await read(bad)).error.code).toBe(-32700)
    expect((await read(rpc(env.route, token, { jsonrpc: "2.0", id: 3, method: "resources/list" }))).error.code)
      .toBe(-32601)
    expect((await read(rpc(env.route, token, call("nope")))).error.code).toBe(-32602)
    expect((await rpc(env.route, token, {}, { path: "/mcp" })).status).toBe(404)
  })
})

describe("M4: explicit policy, strict arguments, immutable grant", () => {
  const tool = {
    name: "open",
    description: "No policy",
    input: Schema.Struct({}),
    capability: "flows:run",
    call: async () => ({}),
  }

  test("a tool without a policy cannot be defined", () => {
    // @ts-expect-error policy is required
    expect(() => defineTool(tool)).toThrow("must declare its policy")
    // @ts-expect-error the old optional flag is not a policy
    expect(() => defineTool({ ...tool, personOnly: false })).toThrow("must declare its policy")
    // @ts-expect-error only the two named policies exist
    expect(() => defineTool({ ...tool, policy: "open" })).toThrow("must declare its policy")
  })

  test("a route refuses a tool that defineTool did not make, and a duplicate name", () => {
    const attach = setup().attach
    const handBuilt = { ...tool, policy: "agent", invoke: async () => Result.succeed({}) } as unknown as McpTool
    expect(() => makeMcpRoute({ attach, hostOrigin: HOST, tools: [handBuilt] })).toThrow("is not from defineTool")
    const noPolicy = { ...tool, invoke: async () => Result.succeed({}) } as unknown as McpTool
    expect(() => makeMcpRoute({ attach, hostOrigin: HOST, tools: [noPolicy] })).toThrow("is not from defineTool")
    const real = defineTool({ ...tool, policy: "agent" })
    expect(() => makeMcpRoute({ attach, hostOrigin: HOST, tools: [real, real] })).toThrow("registered twice")
  })

  test.each([
    ["an argument the schema does not declare", { flow: "ci", force: true }],
    ["a wrongly typed argument", { flow: 5 }],
    ["an array", ["ci"]],
    ["a string", "ci"],
    ["null", null],
  ])("refuses %s before the tool runs", async (_name, args) => {
    const env = setup()
    const { token } = await attachAgent(env)
    const body = await read(rpc(env.route, token, call("run_flow", args)))
    expect(body.error).toMatchObject({ code: -32602, data: { reason: "invalid_arguments" } })
    expect(env.calls).toEqual([])
  })

  test("a tool gets its own frozen grant and cannot widen it", async () => {
    const env = setup()
    const { token, grant } = await attachAgent(env, ["flows:run", "tamper"])
    expect(Object.isFrozen(grant) && Object.isFrozen(grant.ceiling)).toBe(true)
    const tampered = await read(rpc(env.route, token, call("tamper")))
    expect(tampered.result.structuredContent).toEqual({ outcomes: ["frozen", "frozen", "frozen"] })
    // The verifier's grant is untouched: deploy is still outside the ceiling and the next call still runs as will.
    expect(await reason(rpc(env.route, token, call("deploy")))).toBe("capability_exceeded")
    await rpc(env.route, token, call("run_flow", { flow: "a" }))
    await rpc(env.route, token, call("run_flow", { flow: "b" }))
    expect(env.calls).toEqual(["run_flow:will:a", "run_flow:will:b"])
    const [first, second] = env.grants
    expect(first).not.toBe(second)
    expect(first).not.toBe(grant)
    expect(first).toEqual({ ...grant, ceiling: ["flows:run", "tamper"] })
    expect(Object.isFrozen(first) && Object.isFrozen(first!.ceiling)).toBe(true)
  })
})

describe("M5: bounded bodies and bounded state", () => {
  const ping = (padBytes: number) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "a".repeat(padBytes) })

  const post = (env: Env, token: string, init: RequestInit) =>
    env.route(new Request(`${HOST}/mcp/evmts/voltaire/main`, {
      method: "POST",
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    }))

  test("a body at the cap is read and one byte over is refused, though both are valid JSON", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    const overhead = ping(0).length
    expect((await post(env, token, { body: ping(MCP_MAX_REQUEST_BYTES - overhead) })).status).toBe(200)
    const over = await post(env, token, { body: ping(MCP_MAX_REQUEST_BYTES - overhead + 1) })
    expect(over.status).toBe(413)
    expect(await reason(over)).toBe("too_large")
  })

  test("a declared length over the cap is refused before a byte is read", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new TextEncoder().encode(ping(0)))
        controller.close()
      },
    }, { highWaterMark: 0 })
    const response = await post(env, token, {
      body,
      headers: { "content-length": String(MCP_MAX_REQUEST_BYTES + 1) },
      duplex: "half",
    } as RequestInit)
    expect(response.status).toBe(413)
    expect(pulled).toBe(0)
  })

  test("a stream with no declared length is cancelled at the cap, not buffered", async () => {
    const env = setup()
    const { token } = await attachAgent(env)
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    let pulled = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        // Endless whitespace: without a cap the route would read forever.
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    const response = await post(env, token, { body, duplex: "half" } as RequestInit)
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(MCP_MAX_REQUEST_BYTES / chunk.byteLength + 2)
  })

  test("abandoned claims and unredeemed codes are forgotten when their reference expires", async () => {
    const env = setup()
    await mint(env)
    await claimed(env)
    const approved = await claimed(env)
    unwrap(await approve(env, approved.reference, approved.pairing))
    expect(env.attach.sizes()).toMatchObject({ intents: 3, claims: 2, codes: 1 })
    env.advance(CODE_TTL_MS)
    await mint(env)
    // The approved reference is spent once its code lapses, so it goes with the code.
    expect(env.attach.sizes()).toMatchObject({ intents: 3, claims: 1, codes: 0 })
    env.advance(INTENT_TTL_MS)
    expect(failure(env.attach.claimIntent({ reference: approved.reference, client: "C", challenge: CHALLENGE })))
      .toBe("unknown_reference")
    expect(env.attach.sizes()).toMatchObject({ intents: 0, claims: 0, codes: 0 })
  })

  test("unused expired tokens and old revocations are forgotten", async () => {
    const env = setup()
    await attachAgent(env)
    const { grant, token } = await attachAgent(env)
    unwrap(env.attach.revokeGrant({ ...as("will"), grant: grant.id }))
    expect(env.attach.sizes()).toMatchObject({ tokens: 1, revocations: 1 })
    env.advance(GRANT_TTL_MS)
    await mint(env)
    expect(env.attach.sizes()).toMatchObject({ tokens: 0, revocations: 0 })
    expect((await rpc(env.route, token, call("run_flow"))).status).toBe(401)
  })

  test("a person cannot hold more unredeemed references than the cap", async () => {
    const env = setup({ intentsPerPerson: 2 })
    await mint(env)
    await mint(env)
    expect(failure(await env.attach.mintIntent({ ...as("will"), ...target, ceiling: [] }))).toBe("too_many")
    expect(Result.isSuccess(await env.attach.mintIntent({ ...as("mallory"), ...target, ceiling: [] }))).toBe(true)
    env.advance(INTENT_TTL_MS)
    expect(Result.isSuccess(await env.attach.mintIntent({ ...as("will"), ...target, ceiling: [] }))).toBe(true)
  })

  test("the deployment holds no more references or tokens than its caps", async () => {
    const env = setup({ intents: 1, tokens: 1 })
    const first = await attachAgent(env)
    await mint(env)
    expect(failure(await env.attach.mintIntent({ ...as("mallory"), ...target, ceiling: [] }))).toBe("too_many")
    env.advance(INTENT_TTL_MS)
    const { reference, claim, pairing } = await claimed(env)
    const { code } = unwrap(await approve(env, reference, pairing))
    expect(failure(await env.attach.redeemCode({ claim, code, verifier: VERIFIER }))).toBe("too_many")
    expect(env.attach.sizes()).toMatchObject({ intents: 0, claims: 0, codes: 0, tokens: 1 })
    expect((await rpc(env.route, first.token, call("run_flow"))).status).toBe(200)
  })

  test("revocations past the cap forget the oldest, whose token stays refused", async () => {
    const env = setup({ revocations: 1 })
    const first = await attachAgent(env)
    const second = await attachAgent(env)
    unwrap(env.attach.revokeGrant({ ...as("will"), grant: first.grant.id }))
    unwrap(env.attach.revokeGrant({ ...as("will"), grant: second.grant.id }))
    expect(env.attach.sizes()).toMatchObject({ tokens: 0, revocations: 1 })
    const forgotten = await rpc(env.route, first.token, call("run_flow"))
    expect(forgotten.status).toBe(401)
    expect(await reason(forgotten)).toBe("unauthenticated")
    expect(await reason(rpc(env.route, second.token, call("run_flow")))).toBe("revoked")
    expect(env.calls).toEqual([])
  })
})

describe("one claim, one code, one grant", () => {
  test("concurrent approvals of one claim issue exactly one code", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    unwrap(env.attach.consentFor({ ...as("will"), reference }))
    const outcomes = await Promise.all([
      env.attach.approveIntent({ ...as("will"), claim, pairing }),
      env.attach.approveIntent({ ...as("will"), claim, pairing }),
      env.attach.approveIntent({ ...as("will"), claim, pairing }),
    ])
    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
    expect(outcomes.map(failure).filter((refusal) => refusal !== undefined)).toEqual(["already_claimed", "already_claimed"])
    expect(env.attach.sizes().codes).toBe(1)
  })

  test("concurrent approvals yield one grant, and revoking it leaves no live token", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    unwrap(env.attach.consentFor({ ...as("will"), reference }))
    const outcomes = await Promise.all([
      env.attach.approveIntent({ ...as("will"), claim, pairing }),
      env.attach.approveIntent({ ...as("will"), claim, pairing }),
    ])
    const redeemed = await Promise.all(outcomes.filter(Result.isSuccess).map((outcome) =>
      env.attach.redeemCode({ claim, code: outcome.success.code, verifier: VERIFIER })
    ))
    const grants = redeemed.filter(Result.isSuccess).map((outcome) => outcome.success)
    expect(grants).toHaveLength(1)
    unwrap(env.attach.revokeGrant({ ...as("will"), grant: grants[0]!.grant.id }))
    expect(env.attach.sizes()).toMatchObject({ tokens: 0, codes: 0, intents: 0 })
  })

  test("a wrong pairing code releases the reservation, so the right one still approves", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    unwrap(env.attach.consentFor({ ...as("will"), reference }))
    const wrong = pairing === "000000" ? "000001" : "000000"
    const [bad, good] = await Promise.all([
      env.attach.approveIntent({ ...as("will"), claim, pairing: wrong }),
      env.attach.approveIntent({ ...as("will"), claim, pairing }),
    ])
    expect(failure(bad)).toBe("wrong_pairing")
    expect(Result.isSuccess(good)).toBe(true)
  })

  test("a code never outlives the reference that issued it", async () => {
    const env = setup()
    const { reference, claim, pairing } = await claimed(env)
    env.advance(INTENT_TTL_MS - CODE_TTL_MS / 2)
    const { code } = unwrap(await approve(env, reference, pairing))
    env.advance(CODE_TTL_MS / 2)
    expect(failure(await env.attach.redeemCode({ claim, code, verifier: VERIFIER }))).toBe("invalid_code")
    expect(env.attach.sizes()).toMatchObject({ intents: 0, codes: 0, tokens: 0 })
  })
})

describe("M5: sweeps ignore insertion order, and caps hold under concurrency", () => {
  test("a token inserted before an earlier-expiring one does not shield it from the sweep", async () => {
    const env = setup()
    // Approved first, redeemed last: inserted second, expires first.
    const early = await claimed(env)
    const earlyCode = unwrap(await approve(env, early.reference, early.pairing)).code
    env.advance(10_000)
    const late = await attachAgent(env)
    env.advance(10_000)
    const first = unwrap(await env.attach.redeemCode({ claim: early.claim, code: earlyCode, verifier: VERIFIER }))
    expect(first.grant.expiresAt).toBeLessThan(late.grant.expiresAt)
    expect(env.attach.sizes().tokens).toBe(2)
    env.advance(GRANT_TTL_MS - 20_000)
    await mint(env)
    expect(env.attach.sizes().tokens).toBe(1)
    expect((await rpc(env.route, late.token, call("run_flow"))).status).toBe(200)
  })

  test("concurrent redemptions at the token cap store exactly the cap", async () => {
    const env = setup({ tokens: 1 })
    const pending = []
    for (let index = 0; index < 3; index += 1) {
      const { reference, claim, pairing } = await claimed(env)
      pending.push({ claim, code: unwrap(await approve(env, reference, pairing)).code })
    }
    const outcomes = await Promise.all(pending.map(({ claim, code }) => env.attach.redeemCode({ claim, code, verifier: VERIFIER })))
    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)
    expect(outcomes.map(failure).filter((refusal) => refusal !== undefined)).toEqual(["too_many", "too_many"])
    expect(env.attach.sizes().tokens).toBe(1)
  })
})

describe("M4: fresh grant at dispatch, nested authorization, one schema", () => {
  test("a grant revoked while the body streams in runs no tool", async () => {
    const env = setup()
    const { token, grant } = await attachAgent(env)
    const encoded = new TextEncoder().encode(JSON.stringify(call("run_flow", { flow: "ci" })))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // The person revokes mid-upload, before the last byte arrives.
        unwrap(env.attach.revokeGrant({ ...as("will"), grant: grant.id }))
        controller.enqueue(encoded)
        controller.close()
      },
    }, { highWaterMark: 0 })
    const response = await env.route(new Request(`${HOST}/mcp/evmts/voltaire/main`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
      duplex: "half",
    } as RequestInit))
    expect(response.status).toBe(401)
    expect(await reason(response)).toBe("revoked")
    expect(env.calls).toEqual([])
  })

  test("a tool's authorize refuses a nested resource outside the grant", async () => {
    const env = setup()
    const { token } = await attachAgent(env, ["runs:read"])
    const refused = await rpc(env.route, token, call("open_run", { run: { conversation: "c_2", id: "r_9" } }))
    expect(refused.status).toBe(403)
    expect(await reason(refused)).toBe("forbidden")
    expect(env.calls).toEqual([])
    const allowed = await rpc(env.route, token, call("open_run", { run: { conversation: "c_1", id: "r_1" } }))
    expect(allowed.status).toBe(200)
    expect(env.calls).toEqual(["open_run:r_1"])
  })

  test("tools/list advertises the schema derived from the one a call enforces", async () => {
    const env = setup()
    const { token } = await attachAgent(env, ["flows:run", "runs:read"])
    const list = await read(rpc(env.route, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }))
    const tools = list.result.tools as ReadonlyArray<{ readonly name: string; readonly inputSchema: Record<string, unknown> }>
    const runFlow = tools.find((tool) => tool.name === "run_flow")!
    expect(runFlow.inputSchema).toEqual(inputSchemaOf(
      "run_flow",
      Schema.Struct({ flow: Schema.optional(Schema.String), branch: Schema.optional(Schema.String) }),
    ))
    expect(runFlow.inputSchema).toMatchObject({ type: "object", additionalProperties: false })
    const openRun = tools.find((tool) => tool.name === "open_run")!
    expect(openRun.inputSchema).toMatchObject({
      type: "object",
      required: ["run"],
      additionalProperties: false,
      properties: { run: { type: "object", required: ["conversation", "id"], additionalProperties: false } },
    })
    // What the advertised schema admits, the call accepts: an optional field may be sent as null.
    expect((await rpc(env.route, token, call("run_flow", { flow: null }))).status).toBe(200)
    // What it forbids, the call refuses: a nested key the schema does not declare.
    const extra = await read(rpc(env.route, token, call("open_run", { run: { conversation: "c_1", id: "r", x: 1 } })))
    expect(extra.error.data.reason).toBe("invalid_arguments")
  })

  test("a tool taking no arguments advertises a closed object and refuses any key", async () => {
    const env = setup()
    const { token } = await attachAgent(env, ["deploy"])
    const list = await read(rpc(env.route, token, { jsonrpc: "2.0", id: 2, method: "tools/list" }))
    const deploy = (list.result.tools as ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>)
      .find((tool) => tool.name === "deploy")!
    expect(deploy.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false })
    expect((await read(rpc(env.route, token, call("deploy", { force: true })))).error.data.reason).toBe("invalid_arguments")
    expect(env.calls).toEqual([])
  })

  test("a tool whose input is not an object schema cannot be defined", () => {
    expect(() => defineTool({
      name: "bad",
      description: "String input",
      input: Schema.String,
      capability: "flows:run",
      policy: "agent",
      call: async () => ({}),
    })).toThrow("must be an object schema")
  })
})
