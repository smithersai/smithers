/**
 * Adopt legacy generated skills into Incur's normal retirement lifecycle.
 * @since 1.0.0
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const read = async (file: string) => {
  try {
    return await readFile(file, "utf8")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
}

const metadata = (source: string | undefined): Record<string, unknown> => {
  try {
    const value = JSON.parse(source ?? "{}")
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Records an orphaned generated create-app skill so the next global sync
 * removes it using Incur's agent-aware cleanup. Custom skills are preserved.
 * @category migrations
 * @since 1.0.0
 */
export const register = async (home: string, dataHome: string) => {
  const name = "smthrs-create-app"
  const skill = await read(join(home, ".agents", "skills", name, "SKILL.md"))
  if (
    skill === undefined || ![
      "name: smthrs-create-app",
      "requires_bin: smthrs",
      "command: smthrs create-app"
    ].every((line) => skill.split(/\r?\n/).includes(line))
  ) return
  const file = join(dataHome, "incur", "smthrs.json")
  const previous = await read(file)
  const meta = metadata(previous)
  const skills = Array.isArray(meta.skills)
    ? meta.skills.filter((skill): skill is string => typeof skill === "string")
    : []
  if (skills.includes(name)) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ ...meta, skills: [...skills, name] }) + "\n")
}
