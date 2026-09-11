/*
 * The language-server registry (code-intel PLAN.md §3 "Native"): a static
 * table keyed by language. The renderer names a file; this module names the
 * binary, its argv, its install line and nothing else (LOCAL-APP.md
 * "Repository and process authority"). v1 is TypeScript through
 * `typescript-language-server --stdio`; the table is ready for more rows.
 * A missing server is stated with its install line and never installed.
 *
 * The binary comes from the HOST — the harness candidate dirs and PATH —
 * never from the repository. A repository is data the user opened, often
 * read-only, often someone else's; a `node_modules/.bin/typescript-language-
 * server` inside it is a program the repository chose, and a hover must not
 * run it. (tsserver still resolves the repository's own `typescript` from
 * inside the language server: that is the server's job, under the sandbox.)
 */
import { delimiter, extname, join } from "node:path"
import { LSP_LANGUAGE_EXTENSIONS } from "@smthrs/rpc/LocalApp"
import type { LspLanguageId } from "@smthrs/rpc/LocalApp"
import { harnessCandidateDirs } from "../Harnesses"
import type { HarnessHost } from "../Harnesses"
import type { NodeSidecar } from "../Node"

export type LanguageId = LspLanguageId

export interface ServerSpec {
  readonly id: LanguageId
  /** The word the card and the refusal use. */
  readonly displayName: string
  /** File extensions, with the dot, the server handles. */
  readonly extensions: ReadonlyArray<string>
  /** The binary name; `resolveServer` finds it. */
  readonly bin: string
  readonly args: ReadonlyArray<string>
  /** The line a person runs when the binary is absent; printed verbatim. */
  readonly install: string
  readonly initializationOptions?: Readonly<Record<string, unknown>>
  /** The `textDocument/didOpen` languageId for a path, in the server's own vocabulary. */
  readonly documentLanguageId: (path: string) => string
}

const TYPESCRIPT_DOCUMENT_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact"
}

export const TYPESCRIPT_SERVER: ServerSpec = {
  id: "typescript",
  displayName: "TypeScript",
  extensions: LSP_LANGUAGE_EXTENSIONS.typescript,
  bin: "typescript-language-server",
  args: ["--stdio"],
  install: "npm i -g typescript-language-server typescript",
  initializationOptions: {
    hostInfo: "smithers",
    /* The lsp seatbelt policy has no network: the server never fetches @types. */
    disableAutomaticTypingAcquisition: true,
    /*
     * One semantic server, no syntax-only sidecar: while a project loads the
     * syntax server answers quickinfo with `any`, and a wrong type is worse
     * than a slow one (the request's own timeout bounds the wait).
     */
    tsserver: { logVerbosity: "off", useSyntaxServer: "never" }
  },
  documentLanguageId: (path) => TYPESCRIPT_DOCUMENT_IDS[extname(path).toLowerCase()] ?? "typescript"
}

const SERVERS: Readonly<Record<LanguageId, ServerSpec>> = { typescript: TYPESCRIPT_SERVER }

export const LANGUAGE_SERVERS: ReadonlyArray<ServerSpec> = Object.values(SERVERS)

/** The language whose server handles the path, or null when no row does. */
export const languageFor = (path: string): LanguageId | null => {
  const extension = extname(path).toLowerCase()
  return LANGUAGE_SERVERS.find((spec) => spec.extensions.includes(extension))?.id ?? null
}

export const serverFor = (language: LanguageId): ServerSpec => SERVERS[language]

/** The host facts a lookup reads: the environment's PATH, the home dir, and the filesystem. */
export interface ServerLookup extends Pick<HarnessHost, "env" | "home" | "listDir" | "isFile"> {
  /** The resolved path of a file (a symlinked bin), or the path itself when it cannot be resolved. */
  readonly realpath: (path: string) => string
}

export type ResolvedServer = { readonly argv: ReadonlyArray<string> } | { readonly missing: string }

/**
 * The argv that starts a server: the harness candidate dirs, then PATH (a
 * Finder launch has the launchd PATH) — the host's own installs, never a
 * directory inside a repository. A JavaScript entry runs on the Node sidecar
 * so `#!/usr/bin/env node` never has to resolve; anything else (pnpm's shell
 * shim) runs as-is with the sidecar's dir on PATH, which the host puts
 * there. Nothing here installs anything.
 */
export const resolveServer = (
  spec: ServerSpec,
  lookup: ServerLookup,
  node: NodeSidecar | null
): ResolvedServer => {
  const fromPath = (lookup.env.PATH ?? "").split(delimiter).filter((dir) => dir !== "")
  const dirs = [...harnessCandidateDirs(lookup), ...fromPath]
  const bin = dirs.map((dir) => join(dir, spec.bin)).find((candidate) => lookup.isFile(candidate))
  if (bin === undefined) return { missing: spec.install }
  const entry = lookup.realpath(bin)
  const script = /\.[cm]?js$/.test(entry)
  return { argv: script && node !== null ? [node.path, entry, ...spec.args] : [bin, ...spec.args] }
}
