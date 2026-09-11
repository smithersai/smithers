/*
 * The code-intel routes (LOCAL-APP.md "HTTP and WebSocket surface", code-intel
 * PLAN.md §3): `POST /api/lsp/{hover,definition,diagnostics}` and
 * `GET /api/lsp/servers`. The renderer names a repoId, a relative path and a
 * 1-based position; the host owns the binary, its argv and its cwd, and
 * finds the binary on the host, never inside the repository, so read access
 * suffices: a language server reads. Refusals use the
 * `{ error: { code, message } }` envelope; `409 language_server_missing`
 * carries the install line verbatim in `install` and nothing installs it.
 * Diagnostics also ride `/ws` on `lsp:<repoId>` (the host publishes them).
 */
import {
  LSP_DEFINITION_PATH,
  LSP_DIAGNOSTICS_PATH,
  LSP_HOVER_PATH,
  LSP_LANGUAGE_SERVER_MISSING,
  LSP_REQUEST_BODY_CAP_BYTES,
  LSP_REQUEST_TIMEOUT_MS,
  LSP_SERVERS_PATH,
  LspFileRequestSchema,
  LspPositionRequestSchema
} from "@smthrs/rpc/LocalApp"
import type { LspDefinitionResponse, LspDiagnosticsResponse, LspErrorResponse, LspHoverResponse, LspServersResponse } from "@smthrs/rpc/LocalApp"
import { extname } from "node:path"
import type { z } from "zod"
import { serverFor } from "../lsp/LanguageServers"
import type { LspHost } from "../lsp/LspHost"
import { LspRequestError } from "../lsp/LspSession"
import type { LspSession } from "../lsp/LspSession"
import { json, jsonError } from "../routes"
import type { Router } from "../routes"
import type { PtyRepositoryResolver } from "./pty"

export interface LspRouteHost {
  readonly router: Router
}

/** `resolveRepo` here is the read-access resolver (`repoTargets.resolveRepo(id, "read")`). */
export type LspRepositoryResolver = PtyRepositoryResolver

const bodyTooLarge = (): Response => jsonError(413, "body_too_large", `Code-intel requests are capped at ${LSP_REQUEST_BODY_CAP_BYTES} bytes.`)

/** The JSON body under the cap, or the refusal to answer as-is. */
const readBounded = async (request: Request): Promise<{ readonly body: unknown } | { readonly error: Response }> => {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > LSP_REQUEST_BODY_CAP_BYTES) return { error: bodyTooLarge() }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    return { error: jsonError(415, "unsupported_media_type", "Request body must use application/json.") }
  }
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > LSP_REQUEST_BODY_CAP_BYTES) return { error: bodyTooLarge() }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    return { error: jsonError(400, "invalid_json", "Request body must be valid JSON.") }
  }
}

export const registerLspRoutes = (host: LspRouteHost, lsp: LspHost, repositories: LspRepositoryResolver): void => {
  const { router } = host

  /** Parse, resolve the repository, find or start the session, run one request; every refusal typed. */
  const withSession = async <Schema extends z.ZodType<{ repoId: string; path: string }>>(
    request: Request,
    schema: Schema,
    shape: string,
    run: (session: LspSession, body: z.infer<Schema>) => Promise<Response>
  ): Promise<Response> => {
    const parsed = await readBounded(request)
    if ("error" in parsed) return parsed.error
    const body = schema.safeParse(parsed.body)
    if (!body.success) return jsonError(400, "invalid_request", `Body must be ${shape}.`)
    const resolved = repositories.resolveRepo(body.data.repoId)
    if (resolved.status !== "ok") {
      return resolved.status === "not-found"
        ? jsonError(404, "repo_not_found", `No open repository with id ${body.data.repoId}.`)
        : jsonError(403, "repository_read_denied", "This repository was not opened with read access.")
    }
    const session = await lsp.session(body.data.repoId, resolved.path, body.data.path)
    if (session.status === "unsupported") {
      const extension = extname(body.data.path)
      return jsonError(400, "language_unsupported", `No language server handles ${extension === "" ? "this file" : `${extension} files`}.`)
    }
    if (session.status === "missing") {
      const refusal: LspErrorResponse = {
        error: {
          code: LSP_LANGUAGE_SERVER_MISSING,
          message: `No ${serverFor(session.language).displayName} language server on this machine.`,
          install: session.install
        }
      }
      return json(refusal, 409)
    }
    try {
      return await run(session.session, body.data)
    } catch (error) {
      if (error instanceof LspRequestError) return jsonError(error.http, error.code, error.message)
      throw error
    }
  }

  router.add("POST", LSP_HOVER_PATH, ({ request }) =>
    withSession(request, LspPositionRequestSchema, "{ repoId, path, line, character }", async (session, body) => {
      const answer: LspHoverResponse = await session.hover(body.path, body)
      return json(answer)
    }))

  router.add("POST", LSP_DEFINITION_PATH, ({ request }) =>
    withSession(request, LspPositionRequestSchema, "{ repoId, path, line, character }", async (session, body) => {
      const answer: LspDefinitionResponse = await session.definition(body.path, body)
      return json(answer)
    }))

  router.add("POST", LSP_DIAGNOSTICS_PATH, ({ request }) =>
    withSession(request, LspFileRequestSchema, "{ repoId, path }", async (session, body) => {
      const answer: LspDiagnosticsResponse = await session.diagnostics(body.path, LSP_REQUEST_TIMEOUT_MS)
      return json(answer)
    }))

  router.add("GET", LSP_SERVERS_PATH, () => {
    const answer: LspServersResponse = { servers: [...lsp.list()] }
    return json(answer)
  })
}
