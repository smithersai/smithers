"""Tests for retry functionality."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from smithers import (
    SqliteStore,
    build_graph,
    run_graph_with_store,
    workflow,
)
from smithers.errors import RateLimitError
from smithers.types import (
    NO_RETRY,
    RETRY_ONCE,
    RETRY_THREE_TIMES,
    RETRY_WITH_BACKOFF,
    RetryPolicy,
)
from smithers.workflow import clear_registry, retry


class RetryOutput(BaseModel):
    """Output for retry tests."""

    value: str


class DepOutput(BaseModel):
    """Output for dependency tests."""

    value: str


class TestRetryPolicy:
    """Test RetryPolicy dataclass."""

    def test_default_values(self) -> None:
        """Test default RetryPolicy values."""
        policy = RetryPolicy()
        assert policy.max_attempts == 1
        assert policy.backoff_seconds == 1.0
        assert policy.backoff_multiplier == 2.0
        assert policy.max_backoff_seconds == 60.0
        assert policy.jitter is True
        assert policy.retry_on == ()

    def test_custom_values(self) -> None:
        """Test RetryPolicy with custom values."""
        policy = RetryPolicy(
            max_attempts=5,
            backoff_seconds=0.5,
            backoff_multiplier=3.0,
            max_backoff_seconds=30.0,
            jitter=False,
            retry_on=(ValueError, RuntimeError),
        )
        assert policy.max_attempts == 5
        assert policy.backoff_seconds == 0.5
        assert policy.backoff_multiplier == 3.0
        assert policy.max_backoff_seconds == 30.0
        assert policy.jitter is False
        assert policy.retry_on == (ValueError, RuntimeError)

    def test_frozen(self) -> None:
        """Test that RetryPolicy is frozen."""
        policy = RetryPolicy()
        with pytest.raises(AttributeError):
            policy.max_attempts = 5  # type: ignore[misc]

    def test_validation_max_attempts(self) -> None:
        """Test that max_attempts must be >= 1."""
        with pytest.raises(ValueError, match="max_attempts must be >= 1"):
            RetryPolicy(max_attempts=0)

        with pytest.raises(ValueError, match="max_attempts must be >= 1"):
            RetryPolicy(max_attempts=-1)

    def test_validation_backoff_seconds(self) -> None:
        """Test that backoff_seconds must be >= 0."""
        with pytest.raises(ValueError, match="backoff_seconds must be >= 0"):
            RetryPolicy(backoff_seconds=-1)

    def test_validation_backoff_multiplier(self) -> None:
        """Test that backoff_multiplier must be >= 1."""
        with pytest.raises(ValueError, match="backoff_multiplier must be >= 1"):
            RetryPolicy(backoff_multiplier=0.5)

    def test_validation_max_backoff_seconds(self) -> None:
        """Test that max_backoff_seconds must be >= 0."""
        with pytest.raises(ValueError, match="max_backoff_seconds must be >= 0"):
            RetryPolicy(max_backoff_seconds=-1)


class TestRetryPolicyShouldRetry:
    """Test RetryPolicy.should_retry method."""

    def test_should_not_retry_on_first_attempt_exhausted(self) -> None:
        """Test that no retry when max_attempts is 1."""
        policy = RetryPolicy(max_attempts=1)
        exc = ValueError("test")
        assert policy.should_retry(exc, 1) is False

    def test_should_retry_on_first_failure(self) -> None:
        """Test that retry is allowed on first failure."""
        policy = RetryPolicy(max_attempts=3)
        exc = ValueError("test")
        assert policy.should_retry(exc, 1) is True
        assert policy.should_retry(exc, 2) is True
        assert policy.should_retry(exc, 3) is False

    def test_should_retry_all_exceptions_by_default(self) -> None:
        """Test that all exceptions are retried when retry_on is empty."""
        policy = RetryPolicy(max_attempts=3, retry_on=())
        assert policy.should_retry(ValueError("test"), 1) is True
        assert policy.should_retry(RuntimeError("test"), 1) is True
        assert policy.should_retry(ConnectionError("test"), 1) is True

    def test_should_retry_only_specified_exceptions(self) -> None:
        """Test that only specified exceptions are retried."""
        policy = RetryPolicy(max_attempts=3, retry_on=(ValueError, RateLimitError))
        assert policy.should_retry(ValueError("test"), 1) is True
        assert policy.should_retry(RateLimitError("test"), 1) is True
        assert policy.should_retry(RuntimeError("test"), 1) is False
        assert policy.should_retry(ConnectionError("test"), 1) is False

    def test_should_retry_subclasses(self) -> None:
        """Test that exception subclasses are matched."""
        policy = RetryPolicy(max_attempts=3, retry_on=(Exception,))
        assert policy.should_retry(ValueError("test"), 1) is True
        assert policy.should_retry(RuntimeError("test"), 1) is True


class TestRetryPolicyGetDelay:
    """Test RetryPolicy.get_delay method."""

    def test_exponential_backoff(self) -> None:
        """Test exponential backoff calculation."""
        policy = RetryPolicy(
            max_attempts=5,
            backoff_seconds=1.0,
            backoff_multiplier=2.0,
            jitter=False,
        )
        assert policy.get_delay(1) == 1.0
        assert policy.get_delay(2) == 2.0
        assert policy.get_delay(3) == 4.0
        assert policy.get_delay(4) == 8.0

    def test_max_backoff_cap(self) -> None:
        """Test that delay is capped at max_backoff_seconds."""
        policy = RetryPolicy(
            max_attempts=10,
            backoff_seconds=1.0,
            backoff_multiplier=2.0,
            max_backoff_seconds=5.0,
            jitter=False,
        )
        assert policy.get_delay(5) == 5.0  # Would be 16.0 without cap
        assert policy.get_delay(10) == 5.0  # Stays at cap

    def test_fixed_delay(self) -> None:
        """Test fixed delay with multiplier of 1."""
        policy = RetryPolicy(
            max_attempts=5,
            backoff_seconds=2.0,
            backoff_multiplier=1.0,
            jitter=False,
        )
        assert policy.get_delay(1) == 2.0
        assert policy.get_delay(2) == 2.0
        assert policy.get_delay(3) == 2.0

    def test_jitter_adds_variation(self) -> None:
        """Test that jitter adds variation to delay."""
        policy = RetryPolicy(
            max_attempts=5,
            backoff_seconds=1.0,
            backoff_multiplier=1.0,
            jitter=True,
        )
        # With jitter, delay should be between 0.5 and 1.0 (50% to 100%)
        delays = [policy.get_delay(1) for _ in range(100)]
        assert min(delays) >= 0.4  # Some margin for randomness
        assert max(delays) <= 1.1  # Some margin for randomness
        # Verify there's actual variation
        assert len(set(delays)) > 1


class TestPresetPolicies:
    """Test preset RetryPolicy constants."""

    def test_no_retry(self) -> None:
        """Test NO_RETRY preset."""
        assert NO_RETRY.max_attempts == 1
        assert NO_RETRY.should_retry(ValueError(), 1) is False

    def test_retry_once(self) -> None:
        """Test RETRY_ONCE preset."""
        assert RETRY_ONCE.max_attempts == 2
        assert RETRY_ONCE.should_retry(ValueError(), 1) is True
        assert RETRY_ONCE.should_retry(ValueError(), 2) is False

    def test_retry_three_times(self) -> None:
        """Test RETRY_THREE_TIMES preset."""
        assert RETRY_THREE_TIMES.max_attempts == 4  # 4 attempts = 3 retries
        assert RETRY_THREE_TIMES.should_retry(ValueError(), 3) is True
        assert RETRY_THREE_TIMES.should_retry(ValueError(), 4) is False

    def test_retry_with_backoff(self) -> None:
        """Test RETRY_WITH_BACKOFF preset."""
        assert RETRY_WITH_BACKOFF.max_attempts == 5
        assert RETRY_WITH_BACKOFF.backoff_seconds == 1.0
        assert RETRY_WITH_BACKOFF.backoff_multiplier == 2.0


class TestRetryDecorator:
    """Test @retry decorator."""

    def setup_method(self) -> None:
        """Clear registry before each test."""
        clear_registry()

    def test_retry_with_policy(self) -> None:
        """Test @retry decorator with explicit policy."""
        policy = RetryPolicy(max_attempts=3, backoff_seconds=0.5)

        @workflow
        @retry(policy=policy)
        async def my_workflow() -> RetryOutput:
            return RetryOutput(value="test")

        assert my_workflow.retry_policy.max_attempts == 3
        assert my_workflow.retry_policy.backoff_seconds == 0.5

    def test_retry_with_max_attempts(self) -> None:
        """Test @retry decorator with max_attempts parameter."""
        clear_registry()

        @workflow
        @retry(max_attempts=5)
        async def my_workflow2() -> RetryOutput:
            return RetryOutput(value="test")

        assert my_workflow2.retry_policy.max_attempts == 5

    def test_retry_with_all_parameters(self) -> None:
        """Test @retry decorator with all parameters."""
        clear_registry()

        @workflow
        @retry(
            max_attempts=4,
            backoff_seconds=2.0,
            backoff_multiplier=3.0,
            max_backoff_seconds=30.0,
            jitter=False,
            retry_on=(ValueError, RateLimitError),
        )
        async def my_workflow3() -> RetryOutput:
            return RetryOutput(value="test")

        policy = my_workflow3.retry_policy
        assert policy.max_attempts == 4
        assert policy.backoff_seconds == 2.0
        assert policy.backoff_multiplier == 3.0
        assert policy.max_backoff_seconds == 30.0
        assert policy.jitter is False
        assert policy.retry_on == (ValueError, RateLimitError)


class TestWorkflowRetryParameter:
    """Test @workflow decorator retry parameters."""

    def setup_method(self) -> None:
        """Clear registry before each test."""
        clear_registry()

    def test_workflow_with_retry_policy(self) -> None:
        """Test @workflow with retry parameter."""
        policy = RetryPolicy(max_attempts=3)

        @workflow(retry=policy)
        async def my_workflow() -> RetryOutput:
            return RetryOutput(value="test")

        assert my_workflow.retry_policy.max_attempts == 3

    def test_workflow_with_max_retries(self) -> None:
        """Test @workflow with max_retries shorthand."""
        clear_registry()

        @workflow(max_retries=2)  # 3 total attempts
        async def my_workflow2() -> RetryOutput:
            return RetryOutput(value="test")

        assert my_workflow2.retry_policy.max_attempts == 3

    def test_workflow_with_max_retries_and_retry_on(self) -> None:
        """Test @workflow with max_retries and retry_on."""
        clear_registry()

        @workflow(max_retries=3, retry_on=(ValueError, RuntimeError))
        async def my_workflow3() -> RetryOutput:
            return RetryOutput(value="test")

        policy = my_workflow3.retry_policy
        assert policy.max_attempts == 4
        assert policy.retry_on == (ValueError, RuntimeError)

    def test_workflow_cannot_use_both_retry_and_max_retries(self) -> None:
        """Test that retry and max_retries cannot be used together."""
        with pytest.raises(ValueError, match="Cannot specify both"):

            @workflow(retry=RetryPolicy(max_attempts=3), max_retries=2)
            async def my_workflow4() -> RetryOutput:
                return RetryOutput(value="test")


class TestWorkflowBoundRetryPolicy:
    """Test that retry policy is preserved when binding."""

    def setup_method(self) -> None:
        """Clear registry before each test."""
        clear_registry()

    def test_bind_preserves_retry_policy(self) -> None:
        """Test that bind() preserves the retry policy."""

        @workflow(register=False, retry=RetryPolicy(max_attempts=3))
        async def my_workflow(param: str) -> RetryOutput:
            return RetryOutput(value=param)

        bound = my_workflow.bind(param="test")
        assert bound.retry_policy.max_attempts == 3


class TestRetryExecution:
    """Test retry execution in executor."""

    def setup_method(self) -> None:
        """Clear registry before each test."""
        clear_registry()

    @pytest.mark.asyncio
    async def test_no_retry_on_success(self, tmp_path) -> None:
        """Test that successful workflows don't retry."""
        clear_registry()
        call_count = 0

        @workflow
        @retry(max_attempts=3)
        async def successful_workflow() -> RetryOutput:
            nonlocal call_count
            call_count += 1
            return RetryOutput(value="success")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(successful_workflow)
        result = await run_graph_with_store(graph, store=store)

        assert result.value == "success"
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_retry_on_failure(self, tmp_path) -> None:
        """Test that failing workflows are retried."""
        clear_registry()
        call_count = 0

        @workflow(retry=RetryPolicy(max_attempts=3, backoff_seconds=0.01, jitter=False))
        async def flaky_workflow() -> RetryOutput:
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ValueError(f"Attempt {call_count} failed")
            return RetryOutput(value="success")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(flaky_workflow)
        result = await run_graph_with_store(graph, store=store)

        assert result.value == "success"
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_max_retries_exhausted(self, tmp_path) -> None:
        """Test that error is raised when max retries are exhausted."""
        clear_registry()
        call_count = 0

        @workflow(retry=RetryPolicy(max_attempts=3, backoff_seconds=0.01, jitter=False))
        async def always_fails() -> RetryOutput:
            nonlocal call_count
            call_count += 1
            raise ValueError(f"Attempt {call_count} failed")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(always_fails)

        with pytest.raises(Exception) as exc_info:
            await run_graph_with_store(graph, store=store)

        assert call_count == 3
        assert "failed" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_retry_on_filters_exceptions(self, tmp_path) -> None:
        """Test that only specified exceptions trigger retry."""
        clear_registry()
        call_count = 0

        @workflow(
            retry=RetryPolicy(
                max_attempts=3,
                backoff_seconds=0.01,
                jitter=False,
                retry_on=(ValueError,),
            )
        )
        async def wrong_error() -> RetryOutput:
            nonlocal call_count
            call_count += 1
            raise RuntimeError("Not a ValueError")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(wrong_error)

        with pytest.raises(Exception):
            await run_graph_with_store(graph, store=store)

        # Should only be called once since RuntimeError is not in retry_on
        assert call_count == 1

    @pytest.mark.asyncio
    async def test_retry_events_emitted(self, tmp_path) -> None:
        """Test that retry events are emitted."""
        clear_registry()
        call_count = 0

        @workflow(retry=RetryPolicy(max_attempts=3, backoff_seconds=0.01, jitter=False))
        async def retry_events_workflow() -> RetryOutput:
            nonlocal call_count
            call_count += 1
            if call_count < 2:
                raise ValueError("First attempt failed")
            return RetryOutput(value="success")

        store = SqliteStore(tmp_path / "test.db")
        await store.initialize()
        graph = build_graph(retry_events_workflow)
        await run_graph_with_store(graph, store=store)

        # Get all events for the run
        runs = await store.list_runs()
        assert len(runs) == 1
        events = await store.get_events(runs[0].run_id)

        # Find retry events
        event_types = [e.type for e in events]
        assert "NodeRetrying" in event_types

        # Check NodeFinished includes attempts
        node_finished = next(e for e in events if e.type == "NodeFinished")
        assert node_finished.payload.get("attempts") == 2

    @pytest.mark.asyncio
    async def test_retry_policy_backoff_applied(self, tmp_path) -> None:
        """Test that backoff delay is applied between retries."""
        clear_registry()
        call_times: list[float] = []
        import time as time_module

        @workflow(
            retry=RetryPolicy(
                max_attempts=3,
                backoff_seconds=0.05,  # 50ms
                backoff_multiplier=2.0,
                jitter=False,
            )
        )
        async def timed_workflow() -> RetryOutput:
            call_times.append(time_module.perf_counter())
            if len(call_times) < 3:
                raise ValueError("Not yet")
            return RetryOutput(value="done")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(timed_workflow)
        await run_graph_with_store(graph, store=store)

        assert len(call_times) == 3
        # First delay should be ~50ms
        delay1 = call_times[1] - call_times[0]
        # Second delay should be ~100ms (2x)
        delay2 = call_times[2] - call_times[1]

        # Allow some margin for execution time
        assert delay1 >= 0.04  # At least 40ms
        assert delay2 >= 0.08  # At least 80ms
        # Second delay should be roughly 2x the first
        assert delay2 > delay1 * 1.5


class TestRetryWithDependencies:
    """Test retry behavior with workflow dependencies."""

    def setup_method(self) -> None:
        """Clear registry before each test."""
        clear_registry()

    @pytest.mark.asyncio
    async def test_retry_does_not_re_run_dependencies(self, tmp_path) -> None:
        """Test that dependencies are not re-run when retrying."""
        clear_registry()
        dep_call_count = 0
        main_call_count = 0

        @workflow
        async def dependency() -> DepOutput:
            nonlocal dep_call_count
            dep_call_count += 1
            return DepOutput(value="dep")

        @workflow(retry=RetryPolicy(max_attempts=3, backoff_seconds=0.01, jitter=False))
        async def main_workflow(dep: DepOutput) -> RetryOutput:
            nonlocal main_call_count
            main_call_count += 1
            if main_call_count < 2:
                raise ValueError("First attempt failed")
            return RetryOutput(value=f"main-{dep.value}")

        store = SqliteStore(tmp_path / "test.db")
        graph = build_graph(main_workflow)
        result = await run_graph_with_store(graph, store=store)

        assert result.value == "main-dep"
        assert dep_call_count == 1  # Dependency only called once
        assert main_call_count == 2  # Main workflow retried once
