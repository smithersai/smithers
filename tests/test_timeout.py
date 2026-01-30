"""Tests for timeout handling in Smithers workflows."""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from pydantic import BaseModel

from smithers import (
    GraphTimeoutError,
    WorkflowTimeoutError,
    build_graph,
    run_graph,
    workflow,
)
from smithers.errors import WorkflowError
from smithers.timeout import (
    LONG_TIMEOUT,
    MEDIUM_TIMEOUT,
    NO_TIMEOUT,
    SHORT_TIMEOUT,
    TimeoutAction,
    TimeoutPolicy,
    TimeoutState,
    execute_with_timeout,
    get_effective_timeout,
    timeout,
)
from smithers.workflow import clear_registry


@pytest.fixture(autouse=True)
def clean_registry():
    """Clear the workflow registry before and after each test."""
    clear_registry()
    yield
    clear_registry()


# ============================================================================
# Test Models
# ============================================================================


class SimpleOutput(BaseModel):
    result: str


class SlowOutput(BaseModel):
    duration: float


# ============================================================================
# TimeoutPolicy Tests
# ============================================================================


class TestTimeoutPolicy:
    """Tests for TimeoutPolicy class."""

    def test_create_with_seconds(self):
        """Test creating a TimeoutPolicy with seconds."""
        policy = TimeoutPolicy(timeout_seconds=30.0)
        assert policy.timeout_seconds == 30.0
        assert policy.on_timeout == TimeoutAction.FAIL
        assert policy.grace_period_seconds == 5.0
        assert policy.include_queue_time is False

    def test_create_with_custom_action(self):
        """Test creating a TimeoutPolicy with custom action."""
        policy = TimeoutPolicy(timeout_seconds=60.0, on_timeout=TimeoutAction.SKIP)
        assert policy.on_timeout == TimeoutAction.SKIP

    def test_create_with_grace_period(self):
        """Test creating a TimeoutPolicy with custom grace period."""
        policy = TimeoutPolicy(timeout_seconds=30.0, grace_period_seconds=10.0)
        assert policy.grace_period_seconds == 10.0

    def test_create_with_include_queue_time(self):
        """Test creating a TimeoutPolicy with include_queue_time."""
        policy = TimeoutPolicy(timeout_seconds=30.0, include_queue_time=True)
        assert policy.include_queue_time is True

    def test_from_timedelta(self):
        """Test creating a TimeoutPolicy from timedelta."""
        policy = TimeoutPolicy.from_timedelta(
            timedelta(minutes=2),
            on_timeout=TimeoutAction.CANCEL,
            grace_period=timedelta(seconds=10),
        )
        assert policy.timeout_seconds == 120.0
        assert policy.on_timeout == TimeoutAction.CANCEL
        assert policy.grace_period_seconds == 10.0

    def test_invalid_timeout_seconds(self):
        """Test that invalid timeout_seconds raises ValueError."""
        with pytest.raises(ValueError, match="timeout_seconds must be > 0"):
            TimeoutPolicy(timeout_seconds=0)

        with pytest.raises(ValueError, match="timeout_seconds must be > 0"):
            TimeoutPolicy(timeout_seconds=-1)

    def test_invalid_grace_period(self):
        """Test that invalid grace_period raises ValueError."""
        with pytest.raises(ValueError, match="grace_period_seconds must be >= 0"):
            TimeoutPolicy(timeout_seconds=30.0, grace_period_seconds=-1)

    def test_remaining(self):
        """Test the remaining time calculation."""
        policy = TimeoutPolicy(timeout_seconds=30.0)
        assert policy.remaining(0) == 30.0
        assert policy.remaining(10) == 20.0
        assert policy.remaining(30) == 0.0
        assert policy.remaining(40) == 0.0

    def test_is_expired(self):
        """Test the is_expired check."""
        policy = TimeoutPolicy(timeout_seconds=30.0)
        assert policy.is_expired(0) is False
        assert policy.is_expired(29.9) is False
        assert policy.is_expired(30.0) is True
        assert policy.is_expired(40.0) is True


