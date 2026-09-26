/** The local-setup commands a CLI registers by name. */
import { backupCommand as backup, restoreCommand as restore } from "./backup.ts"
import { command as doctor } from "./doctor.ts"
import { command as clean } from "./hygiene.ts"
import { command as init } from "./init.ts"
import { installService, uninstallService } from "./service.ts"
import type { Command } from "./settings.ts"

export type { Command, Io } from "./settings.ts"
export { processIo } from "./settings.ts"
export { backup, clean, doctor, init, installService, restore, uninstallService }

export const commands: ReadonlyArray<Command> = [init, doctor, installService, uninstallService, backup, restore, clean]
