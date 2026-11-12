/**
 * Reproduces a SQL fixture's injection in a Node child with no host authority.
 *
 * A corpus fixture is contributor-controlled code, and the live security
 * evaluation runs with provider credentials in its environment. Importing the
 * fixture there would let its top-level code read those credentials, host
 * files, or the network before the review starts. This module imports it only
 * in a child Node process under the permission model: an empty environment,
 * read access to the fixture file alone, and no network, child process,
 * worker, addon, FFI, or WASI authority. The child returns only the row count.
 *
 * @since 1.0.0
 */
import { execFileSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * The synthetic receipt of one reproduction: how many private rows the
 * injected input returned.
 *
 * @since 1.0.0
 * @category models
 */
export type Reproduction = { readonly observedRows: number }

/** The child entry: import the fixture, call its helper against synthetic rows, print the receipt. */
async function child(file: string, helper: string): Promise<void> {
  const db = new DatabaseSync(":memory:")
  db.exec(
    "CREATE TABLE users(id TEXT, email TEXT); INSERT INTO users VALUES ('private','secret');" +
      "CREATE TABLE articles(id TEXT, title TEXT); INSERT INTO articles VALUES ('private','secret');"
  )
  const module = await import(pathToFileURL(file).href)
  const query = async (sql: string, params: Array<string> = []) => db.prepare(sql).all(...params)
  const result = await module[helper]({ query }, "' OR 1=1 --")
  const receipt: Reproduction = { observedRows: Array.isArray(result) ? result.length : result === null ? 0 : 1 }
  process.stdout.write(`\n${JSON.stringify(receipt)}\n`)
}

/**
 * Calls `helper` exported by the fixture module `file` with an injection
 * payload, inside a child `node` that holds no host authority, and returns
 * the receipt. Throws when the child fails, including when the fixture
 * reaches for an authority the child does not hold.
 *
 * @since 1.0.0
 * @category reproduction
 */
export function reproduce(file: string, helper: string, node: string = process.execPath): Reproduction {
  const entry = fileURLToPath(import.meta.url)
  const stdout = execFileSync(
    node,
    ["--permission", `--allow-fs-read=${entry}`, `--allow-fs-read=${file}`, entry, file, helper],
    { env: {}, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }
  )
  const observedRows: unknown = JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "").observedRows
  if (!Number.isSafeInteger(observedRows)) throw new Error("reproduction returned no receipt")
  return { observedRows: observedRows as number }
}

if (import.meta.main) await child(process.argv[2]!, process.argv[3]!)
