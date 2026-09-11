import type { PickLocalRepositoryResult, RepositoryAccess } from "@smthrs/rpc/NativeRepository"

/*
 * The native folder picker is a modal dialog: it returns when the human
 * chooses or cancels, which is seconds to minutes later. The Electrobun RPC
 * layer (.hutch/devkit/api/shared/rpc.ts) rejects any request older than
 * DEFAULT_MAX_REQUEST_TIME = 1000 ms with "RPC request timed out.", so a
 * picker call made without an override died before the dialog could be
 * answered and the app reported "the picker stopped responding". The only
 * honest deadline for a human's dialog is none.
 */
export const PICKER_REQUEST_OPTIONS = { maxRequestTime: Number.POSITIVE_INFINITY } as const

export type PickerRequest = (
  params: { readonly access: RepositoryAccess },
  options?: { readonly maxRequestTime?: number }
) => Promise<PickLocalRepositoryResult>

/** The picker request with the no-deadline option every call must carry. */
export const pickLocalRepositoryVia = (
  request: PickerRequest,
  access: RepositoryAccess
): Promise<PickLocalRepositoryResult> => request({ access }, PICKER_REQUEST_OPTIONS)
