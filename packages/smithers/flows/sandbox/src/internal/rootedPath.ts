/**
 * Roots relative paths at a session workdir.
 *
 * @since 0.1.0
 */

/**
 * The one rule for a relative path a session sees: `Sandbox.fileSystem` roots
 * every file path with it and every bundled provider roots a spawn `cwd` with
 * it, so a relative path names the same guest entry on every backend.
 *
 * An absolute path is returned unchanged. `""`, `.`, and a run of `./` name the
 * workdir itself, and a leading `./` goes together with the slashes around it,
 * so `.//x` names the same entry `./x` does rather than `<workdir>//x`. The
 * workdir's trailing slashes go, because every rooted path adds its own. A
 * workdir that is nothing but slashes is the root, and stripping it to the
 * empty string would quote `''` into a probe and name the host's cwd rather
 * than the machine's; the root keeps its one slash and never doubles it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const rootedAt = (workdir: string): (path: string) => string => {
  const trimmed = workdir.replace(/\/+$/, "")
  const root = trimmed === "" ? "/" : trimmed
  return (path) => {
    if (path.startsWith("/")) return path
    const relative = path.replace(/^(?:\.?\/+)*/, "")
    if (relative === "" || relative === ".") return root
    return root === "/" ? `/${relative}` : `${root}/${relative}`
  }
}
