# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this codebase.

## Project Overview

Smithers is a Python framework for composing LLM agents into type-safe, cacheable, parallel workflows. It uses Pydantic for validation and uv for package management.

## Architecture Principles

1. **Plan before execute** — `build_graph()` produces a frozen plan. Execution only consumes it.
2. **SQLite as system of record** — All state (runs, cache, events, approvals) lives in SQLite.
3. **Verification + visibility** — Every step is validated, hashed, logged, and queryable.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Key Components

- **Workflows** — Async functions decorated with `@workflow` that return Pydantic models
- **Ralph Loops** — Declarative iteration via `ralph_loop()` that preserves DAG model
- **Composition** — Build complex workflows with `chain`, `parallel`, `branch`, `map_workflow`, `reduce_workflow`
- **Registry** — Maps output types to workflows for dependency resolution
- **GraphBuilder** — Constructs frozen `WorkflowGraph` plans from workflows
- **ExecutionEngine** — Runs graphs level-by-level with parallel execution
- **SqliteStore** — Persistent cache, runs, events, approvals, and loop iterations
- **ClaudeProvider** — LLM integration with tool loop and structured output
- **Visualization** — Enhanced graph visualization with ASCII art, status colors, and real-time progress
- **MetricsCollector** — Prometheus/OpenTelemetry metrics export for production monitoring
- **WebSocketServer** — Real-time progress updates for web UIs via WebSocket
- **TimeoutPolicy** — Per-workflow and global timeout handling to prevent runaway execution

## Commands

```bash
# Build everything
zig build

# Run the app (Ghostty terminal)
zig build run

# Run Python tests
zig build test

# Type check Python
zig build check

# Lint Python
zig build lint

# Format all code
zig build fmt

# Build Ghostty only
zig build ghostty

# Clean build artifacts
zig build clean

# Run a workflow directly
uv run python examples/01_hello_world.py
```

## Project Structure

```
smithers/
├── src/smithers/
│   ├── __init__.py      # Public API exports
│   ├── core/
│   │   ├── types.py     # NodeStatus, RunStatus, RetryPolicy
│   │   ├── workflow.py  # @workflow decorator, Workflow wrapper
│   │   ├── registry.py  # WorkflowRegistry
│   │   ├── graph.py     # WorkflowGraph, GraphNode, DepBinding
│   │   ├── builder.py   # build_graph algorithm
│   │   ├── executor.py  # run_graph execution engine
│   │   ├── events.py    # Event models
│   │   └── hashing.py   # Canonical JSON + hashing
│   ├── llm/
│   │   ├── provider.py  # LLMProvider protocol
│   │   └── claude.py    # Claude implementation
│   ├── tools/
│   │   ├── base.py      # Tool protocol
│   │   ├── registry.py  # ToolRegistry
│   │   └── builtins/    # Read, Edit, Bash
│   ├── store/
│   │   └── sqlite.py    # SqliteStore
│   └── approvals/
│       └── cli.py       # CLI approval provider
├── tests/
├── examples/
├── docs/                # Mintlify documentation
├── ARCHITECTURE.md      # Full architecture design
├── pyproject.toml
└── README.md
```

## Code Style

- Python 3.12+
- Type hints on all public functions
- Pydantic models for all data structures
- Async-first (use `async def` for workflows)
- Dataclasses with `frozen=True` for immutable data

## Key Patterns

### Workflow Definition
```python
from smithers import workflow, claude
from pydantic import BaseModel

class Output(BaseModel):
    result: str

@workflow
async def my_workflow() -> Output:
    return await claude("Do something", output=Output)
```

### Dependencies via Type Hints
```python
@workflow
async def step_two(step_one_output: StepOneOutput) -> StepTwoOutput:
    # step_one_output is automatically resolved from registry
    ...
```

### Graph Execution
```python
from smithers import build_graph, run_graph, SqliteCache

graph = build_graph(final_workflow)  # Frozen plan
result = await run_graph(graph, cache=SqliteCache("./cache.db"))
```

### Ralph Loops (Declarative Iteration)
```python
from smithers import workflow, ralph_loop, claude

@workflow
async def review_and_revise(code: CodeOutput) -> CodeOutput:
    review = await claude(f"Review: {code.code}", output=ReviewOutput)
    if review.approved:
        return CodeOutput(code=code.code, approved=True)
    return await claude(f"Fix: {review.feedback}", output=CodeOutput)

# Loop until approved (max 5 iterations)
review_loop = ralph_loop(
    review_and_revise,
    until=lambda r: r.approved,
    max_iterations=5,
)
```

