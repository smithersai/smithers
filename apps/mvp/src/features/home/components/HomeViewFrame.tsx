import { Button, PaneFrame } from "@smthrs/ui"

export type HomeViewFrameProps = {
  readonly flow: string
  readonly onOpen: (flow: string) => void
}

/**
 * Host-owned sandboxed view launcher rendered inside RepositoryHome view blocks
 * (for example live evmts/zevm and evmts/tevm EVM playgrounds).
 */
export function HomeViewFrame({ flow, onOpen }: HomeViewFrameProps) {
  return (
    <PaneFrame
      paneId={flow}
      title={flow}
      size="inline"
      origin="framed-app"
      onInspect={() => onOpen(flow)}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
        <span>Interactive repository view</span>
        <Button type="button" size="sm" variant="outline" onClick={() => onOpen(flow)}>
          Open view
        </Button>
      </div>
    </PaneFrame>
  )
}

export function isOfferedHomeFlow(
  flow: string,
  builtInOffered: (name: string) => boolean,
  repoFlows: ReadonlyArray<{ readonly name: string }>,
): boolean {
  if (builtInOffered(flow)) return true
  const normalized = flow.replace(/\./g, "/")
  return repoFlows.some(
    (entry) => entry.name === flow || entry.name === normalized || entry.name.replace(/\//g, ".") === flow,
  )
}
