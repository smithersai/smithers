/**
 * One wire protocol, two implementations, one gate.
 *
 * `infra/worker/protocol.ts` and `terraform/modules/cache/service/protocol.js`
 * serve the same routes to the same clients, and README.md calls that protocol
 * shared. Nothing enforced it: each suite pinned its own behavior, so the two
 * drifted on the credential model, on a storage outcome, and on whether a
 * declared artifact reference is validated, and every suite stayed green
 * through all three.
 *
 * These assertions compare the two sources against each other. They cannot
 * prove the handlers behave identically — the black-box conformance corpus in
 * terraform/modules/cache/service/test/conformance_test.js runs the same
 * requests through both handlers and does — but they do fail the moment one
 * side changes a bound or drops a shared refusal the other still has.
 */
import * as Fs from "node:fs"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"

const packageRoot = NodePath.join(import.meta.dirname, "..")

const worker = Fs.readFileSync(NodePath.join(packageRoot, "infra/worker/protocol.ts"), "utf8")
const service = Fs.readFileSync(
  NodePath.join(packageRoot, "terraform/modules/cache/service/protocol.js"),
  "utf8"
)

const implementations = [["worker", worker], ["service", service]] as const

/** Every `export const name = <numeric expression>` in one source. */
const numericConstants = (source: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>()
  for (const match of source.matchAll(/^export const ([A-Za-z][A-Za-z0-9]*) = ([0-9][0-9_ *]*)$/gm)) {
    found.set(match[1]!, match[2]!.trim())
  }
  return found
}

describe("hosted and self-hosted cache protocols", () => {
  it("declares the same value for every bound both implementations name", () => {
    const hosted = numericConstants(worker)
    const selfHosted = numericConstants(service)
    const shared = [...hosted.keys()].filter((name) => selfHosted.has(name))
    // A parse that found nothing would pass this test silently.
    expect(shared.length).toBeGreaterThanOrEqual(14)
    for (const name of shared) {
      expect(selfHosted.get(name), `${name} differs between the two protocol implementations`).toBe(
        hosted.get(name)
      )
    }
  })

  it("keeps both tiers on one credential model", () => {
    for (const [label, source] of implementations) {
      expect(source, `${label} does not classify by credential`).toContain("presentedCredential")
      // The Worker classifies into `{ kind, digest }` for credential budgets and
      // the service into a bare string; the refusal is the same on both.
      expect(source, `${label} admits a read credential to a mutation`).toMatch(
        /\(request\.method === "PUT" \|\| request\.method === "DELETE"\) && credential(?:\.kind)? !== "write"/
      )
      expect(source, `${label} accepts one secret for both directions`).toContain(
        "readTokenHash and writeTokenHash must differ, or the read credential can publish"
      )
    }
  })

  it("validates a publication's declared artifact references on both tiers", () => {
    // The self-hosted tier refcounts these digests and the hosted tier only
    // stores them, but a client publishing one malformed reference must get
    // the same answer from either.
    for (const [label, source] of implementations) {
      expect(source, `${label} does not validate declared references`).toMatch(
        /referencedDigests|assertDeclaredOutputsValid/
      )
      expect(source, `${label} accepts an invalid declared output digest`).toContain(
        "declared output digest is invalid"
      )
      expect(source, `${label} accepts an unbounded reference list`).toContain(
        "publication references too many artifacts"
      )
    }
  })

  it("refuses a ranged artifact upload with one shared answer", () => {
    // `RemoteArtifacts.Options.chunkBytes` falls back to one whole-blob `PUT`
    // when a ranged `PUT /cas` is answered `400`, RFC 9110 section 14.5's
    // status for a resource that does not support partial PUT. The client's
    // degradation depends on that refusal, so it may not drift from either
    // tier.
    for (const [label, source] of implementations) {
      expect(source, `${label} accepts a ranged artifact upload`).toContain(
        "content-range is not supported; send the whole blob in one request"
      )
    }
  })

  it("holds an admission permit through every response body a client paces", () => {
    for (const [label, source] of implementations) {
      expect(source, `${label} has no streaming permit holder`).toContain("heldWhileStreaming")
      // Two call sites: the action-cache hit and the artifact download. A
      // handler that releases on return bounds the store lookup, not the
      // transfer, so the cap it advertises binds nothing.
      expect([...source.matchAll(/heldWhileStreaming\(response,/g)], `${label} holds one body kind`)
        .toHaveLength(2)
    }
  })
})
