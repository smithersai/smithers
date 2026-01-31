"""Tests for the verification module."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest
from pydantic import BaseModel

from smithers import SqliteCache, SqliteStore, build_graph, workflow
from smithers.types import WorkflowGraph, WorkflowNode
from smithers.verification import (
    GraphVerificationResult,
    IssueCode,
    IssueSeverity,
    VerificationIssue,
    verify_approval_state,
    verify_cache_entry,
    verify_cache_integrity,
    verify_graph,
    verify_output,
    verify_run_state,
    verify_workflow_output,
)
from smithers.workflow import clear_registry


# Test models
class OutputA(BaseModel):
    value: str


class OutputB(BaseModel):
    count: int


class OutputC(BaseModel):
    name: str
    items: list[str]


# =============================================================================
# Graph Verification Tests (I1)
# =============================================================================


class TestGraphVerification:
    """Tests for verify_graph and related functions."""

    def setup_method(self) -> None:
        """Reset registry before each test."""
        clear_registry()

    def test_verify_valid_graph(self) -> None:
        """Test verification of a valid DAG."""

        @workflow
        async def step_a() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def step_b(a: OutputA) -> OutputB:
            return OutputB(count=len(a.value))

        graph = build_graph(step_b)
        result = verify_graph(graph)

        assert result.valid is True
        assert len(result.errors) == 0
        assert result.stats["node_count"] == 2
        assert result.stats["edge_count"] == 1
        assert result.stats["level_count"] == 2

    def test_verify_single_node_graph(self) -> None:
        """Test verification of a single-node graph."""

        @workflow
        async def single() -> OutputA:
            return OutputA(value="single")

        graph = build_graph(single)
        result = verify_graph(graph)

        assert result.valid is True
        assert result.stats["node_count"] == 1
        assert result.stats["edge_count"] == 0
        assert result.stats["level_count"] == 1

    def test_verify_parallel_graph(self) -> None:
        """Test verification of a graph with parallel nodes."""

        @workflow
        async def root() -> OutputA:
            return OutputA(value="root")

        @workflow
        async def branch_1(a: OutputA) -> OutputB:
            return OutputB(count=1)

        @workflow
        async def branch_2(a: OutputA) -> OutputC:
            return OutputC(name="c", items=[])

        # Build graph by calling all workflows
        graph = build_graph(branch_1)
        clear_registry()

        # Re-register for full graph
        @workflow
        async def root2() -> OutputA:
            return OutputA(value="root")

        @workflow
        async def b1(a: OutputA) -> OutputB:
            return OutputB(count=1)

        graph = build_graph(b1)
        result = verify_graph(graph)

        assert result.valid is True

    def test_detect_missing_dependency(self) -> None:
        """Test detection of missing dependencies."""
        # Manually create a graph with missing dependency
        nodes = {
            "step_a": WorkflowNode(
                name="step_a",
                output_type=OutputA,
                dependencies=["missing_node"],  # This doesn't exist
            ),
        }

        graph = WorkflowGraph(
            root="step_a",
            nodes=nodes,
            edges=[],
            levels=[["step_a"]],
        )

        result = verify_graph(graph)

        assert result.valid is False
        assert len(result.errors) >= 1
        assert any(i.code == IssueCode.MISSING_DEPENDENCY for i in result.issues)

    def test_detect_cycle_in_manual_graph(self) -> None:
        """Test cycle detection with manually constructed cyclic graph."""
        # Create a graph where A -> B -> A (cycle)
        nodes = {
            "step_a": WorkflowNode(
                name="step_a",
                output_type=OutputA,
                dependencies=["step_b"],
            ),
            "step_b": WorkflowNode(
                name="step_b",
                output_type=OutputB,
                dependencies=["step_a"],
            ),
        }

        graph = WorkflowGraph(
            root="step_a",
            nodes=nodes,
            edges=[("step_a", "step_b"), ("step_b", "step_a")],
            levels=[["step_a", "step_b"]],  # Invalid levels for cycle
        )

        result = verify_graph(graph)

        assert result.valid is False
        cycle_issues = [i for i in result.issues if i.code == IssueCode.CYCLE_DETECTED]
        assert len(cycle_issues) >= 1

    def test_detect_level_inconsistency(self) -> None:
        """Test detection of level inconsistencies."""
        # Create graph where dependency is in same/later level
        nodes = {
            "step_a": WorkflowNode(
                name="step_a",
                output_type=OutputA,
                dependencies=[],
            ),
            "step_b": WorkflowNode(
                name="step_b",
                output_type=OutputB,
                dependencies=["step_a"],
            ),
        }

        graph = WorkflowGraph(
            root="step_b",
            nodes=nodes,
            edges=[("step_a", "step_b")],
            levels=[["step_a", "step_b"]],  # Both in same level - invalid
        )

        result = verify_graph(graph)

        # Should detect that step_b depends on step_a but they're in same level
        assert result.valid is False

    def test_summary_output(self) -> None:
        """Test the summary output of verification result."""

        @workflow
        async def simple() -> OutputA:
            return OutputA(value="test")

        graph = build_graph(simple)
        result = verify_graph(graph)

        summary = result.summary()
        assert "PASSED" in summary
        assert "Nodes: 1" in summary
        assert "errors" in summary.lower()


# =============================================================================
# Output Verification Tests (I2)
# =============================================================================


class TestOutputVerification:
    """Tests for verify_output and related functions."""

    def test_verify_valid_output(self) -> None:
        """Test verification of valid output."""
        output = OutputA(value="test")
        result = verify_output(output, OutputA)

        assert result.valid is True
        assert result.output == output
        assert result.output_hash is not None
        assert len(result.issues) == 0

    def test_verify_dict_as_output(self) -> None:
        """Test verification of dict that matches model."""
        result = verify_output({"value": "test"}, OutputA)

        assert result.valid is True
        assert isinstance(result.output, OutputA)
        assert result.output.value == "test"

    def test_verify_invalid_output_type(self) -> None:
        """Test verification fails for wrong type."""
        output = OutputB(count=42)
        result = verify_output(output, OutputA)

        assert result.valid is False
        assert any(i.code == IssueCode.OUTPUT_VALIDATION_FAILED for i in result.issues)

    def test_verify_missing_field(self) -> None:
        """Test verification fails for missing required field."""
        result = verify_output({}, OutputA)

        assert result.valid is False
        assert any(i.code == IssueCode.OUTPUT_VALIDATION_FAILED for i in result.issues)

    def test_verify_none_not_allowed(self) -> None:
        """Test verification fails for None when not allowed."""
        result = verify_output(None, OutputA, allow_none=False)

        assert result.valid is False
        assert any(i.code == IssueCode.NULL_OUTPUT_NOT_ALLOWED for i in result.issues)

    def test_verify_none_allowed(self) -> None:
        """Test verification passes for None when allowed."""
        result = verify_output(None, OutputA, allow_none=True)

        assert result.valid is True
        assert result.output is None

    def test_verify_workflow_output(self) -> None:
        """Test verify_workflow_output convenience function."""
        clear_registry()

        @workflow
        async def test_wf() -> OutputA:
            return OutputA(value="test")

        output = OutputA(value="test")
        result = verify_workflow_output(test_wf, output)

        assert result.valid is True


# =============================================================================
# Cache Verification Tests (I3, I5)
# =============================================================================


class TestCacheVerification:
    """Tests for cache verification functions."""

    @pytest.fixture
    def temp_cache(self) -> SqliteCache:
        """Create a temporary cache for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            cache = SqliteCache(Path(tmpdir) / "test_cache.db")
            yield cache

    @pytest.mark.asyncio
    async def test_verify_valid_cache_entry(self, temp_cache: SqliteCache) -> None:
        """Test verification of valid cache entry."""
        # Store a value
        value = OutputA(value="cached")
        await temp_cache.set("test_key", value, workflow_name="test_workflow")

        # Verify it
        result = await verify_cache_entry(temp_cache, "test_key", OutputA)

        assert result.valid is True
        assert result.cache_key == "test_key"
        assert result.computed_hash is not None

    @pytest.mark.asyncio
    async def test_verify_missing_cache_entry(self, temp_cache: SqliteCache) -> None:
        """Test verification fails for missing entry."""
        await temp_cache._ensure_initialized()

        result = await verify_cache_entry(temp_cache, "nonexistent_key")

        assert result.valid is False
        assert any(i.code == IssueCode.CACHE_CORRUPT for i in result.issues)

    @pytest.mark.asyncio
    async def test_verify_cache_schema_mismatch(self, temp_cache: SqliteCache) -> None:
        """Test verification fails for schema mismatch."""
        # Store a value of one type
        value = OutputB(count=42)
        await temp_cache.set("test_key", value)

        # Verify against different type
        result = await verify_cache_entry(temp_cache, "test_key", OutputA)

        assert result.valid is False
        assert any(i.code == IssueCode.CACHE_SCHEMA_INVALID for i in result.issues)

    @pytest.mark.asyncio
    async def test_verify_cache_hash_mismatch(self, temp_cache: SqliteCache) -> None:
        """Test verification fails for hash mismatch."""
        value = OutputA(value="cached")
        await temp_cache.set("test_key", value)

        # Verify with wrong expected hash
        result = await verify_cache_entry(
            temp_cache,
            "test_key",
            expected_hash="0000000000000000",
        )

        assert result.valid is False
        assert any(i.code == IssueCode.CACHE_HASH_MISMATCH for i in result.issues)

    @pytest.mark.asyncio
    async def test_verify_corrupt_cache_entry(self, temp_cache: SqliteCache) -> None:
        """Test verification fails for corrupt entry."""
        import aiosqlite

        await temp_cache._ensure_initialized()

        # Insert corrupt data directly
        async with aiosqlite.connect(temp_cache.path) as db:
            await db.execute(
                """
                INSERT INTO cache (key, value, created_at, accessed_at)
                VALUES (?, ?, ?, ?)
                """,
                ("corrupt_key", b"not valid pickle data", "2024-01-01", "2024-01-01"),
            )
            await db.commit()

        result = await verify_cache_entry(temp_cache, "corrupt_key")

        assert result.valid is False
        assert any(i.code == IssueCode.CACHE_DESERIALIZATION_FAILED for i in result.issues)

    @pytest.mark.asyncio
    async def test_verify_cache_integrity_all(self, temp_cache: SqliteCache) -> None:
        """Test verify_cache_integrity checks all entries."""
        # Store multiple values
        await temp_cache.set("key1", OutputA(value="a"), workflow_name="wf1")
        await temp_cache.set("key2", OutputB(count=1), workflow_name="wf2")
        await temp_cache.set("key3", OutputA(value="c"), workflow_name="wf1")

        results = await verify_cache_integrity(temp_cache)

        assert len(results) == 3
        assert all(r.valid for r in results)

    @pytest.mark.asyncio
    async def test_verify_cache_integrity_with_schema(self, temp_cache: SqliteCache) -> None:
        """Test verify_cache_integrity with schema validation."""
        await temp_cache.set("key1", OutputA(value="a"), workflow_name="wf1")
        await temp_cache.set("key2", OutputB(count=1), workflow_name="wf2")

        workflow_types = {
            "wf1": OutputA,
            "wf2": OutputB,
        }

        results = await verify_cache_integrity(
            temp_cache,
            validate_schemas=True,
            workflow_types=workflow_types,
        )

        assert len(results) == 2
        assert all(r.valid for r in results)


