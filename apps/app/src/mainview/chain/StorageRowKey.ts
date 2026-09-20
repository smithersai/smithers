/** SQLite text bindings are NUL-terminated. JSON escaping keeps these keys lossless. */
export const storageRowKey = (key: string | number): string => typeof key === "number"
  ? `n:${key}`
  : key.includes("\u0000") ? `j:${JSON.stringify(key)}` : `s:${key}`

export const normalizeStorageRowKey = (key: string): string => key.startsWith("s:")
  ? storageRowKey(key.slice(2))
  : key.startsWith("n:") || key.startsWith("j:") ? key : storageRowKey(key)
