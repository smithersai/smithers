import { describe, expect, test } from "bun:test"
import { NATIVE_FAILURES } from "@smthrs/rpc/NativeFailureCodes"
import { faultOfStatus, refusalCode, refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"
import { WORKER_FAILURES } from "@smthrs/rpc/WorkerFailureCodes"
import { jsonError, jsonErrorWithStatus, refuse } from "./routes"

/*
 * This host and the Cloudflare Worker serve the same `/api/cloud/*` path to
 * the same product code, and the app classifies both answers with ONE
 * classifier. That classifier reads `code` at the top level; this host's own
 * envelope nests it under `error`. So every refusal it wrote on that route
 * used to arrive with no code and its fault read off the status — "the cloud
 * seam is disabled in this build" classified as `fault: bug`, which says
 * Smithers is broken rather than that this build does not carry the seam.
 */
describe("the native host on the routes the Worker also serves", () => {
  const classify = async (response: Response) => {
    const body: unknown = await response.json()
    const message = (body as { message?: string }).message ?? ""
    return refusalOf({ body, status: response.status, message })
  }

  test("answers in the Worker's shape, at the status the shared registry names", async () => {
    const response = refuse("feature_unavailable_here", "The cloud seam is disabled in this build.")
    expect(response.status).toBe(WORKER_FAILURES.feature_unavailable_here.status)
    const refusal = await classify(response)
    expect(refusal.code).toBe("feature_unavailable_here")
    expect(refusal.fault).toBe("user")
    expect(refusal.message).toBe("The cloud seam is disabled in this build.")
    expect(refusalLead(refusal)).toBe("This build of Smithers doesn't do that.")
  })

  /*
   * A desktop build runs no Worker at all. Saying `worker` named a machine
   * that was not running, and the Worker's own copy for a missing seam says
   * "this deployment" — wrong for a program on the reader's laptop.
   */
  test("says it was the local host, not the Worker, because the code alone cannot tell them apart", async () => {
    const refusal = await classify(refuse("seam_not_configured", "The cloud seam is disabled in this build."))
    expect(refusal.origin).toBe("local")
    const lead = refusalLead(refusal)
    expect(lead).toContain("This build")
    expect(lead).not.toContain("deployment")
    expect(lead).not.toContain("@fucory")
  })

  test("an unreachable cloud upstream is a dependency, not a bug this host committed", async () => {
    const refusal = await classify(refuse("upstream_unreachable", "cloud upstream unreachable"))
    expect(refusal.code).toBe("upstream_unreachable")
    expect(refusal.fault).toBe("dependency")
  })

})

/*
 * The rest of this host's surface — the repository, target, terminal,
 * code-intel and agent routes it alone serves — is the THIRD vocabulary. Its
 * refusals used to reach the app with `code: null` and a fault read off the
 * status, because the local envelope nests the code under `error` and its
 * spellings collide with plue's. They are typed now
 * (@smthrs/rpc/NativeFailureCodes): the route name stays where its clients
 * read it, and the same refusal is classified beside it under this host's
 * `native_` namespace.
 */
describe("the native host on the routes only it serves", () => {
  const classify = async (response: Response) => {
    const body: unknown = await response.json()
    const message = (body as { message?: string }).message ?? ""
    return refusalOf({ body, status: response.status, message })
  }

  test("classifies in the host's own namespace, with the registry's fault and origin=local", async () => {
    const response = jsonError("repo_not_found", "No open repository with id r1.")
    expect(response.status).toBe(NATIVE_FAILURES.repo_not_found.status)
    const refusal = await classify(response)
    expect(refusal.code).toBe("native_repo_not_found")
    expect(refusal.rawCode).toBe("native_repo_not_found")
    expect(refusal.fault).toBe("user")
    expect(refusal.origin).toBe("local")
    expect(refusal.message).toBe("No open repository with id r1.")
  })

  test("keeps the route's own name where this host's clients already read it", async () => {
    const body = (await jsonError("language_server_missing", "No TypeScript language server on this machine.", {
      install: "npm i -g typescript-language-server"
    }).json()) as { error: { code: string; message: string; install?: string } }
    // LspClient matches this spelling, and the card prints the install line.
    expect(body.error.code).toBe("language_server_missing")
    expect(body.error.install).toBe("npm i -g typescript-language-server")
    expect(body.error.message).toBe("No TypeScript language server on this machine.")
  })

  /*
   * The refusal that named the bug: `503 node_missing` is a laptop with no
   * Node on it. Uncoded, the classifier read `infra` off the 503 and the copy
   * told the reader Smithers had run out of infra and to ask for more of it.
   */
  test("never tells a reader that a box of their own ran out of Smithers' infra", async () => {
    const refusal = await classify(jsonError("node_missing", "No Node.js >= 26.4 was found for the smithers-build CLI."))
    expect(faultOfStatus(503)).toBe("infra")
    expect(refusal.fault).toBe("dependency")
    expect(refusalLead(refusal)).not.toContain("@fucory")
    expect(refusalLead(refusal)).not.toContain("ran out")
  })

  test("a status a route did not choose is still the code's own: the language server's failure says which", async () => {
    // LspSession answers 503 for an acquisition cancelled by a closing
    // repository and 502 for a server that exited; the code is the same.
    const cancelled = jsonErrorWithStatus(503, "language_server_failed", "Language server acquisition cancelled.")
    expect(cancelled.status).toBe(503)
    const refusal = await classify(cancelled)
    expect(refusal.code).toBe("native_language_server_failed")
    expect(refusal.status).toBe(503)
    expect(refusal.fault).toBe("dependency")
  })

  test("the host's codes stay out of plue's namespace, so one string still names its author", () => {
    // Eight route names are spelled by plue and one by the Worker; the bare
    // spelling on the wire is still theirs, never this host's.
    expect(refusalCode("not_found")).toBe("not_found")
    expect(refusalOf({ body: { code: "not_found" }, status: 404, message: "x" }).origin).toBe("plue")
    expect(refusalCode("native_not_found")).toBe("native_not_found")
  })
})
