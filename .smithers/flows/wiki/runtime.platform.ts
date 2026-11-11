// The platform code of runtime.vibe: the host process's environment, which a .vibe file does not read directly.

/**
 * The host process's environment, as the seat catalog, the supervisor stance and the judge read it.
 * @throws {never}
 */
export function processEnvironment(): Readonly<Record<string, string | undefined>> {
  return process.env
}