# ============================================================================
# Predefined Timeout Tests
# ============================================================================


class TestPredefinedTimeouts:
    """Tests for predefined timeout constants."""

    def test_no_timeout(self):
        """Test NO_TIMEOUT is None."""
        assert NO_TIMEOUT is None

    def test_short_timeout(self):
        """Test SHORT_TIMEOUT is 30 seconds."""
        assert SHORT_TIMEOUT.timeout_seconds == 30.0

    def test_medium_timeout(self):
        """Test MEDIUM_TIMEOUT is 120 seconds."""
        assert MEDIUM_TIMEOUT.timeout_seconds == 120.0

    def test_long_timeout(self):
        """Test LONG_TIMEOUT is 600 seconds."""
        assert LONG_TIMEOUT.timeout_seconds == 600.0


# ============================================================================
# Timeout Decorator Tests
# ============================================================================


class TestTimeoutDecorator:
    """Tests for the @timeout decorator."""

    def test_timeout_with_seconds(self):
        """Test @timeout decorator with seconds."""

        @workflow
        @timeout(30)
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy is not None
        assert timed_workflow.timeout_policy.timeout_seconds == 30.0

    def test_timeout_with_seconds_kwarg(self):
        """Test @timeout decorator with seconds= keyword."""

        @workflow
        @timeout(seconds=60)
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.timeout_seconds == 60.0

    def test_timeout_with_minutes_kwarg(self):
        """Test @timeout decorator with minutes= keyword."""

        @workflow
        @timeout(minutes=5)
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.timeout_seconds == 300.0

    def test_timeout_with_combined_kwargs(self):
        """Test @timeout decorator with combined seconds and minutes."""

        @workflow
        @timeout(seconds=30, minutes=2)
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.timeout_seconds == 150.0  # 30 + 120

    def test_timeout_with_timedelta(self):
        """Test @timeout decorator with timedelta."""

        @workflow
        @timeout(timedelta(hours=1))
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.timeout_seconds == 3600.0

    def test_timeout_with_policy(self):
        """Test @timeout decorator with TimeoutPolicy."""
        policy = TimeoutPolicy(
            timeout_seconds=45.0,
            on_timeout=TimeoutAction.SKIP,
            grace_period_seconds=15.0,
        )

        @workflow
        @timeout(policy)
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.timeout_seconds == 45.0
        assert timed_workflow.timeout_policy.on_timeout == TimeoutAction.SKIP
        assert timed_workflow.timeout_policy.grace_period_seconds == 15.0

    def test_timeout_with_on_timeout(self):
        """Test @timeout decorator with on_timeout action."""

        @workflow
        @timeout(30, on_timeout="skip")
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.on_timeout == TimeoutAction.SKIP

    def test_timeout_with_enum_action(self):
        """Test @timeout decorator with TimeoutAction enum."""

        @workflow
        @timeout(30, on_timeout=TimeoutAction.CANCEL)
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.on_timeout == TimeoutAction.CANCEL

    def test_timeout_with_grace_period(self):
        """Test @timeout decorator with grace_period_seconds."""

        @workflow
        @timeout(30, grace_period_seconds=20.0)
        async def timed_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert timed_workflow.timeout_policy.grace_period_seconds == 20.0

    def test_timeout_no_args_raises(self):
        """Test @timeout decorator without args raises ValueError."""
        with pytest.raises(ValueError, match="Must provide timeout_value"):

            @workflow
            @timeout()
            async def bad_workflow() -> SimpleOutput:
                return SimpleOutput(result="done")

    def test_workflow_without_timeout(self):
        """Test workflow without @timeout has no timeout_policy."""

        @workflow
        async def normal_workflow() -> SimpleOutput:
            return SimpleOutput(result="done")

        assert normal_workflow.timeout_policy is None


# ============================================================================
# Execute With Timeout Tests
# ============================================================================


