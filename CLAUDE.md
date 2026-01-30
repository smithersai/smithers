# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this codebase.

## Project Overview

Smithers is a Python framework for composing LLM agents into type-safe, cacheable, parallel workflows. It uses Pydantic for validation and uv for package management.

## Key Architecture

- **Workflows** — Async functions decorated with `@workflow` that return Pydantic models
- **Dependencies** — Inferred from function type hints (no manual wiring)
- **Graph** — Built automatically from dependency analysis, enables parallel execution
- **Caching** — SQLite-based, skips unchanged work based on input hashing

## Commands

```bash
# Install dependencies
uv sync

# Run tests
uv run pytest

# Type check
uv run pyright

# Lint
uv run ruff check .

# Format
uv run ruff format .

# Run a workflow
uv run python -m smithers run examples/simple.py
```

## Project Structure

```
smithers/
├── src/
│   └── smithers/
│       ├── __init__.py      # Public API exports
│       ├── workflow.py      # @workflow decorator
│       ├── graph.py         # Graph building and execution
│       ├── claude.py        # Claude LLM integration
│       ├── cache.py         # SQLite caching
│       └── types.py         # Core types
├── tests/
├── examples/
├── pyproject.toml
└── README.md
```

## Code Style

- Python 3.11+
- Type hints on all public functions
- Pydantic models for all data structures
- Async-first (use `async def` for workflows)
- No classes for workflows — plain functions with decorators

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
    # step_one_output is automatically resolved
    ...
```

### Graph Execution
```python
from smithers import build_graph, run_graph

graph = build_graph(final_workflow)  # Walks deps automatically
result = await run_graph(graph)
```

## Testing

- Use pytest with pytest-asyncio
- Mock Claude calls in unit tests
- Integration tests can use real Claude with `@pytest.mark.integration`

## Dependencies

Core:
- `pydantic` — Data validation and schemas
- `anthropic` — Claude API client
- `aiosqlite` — Async SQLite for caching

Dev:
- `pytest` / `pytest-asyncio` — Testing
- `pyright` — Type checking
- `ruff` — Linting and formatting
