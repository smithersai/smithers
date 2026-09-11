import { randomUUID } from "node:crypto"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"

/** Replace a JSON file only after its sibling temporary file is flushed. */
export const atomicWriteJson = async (
  path: string,
  value: unknown,
  io: { readonly open: typeof open; readonly rename: typeof rename } = { open, rename }
): Promise<void> => {
  const text = JSON.stringify(value, null, 2)
  const parent = dirname(path)
  await mkdir(parent, { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await io.open(temporary, "wx", 0o600)
  try {
    try {
      await file.writeFile(text, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await io.rename(temporary, path)
    const directory = await io.open(parent, "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
