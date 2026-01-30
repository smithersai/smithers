# Smithers Architecture Design Prompt

You are a senior software architect designing the internals of **Smithers**, a Python framework for composing LLM agents into type-safe, cacheable, parallel workflows.

## Context

Smithers is inspired by:
- **Bazel** — Explicit dependencies, automatic parallelization, caching based on input hashing
- **Pydantic** — Type-safe data validation and schemas
- **Effect.ts** — Composable, declarative execution

The core philosophy is: **"Build AI agent workflows the way you build software."**

## The User-Facing API (Already Designed)

Here's what users write:

```python
from pydantic import BaseModel
from smithers import workflow, claude, build_graph, run_graph

class AnalysisOutput(BaseModel):
    files: list[str]
    summary: str

class ImplementOutput(BaseModel):
    changed_files: list[str]

@workflow
async def analyze() -> AnalysisOutput:
    return await claude(
        "Analyze the codebase",
        tools=["Read", "Grep"],
        output=AnalysisOutput,
    )

@workflow
async def implement(analysis: AnalysisOutput) -> ImplementOutput:
    return await claude(
        f"Fix files: {analysis.files}",
        tools=["Read", "Edit"],
        output=ImplementOutput,
    )

# Build graph from target (deps resolved automatically)
graph = build_graph(implement)

# Visualize
print(graph.mermaid())

# Execute with caching
result = await run_graph(graph, cache=SqliteCache("./cache.db"))
```

### Key API Features

1. **`@workflow` decorator** — Marks async functions as workflows
2. **Dependencies via type hints** — `implement(analysis: AnalysisOutput)` means "I depend on whatever workflow produces `AnalysisOutput`"
3. **`claude()` function** — Calls Claude with optional tools and structured output
4. **`build_graph(target)` function** — Walks dependencies, returns a `WorkflowGraph`
5. **`run_graph(graph)` function** — Executes with automatic parallelization
6. **`SqliteCache`** — Caches workflow results, skips unchanged work
7. **`@require_approval` decorator** — Pauses for human confirmation

### Parallel Execution

```python
@workflow
async def lint(impl: ImplementOutput) -> LintOutput: ...

@workflow
async def test(impl: ImplementOutput) -> TestOutput: ...

@workflow
async def deploy(lint: LintOutput, test: TestOutput) -> DeployOutput: ...

# lint and test run in PARALLEL (both depend on implement, neither depends on the other)
# Graph levels: [implement] → [lint, test] → [deploy]
```

### Caching

```python
cache = SqliteCache("./cache.db")

# First run: executes all
await run_graph(graph, cache=cache)

# Second run: skips workflows with unchanged inputs
await run_graph(graph, cache=cache)  # Instant if nothing changed
```

### Human-in-the-Loop

```python
@workflow
@require_approval("Deploy to production?")
async def deploy(impl: ImplementOutput) -> DeployOutput:
    ...
```

---

## Your Task

Design the complete internal architecture to make this API work. Answer ALL of the following questions with detailed, implementable specifications.

---

## Questions to Answer

### 1. The `@workflow` Decorator

**What does `@workflow` do internally?**

- What does it return? A `Workflow` object? The original function wrapped?
- How do we track the output type (`-> AnalysisOutput`)?
- How do we track the input types (function parameter annotations)?
- Is there a global registry? How does it work?

```python
@workflow
async def analyze() -> AnalysisOutput:
    ...

# After decoration:
# - type(analyze) = ?
# - How can we call it directly for testing?
# - How do we introspect its dependencies?
```

### 2. Workflow Registry & Discovery

**How does `build_graph` find workflows by output type?**

When we see:
```python
@workflow
async def implement(analysis: AnalysisOutput) -> ImplementOutput:
    ...
```

How do we find the workflow that produces `AnalysisOutput`?

Options to consider:
- Global registry mapping `OutputType → Workflow`
- Module scanning
- Explicit workflow set passed to `build_graph`
- Something else?

**What happens if:**
- Multiple workflows produce the same output type?
- No workflow produces a required type?
- There's a circular dependency?

### 3. The `WorkflowGraph` Data Structure

**What exactly is a `WorkflowGraph`?**

```python
graph = build_graph(deploy)
```

Define the data structure:
- What fields does it have?
- How are nodes represented?
- How are edges represented?
- How are "levels" (parallelization groups) computed?
- How is it serializable (for caching, visualization)?

