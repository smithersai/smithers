---
title: Find files and commands
description: Search the project, insert file references, and navigate sessions.
order: 3
section: Use the TUI
---

Use **Ctrl+K** to find a command, file, saved session, or worker without leaving the terminal.

## Mention a file

Type `@` followed by part of a path. **Up/Down** choose a result, **Tab** completes it, and **Esc** dismisses the menu. Files come from `git ls-files`, falling back to `rg --files` outside Git.

```tui-script file-mention
Use "basic"
Type "Review @math"
Wait for "math.js"
Capture "Fuzzy-match a project file."
Press Tab
Capture "Insert the selected file reference."
```

## Search file contents

```tui-script text-search
Use "basic"
Press Ctrl+K
Type "text:add"
Wait for "math.js:1"
Capture "Search file contents with text:."
Press Enter
Capture "Insert a path and line number into the prompt."
```

| Input            | Searches                                      | Enter does                        |
| ---------------- | --------------------------------------------- | --------------------------------- |
| `math`           | Commands, contributed actions, and file paths | Runs a command or inserts `@path` |
| `/session`       | Slash commands                                | Runs the selected command         |
| `text:add`       | File text with ripgrep                        | Inserts `@path:line`              |
| `text:/add\(/`   | A regular expression                          | Inserts the matching location     |
| `session:review` | Saved sessions by name or first prompt        | Resumes the selected session      |
| `tab:review`     | Workers by title, ID, or status               | Opens the worker                  |
| `?`              | Available prefixes                            | Inserts the prefix                |

Search does not run an agent. A command or contributed action runs only when you choose it.

## Complete a command

```tui-script commands-menu
Use "basic"
Type "/"
Capture "Browse slash commands."
Type "thinking"
Press Tab
Type "high"
Press Enter
Wait for "Thinking level: high"
Capture "Complete a command and its argument."
```

The menu also completes arguments after `/model`, `/thinking`, `/flow`, and `/agent`. Repository flows appear alongside built-in commands.
