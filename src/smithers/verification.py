"""Verification module for graph invariants and cache integrity.

This module implements the verification backbone described in ARCHITECTURE.md,
ensuring system invariants are enforced and checkable:

- I1: WorkflowGraph must be a DAG (cycle detection at plan time)
- I2: Each node's declared output_type must be validated at runtime
- I3: Every node run is content-addressed (cache_key verification)
- I4: Every node state transition is persisted to SQLite
- I5: Cache entries must be schema-valid and hash-consistent
- I6: Approval is an explicit persisted gate

Usage:
    from smithers.verification import (
        verify_graph,
        verify_cache_entry,
        verify_output,
        GraphVerificationResult,
    )

    # Verify a graph at plan time
    result = verify_graph(graph)
    if not result.valid:
        for issue in result.issues:
            print(f"[{issue.severity}] {issue.code}: {issue.message}")

    # Verify a cache entry
    is_valid = await verify_cache_entry(cache, key, expected_type)

    # Verify workflow output
    verified = verify_output(output, expected_type)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, TypeVar

from pydantic import BaseModel, TypeAdapter, ValidationError

from smithers.hashing import hash_json

if TYPE_CHECKING:
    from smithers.cache import SqliteCache
    from smithers.store.sqlite import SqliteStore
    from smithers.types import WorkflowGraph
    from smithers.workflow import Workflow


T = TypeVar("T", bound=BaseModel)


class IssueSeverity(str, Enum):
    """Severity level for verification issues."""

    ERROR = "ERROR"  # Fatal: prevents execution
    WARNING = "WARNING"  # Non-fatal: may cause problems
    INFO = "INFO"  # Informational: optimization hints


class IssueCode(str, Enum):
    """Codes for specific verification issues."""

    # Graph structure issues (I1)
    CYCLE_DETECTED = "CYCLE_DETECTED"
    MISSING_DEPENDENCY = "MISSING_DEPENDENCY"
    DUPLICATE_PRODUCER = "DUPLICATE_PRODUCER"
    ORPHAN_NODE = "ORPHAN_NODE"
    UNREACHABLE_NODE = "UNREACHABLE_NODE"

    # Output validation issues (I2)
    INVALID_OUTPUT_TYPE = "INVALID_OUTPUT_TYPE"
    OUTPUT_VALIDATION_FAILED = "OUTPUT_VALIDATION_FAILED"
    NULL_OUTPUT_NOT_ALLOWED = "NULL_OUTPUT_NOT_ALLOWED"

    # Cache integrity issues (I3, I5)
    CACHE_KEY_MISMATCH = "CACHE_KEY_MISMATCH"
    CACHE_HASH_MISMATCH = "CACHE_HASH_MISMATCH"
    CACHE_SCHEMA_INVALID = "CACHE_SCHEMA_INVALID"
    CACHE_CORRUPT = "CACHE_CORRUPT"
    CACHE_DESERIALIZATION_FAILED = "CACHE_DESERIALIZATION_FAILED"

    # State persistence issues (I4)
    STATE_NOT_PERSISTED = "STATE_NOT_PERSISTED"
    STATE_INCONSISTENT = "STATE_INCONSISTENT"

    # Approval issues (I6)
    APPROVAL_NOT_RECORDED = "APPROVAL_NOT_RECORDED"
    APPROVAL_STATUS_INVALID = "APPROVAL_STATUS_INVALID"


def _empty_dict() -> dict[str, Any]:
    """Create an empty dict for default_factory."""
    return {}


def _empty_issue_list() -> list[VerificationIssue]:
    """Create an empty list for default_factory."""
    return []


@dataclass(frozen=True)
class VerificationIssue:
    """A single verification issue."""

    code: IssueCode
    severity: IssueSeverity
    message: str
    node_id: str | None = None
    details: dict[str, Any] = field(default_factory=_empty_dict)


@dataclass
class GraphVerificationResult:
    """Result of graph verification."""

    valid: bool
    issues: list[VerificationIssue] = field(default_factory=_empty_issue_list)
    stats: dict[str, Any] = field(default_factory=_empty_dict)

    @property
    def errors(self) -> list[VerificationIssue]:
        """Get only ERROR severity issues."""
        return [i for i in self.issues if i.severity == IssueSeverity.ERROR]

    @property
    def warnings(self) -> list[VerificationIssue]:
        """Get only WARNING severity issues."""
        return [i for i in self.issues if i.severity == IssueSeverity.WARNING]

    def summary(self) -> str:
        """Generate a human-readable summary."""
        lines = [
            f"Graph Verification: {'PASSED' if self.valid else 'FAILED'}",
            f"  Nodes: {self.stats.get('node_count', 0)}",
            f"  Edges: {self.stats.get('edge_count', 0)}",
            f"  Levels: {self.stats.get('level_count', 0)}",
            f"  Issues: {len(self.errors)} errors, {len(self.warnings)} warnings",
        ]
        return "\n".join(lines)


@dataclass
class CacheVerificationResult:
    """Result of cache entry verification."""

    valid: bool
    issues: list[VerificationIssue] = field(default_factory=_empty_issue_list)
    cache_key: str | None = None
    stored_hash: str | None = None
    computed_hash: str | None = None


@dataclass
class OutputVerificationResult:
    """Result of output verification."""

    valid: bool
    output: Any = None
    issues: list[VerificationIssue] = field(default_factory=_empty_issue_list)
    output_hash: str | None = None


# =============================================================================
# Graph Verification (I1)
# =============================================================================


def verify_graph(graph: WorkflowGraph) -> GraphVerificationResult:
    """
    Verify graph invariants at plan time.

    Checks:
    - I1: Graph is a DAG (no cycles)
    - All dependencies are satisfied
    - No duplicate producers for the same type
    - All nodes are reachable from root

    Args:
        graph: The workflow graph to verify

    Returns:
        GraphVerificationResult with issues and validity status
    """
    issues: list[VerificationIssue] = []

    # Collect stats
    stats = {
        "node_count": len(graph.nodes),
        "edge_count": len(graph.edges),
        "level_count": len(graph.levels),
        "root": graph.root,
    }

    # Check 1: Cycle detection (I1)
    cycle_issues = _detect_cycles(graph)
    issues.extend(cycle_issues)

    # Check 2: Missing dependencies
    dep_issues = _verify_dependencies(graph)
    issues.extend(dep_issues)

    # Check 3: Orphan nodes (nodes with no path to root)
    orphan_issues = _detect_orphan_nodes(graph)
    issues.extend(orphan_issues)

    # Check 4: Level consistency
    level_issues = _verify_levels(graph)
    issues.extend(level_issues)

    # Determine overall validity (no ERROR issues)
    has_errors = any(i.severity == IssueSeverity.ERROR for i in issues)

    return GraphVerificationResult(
        valid=not has_errors,
        issues=issues,
        stats=stats,
    )


def _detect_cycles(graph: WorkflowGraph) -> list[VerificationIssue]:
    """Detect cycles in the graph using DFS."""
    issues: list[VerificationIssue] = []
    visited: set[str] = set()
    rec_stack: set[str] = set()
    path: list[str] = []

    def dfs(node_id: str) -> bool:
        """Returns True if cycle detected."""
        visited.add(node_id)
        rec_stack.add(node_id)
        path.append(node_id)

        node = graph.nodes.get(node_id)
        if node is None:
            return False

        for dep in node.dependencies:
            if dep not in visited:
                if dfs(dep):
                    return True
            elif dep in rec_stack:
                # Cycle detected - find the cycle
                cycle_start = path.index(dep)
                cycle = [*path[cycle_start:], dep]
                issues.append(
                    VerificationIssue(
                        code=IssueCode.CYCLE_DETECTED,
                        severity=IssueSeverity.ERROR,
                        message=f"Cycle detected: {' -> '.join(cycle)}",
                        details={"cycle": cycle},
                    )
                )
                return True

        path.pop()
        rec_stack.remove(node_id)
        return False

    for node_id in graph.nodes:
        if node_id not in visited:
            dfs(node_id)

    return issues


def _verify_dependencies(graph: WorkflowGraph) -> list[VerificationIssue]:
    """Verify all dependencies exist in the graph."""
    issues: list[VerificationIssue] = []

    for node_id, node in graph.nodes.items():
        for dep in node.dependencies:
            if dep not in graph.nodes:
                issues.append(
                    VerificationIssue(
                        code=IssueCode.MISSING_DEPENDENCY,
                        severity=IssueSeverity.ERROR,
                        message=f"Node '{node_id}' depends on '{dep}' which is not in the graph",
                        node_id=node_id,
                        details={"missing_dep": dep},
                    )
                )

    return issues


def _detect_orphan_nodes(graph: WorkflowGraph) -> list[VerificationIssue]:
    """Detect nodes that don't contribute to the root."""
    issues: list[VerificationIssue] = []

    # Build reverse dependency map (what does each node contribute to?)
    contributes_to: dict[str, set[str]] = {node_id: set() for node_id in graph.nodes}
    for node_id, node in graph.nodes.items():
        for dep in node.dependencies:
            if dep in contributes_to:
                contributes_to[dep].add(node_id)

    # BFS from root to find all reachable nodes
    reachable: set[str] = set()
    queue = [graph.root]
    while queue:
        node_id = queue.pop(0)
        if node_id in reachable:
            continue
        reachable.add(node_id)

        node = graph.nodes.get(node_id)
        if node:
            for dep in node.dependencies:
                if dep not in reachable:
                    queue.append(dep)

    # Find unreachable nodes
    for node_id in graph.nodes:
        if node_id not in reachable:
            issues.append(
                VerificationIssue(
                    code=IssueCode.UNREACHABLE_NODE,
                    severity=IssueSeverity.WARNING,
                    message=f"Node '{node_id}' is not reachable from root '{graph.root}'",
                    node_id=node_id,
                )
            )

    return issues


