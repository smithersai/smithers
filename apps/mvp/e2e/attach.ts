import { createHash, randomBytes } from "node:crypto"
import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test"
import { DEVICE_PERSON_HEADER, SESSION_ROUTE, type SessionState } from "../src/features/auth/contract.ts"
import {
  ATTACH_APPROVALS_ROUTE,
  ATTACH_CLAIMS_ROUTE,
  ATTACH_CONSENT_ROUTE,
  ATTACH_INTENTS_ROUTE,
  ATTACH_REVOCATIONS_ROUTE,
  ATTACH_TOKENS_ROUTE,
  attachMcpRoute,
} from "../src/features/mcp/contract.ts"
import { ownPlace } from "./target"

export interface AttachTarget {
  readonly repo: string
  readonly branch: string
  readonly conversation: string
}

/** A deterministic test agent connected through the real attach routes and scoped to one conversation. */
export const attachAgent = async (request: APIRequestContext, baseUrl: string, personId: string, target: AttachTarget) => {
  const origin = new URL(baseUrl).origin
  const person = { origin, [DEVICE_PERSON_HEADER]: personId }
  const post = async <A>(path: string, data: unknown, expected: number, headers?: Record<string, string>): Promise<A> => {
    const response = await request.post(origin + path, { data, headers })
    try {
      if (response.status() !== expected) throw new Error(`POST ${path} answered ${response.status()}, expected ${expected}`)
      return (expected === 204 ? undefined : await response.json()) as A
    } finally {
      await response.dispose()
    }
  }

  const { reference } = await post<{ reference: string }>(ATTACH_INTENTS_ROUTE, {
    ...target,
    ceiling: ["conversation:write"],
  }, 201, person)
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const { claim, pairing } = await post<{ claim: string; pairing: string }>(ATTACH_CLAIMS_ROUTE, {
    reference, client: "Smithers test agent", challenge,
  }, 201)
  await post(ATTACH_CONSENT_ROUTE, { reference }, 200, person)
  const { code } = await post<{ code: string }>(ATTACH_APPROVALS_ROUTE, { claim, pairing }, 200, person)
  const { token, grant } = await post<{ token: string; grant: { id: string } }>(ATTACH_TOKENS_ROUTE, { claim, code, verifier }, 200)
  const [owner, name] = target.repo.split("/")
  const path = attachMcpRoute(owner!, name!, target.branch)
  return {
    respond: async (questionId: string, text: string) => {
      const response = await post<{ result?: { structuredContent?: { answered?: boolean } } }>(path, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "conversation_respond", arguments: { questionId, text } },
      }, 200, { authorization: `Bearer ${token}` })
      if (response.result?.structuredContent?.answered !== true) throw new Error("Attached agent could not settle the answer")
    },
    revoke: () => post<void>(ATTACH_REVOCATIONS_ROUTE, { grant: grant.id }, 204, person),
  }
}

export const attachToOpenConversation = async (page: Page) => {
  const { origin } = new URL(page.url())
  const session = await page.request.get(origin + SESSION_ROUTE)
  expect(session.status()).toBe(200)
  const state = await session.json() as SessionState
  if (!state.signedIn || state.personId === undefined) throw new Error("The browser has no signed-in person")

  const own = ownPlace()
  if (own === undefined) {
    if (state.homeConversationId === undefined) throw new Error("The browser has no home conversation")
    return attachAgent(page.request, origin, state.personId, {
      repo: process.env.GITHUB_REPOSITORY ?? "smithersai/smithers",
      branch: "main",
      conversation: state.homeConversationId,
    })
  }

  const [, owner, repo, kind, ...ref] = own.path.split("/")
  if (owner === undefined || repo === undefined || kind !== "tree" || ref.length === 0) {
    throw new Error("The test conversation has no branch path")
  }
  return attachAgent(page.request, origin, state.personId, {
    repo: owner + "/" + repo,
    branch: ref.map(decodeURIComponent).join("/"),
    conversation: own.conversationId,
  })
}

/** Capture any browser request to the retired public model routes. */
export const browserModelRequests = (context: BrowserContext) => {
  const calls: Array<string> = []
  context.on("request", (request) => {
    const { pathname } = new URL(request.url())
    if (pathname === "/api/model" || pathname.startsWith("/api/model/")) calls.push(pathname)
  })
  return calls
}
