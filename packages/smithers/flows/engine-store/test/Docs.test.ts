import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as ts from "typescript"
import { describe, expect, it } from "vitest"

const readDoc = (path: string): string => readFileSync(new URL(`../docs/${path}`, import.meta.url), "utf8")

const packageRoot = new URL("../", import.meta.url)
const repoRoot = new URL("../../../../../", import.meta.url)

/** Every file under `directory` whose name ends in one of `extensions`. */
const sourceFiles = (directory: URL, extensions: ReadonlyArray<string>): Array<URL> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(new URL(`${entry.name}/`, directory), extensions)
      : extensions.some((extension) => entry.name.endsWith(extension))
      ? [new URL(entry.name, directory)]
      : []
  )

describe("documentation contracts", () => {
  it("guide describes actual transaction ordering", () => {
    const guide = readDoc("concepts/execution-facts.md").replace(/\s+/g, " ")
    expect(guide).toContain("Engine-state is the outer transaction and the journal write transaction is inside it")
    expect(guide).toContain("The memory state gate is released at SQL commit before post-commit journal work")
    expect(guide).not.toContain("Journal/SQL is the outer transaction")
  })

  it.each([
    "../README.md",
    "concepts/execution-facts.md",
    "guides/back-up-and-restore.md"
  ])("documents restore fencing's journal exception in %s", (path) => {
    const doc = readDoc(path).replace(/\s+/g, " ")
    expect(doc).toContain("`DisasterRecovery.fence`")
    expect(doc).toContain("does not append")
    expect(doc).toContain("run decision")
    expect(doc).toContain("ownership event")
    expect(doc).toContain("execution fact")
    expect(doc).toContain("unverified-observation")
  })

  it.each([
    ["consumeDeferred", "(address: DeferredAddress, consumedAtMs: number) => Effect<boolean>"],
    ["completeRunClocks", "(executionId: string, completedAtMs: number) => Effect<ReadonlyArray<ClockRow>>"]
  ])("documents the %s result callers use for journaling", (member, signature) => {
    const row = readDoc("api.md").split("\n").find((line) => line.includes(`\`${member}\``))
    expect(row?.replace(/\s+/g, " ")).toContain(`\`${signature}\``)
  })

  it("lists every SchedulerError code in the reference and driving guide", () => {
    const source = readFileSync(new URL("../src/PlanScheduler.ts", import.meta.url), "utf8")
    const literals = source.match(/code: Schema\.Literals\(\[([\s\S]*?)\]\)/)![1]!
    const codes = [...literals.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    expect(codes.length).toBeGreaterThan(0)
    for (const path of ["api.md", "guides/drive-a-plan.md"]) {
      const doc = readDoc(path)
      const start = doc.indexOf(path === "api.md" ? "| `SchedulerError`" : "`SchedulerError` is a refusal")
      expect(start).toBeGreaterThanOrEqual(0)
      const paragraph = doc.slice(start).split("\n\n")[0]!.split(".")[0]!
      expect([...paragraph.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!).filter((code) => code !== "code"))
        .toEqual(codes)
    }
  })

  it("lists every persisted EventTypes member", () => {
    const source = readFileSync(new URL("../src/EventTypes.ts", import.meta.url), "utf8")
    const members = [...source.matchAll(/(\w+): "flows\.engine\./g)].map((match) => match[1]!)
    expect(members.length).toBeGreaterThan(0)
    const doc = readDoc("event-types.md")
    for (const member of members) expect(doc).toContain(`\`${member}\``)
    expect(doc).toContain("`childSpawnKind`")
    expect(doc).toContain("not a journal event type")
  })

  it("cites only documentation pages that exist", () => {
    // A cited page is where a reader goes next. The retired docs/pages tree
    // left twenty citations pointing at nothing, including the operator
    // script's own procedure. Citations are backticked; quoted paths in
    // tests are fixtures, not citations.
    const files = ["src/", "scripts/", "test/"].flatMap((directory) =>
      sourceFiles(new URL(directory, packageRoot), [".ts", ".mjs"])
    )
    const dangling = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/`((?:packages\/[\w./-]+\/)?docs\/[\w./-]+\.mdx?)`/g)]
        .map((match) => match[1]!)
        .filter((cited) => !existsSync(new URL(cited, cited.startsWith("packages/") ? repoRoot : packageRoot)))
        .map((cited) => `${file.pathname.slice(packageRoot.pathname.length)}: ${cited}`)
    )
    expect(dangling).toEqual([])
  })

  it("describes the strict default and both explicit inconsistency layers", () => {
    const row = readDoc("guides/compose-a-durable-engine.md").split("\n")
      .find((line) => /^\|\s*`Inconsistency`\s*\|/.test(line))
    expect(row).toBeDefined()
    const cells = row!.split("|").map((cell) => cell.trim())
    expect(cells[2]).toContain("Conflicts are journaled and fail the dispatch (the strict default)")
    expect(cells[2]).toContain("`layerTolerant(owner)` to continue past them")
    expect(cells[3]).toContain("`layerStrict(owner)`")
    expect(cells[3]).toContain("`layerTolerant(owner)`")
  })

  it("documents the durable TTL removal refusal and recovery policy", () => {
    const api = readDoc("api.md").replace(/\s+/g, " ")
    expect(api).toContain("Omitting `ttlMs` is unbounded only before a durable age verdict exists")
    expect(api).toContain("Removing `ttlMs` after a recorded verdict fails with `idempotency_conflict`")
    expect(api).toContain(
      "Recovery must retain the original TTL and history identity, or use a new action or run identity"
    )
    expect(api).not.toContain("retains the existing unbounded path and is not covered by this conflict check")
  })

  it("states that a shared step-result tier is trusted to write into the workspace", () => {
    const guide = readDoc("guides/share-a-cache-across-machines.md").replace(/\s+/g, " ")
    expect(guide).toContain("## Trust every writer of the shared tier")
    expect(guide).toContain("A shared step-result tier is trusted to write into your workspace")
    expect(guide).toContain("Only producers you trust as much as your own machines may write to the tier")
    expect(guide).toContain("read-only credentials")
    expect(guide).toContain("signed provenance")
    const admission = readDoc("concepts/cache-admission.md").replace(/\s+/g, " ")
    expect(admission).toContain("Only producers you trust as much as your own machines may write to the shared tier")
    expect(admission).toContain("../guides/share-a-cache-across-machines.md#trust-every-writer-of-the-shared-tier")
  })

  it("assembled quickstart typechecks against public Jj", () => {
    const blocks = [...readDoc("quickstart.md").matchAll(/^```ts\n([\s\S]*?)^```/gm)]
    expect(blocks.length).toBeGreaterThan(1)
    const filename = fileURLToPath(new URL("../docs/quickstart.mts", import.meta.url))
    const source = blocks.map((block) => block[1]).join("\n")
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      types: ["node"]
    }
    const host = ts.createCompilerHost(options)
    const readFile = host.readFile.bind(host)
    const fileExists = host.fileExists.bind(host)
    host.readFile = (path) => path === filename ? source : readFile(path)
    host.fileExists = (path) => path === filename || fileExists(path)
    const program = ts.createProgram([filename], options, host)
    // The quickstart's own diagnostics: checking every dependency's source as well
    // repeats their typecheck targets and took over a minute on a CI runner.
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(filename))
    expect(
      diagnostics.map((diagnostic) =>
        ts.formatDiagnosticsWithColorAndContext([diagnostic], {
          getCanonicalFileName: (path) => path,
          getCurrentDirectory: () => host.getCurrentDirectory(),
          getNewLine: () => "\n"
        })
      )
    ).toEqual([])
  })
})

