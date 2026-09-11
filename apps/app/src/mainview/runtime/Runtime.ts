import { APP_BOOTSTRAP_PATH, AppBootstrapSchema, hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { FetchLike, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import type { NativeRepositories } from "../native/NativeBridge"
import type { AgentPort } from "./AgentPort"
import { createWebAgent } from "../native/WebAgent"

export type ShellPort =
  | { readonly kind: "browser" }
  | { readonly kind: "native"; readonly openExternal: (url: string) => Promise<boolean> }

export interface AppRuntime {
  readonly bootstrap: AppBootstrap
  readonly http: FetchLike
  /*
   * Only the ports a consumer holds. Everything else the host advertises stays
   * on `bootstrap.capabilities`, read through `hasCapability` at the site that
   * cares, rather than mirrored here as a descriptor nobody reads.
   */
  readonly backend: {
    readonly agent?: AgentPort
    readonly repositories?: NativeRepositories
  }
  readonly shell: ShellPort
}

export const unavailableAgent = (): AgentPort => ({
  available: false,
  startTurn: async (): Promise<StartAgentTurnResult> => ({
    status: "error",
    message: "No agent provider is available in this runtime."
  }),
  cancelTurn: async () => {},
  subscribe: () => () => {}
})

export const unavailableRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Local repository selection is unavailable in this runtime."
  })
}

export const loadBootstrap = async (http: FetchLike): Promise<AppBootstrap> => {
  const response = await http(APP_BOOTSTRAP_PATH, { headers: { accept: "application/json" } })
  if (!response.ok) throw new Error(`Runtime bootstrap failed with HTTP ${response.status}.`)
  const parsed = AppBootstrapSchema.safeParse(await response.json().catch(() => undefined))
  if (!parsed.success) throw new Error(`Runtime bootstrap broke its contract: ${parsed.error.message}`)
  return parsed.data
}

export const createRuntime = (options: {
  readonly bootstrap: AppBootstrap
  readonly http: FetchLike
  readonly nativeRepositories?: NativeRepositories
  readonly nativeOpenExternal?: (url: string) => Promise<boolean>
}): AppRuntime => {
  const { bootstrap, http } = options
  const native = options.nativeOpenExternal === undefined
    ? ({ kind: "browser" } as const)
    : ({ kind: "native", openExternal: options.nativeOpenExternal } as const)
  return {
    bootstrap,
    http,
    backend: {
      ...(hasCapability(bootstrap, "agent") ? { agent: createWebAgent({ fetchImpl: http }) } : {}),
      ...(bootstrap.host === "local" && bootstrap.sandbox !== null
        ? { repositories: options.nativeRepositories ?? unavailableRepositories }
        : {})
    },
    shell: native
  }
}
