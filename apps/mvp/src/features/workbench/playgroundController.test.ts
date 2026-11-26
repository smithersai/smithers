import { describe, expect, test } from "vitest"
import { PLAYGROUND_PROTOCOL, playgroundPresetFor } from "./playgroundBridge.ts"
import {
  buildPlaygroundSrcDoc,
  defaultSnippetForPreset,
  escapeHtmlText,
  handlePlaygroundBridgeEvent,
  runPlaygroundDryRun,
  serializeScriptJson,
} from "./playgroundController.vibe"

const TEVM_PRESET = playgroundPresetFor("evmts/tevm-monorepo")!
const ZEVM_PRESET = playgroundPresetFor("evmts/zevm")!
const VIBE_PRESET = playgroundPresetFor("smithersai/vibelang")!
const SMITHERS_PRESET = playgroundPresetFor("smithersai/smithers")!

describe("playgroundController", () => {
  test("escapes HTML and script JSON safely without raw closing tags", () => {
    expect(escapeHtmlText(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;")
    const serialized = serializeScriptJson({ body: "</script>&\u2028\u2029" })
    expect(serialized).not.toContain("</script>")
    expect(serialized).toContain("\\u003c/script\\u003e\\u0026\\u2028\\u2029")
  })

  test("builds self-contained srcDoc and default snippets for all first-party presets", () => {
    for (const preset of [TEVM_PRESET, ZEVM_PRESET, VIBE_PRESET, SMITHERS_PRESET]) {
      expect(defaultSnippetForPreset(preset).length).toBeGreaterThan(0)
      const html = buildPlaygroundSrcDoc(preset)
      expect(html).toContain(preset.title)
      expect(html).toContain(preset.defaultFlow)
      expect(html).toContain(PLAYGROUND_PROTOCOL)
    }
  })

  test("runs deterministic dry-run receipts for each preset flow and empty input", () => {
    expect(
      runPlaygroundDryRun({
        protocol: PLAYGROUND_PROTOCOL,
        requestId: "r1",
        kind: "workflow.invoke",
        flow: "playground/tevm-call",
        input: { source: "line1\nline2" },
      }),
    ).toMatchObject({ flow: "playground/tevm-call", mode: "dry-run", lineCount: 2 })

    expect(
      runPlaygroundDryRun({
        protocol: PLAYGROUND_PROTOCOL,
        requestId: "r2",
        kind: "workflow.invoke",
        flow: "playground/zevm-trace",
        input: { source: "bytecode 0x00" },
      }),
    ).toMatchObject({ flow: "playground/zevm-trace", lineCount: 1 })

    expect(
      runPlaygroundDryRun({
        protocol: PLAYGROUND_PROTOCOL,
        requestId: "r3",
        kind: "workflow.invoke",
        flow: "playground/vibe-check",
        input: { source: "export const a = 1" },
      }),
    ).toMatchObject({ flow: "playground/vibe-check", lineCount: 1 })

    expect(
      runPlaygroundDryRun({
        protocol: PLAYGROUND_PROTOCOL,
        requestId: "r4",
        kind: "workflow.invoke",
        flow: "playground/workflow-dry-run",
        input: {},
      }),
    ).toMatchObject({ flow: "playground/workflow-dry-run", sourceChars: 0, lineCount: 0 })
  })

  test("enforces opaque origin, allowlist, and closed error responses over the bridge", async () => {
    const fakeWin = { id: "iframe-win" }

    // Untrusted source or non-null origin is ignored silently
    expect(
      await handlePlaygroundBridgeEvent(
        { source: {}, origin: "null", data: "{}" },
        fakeWin,
        TEVM_PRESET,
      ),
    ).toBeNull()
    expect(
      await handlePlaygroundBridgeEvent(
        { source: fakeWin, origin: "https://smithers.sh", data: "{}" },
        fakeWin,
        TEVM_PRESET,
      ),
    ).toBeNull()

    // Denied flow returns closed flow_denied error JSON string
    const deniedRaw = JSON.stringify({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req_bad",
      kind: "workflow.invoke",
      flow: "branch/merge",
      input: {},
    })
    const deniedReply = await handlePlaygroundBridgeEvent(
      { source: fakeWin, origin: "null", data: deniedRaw },
      fakeWin,
      TEVM_PRESET,
    )
    expect(JSON.parse(deniedReply!)).toEqual({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req_bad",
      ok: false,
      code: "flow_denied",
    })

    // Valid allowlisted flow executes default dry-run
    const okRaw = JSON.stringify({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req_ok",
      kind: "workflow.invoke",
      flow: "playground/tevm-call",
      input: { source: "call 0x01" },
    })
    const okReply = await handlePlaygroundBridgeEvent(
      { source: fakeWin, origin: "null", data: okRaw },
      fakeWin,
      TEVM_PRESET,
    )
    expect(JSON.parse(okReply!)).toMatchObject({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req_ok",
      ok: true,
      output: { flow: "playground/tevm-call", mode: "dry-run" },
    })

    // Throwing executor maps to closed execution_failed code (never raw error text)
    const failedReply = await handlePlaygroundBridgeEvent(
      { source: fakeWin, origin: "null", data: okRaw },
      fakeWin,
      TEVM_PRESET,
      () => {
        throw new Error("internal stack trace secret")
      },
    )
    expect(JSON.parse(failedReply!)).toEqual({
      protocol: PLAYGROUND_PROTOCOL,
      requestId: "req_ok",
      ok: false,
      code: "execution_failed",
    })
    expect(failedReply).not.toContain("secret")
  })
})