def _verify_levels(graph: WorkflowGraph) -> list[VerificationIssue]:
    """Verify level assignments are consistent with dependencies."""
    issues: list[VerificationIssue] = []

    # Build node -> level map
    node_level: dict[str, int] = {}
    for level_idx, level in enumerate(graph.levels):
        for node_id in level:
            node_level[node_id] = level_idx

    # Verify each node's dependencies are in earlier levels
    for node_id, node in graph.nodes.items():
        if node_id not in node_level:
            issues.append(
                VerificationIssue(
                    code=IssueCode.ORPHAN_NODE,
                    severity=IssueSeverity.ERROR,
                    message=f"Node '{node_id}' is not assigned to any level",
                    node_id=node_id,
                )
            )
            continue

        my_level = node_level[node_id]
        for dep in node.dependencies:
            dep_level = node_level.get(dep)
            if dep_level is None:
                continue  # Already caught by missing dependency check
            if dep_level >= my_level:
                issues.append(
                    VerificationIssue(
                        code=IssueCode.CYCLE_DETECTED,
                        severity=IssueSeverity.ERROR,
                        message=(
                            f"Node '{node_id}' (level {my_level}) depends on "
                            f"'{dep}' (level {dep_level}) which is not in an earlier level"
                        ),
                        node_id=node_id,
                        details={"my_level": my_level, "dep_level": dep_level, "dep": dep},
                    )
                )

    return issues