class TestExecuteWithTimeout:
    """Tests for execute_with_timeout helper."""

    @pytest.mark.asyncio
    async def test_execute_completes_in_time(self):
        """Test that a fast coroutine completes normally."""

        async def fast_coro() -> str:
            return "done"

        policy = TimeoutPolicy(timeout_seconds=1.0)
        result = await execute_with_timeout(
            fast_coro(),
            policy,
            workflow_name="test",
        )
        assert result == "done"

    @pytest.mark.asyncio
    async def test_execute_times_out_with_fail(self):
        """Test that a slow coroutine times out and raises error."""

        async def slow_coro() -> str:
            await asyncio.sleep(2.0)
            return "done"

        policy = TimeoutPolicy(timeout_seconds=0.1, on_timeout=TimeoutAction.FAIL)
        with pytest.raises(WorkflowTimeoutError) as exc_info:
            await execute_with_timeout(
                slow_coro(),
                policy,
                workflow_name="slow_test",
            )
        assert exc_info.value.workflow_name == "slow_test"
        assert exc_info.value.timeout_seconds == 0.1

    @pytest.mark.asyncio
    async def test_execute_times_out_with_skip(self):
        """Test that a slow coroutine with SKIP action raises error (caller handles skip)."""

        async def slow_coro() -> str:
            await asyncio.sleep(2.0)
            return "done"

        policy = TimeoutPolicy(timeout_seconds=0.1, on_timeout=TimeoutAction.SKIP)
        # SKIP still raises the error - the caller determines what to do with it
        with pytest.raises(WorkflowTimeoutError):
            await execute_with_timeout(
                slow_coro(),
                policy,
                workflow_name="slow_test",
            )

    @pytest.mark.asyncio
    async def test_execute_times_out_with_cancel(self):
        """Test that a slow coroutine with CANCEL action raises CancelledError."""

        async def slow_coro() -> str:
            await asyncio.sleep(2.0)
            return "done"

        policy = TimeoutPolicy(timeout_seconds=0.1, on_timeout=TimeoutAction.CANCEL)
        with pytest.raises(asyncio.CancelledError):
            await execute_with_timeout(
                slow_coro(),
                policy,
                workflow_name="slow_test",
            )

    @pytest.mark.asyncio
    async def test_execute_with_callback(self):
        """Test that on_timeout_callback is called."""
        callback_called = False

        async def slow_coro() -> str:
            await asyncio.sleep(2.0)
            return "done"

        async def on_timeout(error: WorkflowTimeoutError) -> None:
            nonlocal callback_called
            callback_called = True

        policy = TimeoutPolicy(timeout_seconds=0.1, on_timeout=TimeoutAction.FAIL)
        with pytest.raises(WorkflowTimeoutError):
            await execute_with_timeout(
                slow_coro(),
                policy,
                workflow_name="test",
                on_timeout_callback=on_timeout,
            )
        assert callback_called


# ============================================================================
# TimeoutState Tests
# ============================================================================


class TestTimeoutState:
    """Tests for TimeoutState tracking."""

    def test_create_state(self):
        """Test creating a TimeoutState."""
        state = TimeoutState(global_timeout_seconds=60.0)
        assert state.global_timeout_seconds == 60.0
        assert state.node_timeouts == {}
        assert state.node_start_times == {}
        assert state.timed_out_nodes == []

    def test_global_remaining_no_timeout(self):
        """Test global_remaining with no timeout."""
        state = TimeoutState()
        assert state.global_remaining() is None

    def test_global_remaining_with_timeout(self):
        """Test global_remaining with timeout."""
        state = TimeoutState(global_timeout_seconds=60.0)
        remaining = state.global_remaining()
        assert remaining is not None
        assert remaining <= 60.0
        assert remaining > 59.0  # Should be very close to 60

    def test_is_globally_expired_no_timeout(self):
        """Test is_globally_expired with no timeout."""
        state = TimeoutState()
        assert state.is_globally_expired() is False

    def test_start_node(self):
        """Test starting a node."""
        state = TimeoutState()
        policy = TimeoutPolicy(timeout_seconds=30.0)
        state.start_node("node1", policy)
        assert "node1" in state.node_start_times
        assert state.node_timeouts["node1"] == policy

    def test_node_remaining(self):
        """Test node_remaining calculation."""
        state = TimeoutState()
        policy = TimeoutPolicy(timeout_seconds=30.0)
        state.start_node("node1", policy)
        remaining = state.node_remaining("node1")
        assert remaining is not None
        assert remaining <= 30.0
        assert remaining > 29.0

    def test_record_timeout(self):
        """Test recording a timed out node."""
        state = TimeoutState()
        state.record_timeout("node1")
        assert "node1" in state.timed_out_nodes

        # Duplicate recording should not add again
        state.record_timeout("node1")
        assert state.timed_out_nodes.count("node1") == 1


