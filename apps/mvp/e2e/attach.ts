import { createHash, randomBytes } from "node:crypto"
import { expect, request as playwrightRequest, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test"
import { RUNS_ROUTE } from "../src/features/status/contract.ts"
import type { Report } from "../src/features/status/schema.ts"
import { QUESTIONS_ROUTE } from "../src/features/chat/contract.ts"
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
import { onThisMachine, ownPlace, target as e2eTarget } from "./target.ts"

export interface AttachTarget {
  readonly repo: string
  readonly branch: string
  readonly conversation: string
}

/** A deterministic test agent connected through the real attach routes and scoped to one conversation. */
export const attachAgent = async (request: APIRequestContext, baseUrl: string, personId: string, target: AttachTarget) => {
  const origin = new URL(baseUrl).origin
  const person = { origin, [DEVICE_PERSON_HEADER]: personId }
  const post = async <A>(
    path: string,
    data: unknown,
    expected: number,
    headers?: Record<string, string>,
    client = request,
  ): Promise<A> => {
    const response = await client.post(origin + path, { data, headers })
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
  // Pair and respond in a separate client that holds only the attach bearer.
  const client = await playwrightRequest.newContext({ ignoreHTTPSErrors: onThisMachine(origin) })
  try {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const { claim, pairing } = await post<{ claim: string; pairing: string }>(ATTACH_CLAIMS_ROUTE, {
      reference, client: "Smithers test agent", challenge,
    }, 201, undefined, client)
    await post(ATTACH_CONSENT_ROUTE, { reference }, 200, person)
    const { code } = await post<{ code: string }>(ATTACH_APPROVALS_ROUTE, { claim, pairing }, 200, person)
    const { token, grant } = await post<{ token: string; grant: { id: string } }>(ATTACH_TOKENS_ROUTE, { claim, code, verifier }, 200, undefined, client)
    const [owner, name] = target.repo.split("/")
    const path = attachMcpRoute(owner!, name!, target.branch)
    return {
      /** Admit a question through the person's API session when the browser is not the writer under test. */
      ask: (question: { id: string; answerId: string; text: string }) =>
        post<unknown>(QUESTIONS_ROUTE, { ...question, conversationId: target.conversation }, 202, person),
      reportRunAsPerson: (answerId: string, report: Report) => post<unknown>(RUNS_ROUTE + "/" + answerId, report, 200, person),
      respond: async (questionId: string, text: string) => {
        const response = await post<{ result?: { structuredContent?: { answered?: boolean; answerId?: string } } }>(path, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "conversation_respond", arguments: { questionId, text } },
        }, 200, { authorization: `Bearer ${token}` }, client)
        const result = response.result?.structuredContent
        if (result?.answered !== true || result.answerId === undefined) throw new Error("Attached agent could not settle the answer")
        return result.answerId
      },
      revoke: async () => {
        try {
          await post<void>(ATTACH_REVOCATIONS_ROUTE, { grant: grant.id }, 204, person)
        } finally {
          await client.dispose()
        }
      },
    }
  } catch (error) {
    await client.dispose()
    throw error
  }
}

export const attachToOpenConversation = async (page: Page, conversation?: AttachTarget) => {
  const { origin } = new URL(page.url())
  const session = await page.request.get(origin + SESSION_ROUTE)
  let state: SessionState
  try {
    expect(session.status()).toBe(200)
    state = await session.json() as SessionState
  } finally {
    await session.dispose()
  }
  if (!state.signedIn || state.personId === undefined) throw new Error("The browser has no signed-in person")

  if (conversation !== undefined) return attachAgent(page.request, origin, state.personId, conversation)

  const own = ownPlace()
  if (e2eTarget === "local") {
    if (state.homeConversationId === undefined) throw new Error("The browser has no home conversation")
    return attachAgent(page.request, origin, state.personId, {
      repo: process.env.GITHUB_REPOSITORY ?? "smithersai/smithers",
      branch: "main",
      conversation: state.homeConversationId,
    })
  }

  const path = new URL(page.url()).pathname
  if (own === undefined || (path !== own.path && path !== own.path + "/")) {
    throw new Error("Open the deployment test's own conversation before attaching")
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

export type AttachedAgent = Awaited<ReturnType<typeof attachAgent>>

export const withAttachedAgent = async <A>(
  page: Page,
  use: (agent: AttachedAgent) => Promise<A>,
  conversation?: AttachTarget,
): Promise<A> => {
  const agent = await attachToOpenConversation(page, conversation)
  try {
    return await use(agent)
  } finally {
    await agent.revoke()
  }
}

/** Admit an exchange through the chat API and settle it through MCP. */
export const recordExchange = async (agent: AttachedAgent, question: { id: string; answerId: string; text: string }, reply: string) => {
  await agent.ask(question)
  expect(await agent.respond(question.id, reply)).toBe(question.answerId)
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
