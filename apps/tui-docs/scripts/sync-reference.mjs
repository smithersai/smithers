/** Keep the complete command and key inventories tied to the actual TUI registries. */
import { writeFileSync } from "node:fs"
import { commands } from "../../tui/src/editor.ts"
import { registry } from "../../tui/src/keys.ts"
const target = new URL("../../tui/docs/reference/", import.meta.url)
const front = (title, description, order) =>
  `---\ntitle: ${title}\ndescription: ${description}\norder: ${order}\nsection: Reference\n---\n\n`
const guides = {
  model: "../guides/models.md",
  thinking: "../guides/models.md",
  theme: "../guides/appearance.md",
  new: "../guides/sessions.md",
  resume: "../guides/sessions.md",
  fork: "../guides/sessions.md",
  session: "../guides/sessions.md",
  compact: "../guides/sessions.md",
  name: "../guides/sessions.md",
  copy: "../guides/chat.md",
  summary: "../guides/review-changes.md",
  tabs: "../guides/background-work.md",
  chat: "../guides/appearance.md",
  filter: "../guides/appearance.md",
  grep: "../guides/appearance.md",
  ui: "../automation/views.md",
  smithers: "../automation/flows.md",
  flows: "../automation/flows.md",
  flow: "../automation/flows.md",
  agent: "../automation/agents.md",
  retry: "../guides/background-work.md",
  stop: "../guides/background-work.md",
  hotkeys: "./keys.md",
  quit: "./cli.md"
}
const inventory = commands.map((c) =>
  `| \`/${c.name}${c.args ? " " + c.args.replaceAll("|", "\\|") : ""}\` | ${c.description}. | [Guide](${
    guides[c.name]
  }) |`
).join("\n")
writeFileSync(
  new URL("commands.md", target),
  front("Command reference", "Every built-in slash command and its guide.", 20) +
    `Type \`/\` to browse commands. Up/Down choose, Tab completes, Enter invokes, and Esc dismisses. Commands with required arguments leave the composer ready for those arguments.\n\n\`\`\`tui-script command-reference\nUse "basic"\nType "/"\nCapture "Browse the command menu."\nPress Escape\nPress Ctrl+C\nType "/hotkeys"\nPress Enter\nCapture "Print the complete contextual key list into the transcript."\n\`\`\`\n\n| Command | Action | Details |\n| --- | --- | --- |\n${inventory}\n| \`/exit\` | Alias for \`/quit\`. | [Guide](./cli.md) |\n\nRepository flows also appear in the command menu. \`/model\`, \`/thinking\`, \`/flow\`, and \`/agent\` complete arguments. Prefix a shell command with \`!\` to add its output to context, or \`!!\` to keep it out; see [shell commands](../guides/shell.md).\n`
)
let keyDoc = front("Keyboard reference", "Every registered shortcut, grouped by the active context.", 21) +
  `Press **?** with an empty editor to see the active context's keys. **Esc** or **?** closes the popup; other typing keeps the question mark as prompt text. Global shortcuts remain available as the context permits.\n\n\`\`\`tui-script keyboard-help\nUse "basic"\nPress ?\nCapture "Inspect the keys available in the composer."\nPress Escape\nPress Ctrl+S\nPress ?\nCapture "Inspect the keys for the current view."\nPress Escape\n\`\`\`\n\n`
for (const context of [...new Set(registry.map((k) => k.context))]) {
  keyDoc += `## ${context[0].toUpperCase() + context.slice(1)}\n\n| Key | Action |\n| --- | --- |\n`
  for (const key of registry.filter((k) => k.context === context)) {
    keyDoc += `| ${key.keys.map((k) => "`" + k.replaceAll("|", "\\|") + "`").join(" / ")} | ${key.label}. |\n`
  }
  keyDoc += "\n"
}
keyDoc +=
  `## Editor and mouse\n\nCtrl+A/Ctrl+E move to the beginning/end of a line. Ctrl+W deletes a word and Ctrl+U deletes to the start of the line. Ctrl+K belongs to search. Drag text to copy a selection; click tabs, worker rows, cards, or status actions to open/invoke them. Scroll with the mouse or PageUp/PageDown.\n\nCtrl+C clears the editor; twice within 500 ms exits. Ctrl+D exits only with an empty editor. Approval letters arm only after the editor is empty and their 400 ms guard has elapsed.\n\nRepository and runtime [extensions](../automation/extensions.md) add keys under their owner in the popup. Built-in keys and text-editing bindings cannot be shadowed.\n`
writeFileSync(new URL("keys.md", target), keyDoc)