### Workflow Composition
```python
from smithers import chain, parallel, branch, map_workflow, compose_graphs

# Chain workflows sequentially
pipeline = chain(analyze, implement, test)

# Run workflows in parallel and collect results
class ReviewResults(BaseModel):
    lint: LintOutput
    test: TestOutput

review = parallel(lint_workflow, test_workflow, collect_as=ReviewResults)

# Conditional branching
approval_flow = branch(
    condition=lambda x: x.score > 80,
    if_true=auto_approve,
    if_false=manual_review,
    input_type=ScoreOutput,
)

# Map over multiple inputs
analyze_all = map_workflow(analyze_file)  # list[FileInput] -> list[FileAnalysis]

# Merge multiple graphs
combined = compose_graphs(graph1, graph2, target="deploy")
```

### Prometheus/OpenTelemetry Metrics
```python
from smithers import get_metrics_collector, MetricsCollector

# Get global collector and attach to EventBus
collector = get_metrics_collector()
collector.attach_to_event_bus()

# Start HTTP server for Prometheus scraping
collector.start_server(port=9090)  # http://localhost:9090/metrics

# Or export manually
print(collector.export_prometheus())

# Convenience functions for manual recording
from smithers import record_workflow_run, record_llm_call
record_workflow_run("my_workflow", "success", duration_seconds=1.5)
record_llm_call("claude-3-opus", input_tokens=1000, output_tokens=500)
```

### WebSocket Real-Time Updates
```python
from smithers import get_websocket_server, WebSocketServer

# Get global server and start it
server = get_websocket_server()
await server.start(host="localhost", port=8765)

# Server automatically subscribes to EventBus
# All workflow events are broadcast to connected clients

# Manually broadcast messages
await server.broadcast({"type": "custom", "data": "hello"})

# Send to specific client
await server.send_to_client(client_id, {"type": "direct"})

# Stop the server
await server.stop()
```

Client protocol (JSON over WebSocket):
- Subscribe to run: `{"action": "subscribe", "run_id": "run-123"}`
- Filter events: `{"action": "filter", "event_types": ["NodeStarted", "NodeFinished"]}`
- Ping/heartbeat: `{"action": "ping"}`

### Timeout Handling
```python
from smithers import workflow, timeout, run_graph_with_store
from datetime import timedelta

# Per-workflow timeout
@workflow
@timeout(seconds=30)
async def quick_task() -> Output:
    ...

# Timeout with timedelta
@workflow
@timeout(timedelta(minutes=5))
async def longer_task() -> Output:
    ...

# Skip on timeout instead of failing
@workflow
@timeout(60, on_timeout="skip")
async def optional_task() -> Output:
    ...

# Global graph timeout
result = await run_graph_with_store(graph, timeout=300)  # 5 minutes

# Default timeout for all nodes
result = await run_graph_with_store(graph, node_timeout=30)
```

Events: `NodeTimedOut`, `RunTimedOut`

## System Invariants

- **I1**: WorkflowGraph must be a DAG (cycle detection at plan time). Ralph loops are single nodes that internally iterate.
- **I2**: Each node's output is validated at runtime (Pydantic TypeAdapter)
- **I3**: Every node run is content-addressed: `cache_key = H(workflow_id + code_hash + input_hash + runtime_hash)`
- **I4**: Every state transition is persisted to SQLite
- **I5**: Cache entries must be schema-valid and hash-consistent
- **I6**: Approvals are persisted gates; execution can pause and resume
- **I7**: Ralph loop iterations are individually tracked with their own events and timing
- **I8**: Workflows timeout if exceeding configured limits; timeouts can fail, skip, or cancel the node

## Testing

- Use pytest with pytest-asyncio
- Mock Claude with `FakeLLMProvider` for deterministic tests
- Test graphs without execution using `build_graph`
- Workflows can be called directly for unit tests

## Dependencies

Core:
- `pydantic>=2.0` — Data validation and schemas
- `anthropic>=0.40` — Claude API client
- `aiosqlite>=0.20` — Async SQLite for storage

Optional:
- `websockets>=12.0` — WebSocket server for real-time updates (install with `pip install smithers[websocket]`)

Dev:
- `pytest` / `pytest-asyncio` — Testing
- `pyright` — Type checking
- `ruff` — Linting and formatting