### 4. The `build_graph` Algorithm

**How does `build_graph` construct the graph?**

Write pseudocode for:
1. Starting from the target workflow
2. Recursively discovering dependencies
3. Building the node and edge sets
4. Computing topological levels for parallel execution
5. Detecting cycles

### 5. The `run_graph` Execution Engine

**How does `run_graph` execute workflows?**

- How do we execute levels in parallel?
- How do we pass outputs from one workflow to its dependents?
- Where do we store intermediate results during execution?
- How do we handle errors in one branch?

```python
async def run_graph(graph: WorkflowGraph, cache: Cache | None = None) -> T:
    # What's the implementation?
```

### 6. The `claude()` Function

**What does `claude()` do?**

```python
await claude(
    "Do something",
    tools=["Read", "Edit", "Bash"],
    output=OutputModel,
)
```

- Is this a single API call or an agentic loop?
- How do tools work? Are they real functions or just names?
- How is the Pydantic model used for structured output?
- How do we handle streaming/progress updates?
- How do we configure the model, API key, etc.?

### 7. Tools System

**How does `tools=["Read", "Edit", "Bash"]` work?**

- Are these string names mapped to implementations?
- Where are tool implementations defined?
- Can users define custom tools?
- How do tools relate to Claude's function calling / tool use API?

### 8. Caching System

**How does `SqliteCache` work?**

- What's the SQLite schema?
- How do we compute cache keys (input hashing)?
- What's hashed? (prompt, tools, deps outputs, workflow source code?)
- How do we invalidate cache?
- How do we handle cache hits vs misses during `run_graph`?

### 9. Human-in-the-Loop

**How does `@require_approval` work?**

```python
@workflow
@require_approval("Deploy to production?")
async def deploy(...) -> ...:
    ...
```

- How do we pause execution?
- How do we resume after approval?
- What's the UI/UX for approval? (CLI prompt? Web hook? Polling?)
- Can the workflow be serialized and resumed later?

### 10. Error Handling

**How do we handle failures?**

- What happens if a workflow raises an exception?
- Do we retry? With backoff?
- Do we cancel parallel branches if one fails?
- How do we surface errors to the user?

### 11. Observability & Progress

**How do users see what's happening?**

- Progress callbacks?
- Logging?
- Events/hooks?
- How do we track token usage, costs, timing?

### 12. Testing

**How do users test workflows?**

- Can workflows be called directly without `run_graph`?
- How do we mock `claude()` calls?
- How do we test the graph structure without executing?

---

## Additional Constraints

- **Python 3.12+** — Use modern Python features
- **Async-first** — All workflows are async
- **Pydantic v2** — Use for all data models
- **Type-safe** — Full type hints, pyright strict mode
- **No magic** — Prefer explicit over implicit

---

## Deliverables

Please provide:

1. **Architecture Overview** — High-level diagram and component descriptions
2. **Data Structures** — Complete type definitions for all core types
3. **Algorithm Pseudocode** — For `build_graph` and `run_graph`
4. **Module Structure** — What files go where
5. **Sequence Diagrams** — For key flows (graph building, execution, caching)
6. **Edge Cases** — How each edge case is handled
7. **Open Questions** — Anything you think needs further discussion

---

## Example Workflows to Support

Make sure your architecture supports all of these:

### Simple
```python
@workflow
async def hello() -> Greeting:
    return await claude("Say hi", output=Greeting)
```

### Dependencies
```python
@workflow
async def step1() -> A: ...

@workflow
async def step2(a: A) -> B: ...

@workflow
async def step3(b: B) -> C: ...
```

### Parallel
```python
@workflow
async def base() -> Base: ...

@workflow
async def branch1(b: Base) -> B1: ...

@workflow
async def branch2(b: Base) -> B2: ...

@workflow
async def merge(b1: B1, b2: B2) -> Final: ...
```

### Conditional Skip
```python
@workflow
async def maybe_deploy(tests: TestResult) -> DeployResult | None:
    if not tests.passed:
        return skip("Tests failed")
    return await claude("Deploy", output=DeployResult)
```

### Human Approval
```python
@workflow
@require_approval("Proceed with deployment?")
async def deploy(impl: Impl) -> Deploy: ...
```

### Cached
```python
cache = SqliteCache("./cache.db")
result = await run_graph(graph, cache=cache)
```

---

Think deeply about this. Take your time. Produce a complete, implementable architecture.
