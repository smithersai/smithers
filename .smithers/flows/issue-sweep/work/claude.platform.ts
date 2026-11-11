// The platform code of claude.vibe: the account's saved login on the operator's disk, which a .vibe file does not read.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * The long-lived login saved in `account`'s `oauth-token` file. Rejects for an
 * account name outside the Claude pool, a missing file, or a token with
 * whitespace; the rejection never carries the file's contents.
 */
export const readOauthToken = async (account: string, accountsDirectory?: string): Promise<string> => {
  if (!/^claude-[A-Za-z0-9_-]+$/.test(account)) throw new Error("invalid account")
  const directory = resolve(accountsDirectory ?? join(homedir(), ".smithers/accounts"), account)
  const token = (await readFile(join(directory, "oauth-token"), "utf8")).trim()
  if (!token || /\s/.test(token)) throw new Error("invalid token file")
  return token
}
