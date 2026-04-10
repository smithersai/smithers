# Expose Alerts And Approvals Through One Attention API

## Problem

The gateway snapshot contains runs and approvals only. The server REST API exposes pending approvals only. There is no live alert list, no alert update stream, and no single operator-facing read model spanning approvals, human requests, and alerts.

## Proposed Changes

- Add a unified attention read model that unions:
  - active alerts
  - pending approvals
  - alert-generated human requests
- Expose both the low-level alert API and the high-level attention API.
- Make the gateway snapshot and websocket event stream alert-aware.

## API Work

- Gateway RPC:
  - `alerts.list`
  - `alerts.ack`
  - `alerts.resolve`
  - `alerts.silence`
  - `attention.list`
  - `attention.act` for shared action routing
- Gateway snapshot:
  - add `alerts` or `attention`
  - include counts by severity and kind
- Gateway event stream:
  - broadcast alert lifecycle events
  - broadcast attention item updates
- Server REST:
  - `GET /v1/alerts`
  - `GET /v1/attention`
  - POST routes for ack, resolve, silence, and shared actions

## Payload Requirements

Each attention item should include:

- `kind`
- `severity`
- `status`
- `runId`
- `nodeId`
- `iteration`
- `owner`
- `runbook`
- `message`
- `why`
- `ageMs`
- `availableActions`
- deep-link targets for run and node

## Touch Points

- `src/gateway/index.ts`
- `src/server/index.ts`
- `src/db/adapter.ts`
- `src/cli/index.ts`

## Dependencies

- `0001-alert-model-and-policy-snapshot.md`
- `0002-alert-rule-registry-and-event-normalization.md`
- `0003-alert-runtime-and-control-flow-reactions.md`

## Acceptance Criteria

- Websocket clients receive alert updates without polling a REST list.
- The gateway hello snapshot includes active alerts or unified attention items alongside runs.
- REST clients can list active alerts and unified attention items.
- Shared actions route to the correct underlying primitive:
  - alert ack/resolve/silence
  - approval approve/deny
  - alert-generated human request answer
- API tests cover state-version bumps and event broadcast for alert lifecycle changes.
