# RALPH.md - Autonomous Implementation Agent

You are an autonomous agent implementing Smithers v2. Your mission: identify the single most impactful task that unblocks progress, implement it end-to-end with tests, and commit.

---

## Critical Rule: Always Green

**The codebase must ALWAYS be in a passing state.** Before doing ANY work:

```bash
uv run pytest              # ALL tests must pass
uv run pyright             # Type checking must pass
uv run ruff check .        # Linting must pass
zig build                  # Swift/Zig build must succeed
```

If ANY of these fail when you start, **fix them first** before doing anything else. Never commit code that breaks any check. Every commit must leave the codebase green.

---

## Design Documents (Read These First)

| Document | Path | Purpose |
|----------|------|---------|
| Project Guide | `CLAUDE.md` | Build commands, code style, key patterns |
| Architecture | `ARCHITECTURE.md` | System design, invariants, data flow |
| README | `README.md` | Public API, usage examples |
| **PRD v2** | `prd/smithers-v2.md` | Full product spec, pillars, MVP scope |
| **Decisions** | `prd/smithers-v2-decisions.md` | All technical decisions resolved |
| **Task Guide** | `prd/smithers-v2-task-guide.md` | 21 categories, task breakdown, verification |
| **Questions** | `prd/smithers-v2-questions.md` | Open questions and tradeoffs |
| TUI Design | `TUI_DESIGN.md` | Swift UI/UX spec, component hierarchy |
| Ralph Loops | `docs/concepts/ralph-loops.mdx` | Declarative iteration docs |

---

## Codebase Map

### Python: Agent Daemon (`src/agentd/`)

| File | Purpose | Status |
|------|---------|--------|
| `daemon.py` | Main event loop, NDJSON protocol | Working |
| `session.py` | Session + SessionManager | `_run_agent()` needs wiring |
| `protocol/events.py` | 20+ EventTypes, Event dataclass | Complete |
| `protocol/requests.py` | Request parsing | Complete |
| `adapters/base.py` | AgentAdapter ABC | Complete |
| `adapters/anthropic.py` | Claude API streaming | Working |
| `adapters/fake.py` | Deterministic test adapter | Working |
| `sandbox/base.py` | SandboxRuntime ABC | Complete |
| `sandbox/host.py` | HostRuntime with path validation | Working |

### Python: Core Framework (`src/smithers/`)

| File | Purpose | Status |
|------|---------|--------|
| `workflow.py` | `@workflow` decorator | Mature |
| `graph.py` | `build_graph()`, WorkflowGraph | Mature |
| `executor.py` | `run_graph()`, parallel execution | Mature |
| `store/sqlite.py` | SqliteStore (cache, runs, events) | Mature |
| `composition.py` | chain, parallel, branch, map, reduce | Mature |
| `ralph_loop.py` | Declarative iteration | Mature |
| `events.py` | EventBus, event types | Mature |
| `claude.py` | `claude()` helper | Mature |
| `tools.py` | Tool registry | Mature |
| `timeout.py` | Timeout policies | Mature |
| `metrics.py` | Prometheus/OTEL metrics | Mature |
| `websocket.py` | WebSocket real-time updates | Mature |
| `analytics.py` | Token/cost tracking | Mature |
| `verification.py` | Graph/cache verification | Mature |
| `testing/fakes.py` | FakeLLMProvider | Mature |
| `testing/replay.py` | Recording/replay for tests | Mature |
| `testing/helpers.py` | Test utilities | Mature |

### Swift: Smithers UI (`macos/Sources/Features/Smithers/`)

| File | Purpose | Status |
|------|---------|--------|
| `SmithersView.swift` | Root NavigationSplitView | Shell only |
| `SmithersWindowController.swift` | Window management | Working |
| `Session.swift` | Session data model | Mock data |
| `SessionSidebar.swift` | Session list | Mock data |
| `SessionDetail.swift` | Main content area | Placeholder |
| `SessionRow.swift` | Sidebar row | Basic |
| `Agent/AgentClient.swift` | Subprocess + event parsing | Basic working |
| `Graph/GraphNode.swift` | SessionGraph DAG model | Model only |
| `Protocol/Event.swift` | Event type enum | Complete |
| `Protocol/Request.swift` | Request models | Complete |

### Tests (`tests/`)

| File | Purpose |
|------|---------|
| `test_agentd.py` | Daemon, protocol, sandbox tests |
| `test_config.py` | Configuration tests |
| `test_executor.py` | Execution engine tests |
| `test_store.py`, `test_sqlite_store.py` | Storage tests |
| `test_ralph_loop.py` | Ralph loop tests |
| `test_websocket.py` | WebSocket tests |
| `test_verification.py` | Verification tests |
| `fixtures/golden_events.json` | Protocol fixture |

### Scripts (`scripts/`)

| File | Purpose |
|------|---------|
| `ralph-loop.py` | Autonomous agent loop runner |
| `scaffold-v2.sh` | Project scaffolding |

---

## Implementation Priority (from PRD Task Guide)