# =============================================================================
# Run State Verification Tests (I4)
# =============================================================================


class TestRunStateVerification:
    """Tests for run state verification."""

    @pytest.fixture
    def temp_store(self) -> SqliteStore:
        """Create a temporary store for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SqliteStore(Path(tmpdir) / "test_store.db")
            yield store

    @pytest.mark.asyncio
    async def test_verify_successful_run(self, temp_store: SqliteStore) -> None:
        """Test verification of successful run state."""
        from smithers.store.sqlite import NodeStatus, RunStatus

        await temp_store.initialize()

        # Create a run
        run_id = await temp_store.create_run("test_hash", "root_node")

        # Create nodes
        await temp_store.create_run_node(run_id, "node1", "wf1", NodeStatus.SUCCESS)
        await temp_store.create_run_node(run_id, "node2", "wf2", NodeStatus.SUCCESS)

        # Update run status
        await temp_store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)

        # Emit start event
        await temp_store.emit_event(run_id, None, "RunStarted", {})

        result = await verify_run_state(temp_store, run_id)

        assert result.valid is True

    @pytest.mark.asyncio
    async def test_verify_missing_run(self, temp_store: SqliteStore) -> None:
        """Test verification fails for missing run."""
        await temp_store.initialize()

        result = await verify_run_state(temp_store, "nonexistent_run")

        assert result.valid is False
        assert any(i.code == IssueCode.STATE_NOT_PERSISTED for i in result.issues)

    @pytest.mark.asyncio
    async def test_verify_inconsistent_run_state(self, temp_store: SqliteStore) -> None:
        """Test detection of inconsistent run state."""
        from smithers.store.sqlite import NodeStatus, RunStatus

        await temp_store.initialize()

        # Create a run marked as SUCCESS
        run_id = await temp_store.create_run("test_hash", "root_node")
        await temp_store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)

        # But with a FAILED node
        await temp_store.create_run_node(run_id, "node1", "wf1", NodeStatus.FAILED)

        result = await verify_run_state(temp_store, run_id)

        # Should have warnings about inconsistency
        assert any(i.code == IssueCode.STATE_INCONSISTENT for i in result.issues)

    @pytest.mark.asyncio
    async def test_verify_paused_run_without_paused_node(self, temp_store: SqliteStore) -> None:
        """Test detection of PAUSED run without PAUSED nodes."""
        from smithers.store.sqlite import NodeStatus, RunStatus

        await temp_store.initialize()

        # Create a PAUSED run
        run_id = await temp_store.create_run("test_hash", "root_node")
        await temp_store.update_run_status(run_id, RunStatus.PAUSED)

        # But no PAUSED nodes
        await temp_store.create_run_node(run_id, "node1", "wf1", NodeStatus.SUCCESS)

        result = await verify_run_state(temp_store, run_id)

        assert any(i.code == IssueCode.STATE_INCONSISTENT for i in result.issues)


# =============================================================================
# Approval State Verification Tests (I6)
# =============================================================================


class TestApprovalVerification:
    """Tests for approval state verification."""

    @pytest.fixture
    def temp_store(self) -> SqliteStore:
        """Create a temporary store for testing."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SqliteStore(Path(tmpdir) / "test_store.db")
            yield store

    @pytest.mark.asyncio
    async def test_verify_valid_approval(self, temp_store: SqliteStore) -> None:
        """Test verification of valid approval record."""
        await temp_store.initialize()

        run_id = await temp_store.create_run("test_hash", "root")

        # Request and decide approval
        await temp_store.request_approval(run_id, "node1", "Approve this?")
        await temp_store.decide_approval(run_id, "node1", True)

        result = await verify_approval_state(temp_store, run_id, "node1")

        assert result.valid is True

    @pytest.mark.asyncio
    async def test_verify_missing_approval(self, temp_store: SqliteStore) -> None:
        """Test verification fails for missing approval."""
        await temp_store.initialize()

        run_id = await temp_store.create_run("test_hash", "root")

        result = await verify_approval_state(temp_store, run_id, "node_without_approval")

        assert result.valid is False
        assert any(i.code == IssueCode.APPROVAL_NOT_RECORDED for i in result.issues)

    @pytest.mark.asyncio
    async def test_verify_pending_approval(self, temp_store: SqliteStore) -> None:
        """Test verification of pending approval."""
        await temp_store.initialize()

        run_id = await temp_store.create_run("test_hash", "root")
        await temp_store.request_approval(run_id, "node1", "Approve?")

        result = await verify_approval_state(temp_store, run_id, "node1")

        # Pending is a valid state
        assert result.valid is True


