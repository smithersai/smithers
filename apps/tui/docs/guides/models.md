---
title: Models and reasoning
description: Choose separate models for chat and background work.
order: 9
section: Use the TUI
---

Use **Ctrl+L** or `/model` to choose a detected model. Type to filter; **Up/Down** and **Enter** select. **Ctrl+P** moves to the next model; **Shift+Ctrl+P** moves to the previous one. `/model provider:modelId` selects an explicit seat.

```tui-script model-picker
Use "models"
Press Ctrl+L
Wait for "GPT-6"
Capture "Choose from models whose providers are configured."
Press Escape
Type "/thinking high"
Press Enter
Wait for "Thinking level: high"
Capture "Set reasoning effort for chat."
Press Shift+Tab
Capture "Cycle reasoning effort from the composer."
```

The recording uses placeholder credentials to populate the picker and makes no request to those providers. Your picker reflects your machine's detected accounts and keys.

## Chat and worker defaults

Chat prefers the configured Cerebras seat, otherwise an available provider. Workers prefer an available non-Cerebras seat. A detected ChatGPT subscription takes precedence over an OpenAI API key in the picker.

| Setting                         | Applies to                                             |
| ------------------------------- | ------------------------------------------------------ |
| `--model provider:modelId`      | Chat; overrides its environment default                |
| `SMITHERS_TUI_SEAT`             | Default chat seat                                      |
| `SMITHERS_TUI_WORKER_SEAT`      | Default worker seat                                    |
| `SMITHERS_TUI_WORKER_SEATS=a,b` | Ordered worker fallbacks after provider limits         |
| Agent file `model:`             | That custom agent, unless its request selected a model |

Workers retain their original model on resume. A failed worker's **m** control lets you choose another model. Limits, reset times, and fallback availability come from the provider; selecting a model does not grant access to it.

## Reasoning effort

`/thinking` accepts `default`, `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`. **Shift+Tab** cycles the same set. Support varies by provider. Custom agent frontmatter also uses the runtime's effort schema, including `max`; it is separate from the chat command's choices.

See [configuration](../reference/configuration.md) for credential variables and [recovery](./background-work.md#recover-a-worker) for failed or parked workers.
