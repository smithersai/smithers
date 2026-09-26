---
title: Monitor changes
description: Get an update when a worker, flow run, or command output changes meaningfully.
order: 17
section: Automate
---

Ask the coordinator to watch a specific result, for example: “Watch the checks and tell me if the failure changes.” A monitor observes its source; Jev judges changed output against your request, and a positive judgment asks Luna for a one-line update.

## Create and inspect a monitor

```tui-script monitor
Use "monitor"
Type "Monitor the addition check output."
Press Enter
Wait for answer "Monitor request settled."
Wait for monitor "checks" status "active"
Wait 1000 ms
Capture "Create a real monitor with local fixture responses at the model boundary."
Type "!printf '3 checks passed\\n' > check-status.txt"
Press Enter
Wait for "Addition checks passed."
Capture "A changed observation produces a persisted monitor update."
Type "Stop the checks monitor."
Press Enter
Wait for answer "Stopped the checks monitor."
Wait for monitor "checks" status "stopped"
Capture "Stop the monitor and retain its recorded updates."
```

The recording runs the production monitor and uses a local deterministic provider/judge. It demonstrates mechanics, not live-model judgment quality.

```js
await ctx.call("monitor.create", {
  id: "checks",
  title: "Checks",
  watch: "Tell me when the check output changes.",
  source: { kind: "shell", command: "cat check-status.txt" },
  trigger: { kind: "interval", seconds: 10 }
})
```

| Source       | Shape                     | Trigger                        |
| ------------ | ------------------------- | ------------------------------ |
| Worker       | `{kind:"tab", id}`        | Events by default, or interval |
| Flow run     | `{kind:"run", id}`        | Events by default, or interval |
| Shell output | `{kind:"shell", command}` | Interval; default 60 seconds   |

Intervals range from 10 seconds to 24 hours. A shell command runs on every tick. Up to eight monitors may be active. Observation text is bounded to its last 4,000 characters.

## Stop and resume

Ask the coordinator to list or stop monitors; the flows are `monitor.list({})` and `monitor.stop({id})`. Reusing an ID restarts that monitor. Unchanged observations do not call a model. Updates appear as a toast and a persisted chat row.

Monitors persist across `/resume` and `-c`. A shell monitor must pass approval again before its first restored command. Under `deny`, it is refused.

## Handle missing credentials

```tui-script monitor-refusal
Use "monitor-refusal"
Type "Monitor the addition check output."
Press Enter
Wait for "Jev is unavailable"
Press Ctrl+O
Capture "Inspect a monitor creation refusal when judging is unavailable."
```

`AI_GATEWAY_API_KEY` is required. There is no fallback when judging is unavailable. A Jev, Luna, source, or restored-approval failure marks the monitor failed and records a typed error. Fix the cause, then recreate the same ID.
