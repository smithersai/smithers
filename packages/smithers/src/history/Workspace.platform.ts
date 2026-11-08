/**
 * Host path resolution for durable workspace routing.
 *
 * @since 1.0.0
 */

import { resolve as resolvePath } from "node:path"

/**
 * @private
 * @since 1.0.0
 */
export const resolve = (...paths: Array<string>): string => resolvePath(...paths)
