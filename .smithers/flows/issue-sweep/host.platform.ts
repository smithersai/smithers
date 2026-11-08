// The platform code of host.vibe: the operator's home and working directories, which a .vibe file does not read.
import { homedir } from "node:os"

/**
 * The operator's home directory.
 * @throws {never}
 */
export function homeDirectory(): string {
  return homedir()
}

/**
 * The host process's working directory.
 * @throws {never}
 */
export function workingDirectory(): string {
  return process.cwd()
}
