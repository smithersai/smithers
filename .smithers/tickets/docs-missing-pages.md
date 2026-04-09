# Documentation missing pages and navigation gaps

## Problem

### Missing from docs.json navigation (pages exist on disk)
- `concepts/rag` — fully written (139 lines), invisible to users
- `guides/rag-quickstart` — fully written (146 lines), invisible to users

### Missing doc pages (components shipped without docs)
- `<Signal>` — typed external event injection (HIGH)
- `<Timer>` — durable timer primitive (HIGH)
- `<Sandbox>` — isolated execution environments (MEDIUM)
- `<ContinueAsNew>` — long-running loop state management (MEDIUM)

### Missing guide pages
- Effect usage guide — 24 Effect modules, zero documentation (HIGH)
- Gateway comprehensive guide — WebSocket protocol, RPC reference, bot-server
  narrative (HIGH — Codex agent may be writing this now)
- Third-party React hooks — TanStack Query, zustand, Vercel AI SDK
- GitHub bot guide — webhook setup, PR automation, check reporting
- Common tools integration — GitHub, Linear, Notion, Slack, Obsidian

### Broken import paths in docs
- `smithers-orchestrator/memory` used in 8 doc files but NOT in package.json
  exports — users get import errors. Fix: add `"./memory"` to exports.

## Severity

**HIGH** — Users cannot discover existing features and will hit import errors.
