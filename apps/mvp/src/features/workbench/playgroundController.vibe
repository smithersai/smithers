import {
  PLAYGROUND_PROTOCOL,
  decodePlaygroundRequest,
  isTrustedPlaygroundEvent,
  playgroundErrorResponse,
  playgroundOkResponse,
  type PlaygroundMessageEventLike,
  type PlaygroundPreset,
  type PlaygroundRequest,
} from "./playgroundBridge.ts"

export interface PlaygroundEventWithData extends PlaygroundMessageEventLike {
  readonly data: unknown
}

export interface PlaygroundDryRunReceipt {
  readonly flow: string
  readonly mode: "dry-run"
  readonly summary: string
  readonly sourceChars: number
  readonly lineCount: number
  readonly checks: ReadonlyArray<string>
}

export function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function serializeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}

export function defaultSnippetForPreset(preset: PlaygroundPreset): string {
  switch (preset.id) {
    case "tevm-evm":
    case "tevm-effect":
      return "call 0x0000000000000000000000000000000000000001 data=0x6001600055"
    case "zevm-evm":
      return "bytecode 0x6001600201 gasLimit=100000"
    case "vibelang-compiler":
      return "export const check = Effect.succeed(\"ok\")"
    default:
      return "flow dry-run fixture=smoke"
  }
}

/**
 * Deterministic credential-free local dry-run executor for allowlisted playground flows.
 */
export function runPlaygroundDryRun(request: PlaygroundRequest): PlaygroundDryRunReceipt {
  const source = typeof request.input["source"] === "string" ? request.input["source"] : ""
  const trimmed = source.trim()
  const lineCount = trimmed.length === 0 ? 0 : trimmed.split(/\r?\n/).length
  switch (request.flow) {
    case "playground/tevm-call":
    case "playground/tevm-trace":
      return {
        flow: request.flow,
        mode: "dry-run",
        summary: "Deterministic EVM call fixture verified with zero host secrets.",
        sourceChars: trimmed.length,
        lineCount,
        checks: ["opaque-origin", "allowlisted-flow", "zero-secrets"],
      }
    case "playground/zevm-trace":
      return {
        flow: request.flow,
        mode: "dry-run",
        summary: "Zig EVM gas trace fixture verified inside bounded sandbox.",
        sourceChars: trimmed.length,
        lineCount,
        checks: ["opaque-origin", "bounded-gas", "zero-secrets"],
      }
    case "playground/vibe-check":
      return {
        flow: request.flow,
        mode: "dry-run",
        summary: "VibeLang syntax fixture checked cleanly.",
        sourceChars: trimmed.length,
        lineCount,
        checks: ["opaque-origin", "typed-envelope", "zero-secrets"],
      }
    default:
      return {
        flow: request.flow,
        mode: "dry-run",
        summary: "Workflow fixture verified with zero credentials.",
        sourceChars: trimmed.length,
        lineCount,
        checks: ["opaque-origin", "allowlisted-flow", "zero-secrets"],
      }
  }
}

/**
 * Process one untrusted MessageEvent from the sandboxed playground iframe.
 * Returns a primitive JSON string response for postMessage, or null when the event
 * did not originate from the expected opaque-origin iframe.
 */
export async function handlePlaygroundBridgeEvent(
  event: PlaygroundEventWithData,
  expectedWindow: unknown,
  preset: PlaygroundPreset,
  invoke: (request: PlaygroundRequest) => unknown | Promise<unknown> = runPlaygroundDryRun,
): Promise<string | null> {
  if (!isTrustedPlaygroundEvent(event, expectedWindow)) {
    return null
  }
  const allowed = new Set(preset.allowedFlows)
  const decoded = decodePlaygroundRequest(event.data, allowed)
  if (!decoded.ok) {
    return JSON.stringify(playgroundErrorResponse(decoded.requestId, decoded.code))
  }
  try {
    const output = await invoke(decoded.request)
    return JSON.stringify(playgroundOkResponse(decoded.request.requestId, output))
  // expected: playground workflow execution failed and is returned as closed execution_failed code
  } catch {
    return JSON.stringify(playgroundErrorResponse(decoded.request.requestId, "execution_failed"))
  }
}

/**
 * Build a self-contained HTML srcDoc for a sandbox="allow-scripts" playground iframe.
 * All communication crosses the boundary strictly as primitive UTF-8 JSON strings.
 */
export function buildPlaygroundSrcDoc(preset: PlaygroundPreset): string {
  const title = escapeHtmlText(preset.title)
  const summary = escapeHtmlText(preset.summary)
  const snippet = escapeHtmlText(defaultSnippetForPreset(preset))
  const configJson = serializeScriptJson({
    protocol: PLAYGROUND_PROTOCOL,
    flows: preset.allowedFlows,
    defaultFlow: preset.defaultFlow,
  })
  const flowOptions = preset.allowedFlows
    .map((flow) => {
      const escaped = escapeHtmlText(flow)
      const selected = flow === preset.defaultFlow ? " selected" : ""
      return `<option value="${escaped}"${selected}>${escaped}</option>`
    })
    .join("")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  body { margin: 0; padding: 12px; background: #0e1116; color: #e6edf3; font-size: 13px; display: flex; flex-direction: column; gap: 10px; }
  header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
  h1 { font-size: 14px; margin: 0; font-weight: 600; }
  p { margin: 0; color: #9aa4b2; font-size: 12px; }
  .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  select, textarea, button { font: inherit; color: #e6edf3; background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; }
  button { background: #1f6feb; border-color: #388bfd; cursor: pointer; font-weight: 600; }
  textarea { width: 100%; min-height: 78px; box-sizing: border-box; resize: vertical; }
  pre { margin: 0; padding: 10px; background: #0b0f14; border: 1px solid #262c36; border-radius: 6px; overflow: auto; min-height: 54px; font-size: 12px; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${title}</h1>
      <p>${summary}</p>
    </div>
    <div class="controls">
      <select id="flow" aria-label="Playground flow">${flowOptions}</select>
      <button id="run" type="button">Run flow</button>
    </div>
  </header>
  <textarea id="source" aria-label="Playground input">${snippet}</textarea>
  <pre id="out" aria-live="polite">Ready. Choose a flow and click Run flow.</pre>
  <script>
    const cfg = ${configJson};
    let seq = 0;
    const out = document.getElementById("out");
    const flowEl = document.getElementById("flow");
    const srcEl = document.getElementById("source");
    window.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const msg = JSON.parse(event.data);
        if (!msg || msg.protocol !== cfg.protocol) return;
        out.textContent = JSON.stringify(msg, null, 2);
      } catch {
        out.textContent = "Invalid bridge reply.";
      }
    });
    document.getElementById("run").addEventListener("click", () => {
      seq += 1;
      const req = {
        protocol: cfg.protocol,
        requestId: "req_" + seq,
        kind: "workflow.invoke",
        flow: flowEl.value || cfg.defaultFlow,
        input: { source: srcEl.value }
      };
      out.textContent = "Running " + req.flow + "...";
      window.parent.postMessage(JSON.stringify(req), "*");
    });
  </script>
</body>
</html>`
}
