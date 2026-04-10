# Bring CLI, TUI, And PI Onto The Same Attention Model

## Problem

Docs promise a richer notification story across terminal and PI surfaces, but the implementation is fragmented:

- CLI has `smithers alerts ...` and `smithers human inbox ...`, but no unified operator queue.
- TUI centers on run status and approvals, not active alerts.
- PI only exposes approval counts in the status line and ad hoc notifications.

## Proposed Changes

- Add one shared operator command surface for attention handling.
- Update the TUI to surface active alerts, alert-generated requests, and approvals together.
- Update the PI extension to show an attention queue rather than an approval-only indicator.

## CLI/TUI Work

- Add `smithers inbox` or `smithers attention` for list and action flows.
- Keep `smithers alerts` and `smithers human inbox` as low-level commands, but route operators toward the unified command.
- Add a TUI attention pane with:
  - count by severity
  - hotkeys for ack/resolve/silence/approve/deny
  - direct jump to run detail
  - terminal bell or OSC notification hooks

## PI Work

- Replace the approval-only status item with an attention summary.
- Use `ctx.ui.notify(...)` for critical alerts and escalations.
- Add an interactive attention picker for approve, deny, ack, resolve, silence, resume, and cancel.
- Reuse the same severity labels and action language as web and CLI.

## Touch Points

- `src/cli/index.ts`
- `src/cli/tui/components/RunsList.tsx`
- `src/cli/tui/components/RunDetailView.tsx`
- new `src/cli/tui/components/AttentionPane.tsx`
- `src/pi-plugin/extension.ts`

## Dependencies

- `0004-attention-api-and-gateway-watch-stream.md`

## Acceptance Criteria

- Operators can handle approvals and alerts from one CLI command.
- The TUI shows active attention items without requiring the web shell.
- PI status text reflects total attention, not just approvals.
- PI can notify and act on alert-generated requests, not only workflow approvals.
- Terminal and PI severity labels match the web attention center.
