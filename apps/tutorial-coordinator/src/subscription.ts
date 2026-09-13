import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import * as CodexAuth from "@smthrs/cli/CodexAuth"

/** Seed once, then let CodexAuth own the writable, persistent refresh state. */
export async function prepareSubscription(authFile: string, bootstrapFile?: string): Promise<void> {
  try {
    if (!CodexAuth.parse(await readFile(authFile, "utf8")).usable) throw new Error("The tutorial subscription session needs a new sign-in")
    return
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  if (!bootstrapFile) throw new Error("The tutorial subscription session is missing; configure its bootstrap login")
  const contents = await readFile(bootstrapFile, "utf8")
  if (!CodexAuth.parse(contents).usable) throw new Error("The tutorial bootstrap must contain a ChatGPT subscription login")
  await mkdir(dirname(authFile), { recursive: true, mode: 0o700 })
  await writeFile(authFile, contents, { flag: "wx", mode: 0o600 })
}
