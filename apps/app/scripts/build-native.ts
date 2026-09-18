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
  await run("Electrobun package", ["pnpm", "exec", "electrobun", "build"])
} catch (error) {
  operationError = error
}

if (operationError !== undefined) throw operationError
