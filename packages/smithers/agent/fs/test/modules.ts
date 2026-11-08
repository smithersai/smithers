import { fileURLToPath } from "node:url"

/** Absolute paths of the command fixtures that routes point at. */
export const visibleModule = fileURLToPath(new URL("./fixtures/command/visible.ts", import.meta.url))
export const specialModule = fileURLToPath(new URL("./fixtures/command/special%23flow.ts", import.meta.url))
export const invalidModule = fileURLToPath(new URL("./fixtures/command/invalid.ts", import.meta.url))
export const recordedModule = fileURLToPath(new URL("./fixtures/command/recorded.ts", import.meta.url))
export const refinedModule = fileURLToPath(new URL("./fixtures/command/refined.ts", import.meta.url))

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
