# Replace Approval-Only Web Surfaces With A Unified Attention Center

## Problem

The current web shell is wired around approvals:

- the sidebar badge counts approvals only
- `/inbox` just redirects to `/approvals`
- run detail uses inline approval and failure banners instead of a shared attention model

That makes severity, ownership, and operator actions inconsistent.

## Proposed Changes

- Build a real `/inbox` attention center and make `/approvals` an alias, not the primary model.
- Use one shared attention card model for alerts, approvals, and alert-generated operator requests.
- Add live toasts for newly firing or escalating attention items.
- Use consistent severity styling across inbox rows, badges, banners, and toasts.

## UX Requirements

- Sidebar badge counts all unresolved attention items, not approvals only.
- Inbox filters:
  - kind
  - severity
  - status
  - owner
  - workflow or run
- Row content:
  - severity
  - age
  - workflow or run
  - node
  - owner
  - runbook
  - "why this fired"
- Row actions:
  - open run
  - open node
  - ack
  - resolve
  - silence for 1h
  - approve or deny
  - resume or cancel when relevant

## Run Detail Requirements

- Replace ad hoc approval and failure banners with shared attention cards.
- Show linked active alerts near the relevant run and node timeline entries.
- Deep links from inbox rows must land on the relevant run or node section.

## Touch Points

- `apps/web/src/app/layouts/app-shell.tsx`
- `apps/web/src/app/router.tsx`
- `apps/web/src/app/routes/inbox/page.tsx`
- `apps/web/src/app/routes/workspace/runs/detail/page.tsx`
- `apps/web/src/features/approvals/...`
- new `apps/web/src/features/attention/...`

## Dependencies

- `0004-attention-api-and-gateway-watch-stream.md`

## Acceptance Criteria

- `/inbox` shows approvals and alerts in one list with live updates.
- The top-level badge reflects total unresolved attention items.
- New critical attention items trigger a toast unless focus suppression applies.
- Run detail can render active alert cards and approval cards through shared attention components.
- Deep links from inbox rows scroll to the correct run or node context.
