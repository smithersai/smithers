import * as NodeServices from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"

/**
 * A real typescript-language-server on the `test/fixtures/lsp/ts` project.
 * The server and its tsserver come from the host, never the repository:
 * `SMITHERS_LSP_TLS` and `SMITHERS_LSP_TSSERVER` name them, or the server is
 * found on PATH with the `typescript` installed beside it. `scripts/lsp-real.sh`
 * installs both under a directory of your choice and runs this suite, so the
 * measurement and the test use the same binaries.
 */
const onPath = (name: string): string | undefined =>
  (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, name)).find((candidate) =>
    existsSync(candidate)
  )
const server = process.env.SMITHERS_LSP_TLS ?? onPath("typescript-language-server")
const tsserver = process.env.SMITHERS_LSP_TSSERVER ??
  (server === undefined ? undefined : join(realpathSync(server), "../../../typescript/lib/tsserver.js"))
const available = server !== undefined && tsserver !== undefined && existsSync(tsserver)

/** The 1-based lines of the error-severity items in a pulled or pushed report. */
const errorLines = (report: unknown): ReadonlyArray<number> =>
  ((report as { readonly items?: ReadonlyArray<{ severity?: number; range: { start: { line: number } } }> }).items ??
    [])
    .filter((item) => item.severity === 1)
    .map((item) => item.range.start.line + 1)

const fixture = fileURLToPath(new URL("./fixtures/lsp/ts", import.meta.url))
const PROBE = "\nexport const probe: string = 1\n"

describe.skipIf(!available)("NodeLanguageServer with a real typescript-language-server", () => {
  let workspace = ""
  beforeAll(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "std-lsp-real-")))
    cpSync(fixture, workspace, { recursive: true })
  })
  afterAll(() => rmSync(workspace, { recursive: true, force: true }))

  it("reports a pushed type error on its line, then an empty report once the text is fixed", async () => {
    const file = join(workspace, "src/main.ts")
    const clean = readFileSync(file, "utf8")
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const languageServer = yield* NodeLanguageServer.make({
          command: server!,
          args: ["--stdio"],
          cwd: workspace,
          initializationOptions: { tsserver: { path: tsserver! }, disableAutomaticTypingAcquisition: true },
          settleMs: 15_000,
          quietMs: 500
        })
        yield* languageServer.sync(file, clean + PROBE)
        const broken = errorLines(yield* languageServer.diagnostics(file))
        yield* languageServer.sync(file, clean)
        const fixed = errorLines(yield* languageServer.diagnostics(file))
        yield* languageServer.close(file)
        yield* languageServer.sync(file, clean + PROBE)
        const reopened = errorLines(yield* languageServer.diagnostics(file))
        return { broken, fixed, reopened }
      })).pipe(Effect.provide(NodeServices.layer))
    )
    const line = (clean + PROBE).split("\n").findIndex((text) => text.includes("probe")) + 1
    expect(result.broken).toContain(line)
    expect(result.fixed).toEqual([])
    expect(result.reopened).toContain(line)
  }, 60_000)
})
