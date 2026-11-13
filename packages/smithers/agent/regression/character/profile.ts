/** The eval runner uses the production profile composer. */
import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import * as Profile from "../../../src/internal/RoleProfile.ts"
import { suitePath } from "./suite.ts"
export { limits, turnContract, type Composed } from "../../../src/internal/RoleProfile.ts"

export interface Source {
  readonly org: string
  readonly role: string
  readonly profile: string
  readonly commonFile?: string | undefined
  /** Confines shared instructions and skill reads when composing a suite. */
  readonly suiteRoot?: string | undefined
}
export const compose = (source: Source): Profile.Composed => {
  const text = readFileSync(source.profile, "utf8")
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const meta = match === null ? {} : (parseYaml(match[1]!) ?? {}) as Record<string, unknown>
  return Profile.compose({
    ...source,
    body: Profile.splitFrontmatter(text).body,
    meta,
    read: (path) => readFileSync(
      source.suiteRoot === undefined || path === source.commonFile ? path : suitePath(source.suiteRoot, path),
      "utf8"
    )
  })
}
