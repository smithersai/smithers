import { fileURLToPath } from "node:url"

/** Absolute paths of the command fixtures that routes point at. */
export const visibleModule = fileURLToPath(new URL("./fixtures/command/visible.ts", import.meta.url))
export const specialModule = fileURLToPath(new URL("./fixtures/command/special%23flow.ts", import.meta.url))
export const invalidModule = fileURLToPath(new URL("./fixtures/command/invalid.ts", import.meta.url))
export const recordedModule = fileURLToPath(new URL("./fixtures/command/recorded.ts", import.meta.url))
export const deployModule = fileURLToPath(new URL("./fixtures/command/deploy.ts", import.meta.url))
export const refinedModule = fileURLToPath(new URL("./fixtures/command/refined.ts", import.meta.url))

/** The scalar fixtures, each named for its input and output schemas. */
export type ScalarFixture =
  | "boolean"
  | "date-text"
  | "gated"
  | "nullable-text"
  | "number"
  | "number-text-to-number"
  | "number-to-number-text"
  | "value-record"
  | "void"

/**
 * Absolute path of one scalar fixture module, which `Route.load` imports.
 *
 * @throws {never}
 */
export const scalarModule = (fixture: ScalarFixture): string =>
  fileURLToPath(new URL(`./fixtures/scalar/${fixture}.ts`, import.meta.url))

/**
 * Installs the gate the `gated` scalar fixture waits on while it is imported.
 * `started` resolves when the module begins evaluating; `release` lets its
 * top-level await finish.
 *
 * @throws {never}
 */
export const scalarGate = (): { readonly started: Promise<void>; readonly release: () => void } => {
  let begin!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    begin = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  ;(globalThis as { fsScalarGate?: { started: () => void; released: Promise<void> } }).fsScalarGate = {
    started: begin,
    released
  }
  return { started, release }
}

/** Native HTTP request constructor at the test host boundary. */
export const Request = globalThis.Request
/** The import counter maintained by the real fixture module. */
export const recordedImports = (): number => (globalThis as { fsRecordedImports?: number }).fsRecordedImports ?? 0

/** Native metadata-import fixture state. */
export const metadataGlobals = globalThis as { fsMetadataGate?: Promise<void> }
export const nativeConsole = console
export const createMetadataFixture = async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "fs-metadata-"))
  const source = join(directory, "stuck.mjs")
  await writeFile(source, "await globalThis.fsMetadataGate; export default null\n")
  return { directory, source }
}
export const removeMetadataFixture = async (directory: string) => {
  const { rm } = await import("node:fs/promises")
  await rm(directory, { recursive: true, force: true })
}
/** Foreign reflection failure used by the existing boundary tests. */
export const throwingProxy = <A extends object>(target: A): A =>
  new Proxy(target, {
    ownKeys: () => {
      throw new Error("trap")
    }
  })
/** Runs the real source-loader process used by the structural-path test. */
export const executeSource = async (script: string): Promise<string> => {
  const { execFileSync } = await import("node:child_process")
  return execFileSync(process.execPath, [
    "--import",
    "vibelang/register",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    script
  ], { encoding: "utf8" })
}

/** An accessor that throws before a foreign decoder can inspect its input. */
export const throwingAssembly = () => ({
  get value(): unknown {
    throw new Error("private assembly getter")
  }
})