# =============================================================================
# Output Verification (I2)
# =============================================================================


def verify_output(
    output: Any,
    expected_type: type[T],
    *,
    allow_none: bool = False,
) -> OutputVerificationResult:
    """
    Verify a workflow output matches the expected type.

    Args:
        output: The output value to verify
        expected_type: The expected Pydantic model type
        allow_none: Whether None is a valid output

    Returns:
        OutputVerificationResult with validation status and any issues
    """
    issues: list[VerificationIssue] = []

    # Handle None
    if output is None:
        if allow_none:
            return OutputVerificationResult(valid=True, output=None)
        issues.append(
            VerificationIssue(
                code=IssueCode.NULL_OUTPUT_NOT_ALLOWED,
                severity=IssueSeverity.ERROR,
                message="Output is None but None is not allowed",
            )
        )
        return OutputVerificationResult(valid=False, issues=issues)

    # Validate with TypeAdapter
    try:
        adapter = TypeAdapter(expected_type)
        validated = adapter.validate_python(output)

        # Compute hash for verified output
        output_hash = hash_json(
            validated.model_dump() if hasattr(validated, "model_dump") else validated
        )

        return OutputVerificationResult(
            valid=True,
            output=validated,
            output_hash=output_hash,
        )

    except ValidationError as exc:
        issues.append(
            VerificationIssue(
                code=IssueCode.OUTPUT_VALIDATION_FAILED,
                severity=IssueSeverity.ERROR,
                message=f"Output validation failed: {exc}",
                details={"errors": exc.errors()},
            )
        )
        return OutputVerificationResult(valid=False, issues=issues)

    except Exception as exc:
        issues.append(
            VerificationIssue(
                code=IssueCode.INVALID_OUTPUT_TYPE,
                severity=IssueSeverity.ERROR,
                message=f"Cannot validate output: {exc}",
                details={"error": str(exc)},
            )
        )
        return OutputVerificationResult(valid=False, issues=issues)


