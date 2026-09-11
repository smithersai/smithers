import { Electroview } from "electrobun/view"
import type { PickLocalRepositoryResult, RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import type { SmithersNativeRPC } from "@smthrs/rpc/NativeRPC"
import { pickLocalRepositoryVia } from "./PickerRequest"

const rpc = (() => {
  if (typeof window === "undefined" || window.__electrobun === undefined) return undefined
  const nativeRpc = Electroview.defineRPC<SmithersNativeRPC>({
    handlers: {
      requests: {},
      messages: {}
    }
  })
  new Electroview({ rpc: nativeRpc })
  return nativeRpc
})()

/**
 * Native shell capability. Pure web has no privileged external-navigation
 * fallback; its identity port uses ordinary browser navigation instead.
 */
export const nativeShellAvailable = rpc !== undefined
export const nativeOpenExternal: (url: string) => Promise<boolean> = rpc === undefined
  ? async () => false
  : async (url) => (await rpc.proxy.request.openExternal({ url })).opened

export interface NativeRepositories {
  readonly available: boolean
  readonly pickLocalRepository: (
    access: RepositoryAccess
  ) => Promise<PickLocalRepositoryResult>
}

export const nativeRepositories: NativeRepositories = {
  available: rpc !== undefined,
  pickLocalRepository: (access) =>
    rpc === undefined
      ? Promise.resolve({
        status: "error",
        code: "native-required",
        message: "Local repositories can only be connected from the Smithers native app."
      })
      : pickLocalRepositoryVia((params, options) => rpc.proxy.request.pickLocalRepository(params, options), access)
}
