/**
 * Knip's settings for this package, under the ignores `dependencyPolicy`
 * declares in PACKAGE.ts.
 *
 * Knip reads `.vibe` sources only through a compiler. `vibelang/knip` hands it
 * each module's imports and the `vibelang-runtime` import its JavaScript
 * carries, so a dependency only a VibeLang module uses counts as used. The
 * declarations VibeLang writes beside each source are its output, not code.
 */
import vibelang from "vibelang/knip"

export default {
  compilers: { vibe: vibelang, vibex: vibelang },
  ignore: ["**/*.d.vibe.ts", "**/*.d.vibex.ts"]
}