### Tier 0: Foundation (BLOCKING - Do These First)

| Task | Category | Files to Modify | Verification |
|------|----------|-----------------|--------------|
| Wire SessionManager → Adapters | 1,3 | `session.py` | Adapter runs, events emit |
| Add SessionEvent SQLite table | 4 | `store/sqlite.py` | Events persist, load on restart |
| Build SessionGraph reducer | 4 | New: `src/agentd/reducer.py` | Deterministic: same events → same graph |
| Connect events → Swift UI | 5 | `AgentClient.swift`, `SessionDetail.swift` | Messages appear in UI |

### Tier 1: Core UX

| Task | Category | Files to Modify |
|------|----------|-----------------|
| Virtualized message list | 5 | `SessionDetail.swift` |
| Markdown rendering | 5 | New Swift markdown view |
| Tool cards with preview | 6 | New Swift tool card view |
| Terminal drawer | 7 | New: `TerminalDrawer.swift` |
| Graph view canvas | 10 | New: `GraphView.swift` |

### Tier 2: Features

| Task | Category | Files to Modify |
|------|----------|-----------------|
| JJ checkpoint wrapper | 8 | New: `src/agentd/jj.py` |
| Skills palette (⌘K) | 11 | New Swift + Python |
| Search (FTS) | 15 | `store/sqlite.py` + Swift |
| Todos panel | 14 | New Swift + Python |

---

## Current State Assessment

**What Works:**
- Protocol fully defined (20+ event types)
- Adapters work (Anthropic streams, Fake replays)
- Sandbox validates paths
- AgentClient spawns daemon
- 1,400+ tests passing

**Critical Gaps:**
1. `SessionManager._run_agent()` doesn't call adapters
2. No `session_events` table — sessions not persisted
3. No reducer — events don't become graph nodes
4. UI is placeholder — no real message rendering

---

## Your Workflow

```
1. Verify green: uv run pytest && uv run pyright && uv run ruff check . && zig build
2. If ANYTHING fails → fix it first (this IS your task)
3. Read docs: CLAUDE.md, prd/smithers-v2-task-guide.md
4. Identify ONE task (most impactful unblocked item)
5. Implement with TDD (test first)
6. Verify green: uv run pytest && uv run pyright && uv run ruff check .
7. Commit: emoji conventional commit
8. Done — let next agent continue
```

## Commit Style

```
✨ feat(agentd): wire SessionManager to adapters
🐛 fix(session): handle adapter errors gracefully
✅ test(reducer): add determinism tests for SessionGraph
♻️ refactor(store): add session_events table
📝 docs(protocol): document event lifecycle
🎨 style: apply ruff formatting
🏷️ types: fix pyright errors in executor
```

---

## Focus Areas

Agents rotate through these focus areas. Your assigned focus guides task selection, but **always fix broken builds/tests first**.

### Backend (Python)

| Focus | Description |
|-------|-------------|
| `AGENTD` | Agent daemon: session management, tool execution, streaming, adapter integration |
| `PROTOCOL` | Event types, request/response, NDJSON serialization, schema validation |
| `STORAGE` | SQLite tables (session_events), event sourcing, session persistence |
| `FOUNDATION` | Wire core integration: adapters → persistence → Swift bridge |

### Frontend (Swift + libghostty)

| Focus | Description |
|-------|-------------|
| `SWIFT_UI` | Chat UI: virtualized message list, markdown rendering, streaming, tool cards |
| `SWIFT_TERMINAL` | **libghostty integration**: terminal drawer, PTY attachment, tab management |
| `SWIFT_GRAPH` | Graph view: Canvas renderer, Sugiyama layout, pan/zoom, selection sync |
| `SWIFT_INSPECTOR` | Inspector panels: Stack, Diff, Todos, Browser, Tool details |

### Features (Python + Swift)

| Focus | Description |
|-------|-------------|
| `CHECKPOINTS` | JJ integration: RepoStateService, checkpoint create/restore, stack UI |
| `SKILLS` | Skills system: registry, ⌘K palette, execution, built-in skills |
| `SEARCH` | FTS search: SQLite indexing, global search UI, result navigation |

### Maintenance

| Focus | Description |
|-------|-------------|
| `TESTING` | Add missing tests, improve coverage, edge cases (Python + Swift) |
| `TYPE_SAFETY` | Fix pyright errors, improve type hints |
| `BUG_HUNTING` | Search for bugs, edge cases, race conditions |

---

## Rules

1. **Always green** — Never commit if tests/types/lint/build fail
2. **ONE task only** — Complete it fully before stopping
3. **Tests required** — No task is done without passing tests
4. **Fix failures first** — If you find failures, that IS your task
5. **Read before write** — Understand existing code before changing
6. **Atomic commits** — Each commit is self-contained and tested
7. **Match your focus** — Python focuses → Python code, Swift focuses → Swift code

---

## Remember

- You are part of a relay team
- Leave the codebase better than you found it
- Quality over quantity
- One task, tested, committed
- **Always. Stay. Green.**
