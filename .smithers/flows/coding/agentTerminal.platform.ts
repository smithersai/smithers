/** The platform code of agentTerminal.vibe, which a .vibe file does not use directly (EK4402). */
import { existsSync } from "node:fs"

/**
 * Whether this process runs as the coding agent on a machine: the installed
 * client and the broker's socket both exist, and the process runs as the
 * agent's user.
 *
 * @throws {never}
 */
export const machineAgent = (client: string, socket: string): boolean =>
  existsSync(client) && existsSync(socket) && process.getuid?.() === 19999
