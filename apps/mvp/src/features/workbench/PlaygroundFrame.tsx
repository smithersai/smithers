import { Badge } from "@smthrs/ui"
import {
  PLAYGROUND_IFRAME_SANDBOX,
  type PlaygroundPreset,
  type PlaygroundRequest,
} from "./playgroundBridge.ts"
import {
  buildPlaygroundSrcDoc,
  handlePlaygroundBridgeEvent,
  runPlaygroundDryRun,
} from "./playgroundController.vibe"

export type PlaygroundFrameProps = {
  readonly preset: PlaygroundPreset
  readonly onInvoke?: (request: PlaygroundRequest) => unknown | Promise<unknown>
}

/**
 * Sandboxed iframe host for interactive repository playgrounds.
 * Runs strictly with sandbox="allow-scripts" (opaque null origin) and validates every
 * postMessage through the narrow primitive-string workflow bridge. Zero React state hooks.
 */
export function PlaygroundFrame({ preset, onInvoke = runPlaygroundDryRun }: PlaygroundFrameProps) {
  const attachBridge = (iframe: HTMLIFrameElement | null) => {
    if (iframe === null || typeof window === "undefined") return
    const onMessage = (event: MessageEvent) => {
      const targetWindow = iframe.contentWindow
      void handlePlaygroundBridgeEvent(
        { source: event.source, origin: event.origin, data: event.data },
        targetWindow,
        preset,
        onInvoke,
      ).then((reply) => {
        if (reply !== null && targetWindow !== null) {
          targetWindow.postMessage(reply, "*")
        }
      })
    }
    window.addEventListener("message", onMessage)
    return () => {
      window.removeEventListener("message", onMessage)
    }
  }

  return (
    <div
      data-slot="workbench-playground"
      data-preset={preset.id}
      style={{ display: "flex", flexDirection: "column", gap: "10px" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <strong style={{ fontSize: "13px" }}>{preset.title}</strong>
          <span style={{ fontSize: "12px", opacity: 0.8 }}>{preset.summary}</span>
        </div>
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          <Badge variant="outline">Isolated sandbox</Badge>
          {preset.allowedFlows.map((flow) => (
            <Badge key={flow} variant="secondary">
              {flow}
            </Badge>
          ))}
        </div>
      </div>

      <iframe
        ref={attachBridge}
        title={preset.title}
        sandbox={PLAYGROUND_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={buildPlaygroundSrcDoc(preset)}
        style={{
          width: "100%",
          minHeight: "320px",
          border: "1px solid var(--border, #2b313a)",
          borderRadius: "8px",
          background: "#0e1116",
        }}
      />
    </div>
  )
}
