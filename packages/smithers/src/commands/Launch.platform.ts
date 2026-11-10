/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type * as Environment from "../Environment.ts"

/**
 * @private
 * @since 1.0.0
 */
export const uuid = (): string => randomUUID()

/**
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const environment = (): Environment.Source => process.env

/**
 * @private
 * @since 1.0.0
 */
export const cwd = (): string => process.cwd()

/**
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const resolvePath = (from: string, path: string): string => resolve(from, path)
