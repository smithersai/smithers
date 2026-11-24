/**
 * Derives machine names from session keys.
 *
 * @since 0.1.0
 */

import { digestSync } from "@smthrs/crypto"

/**
 * The SHA-256 prefix binds the complete key, including unpaired UTF-16 surrogates.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const sessionSlug = (session: string): string => {
  const clean = session.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 24)
  return `${clean}-${digestSync(JSON.stringify(session)).slice(0, 32)}`
}

/**
 * Used only to look up an existing machine or admission, never to create one.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const legacySessionSlug = (session: string): string => {
  let djb2 = 5381
  let fnv = 2166136261
  for (let index = 0; index < session.length; index++) {
    const code = session.charCodeAt(index)
    djb2 = ((djb2 << 5) + djb2 + code) >>> 0
    fnv = Math.imul(fnv ^ code, 16777619) >>> 0
  }
  const digest = `${djb2.toString(16).padStart(8, "0")}${fnv.toString(16).padStart(8, "0")}`
  const clean = session.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 40)
  return `${clean}-${digest}`
}
