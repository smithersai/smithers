import { describe, expect, test } from "bun:test"
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalLead } from "@smthrs/rpc/RefusalCopy"
import { WORKER_FAILURES } from "@smthrs/rpc/WorkerFailureCodes"
import { jsonError, refuse } from "./routes"

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

  /*
   * The rest of this host's surface — the repo, target, pty, lsp and agent
   * routes it alone serves — still answers the local envelope, whose codes are
   * a third vocabulary with spellings that collide with plue's (`not_found`,
   * `invalid_path`, `invalid_json`). Typing those is a separate change; this
   * pins what is true today so nobody reads the local shape as classified.
   */
  test("the local envelope is still uncoded to the app's classifier, and is not pretended otherwise", async () => {
    const refusal = await classify(jsonError(404, "repo_not_found", "No open repository with id r1."))
    expect(refusal.code).toBeNull()
    expect(refusal.rawCode).toBeNull()
  })
})
