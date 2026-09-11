import { describe, expect, test } from "vitest"
import {
  CLOUD_LSP_FRAME_CAP_BYTES,
  CLOUD_LSP_REASSEMBLY_CAP_BYTES,
  CLOUD_LSP_ROOT_URI,
  CLOUD_LSP_SUBPROTOCOL,
  CLOUD_TERMINAL_FRAME_CAP_BYTES,
  CLOUD_WS_NOT_READY_CLOSE_CODE,
  CLOUD_WS_PENDING_CLOSE_CODE,
  CLOUD_WS_SESSION_KINDS,
  CloudAuthStartResponseSchema,
  CloudLspFragmentSchema,
  CloudLspSessionSchema,
  CloudSessionSchema,
  retryAfterOf,
  withRetryAfter
} from "../src/CloudTunnel.ts"

/*
 * Lane L6: the cloud language-server relay through the tunnel (plue #505).
 * The renderer reads plue's fragments and the tunnel's close reasons; what
 * the two sides agree on is pinned here.
 */
describe("the cloud LSP relay contract", () => {
  test("the lsp branch has its own subprotocol, frame cap and reassembly cap, and the checkout is the root", () => {
    expect(CLOUD_WS_SESSION_KINDS).toEqual(["terminal", "lsp"])
    expect(CLOUD_LSP_SUBPROTOCOL).toBe("lsp")
    expect(CLOUD_TERMINAL_FRAME_CAP_BYTES).toBe(64 * 1024)
    expect(CLOUD_LSP_FRAME_CAP_BYTES).toBe(1024 * 1024)
    expect(CLOUD_LSP_REASSEMBLY_CAP_BYTES).toBe(16 * 1024 * 1024)
    expect(CLOUD_LSP_ROOT_URI).toBe("file:///home/developer/workspace")
  })

  test("a fragment is exactly { seq ≥ 1, last, data }; a session row is an lsp session with its language", () => {
    expect(CloudLspFragmentSchema.parse({ seq: 1, last: false, data: "{" })).toEqual({ seq: 1, last: false, data: "{" })
    expect(CloudLspFragmentSchema.safeParse({ seq: 0, last: true, data: "" }).success).toBe(false)
    expect(CloudLspFragmentSchema.safeParse({ seq: 1, last: true, data: "", extra: 1 }).success).toBe(false)
    expect(
      CloudLspSessionSchema.parse({
        id: "s1",
        workspace_id: "ws-1",
        status: "running",
        kind: "lsp",
        language: "typescript",
        idle_timeout_secs: 600
      })
    )
      .toEqual({ id: "s1", status: "running", kind: "lsp", language: "typescript" })
    expect(CloudLspSessionSchema.safeParse({ id: "s1", status: "running", kind: "terminal" }).success).toBe(false)
  })

  test("a refusal's Retry-After rides the close reason in words and reads back as seconds", () => {
    expect(CLOUD_WS_PENDING_CLOSE_CODE).toBe(4425)
    expect(CLOUD_WS_NOT_READY_CLOSE_CODE).toBe(4503)
    const reason = withRetryAfter("workspace_session_pending: session pending", 2)
    expect(reason).toBe("workspace_session_pending: session pending (retry after 2 s)")
    expect(retryAfterOf(reason)).toBe(2)
    expect(retryAfterOf("access revoked: token expired")).toBeNull()
    expect(retryAfterOf("guest_not_ready: activating (retry after 30 s) ")).toBe(30)
  })
})

/*
 * The cloud sign-in answers on the local origin
 * (apps/ui/docs/decisions/0001-piper-one-truth.md). The session carries no
 * token, only what a person sees. `scopes: "degraded"` is the one word for a
 * legacy token set that lacks the workspace scopes, so acts that need them
 * can say "sign in again to enable" instead of failing at the call.
 */
describe("the cloud sign-in wire model", () => {
  test("a signed-out session is three nulls and no scope verdict", () => {
    const signedOut = { state: "signed-out" as const, username: null, expiresAt: null }
    const parsed = CloudSessionSchema.parse(signedOut)
    expect(parsed).toEqual(signedOut)
    expect(parsed.scopes).toBeUndefined()
  })

  test("a signed-in session names the person and its expiry, and says when the token set is degraded", () => {
    const signedIn = {
      state: "signed-in" as const,
      username: "williamcory",
      expiresAt: "2026-10-01T00:00:00.000Z",
      scopes: "degraded" as const
    }
    expect(CloudSessionSchema.parse(signedIn)).toEqual(signedIn)
    // "degraded" is the only verdict the wire carries; full scopes are said by leaving it out.
    expect(CloudSessionSchema.safeParse({ ...signedIn, scopes: "full" }).success).toBe(false)
    expect(CloudSessionSchema.safeParse({ ...signedIn, state: "expired" }).success).toBe(false)
    const { username: _username, ...withoutUsername } = signedIn
    expect(CloudSessionSchema.safeParse(withoutUsername).success).toBe(false)
    // A bearer never reaches the renderer, so it is stripped rather than carried through.
    expect(CloudSessionSchema.parse({ ...signedIn, token: "secret" })).toEqual(signedIn)
  })

  test("starting a browser login answers with the url to open", () => {
    expect(CloudAuthStartResponseSchema.parse({ url: "https://jjhub.tech/login?x=1" }).url)
      .toBe("https://jjhub.tech/login?x=1")
    expect(CloudAuthStartResponseSchema.safeParse({}).success).toBe(false)
  })
})
