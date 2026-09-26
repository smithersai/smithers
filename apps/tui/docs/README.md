---
title: Smithers in your terminal
description: Make a change, inspect every step, and pick up where you left off.
order: 0
---

Smithers is a coding agent that runs tasks as workflows. Ask for a change, keep chatting while it works, and inspect the steps behind the result.

## Try it

Fix a small bug in a private browser workspace. Run the agent, inspect a checkpoint, then branch to try a different approach.

<playground></playground>

The sandbox has two files and no access to your computer. Open **Settings** to use an OpenAI-compatible provider. Without a key, requests use the site's sponsored OpenRouter service when configured.

## Make your first change

Start with a failing check. Give Smithers the command that reproduces it and the result you expect.

```tui-script fix-add
Type "Fix math.js so node check.mjs passes."
Press Enter
Wait for "Fixed"
Capture "The agent edits math.js and verifies the result."
```

This recording runs the real terminal app against a scratch repository. Model responses come from a recorded session; file changes and checks execute again at build time.

## Keep the useful parts

Follow three examples in order:

1. [Fix a failing check](./guides/fix-a-bug.md). Give the agent a result it can verify.
2. [Inspect and branch](./guides/time-travel.md). Read the steps, compare the files, and try another path.
3. [Keep working](./guides/background-work.md). Delegate a task without blocking chat.

[Run Smithers locally](./installation.md) when you are ready to use your own repository.
