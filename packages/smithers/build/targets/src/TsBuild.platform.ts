/**
 * The platform code of TsBuild.vibe, which a .vibe file does not import as a
 * value (EK4402).
 *
 * @since 0.1.0
 */

import * as NodePath from "node:path"

/**
 * The last segment of a host path.
 *
 * @category paths
 * @since 0.1.0
 */
export const basename = (path: string): string => NodePath.basename(path)