# ============================================================================
# Get Effective Timeout Tests
# ============================================================================


class TestGetEffectiveTimeout:
    """Tests for get_effective_timeout helper."""

    def test_no_timeouts(self):
        """Test with no timeouts configured."""
        result = get_effective_timeout(None, None)
        assert result is None

    def test_node_timeout_only(self):
        """Test with only node timeout."""
        policy = TimeoutPolicy(timeout_seconds=30.0)
        result = get_effective_timeout(policy, None)
        assert result == 30.0

    def test_global_remaining_only(self):
        """Test with only global remaining."""
        result = get_effective_timeout(None, 60.0)
        assert result == 60.0

    def test_both_node_is_smaller(self):
        """Test with both, node timeout is smaller."""
        policy = TimeoutPolicy(timeout_seconds=30.0)
        result = get_effective_timeout(policy, 60.0)
        assert result == 30.0

    def test_both_global_is_smaller(self):
        """Test with both, global remaining is smaller."""
        policy = TimeoutPolicy(timeout_seconds=60.0)
        result = get_effective_timeout(policy, 30.0)
        assert result == 30.0


# ============================================================================
# Error Types Tests
# ============================================================================


class TestTimeoutErrors:
    """Tests for timeout error types."""

    def test_workflow_timeout_error(self):
        """Test WorkflowTimeoutError attributes."""
        error = WorkflowTimeoutError(
            workflow_name="my_workflow",
            timeout_seconds=30.0,
            elapsed_seconds=35.0,
        )
        assert error.workflow_name == "my_workflow"
        assert error.timeout_seconds == 30.0
        assert error.elapsed_seconds == 35.0
        assert "my_workflow" in str(error)
        assert "35.0" in str(error)

    def test_graph_timeout_error(self):
        """Test GraphTimeoutError attributes."""
        error = GraphTimeoutError(
            timeout_seconds=60.0,
            elapsed_seconds=65.0,
            completed_nodes=["node1", "node2"],
            running_nodes=["node3"],
        )
        assert error.timeout_seconds == 60.0
        assert error.elapsed_seconds == 65.0
        assert error.completed_nodes == ["node1", "node2"]
        assert error.running_nodes == ["node3"]
        assert "65.0" in str(error)


# ============================================================================
# Integration Tests with Workflows
# ============================================================================