describe("source documentation pointers", () => {
  const sourceDir = new URL("../src/", import.meta.url)
  const sources = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"))
  const read = (name: string): string => readFileSync(new URL(name, sourceDir), "utf8")

  it("every relative docs pointer in a public module resolves to a file", () => {
    const missing: Array<string> = []
    for (const name of sources) {
      for (const match of read(name).matchAll(/`((?:\.\.\/)*(?:docs|packages|apps)\/[^`\s]+\.(?:md|mdx))`/g)) {
        const pointer = match[1]!
        const target = pointer.startsWith("docs/")
          ? new URL(`../${pointer}`, import.meta.url)
          : new URL(`../../../../../${pointer}`, import.meta.url)
        if (!existsSync(target)) missing.push(`${name}: ${pointer}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("documents the PostgreSQL isolation used by the shipped adapter", () => {
    const adapter = readFileSync(
      new URL("../../database/src/postgres/PostgresDatabase.ts", import.meta.url),
      "utf8"
    )
    const api = readDoc("api.md")
    expect(adapter).toContain("BEGIN ISOLATION LEVEL READ COMMITTED")
    expect(adapter).toContain("pg_advisory_xact_lock")
    for (const doc of [api, readDoc("concepts/durable-waits.md")].map((doc) => doc.replace(/\s+/g, " "))) {
      expect(doc).toContain("READ COMMITTED")
      expect(doc).toContain("transaction-scoped advisory lock")
      expect(doc).toContain("PostgreSQL")
      expect(doc).not.toContain("must use `SERIALIZABLE`")
    }
    const installation = readDoc("installation.md").replace(/\s+/g, " ")
    expect(installation).toContain("SQLite or PostgreSQL")
    expect(installation).not.toContain("only durable backing shipped here is local SQLite")
    expect(api).not.toContain("only `DurableWriter` backing shipped here is `node:sqlite`")
  })

  it("names the run statuses the schema admits and the real memory transaction", () => {
    const header = read("DurableEngineState.ts")
    expect(header).not.toMatch(/one `waiting` status/)
    expect(header).toContain("`suspended`")
    expect(header).toContain("`waiting_reason`")
    expect(header).not.toContain("runs the effect directly")
    const api = readDoc("api.md").replace(/\s+/g, " ")
    expect(api).not.toContain("runs the effect directly")
    expect(api).toContain("rolls back")
  })
})
