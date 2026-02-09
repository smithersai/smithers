# Background Agents and Scheduled Agents

## Summary

Support background agents that run in tabs and scheduled agents that run on cron-like schedules (similar to Codex Automations). Background agents let users kick off long-running tasks and continue working. Scheduled agents handle recurring work like issue triage, CI failure summaries, and daily audits — unattended.

## Context

### Background Agents

Cursor supports "background agents" that run in the cloud. Our approach is simpler and more transparent: background agents run in visible tabs within Smithers. The user can switch to the tab to watch progress, or ignore it and come back later.

### Scheduled Agents (Codex Automations)

OpenAI's Codex app (launched Feb 2026) introduced "Automations" — agents that run on a schedule without user prompting. When an Automation finishes, results land in a review queue. OpenAI uses this internally for:

- Daily issue triage
- Finding and summarizing CI failures
- Generating daily release briefs
- Checking for bugs
- Monitoring alerts

We want the same concept but running locally on the user's machine (or a configured remote).

## Requirements

### Background Agents (Tab-Based)

1. User can start a background agent from chat ("do this in the background") or command palette
2. A new tab opens with the agent's chat/progress stream
3. The tab title shows the task description and a status indicator (spinner while running, checkmark when done)
4. User can switch away from the tab and continue editing — the agent keeps running
5. When the agent finishes, the tab shows a summary of what was done (files changed, commands run)
6. Notification (toast or system notification) when a background agent completes
7. Multiple background agents can run concurrently in separate tabs

### Scheduled Agents (Cron-Based)

1. User can define automations via a config file or UI
2. Each automation has:
   - **Name**: Human-readable label
   - **Schedule**: Cron expression (e.g., `0 9 * * *` for daily at 9am) or interval (e.g., `every 4h`)
   - **Prompt**: The task description / instructions for the agent
   - **Skill** (optional): A skill to pre-load for the agent
   - **Working directory**: Which repo/project to operate in
   - **Notification**: How to notify on completion (toast, system notification, Telegram)
3. Smithers runs the automation on schedule if the app is open
4. Results go into a review queue (dedicated view or tab)
5. Each run's output is persisted (files changed, agent messages, diff)
6. User can review, approve, or revert each run's changes

### Configuration Format

```toml
# ~/.smithers/automations.toml  (or per-project .smithers/automations.toml)

[[automation]]
name = "Daily issue triage"
schedule = "0 9 * * 1-5"       # Weekdays at 9am
prompt = "Review open GitHub issues, label and prioritize them, and close stale ones"
skill = "issue-triage"
directory = "~/projects/myapp"
notify = ["toast", "telegram"]

[[automation]]
name = "CI failure summary"
schedule = "*/30 * * * *"       # Every 30 minutes
prompt = "Check CI status, summarize any failures, and suggest fixes"
directory = "~/projects/myapp"
notify = ["toast"]

[[automation]]
name = "Daily release notes"
schedule = "0 17 * * 1-5"      # Weekdays at 5pm
prompt = "Generate release notes from today's merged PRs"
directory = "~/projects/myapp"
notify = ["telegram"]
```

### Review Queue

- Dedicated view accessible from sidebar or command palette
- Lists all automation runs with: name, timestamp, status (success/failed/pending review), files changed count
- Click a run to see full agent output and diff
- Actions: Approve (keep changes), Revert (jj undo), Re-run, Edit automation

## Implementation Notes

### Background Agents

- Extend the existing tab/chat system — a background agent is just a Codex thread in a tab
- Add a `BackgroundAgentManager` to track running agents and their tab associations
- System notifications via `UNUserNotificationCenter` on macOS

### Scheduled Agents

- Use a `Timer` or `DispatchSourceTimer` for scheduling within the app process
- Parse cron expressions (use or port a lightweight cron parser)
- Each scheduled run creates a Codex thread, executes, and stores the result
- Results persisted to `~/.smithers/automation-runs/` as JSON + diffs
- If Smithers is not running at the scheduled time, run on next launch (catch-up)

### Telegram Notifications

Tie into issue 010 (Telegram support) — automations can notify via Telegram when complete, with a summary and link to review in Smithers.

## Open Questions

1. Should scheduled agents use git worktrees to avoid interfering with the user's working state?
2. Should we support remote execution (run on a server) or local-only to start?
3. How to handle automation conflicts (two automations editing the same file)?
4. Should automations have a "dry run" mode that shows what would change without applying?
5. Max concurrency for scheduled agents?
