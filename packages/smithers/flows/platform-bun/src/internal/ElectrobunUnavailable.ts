/**
 * `#electrobun` under the `browser` condition.
 *
 * Electrobun drives native windows through Bun's FFI and Node built-ins, and a
 * browser has neither. A browser bundle resolves the private native import to
 * this module instead of bundling Electrobun, and loading it fails, so
 * `BunDesktop.layer` reports `DesktopUnavailable` there as it does on Node.
 *
 * @since 1.0.0-rc.18
 */

import { DesktopUnavailable } from "../BunDesktop.vibe"

throw new DesktopUnavailable()
