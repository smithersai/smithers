/** The local-setup commands a CLI registers by name: `init` and `doctor`. */
import { command as doctor } from "./doctor.ts"
import { command as init } from "./init.ts"
import type { Command } from "./settings.ts"

export type { Command, Io } from "./settings.ts"
export { processIo } from "./settings.ts"
export { doctor, init }

export const commands: ReadonlyArray<Command> = [init, doctor]
