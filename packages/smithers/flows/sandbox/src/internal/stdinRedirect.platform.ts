/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * An unguessable file name.
 *
 * A per-session counter was not one. It reset on every acquire, so a
 * reattached machine — a resumed Vercel sandbox, an adopted ECS task, a
 * leftover container — started again at `.smthrs-stdin-0` and could read or
 * overwrite the previous incarnation's staged input. Standard input is where a
 * caller puts a script, a patch, or a credential blob.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const staged = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
