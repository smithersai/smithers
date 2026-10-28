import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it(
  "the public skills door retires generated orphans and preserves custom skills, with explicit and default data homes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-skills-retirement-"))
    const originalCwd = process.cwd()
    const names = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    const source = fileURLToPath(new URL("../skills/smithers/SKILL.md", import.meta.url))
    try {
      process.env.HOME = join(root, "home")
      process.env.CLAUDE_CONFIG_DIR = join(process.env.HOME, ".claude")
      process.env.CODEX_HOME = join(process.env.HOME, ".codex")
      process.env.XDG_CONFIG_HOME = join(process.env.HOME, ".config")
      process.env.XDG_DATA_HOME = join(process.env.HOME, "data")
      mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })
      process.chdir(root)
      // Load the real host boundary only after selecting this test's isolated home.
      const { makeCli } = await import("../src/Cli.ts")
      const retired = join(process.env.HOME, ".agents/skills/smthrs-create-app/SKILL.md")
      const custom = join(process.env.HOME, ".agents/skills/my-skill/SKILL.md")
      mkdirSync(dirname(retired), { recursive: true })
      mkdirSync(dirname(custom), { recursive: true })
      writeFileSync(custom, "# A custom skill")
      const output: string[] = []
      for (const explicit of [true, false]) {
        if (!explicit) delete process.env.XDG_DATA_HOME
        mkdirSync(dirname(retired), { recursive: true })
        writeFileSync(retired, "---\nname: smthrs-create-app\nrequires_bin: smthrs\ncommand: smthrs create-app\n---\n")
        await makeCli().serve(["skills", "add", "--help"], {
          stdout: (text) => {
            output.push(text)
          }
        })
        expect(existsSync(retired)).toBe(true)
        await makeCli().serve(["skills", "add"], {
          stdout: (text) => {
            output.push(text)
          }
        })
        expect(existsSync(retired)).toBe(false)
        expect(readFileSync(custom, "utf8")).toBe("# A custom skill")
        expect(readFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "skills/smithers/SKILL.md"), "utf8"))
          .toBe(readFileSync(source, "utf8"))
      }
      expect(output.join("\n")).toContain("skills")
    } finally {
      process.chdir(originalCwd)
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name]
        else process.env[name] = previous[name]
      }
      rmSync(root, { recursive: true, force: true })
    }
  },
  120_000
)
