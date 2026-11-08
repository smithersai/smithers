# 0002. The core is an Effect API

**Status:** accepted, 2026-11-07. **Rulings:** VL-10, VL-26.

**Decision.** One Effect service, `Factory` (`src/core/Factory.vibe`), is the whole API: `post` records a person's
message and `events` streams a conversation's numbered events. The web app, the CLI, the MCP server and the skill are
clients that differ only in the layer they provide: `MockFactory` (0004) or `LiveFactory` (0010).

```
web (Foldkit) ─┐
CLI ───────────┤
MCP server ────┼──▶ Factory service ──▶ MockFactory | LiveFactory ──▶ Worker ──▶ Conversation Durable Object
skill ─────────┘
```

**Why.** Every surface must be testable (VL-10), and an agent must work in the app while Will does (VL-26). A
service with two layers gives each surface one seam to test, and the same mock everywhere.

**Prior art.** incur (`~/incur`) defines one command set and serves it as a CLI, an MCP server and skills; our
surfaces copy that shape on Effect, per VL-10.