# =============================================================================
# Integration Tests
# =============================================================================


class TestVerificationIntegration:
    """Integration tests combining multiple verification aspects."""

    def setup_method(self) -> None:
        """Reset registry before each test."""
        clear_registry()

    @pytest.mark.asyncio
    async def test_full_graph_execution_verification(self) -> None:
        """Test verification after full graph execution."""
        from smithers import run_graph
        from smithers.testing import FakeLLMProvider, use_fake_llm

        @workflow
        async def step1() -> OutputA:
            return OutputA(value="step1")

        @workflow
        async def step2(a: OutputA) -> OutputB:
            return OutputB(count=len(a.value))

        graph = build_graph(step2)

        # Verify graph before execution
        graph_result = verify_graph(graph)
        assert graph_result.valid is True

        # Execute with fake LLM
        with use_fake_llm(FakeLLMProvider(responses=[])):
            result = await run_graph(graph)

        # Verify output
        output_result = verify_output(result, OutputB)
        assert output_result.valid is True

    @pytest.mark.asyncio
    async def test_cached_execution_verification(self) -> None:
        """Test verification of cached execution."""
        from smithers import run_graph
        from smithers.testing import FakeLLMProvider, use_fake_llm

        with tempfile.TemporaryDirectory() as tmpdir:
            cache = SqliteCache(Path(tmpdir) / "cache.db")

            @workflow
            async def cached_wf() -> OutputA:
                return OutputA(value="cached")

            graph = build_graph(cached_wf)

            with use_fake_llm(FakeLLMProvider(responses=[])):
                # First run
                await run_graph(graph, cache=cache)

                # Second run (should be cached)
                result = await run_graph(graph, cache=cache)

            # Verify cache integrity
            cache_results = await verify_cache_integrity(cache)
            assert all(r.valid for r in cache_results)


