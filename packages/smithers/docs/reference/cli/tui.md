### Token budgets

`smthrs tui [directory]` opens the terminal coding agent. `--model provider:model` selects the chat model; `--continue` continues the latest session, `--resume` picks one, and `--print <prompt>` answers once and exits. `--environment <name>` runs the TUI in a saved execution environment.

| Setting | Default | Scope |
| --- | --- | --- |
| `--budget-tokens <n>` or `SMITHERS_TUI_BUDGET_TOKENS` | `200000000` | Each chat turn and worker |
| `SMITHERS_TUI_BUDGET_DAILY_TOKENS` | `2000000000` | All runs per UTC day on the execution machine |

The per-run flag wins over its environment variable. Values are positive whole numbers; `0` or `none` disables a cap. A hit stops new model calls and shows the reached cap. These are runaway-loop tripwires, not a billing limit. The outer `smthrs tui` command has no daily-budget flag; set the daily environment variable.