class TestTimeoutWorkflowIntegration:
    """Integration tests for timeout with real workflow execution."""

    @pytest.mark.asyncio
    async def test_fast_workflow_completes(self):
        """Test that a fast workflow completes within timeout."""

        @workflow
        @timeout(seconds=10)
        async def fast_task() -> SimpleOutput:
            return SimpleOutput(result="fast")

        graph = build_graph(fast_task)
        result = await run_graph(graph)
        assert result.result == "fast"

    @pytest.mark.asyncio
    async def test_slow_workflow_times_out(self):
        """Test that a slow workflow times out."""
        from smithers import run_graph_with_store

        @workflow
        @timeout(seconds=0.1)
        async def slow_task() -> SimpleOutput:
            await asyncio.sleep(2.0)
            return SimpleOutput(result="slow")

        graph = build_graph(slow_task)
        with pytest.raises((WorkflowError, WorkflowTimeoutError)):
            await run_graph_with_store(graph)

    @pytest.mark.asyncio
    async def test_global_timeout_with_run_graph(self):
        """Test global timeout parameter in run_graph."""
        from smithers import run_graph_with_store

        @workflow
        async def slow_task() -> SimpleOutput:
            await asyncio.sleep(5.0)
            return SimpleOutput(result="slow")

        graph = build_graph(slow_task)
        with pytest.raises(Exception):  # Could be GraphTimeoutError or WorkflowError
            await run_graph_with_store(graph, timeout=0.1)

    @pytest.mark.asyncio
    async def test_node_timeout_parameter(self):
        """Test node_timeout parameter in run_graph."""
        from smithers import run_graph_with_store

        @workflow
        async def slow_task() -> SimpleOutput:
            await asyncio.sleep(5.0)
            return SimpleOutput(result="slow")

        graph = build_graph(slow_task)
        with pytest.raises(Exception):
            await run_graph_with_store(graph, node_timeout=0.1)

    @pytest.mark.asyncio
    async def test_workflow_timeout_overrides_node_timeout(self):
        """Test that workflow-specific timeout overrides default node timeout."""

        @workflow
        @timeout(seconds=5)  # Longer than default node_timeout
        async def long_allowed_task() -> SimpleOutput:
            await asyncio.sleep(0.2)
            return SimpleOutput(result="done")

        graph = build_graph(long_allowed_task)
        from smithers import run_graph_with_store

        # node_timeout is 0.1s but workflow timeout is 5s
        result = await run_graph_with_store(graph, node_timeout=0.1)
        assert result.result == "done"

    @pytest.mark.asyncio
    async def test_timeout_with_retry(self):
        """Test that timeout works correctly with retry policy."""
        from smithers import run_graph_with_store
        from smithers.types import RetryPolicy

        attempt_count = 0

        @workflow(retry=RetryPolicy(max_attempts=3, backoff_seconds=0.01, jitter=False))
        @timeout(seconds=5.0)  # Total timeout for all retries with backoff
        async def flaky_task() -> SimpleOutput:
            nonlocal attempt_count
            attempt_count += 1
            await asyncio.sleep(0.01)  # Quick enough to succeed within timeout
            if attempt_count < 3:
                raise ValueError("Flaky")
            return SimpleOutput(result="success")

        graph = build_graph(flaky_task)
        result = await run_graph_with_store(graph)
        assert result.result == "success"
        assert attempt_count == 3


# ============================================================================
# Workflow Binding Tests
# ============================================================================


class TestTimeoutWithBinding:
    """Tests for timeout preservation with workflow binding."""

    def test_timeout_preserved_on_bind(self):
        """Test that timeout_policy is preserved when binding."""
        policy = TimeoutPolicy(timeout_seconds=30.0)

        @workflow(register=False)
        @timeout(policy)
        async def task(value: str) -> SimpleOutput:
            return SimpleOutput(result=value)

        bound = task.bind(value="test")
        assert bound.timeout_policy is not None
        assert bound.timeout_policy.timeout_seconds == 30.0


# ============================================================================
# TimeoutAction Tests
# ============================================================================


class TestTimeoutAction:
    """Tests for TimeoutAction enum."""

    def test_action_values(self):
        """Test TimeoutAction enum values."""
        assert TimeoutAction.FAIL.value == "fail"
        assert TimeoutAction.SKIP.value == "skip"
        assert TimeoutAction.CANCEL.value == "cancel"

    def test_action_from_string(self):
        """Test creating TimeoutAction from string."""
        assert TimeoutAction("fail") == TimeoutAction.FAIL
        assert TimeoutAction("skip") == TimeoutAction.SKIP
        assert TimeoutAction("cancel") == TimeoutAction.CANCEL
