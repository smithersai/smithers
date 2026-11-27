import { describe, expect, test } from "vitest"
import { validateClientName } from "../mcp/OAuth.vibe"
import { safeJsonStringify, sanitizeServeContentType, sha256BytesAsync } from "../object-store/ObjectBytes.ts"
import { authorizeObjectWrite, resolveObjectVisibility, safeLoginSegment } from "./ExecutionTrust.vibe"
import { extractPostMergeFlowIds } from "../ci/PostMerge.vibe"
import type { Actor } from "../Actor.vibe"

const POLICY = { admins: new Set(["roninjin10"]) }
const GUEST: Actor = { subject: { kind: "person", id: "11111111-1111-4111-8111-111111111111" }, role: "guest", login: "eve" }
const LOGINLESS: Actor = { subject: { kind: "person", id: "22222222-2222-4222-8222-222222222222" }, role: "guest" }

describe("Security audit regression suite (P0-1 .. P1-6)", () => {
  test("[P0-1] OAuth DCR rejects reserved sandbox:/agent:/ci: client_name prefixes", () => {
    expect(validateClientName("sandbox:trusted_sandbox")).toBeNull()
    expect(validateClientName("SANDBOX:foo")).toBeNull()
    expect(validateClientName("agent:trusted_maintainer")).toBeNull()
    expect(validateClientName("ci:runner")).toBeNull()
    expect(validateClientName("Claude Desktop")).toBe("Claude Desktop")
  })

  test("[P0-2] ObjectBytes downgrades scriptable MIME types (HTML/SVG/JS) to attachment octet-stream and computes true SHA-256", async () => {
    expect(sanitizeServeContentType("text/html; charset=utf-8")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    })
    expect(sanitizeServeContentType("image/svg+xml")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    })
    expect(sanitizeServeContentType("application/javascript")).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    })
    expect(sanitizeServeContentType("application/json")).toEqual({
      contentType: "application/json; charset=utf-8",
      disposition: "inline",
    })
    // Standard SHA-256("hello")
    const digest = await sha256BytesAsync(new TextEncoder().encode("hello"))
    expect(digest).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")
    expect(safeJsonStringify({ a: "ok\u0000bad" })).toBe("{\"a\":\"okbad\"}")
  })

  test("[P0-3] Untrusted artifact/changeset writes are login-isolated and cannot request public visibility", () => {
    const art = authorizeObjectWrite({
      repoFullName: "smithersai/smithers",
      namespace: "artifact",
      key: "release.tar.gz",
      trust: "untrusted_contributor",
      actor: GUEST,
      login: "eve",
      policy: POLICY,
    })
    expect(art.ok).toBe(true)
    if (art.ok) {
      expect(art.canonicalKey).toBe("untrusted/eve/release.tar.gz")
      expect(art.gateEligible).toBe(false)
    }

    const vis = resolveObjectVisibility({
      repoFullName: "smithersai/smithers",
      isPublicRepo: true,
      namespace: "artifact",
      requested: "public",
      trust: "untrusted_contributor",
      policy: POLICY,
    })
    expect(vis).toBe("repo_members")
  })

  test("[P1-4] PostMerge does not match github.push:main when repository defaultBranch is trunk", () => {
    const manifest = {
      on: {
        "github.push:main": { flow: "release" },
        "github.push:trunk": { flow: "docs-publish" },
      },
    }
    expect(extractPostMergeFlowIds(manifest, "trunk")).toEqual(["docs-publish"])
    expect(extractPostMergeFlowIds(manifest, "main")).toEqual(["release"])
  })

  test("[P2-6] Login-less actors isolate under subject id instead of colliding under anonymous", () => {
    const seg = safeLoginSegment(undefined, LOGINLESS.subject.id)
    expect(seg.startsWith("id-22222222")).toBe(true)
  })
})
