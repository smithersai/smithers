/**
 * What `routes.ui.gen.ts` gives the browser, handed down from the entry point.
 *
 * The generated module imports every page, so a page that imported it back
 * would close an initialization cycle. main.tsx reads it once (its body runs
 * after the generated module is fully evaluated) and provides it here.
 *
 * The flow summary comes from the same generated module, never from
 * `routes.gen.ts`: that table imports every layer file and every tool module,
 * which the browser has no use for.
 */
import { createContext, useContext } from "react"
import type { PaneRegistry } from "@smthrs/create-app/ui"

/** One routed flow, flattened to what the shell needs: a `flowSummaries` row. */
export interface RoutedFlowSummary {
  readonly id: string
  readonly file: string
  /** True when the flow keeps the conversation across turns. */
  readonly chat: boolean
}

export interface AppRegistry {
  readonly panes: PaneRegistry
  readonly flows: ReadonlyArray<RoutedFlowSummary>
}

export const emptyRegistry: AppRegistry = { panes: {}, flows: [] }

export const RegistryContext = createContext<AppRegistry>(emptyRegistry)

export const useRegistry = (): AppRegistry => useContext(RegistryContext)

export const usePaneRegistry = (): PaneRegistry => useRegistry().panes

/**
 * The flow a turn goes to. `chat` when a chat flow is routed under that name,
 * otherwise the first chat flow, otherwise the literal "chat" so the request
 * still names the contract's default.
 */
export const chatFlowId = (flows: ReadonlyArray<RoutedFlowSummary>): string =>
  flows.find((flow) => flow.id === "chat")?.id ?? flows.find((flow) => flow.chat)?.id ?? "chat"

/** The pipeline flow that turns an idea into a plan; "build" when routed. */
export const planFlowId = (flows: ReadonlyArray<RoutedFlowSummary>): string =>
  flows.find((flow) => flow.id === "build")?.id ?? chatFlowId(flows)
