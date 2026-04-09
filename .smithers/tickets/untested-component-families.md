# Zero test coverage for Saga, Poller, AI orchestration, and DevOps components

## Problem

Multiple entire component families ship with zero runtime tests.

### Flow control (ZERO tests)
- **Saga** (7 features): compensation, on-failure modes, declarative steps, JSX children
- **Poller** (7 features): backoff strategies, timeout modes, check compute
- **TryCatchFinally** (2 features): error code filtering

### AI orchestration (29 features, ZERO tests)
- Supervisor component, SuperSmithers, Debate, Panel, ReviewLoop,
  ClassifyAndRoute, GatherAndSynthesize, Optimizer, DecisionTable

### DevOps automation (30 features, ZERO tests)
- CheckSuite, Kanban, Runbook, ScanFixVerify, DriftDetector, ContentPipeline

### Cross-cutting concerns (14 features, ZERO tests)
- Aspects, token budgets, cost budgets, latency SLOs

### MCP semantic tools (13 of 14 operations untested)
- Only `listTools` tested. No tests for run, watch, explain, approvals, etc.

## Proposed solution

1. P0: Runtime tests for Saga, Poller, TryCatchFinally, WaitForEvent
2. P0: One E2E test per AI orchestration component
3. P0: One E2E test per DevOps automation component
4. P1: Test Aspects/cross-cutting concerns
5. P1: Test MCP semantic tool operations

## Severity

**HIGH** — Core features shipping without any test proving they work.
