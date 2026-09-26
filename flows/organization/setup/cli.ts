/** Runs a setup command directly: `node flows/organization/setup/cli.ts <init|doctor> ...`. */
import { commands, processIo } from "./index.ts"

const [name, ...argv] = process.argv.slice(2)
const command = commands.find((candidate) => candidate.name === name)
if (command === undefined) {
  for (const candidate of commands) process.stderr.write(`usage: ${candidate.usage}\n`)
  process.exitCode = 2
} else {
  process.exitCode = await command.run(argv, processIo())
}
