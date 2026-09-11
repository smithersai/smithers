import { digest } from "@smthrs/core/Digest"
import type { StorageApi } from "@tanstack/db"

/** Keep legacy recovery keys, but never overwrite a different saved original. */
export const retainRecoveryCopy = (storage: StorageApi, key: string, raw: string): string => {
  const first = storage.getItem(key)
  const target = first === null || first === raw ? key : `${key}.${digest(raw)}`
  const existing = storage.getItem(target)
  if (existing !== null && existing !== raw) {
    throw new Error(
      "A recovery copy conflicts with the source. Existing copies were preserved; recovery cannot continue safely."
    )
  }
  if (existing === null) storage.setItem(target, raw)
  if (storage.getItem(target) !== raw) {
    throw new Error("A recovery copy did not match its source. Original data was not replaced; recover storage before retrying.")
  }
  return target
}

/** New SQLite copies bind both their source address and exact original bytes. */
export const sqliteRecoveryCopyId = (collectionId: string, rowKey: string, raw: string): string =>
  `recovery-v1:${digest(JSON.stringify([collectionId, rowKey, raw]))}`