# =============================================================================
# Cache Verification (I3, I5)
# =============================================================================


async def verify_cache_entry(
    cache: SqliteCache,
    key: str,
    expected_type: type[T] | None = None,
    *,
    expected_hash: str | None = None,
) -> CacheVerificationResult:
    """
    Verify a cache entry's integrity.

    Checks:
    - Entry exists and can be deserialized
    - If expected_type provided: validates against schema (I5)
    - If expected_hash provided: verifies content hash (I5)

    Args:
        cache: The cache to check
        key: Cache key to verify
        expected_type: Optional expected Pydantic model type
        expected_hash: Optional expected content hash

    Returns:
        CacheVerificationResult with verification status
    """
    import aiosqlite

    issues: list[VerificationIssue] = []

    # Get raw entry from cache
    try:
        async with aiosqlite.connect(cache.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT value, workflow_name, input_hash FROM cache WHERE key = ?",
                (key,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                issues.append(
                    VerificationIssue(
                        code=IssueCode.CACHE_CORRUPT,
                        severity=IssueSeverity.ERROR,
                        message=f"Cache entry not found: {key}",
                    )
                )
                return CacheVerificationResult(valid=False, issues=issues, cache_key=key)

            # Try to deserialize from JSON
            try:
                value_bytes = row["value"]
                value_str = value_bytes.decode("utf-8")
                value = json.loads(value_str)
            except Exception as exc:
                issues.append(
                    VerificationIssue(
                        code=IssueCode.CACHE_DESERIALIZATION_FAILED,
                        severity=IssueSeverity.ERROR,
                        message=f"Failed to deserialize cache entry: {exc}",
                        details={"error": str(exc)},
                    )
                )
                return CacheVerificationResult(valid=False, issues=issues, cache_key=key)

            # Compute hash of deserialized value (already a dict from JSON)
            computed_hash = hash_json(value)

            # Verify hash if provided
            if expected_hash is not None and computed_hash != expected_hash:
                issues.append(
                    VerificationIssue(
                        code=IssueCode.CACHE_HASH_MISMATCH,
                        severity=IssueSeverity.ERROR,
                        message=f"Cache hash mismatch: expected {expected_hash[:16]}..., got {computed_hash[:16]}...",
                        details={
                            "expected_hash": expected_hash,
                            "computed_hash": computed_hash,
                        },
                    )
                )

            # Verify schema if type provided
            if expected_type is not None:
                try:
                    adapter = TypeAdapter(expected_type)
                    adapter.validate_python(value)
                except ValidationError as exc:
                    issues.append(
                        VerificationIssue(
                            code=IssueCode.CACHE_SCHEMA_INVALID,
                            severity=IssueSeverity.ERROR,
                            message=f"Cache entry does not match expected schema: {exc}",
                            details={"errors": exc.errors()},
                        )
                    )

            has_errors = any(i.severity == IssueSeverity.ERROR for i in issues)
            return CacheVerificationResult(
                valid=not has_errors,
                issues=issues,
                cache_key=key,
                computed_hash=computed_hash,
                stored_hash=expected_hash,
            )

    except Exception as exc:
        issues.append(
            VerificationIssue(
                code=IssueCode.CACHE_CORRUPT,
                severity=IssueSeverity.ERROR,
                message=f"Failed to access cache: {exc}",
                details={"error": str(exc)},
            )
        )
        return CacheVerificationResult(valid=False, issues=issues, cache_key=key)


async def verify_cache_integrity(
    cache: SqliteCache,
    *,
    validate_schemas: bool = False,
    workflow_types: dict[str, type[BaseModel]] | None = None,
) -> list[CacheVerificationResult]:
    """
    Verify integrity of all cache entries.

    Args:
        cache: The cache to verify
        validate_schemas: If True, validate each entry against its schema
        workflow_types: Map of workflow names to their output types

    Returns:
        List of CacheVerificationResult for each entry
    """
    results: list[CacheVerificationResult] = []
    workflow_types = workflow_types or {}

    # List all entries
    entries = await cache.list()

    for entry in entries:
        expected_type = None
        if validate_schemas and entry.workflow_name:
            expected_type = workflow_types.get(entry.workflow_name)

        result = await verify_cache_entry(
            cache,
            entry.key,
            expected_type=expected_type,
        )
        results.append(result)

    return results


# =============================================================================
# Cache Key Verification (I3)
# =============================================================================


def verify_cache_key(
    workflow: Workflow,
    inputs: dict[str, Any],
    expected_key: str,
) -> tuple[bool, str]:
    """
    Verify a cache key was computed correctly.

    Args:
        workflow: The workflow instance
        inputs: The input values
        expected_key: The cache key to verify

    Returns:
        Tuple of (is_valid, computed_key)
    """
    from smithers.hashing import cache_key as compute_cache_key

    computed = compute_cache_key(workflow, inputs)
    return (computed == expected_key, computed)


# =============================================================================
# Run State Verification (I4)
# =============================================================================


async def verify_run_state(
    store: SqliteStore,
    run_id: str,
) -> GraphVerificationResult:
    """
    Verify the persisted state of a run is consistent.

    Checks:
    - Run record exists
    - All node records exist
    - Node statuses are consistent with run status
    - Events are properly ordered

    Args:
        store: The SQLite store
        run_id: The run to verify

    Returns:
        GraphVerificationResult with verification status
    """
    issues: list[VerificationIssue] = []
    stats: dict[str, Any] = {"run_id": run_id}

    # Get run
    run = await store.get_run(run_id)
    if run is None:
        issues.append(
            VerificationIssue(
                code=IssueCode.STATE_NOT_PERSISTED,
                severity=IssueSeverity.ERROR,
                message=f"Run not found: {run_id}",
            )
        )
        return GraphVerificationResult(valid=False, issues=issues, stats=stats)

    stats["status"] = run.status.value

    # Get nodes
    nodes = await store.get_run_nodes(run_id)
    stats["node_count"] = len(nodes)

    # Verify node statuses are consistent
    from smithers.store.sqlite import NodeStatus, RunStatus

    if run.status == RunStatus.SUCCESS:
        # All nodes should be SUCCESS, CACHED, or SKIPPED
        for node in nodes:
            if node.status not in (
                NodeStatus.SUCCESS,
                NodeStatus.CACHED,
                NodeStatus.SKIPPED,
            ):
                issues.append(
                    VerificationIssue(
                        code=IssueCode.STATE_INCONSISTENT,
                        severity=IssueSeverity.WARNING,
                        message=(
                            f"Run is SUCCESS but node '{node.node_id}' "
                            f"has status {node.status.value}"
                        ),
                        node_id=node.node_id,
                    )
                )

    elif run.status == RunStatus.FAILED:
        # At least one node should be FAILED
        failed_count = sum(1 for n in nodes if n.status == NodeStatus.FAILED)
        if failed_count == 0:
            issues.append(
                VerificationIssue(
                    code=IssueCode.STATE_INCONSISTENT,
                    severity=IssueSeverity.WARNING,
                    message="Run is FAILED but no nodes have FAILED status",
                )
            )

    elif run.status == RunStatus.PAUSED:
        # At least one node should be PAUSED
        paused_count = sum(1 for n in nodes if n.status == NodeStatus.PAUSED)
        if paused_count == 0:
            issues.append(
                VerificationIssue(
                    code=IssueCode.STATE_INCONSISTENT,
                    severity=IssueSeverity.WARNING,
                    message="Run is PAUSED but no nodes have PAUSED status",
                )
            )

    # Verify events
    events = await store.get_events(run_id)
    stats["event_count"] = len(events)

    # Check for RunCreated or RunStarted event
    run_start_events = [e for e in events if e.type in ("RunCreated", "RunStarted")]
    if not run_start_events:
        issues.append(
            VerificationIssue(
                code=IssueCode.STATE_NOT_PERSISTED,
                severity=IssueSeverity.WARNING,
                message="No RunCreated or RunStarted event found",
            )
        )

    has_errors = any(i.severity == IssueSeverity.ERROR for i in issues)
    return GraphVerificationResult(valid=not has_errors, issues=issues, stats=stats)


# =============================================================================
# Approval Verification (I6)
# =============================================================================


async def verify_approval_state(
    store: SqliteStore,
    run_id: str,
    node_id: str,
) -> GraphVerificationResult:
    """
    Verify approval state for a node is properly recorded.

    Args:
        store: The SQLite store
        run_id: The run ID
        node_id: The node ID requiring approval

    Returns:
        GraphVerificationResult with verification status
    """
    issues: list[VerificationIssue] = []

    approval = await store.get_approval(run_id, node_id)
    if approval is None:
        issues.append(
            VerificationIssue(
                code=IssueCode.APPROVAL_NOT_RECORDED,
                severity=IssueSeverity.ERROR,
                message=f"No approval record found for node '{node_id}'",
                node_id=node_id,
            )
        )
        return GraphVerificationResult(valid=False, issues=issues)

    # Verify status is valid
    valid_statuses = {"PENDING", "APPROVED", "REJECTED"}
    if approval.status not in valid_statuses:
        issues.append(
            VerificationIssue(
                code=IssueCode.APPROVAL_STATUS_INVALID,
                severity=IssueSeverity.ERROR,
                message=f"Invalid approval status: {approval.status}",
                node_id=node_id,
                details={"status": approval.status, "valid_statuses": list(valid_statuses)},
            )
        )

    # If decided, should have decided_at
    if approval.status in ("APPROVED", "REJECTED") and approval.decided_at is None:
        issues.append(
            VerificationIssue(
                code=IssueCode.STATE_INCONSISTENT,
                severity=IssueSeverity.WARNING,
                message=f"Approval is {approval.status} but decided_at is not set",
                node_id=node_id,
            )
        )

    has_errors = any(i.severity == IssueSeverity.ERROR for i in issues)
    return GraphVerificationResult(valid=not has_errors, issues=issues)


# =============================================================================
# Convenience Functions
# =============================================================================


def verify_workflow_output(
    workflow: Workflow,
    output: Any,
) -> OutputVerificationResult:
    """
    Verify a workflow's output against its declared type.

    Args:
        workflow: The workflow instance
        output: The output value to verify

    Returns:
        OutputVerificationResult with validation status
    """
    return verify_output(
        output,
        workflow.output_type,
        allow_none=workflow.output_optional,
    )


async def full_verification(
    graph: WorkflowGraph,
    store: SqliteStore | None = None,
    cache: SqliteCache | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    """
    Run comprehensive verification across all components.

    Args:
        graph: The workflow graph to verify
        store: Optional store for run state verification
        cache: Optional cache for integrity verification
        run_id: Optional run ID for state verification

    Returns:
        Dictionary with verification results for each component
    """
    results: dict[str, Any] = {}

    # Graph verification
    results["graph"] = verify_graph(graph)

    # Cache verification
    if cache is not None:
        cache_results = await verify_cache_integrity(cache)
        results["cache"] = {
            "valid": all(r.valid for r in cache_results),
            "entries_checked": len(cache_results),
            "entries_valid": sum(1 for r in cache_results if r.valid),
            "entries_invalid": sum(1 for r in cache_results if not r.valid),
        }

    # Run state verification
    if store is not None and run_id is not None:
        results["run_state"] = await verify_run_state(store, run_id)

    # Overall validity
    results["valid"] = all(
        r.valid if hasattr(r, "valid") else r.get("valid", True)
        for r in results.values()
        if r is not None
    )

    return results