# =============================================================================
# Verification Issue Tests
# =============================================================================


class TestVerificationIssue:
    """Tests for VerificationIssue dataclass."""

    def test_issue_creation(self) -> None:
        """Test creating a verification issue."""
        issue = VerificationIssue(
            code=IssueCode.CYCLE_DETECTED,
            severity=IssueSeverity.ERROR,
            message="Cycle found: A -> B -> A",
            node_id="A",
            details={"cycle": ["A", "B", "A"]},
        )

        assert issue.code == IssueCode.CYCLE_DETECTED
        assert issue.severity == IssueSeverity.ERROR
        assert issue.node_id == "A"
        assert "cycle" in issue.details

    def test_issue_is_frozen(self) -> None:
        """Test that VerificationIssue is immutable."""
        issue = VerificationIssue(
            code=IssueCode.MISSING_DEPENDENCY,
            severity=IssueSeverity.ERROR,
            message="Missing dep",
        )

        with pytest.raises(Exception):  # FrozenInstanceError
            issue.code = IssueCode.CYCLE_DETECTED  # type: ignore


class TestGraphVerificationResult:
    """Tests for GraphVerificationResult."""

    def test_errors_property(self) -> None:
        """Test errors property filters correctly."""
        issues = [
            VerificationIssue(IssueCode.CYCLE_DETECTED, IssueSeverity.ERROR, "Error 1"),
            VerificationIssue(IssueCode.ORPHAN_NODE, IssueSeverity.WARNING, "Warning 1"),
            VerificationIssue(IssueCode.MISSING_DEPENDENCY, IssueSeverity.ERROR, "Error 2"),
        ]

        result = GraphVerificationResult(valid=False, issues=issues)

        assert len(result.errors) == 2
        assert len(result.warnings) == 1

    def test_summary_failed(self) -> None:
        """Test summary for failed verification."""
        result = GraphVerificationResult(
            valid=False,
            issues=[VerificationIssue(IssueCode.CYCLE_DETECTED, IssueSeverity.ERROR, "Cycle")],
            stats={"node_count": 3, "edge_count": 4, "level_count": 2},
        )

        summary = result.summary()
        assert "FAILED" in summary
        assert "Nodes: 3" in summary
