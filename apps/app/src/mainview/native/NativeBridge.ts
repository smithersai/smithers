import { Electroview } from "electrobun/view"
import type { PickLocalRepositoryResult, RepositoryAccess } from "@smthrs/rpc/NativeRepository"
import type { SmithersNativeRPC } from "@smthrs/rpc/NativeRPC"

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

/*
 * The folder picker retired with the local backend
 * (apps/app/docs/LOCAL-BACKEND-RETIREMENT.md): no host opens a repository on
 * the reader's disk, so every caller gets the refusal the web always got.
 */
export const nativeRepositories: NativeRepositories = {
  available: false,
  pickLocalRepository: async () => ({
    status: "error",
    code: "native-required",
    message: "Repositories are opened as Smithers Cloud workspaces, not from this machine."
  })
}
