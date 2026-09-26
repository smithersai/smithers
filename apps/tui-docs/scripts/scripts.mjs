/** Small, strict human-readable language. No script line executes a shell command. */
export function parseScripts(markdown) {
  const scripts = []
  for (const match of markdown.matchAll(/^```tui-script\s+([^\n]+)\n([\s\S]*?)^```\s*$/gm)) {
    const id = match[1].trim()
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid recording id: ${id}`)
    const steps = match[2].split("\n").filter((line) => line.trim()).map((line) => {
      const text = /^(Type|Wait for|Capture) ("(?:[^"\\]|\\.)*")$/.exec(line)
      if (text) return { kind: text[1], value: JSON.parse(text[2]) }
      const key = /^Press (Enter|Ctrl\+T|Ctrl\+S|Ctrl\+O|Home|End|Escape|ArrowLeft|ArrowRight)$/.exec(line)
      if (key) return { kind: "Press", value: key[1] }
      throw new Error(`Invalid recording instruction: ${line}`)
    })
    if (!steps.some((step) => step.kind === "Capture")) throw new Error(`Recording ${id} needs Capture`)
    scripts.push({ id, steps })
  }
  return scripts
}
