/**
 * HTTP contracts for the Linear OAuth handoff on the local origin.
 *
 * @since 1.0.0
 */
import { z } from "zod"

/*
 * Lane sync (ADR 0005): the Linear OAuth handoff on the local origin. The
 * backend's OAuth callback cannot redirect to the app (its redirect URI is
 * fixed at the API host), so the local origin runs the receiver the settled
 * team-pick flow needs: `start` listens on 127.0.0.1:<random> and answers
 * the OAuth start URL (through the `/api/cloud/*` proxy, so the Bun-held
 * bearer authenticates it) with `callback_port` attached — the same shape
 * the CLI login already speaks. `callback` records the `?setup=<key>` the
 * callback redirects with; `session` answers it to the renderer. The key is
 * an opaque, one-time, user-bound handle (plue#469) — never a token.
 */
/**
 * The linear auth start route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const LINEAR_AUTH_START_PATH = "/api/linear-auth/start"
/**
 * The linear auth session route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const LINEAR_AUTH_SESSION_PATH = "/api/linear-auth/session"
/**
 * Validates linear auth session values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LinearAuthSessionSchema = z.object({
  state: z.enum(["idle", "waiting", "authorized"]),
  /** Present only in the authorized state. */
  setupKey: z.string().optional()
})
/**
 * The decoded value accepted by {@link LinearAuthSessionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LinearAuthSession = z.infer<typeof LinearAuthSessionSchema>
/** `POST /api/linear-auth/start`
 * @since 1.0.0
 * @category schemas
 */
export const LinearAuthStartResponseSchema = z.object({ url: z.string() })
/**
 * The decoded value accepted by {@link LinearAuthStartResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LinearAuthStartResponse = z.infer<typeof LinearAuthStartResponseSchema>
