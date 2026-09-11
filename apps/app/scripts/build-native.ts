const run = async (label: string, argv: ReadonlyArray<string>): Promise<void> => {
  console.log(`[build-native] ${label}: ${argv.join(" ")}`)
  const child = Bun.spawn([...argv], {
    cwd: import.meta.dir + "/..",
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  const exitCode = await child.exited
  if (exitCode !== 0) throw new Error(`${label} failed with exit code ${exitCode}.`)
}

let operationError: unknown
try {
  await run("web bundle", ["pnpm", "run", "build:web"])
  await run("portable smithers-build runtime", [process.execPath, "scripts/prepare-packaged-build-cli.ts"])
  await run("Electrobun package", ["pnpm", "exec", "electrobun", "build"])
} catch (error) {
  operationError = error
}

let cleanupError: unknown
try {
  await run("runtime cleanup", [process.execPath, "scripts/prepare-packaged-build-cli.ts", "--clean"])
} catch (error) {
  cleanupError = error
}

if (operationError !== undefined && cleanupError !== undefined) {
  throw new AggregateError([operationError, cleanupError], "Native build and runtime cleanup both failed.")
}
if (operationError !== undefined) throw operationError
if (cleanupError !== undefined) throw cleanupError
