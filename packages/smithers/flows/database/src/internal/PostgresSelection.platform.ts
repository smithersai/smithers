// The platform code of PostgresSelection.vibe, which a .vibe file does not import as a value (EK4402).

import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"
import { forStore } from "../TestSchemas.ts"
import { UnsupportedDatabase } from "./UnsupportedDatabase.vibe"

/** Recognizes PostgreSQL connection strings.
 * @since 1.0.0
 * @private
 */
export const isUrl = (value: string): boolean => /^postgres(?:ql)?:\/\//.test(value)
/** SQLite keeps memory and URI opens; an environment never redirects them to a
 * persistent shared schema.
 * @since 1.0.0
 * @private
 */
const sqliteOwned = (filename: string): boolean =>
  filename === "" || filename === ":memory:" || filename.startsWith("file:")
/** Where a filename's store lives on PostgreSQL: the connection URL (without
 * its `schema` parameter) and the schema the store's tables are in, or
 * `undefined` for a store SQLite keeps.
 * Explicit URLs select one schema; environment selection preserves each local store's identity.
 * Only Smithers' own settings select PostgreSQL: `SMITHERS_POSTGRES_URL`, or the generic
 * `DATABASE_URL` when `SMITHERS_BACKEND=postgres` asks for it.
 * @since 1.0.0
 * @private
 */
export const location = (filename: string): { readonly url: string; readonly schema: string } | undefined => {
  const explicit = isUrl(filename)
  const backend = process.env.SMITHERS_BACKEND
  if (!explicit && (backend === "sqlite" || sqliteOwned(filename))) return undefined
  const url = explicit ? filename : process.env.SMITHERS_POSTGRES_URL?.trim() ||
    (backend === "postgres" ? process.env.DATABASE_URL?.trim() : undefined)
  if (!url && backend === "postgres") {
    throw new UnsupportedDatabase({
      code: "postgres_url_missing",
      message: "PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL"
    })
  }
  if (!url) return undefined
  if (!isUrl(url)) {
    throw new UnsupportedDatabase({
      code: "postgres_url_invalid",
      message: "PostgreSQL configuration requires a postgres:// or postgresql:// URL"
    })
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsupportedDatabase({ code: "postgres_url_invalid", message: "Invalid PostgreSQL connection URL" })
  }
  const schema = explicit ?
    parsed.searchParams.get("schema") ?? "smithers_flows"
    : process.env.SMITHERS_POSTGRES_SCHEMA
    ? forStore(process.env.SMITHERS_POSTGRES_SCHEMA, basename(filename).replaceAll(/[^a-zA-Z0-9_]/g, "_"))
    : `smithers_${createHash("sha256").update(resolve(filename)).digest("hex").slice(0, 32)}`
  parsed.searchParams.delete("schema")
  return { url: parsed.toString(), schema }
}
