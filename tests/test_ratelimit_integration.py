"""Integration tests for rate limiting with Claude and CLI."""

from __future__ import annotations

import pytest

from smithers.ratelimit import (
    RateLimitConfig,
    RateLimiter,
    get_rate_limiter,
    reset_all_rate_limiters,
    set_rate_limiter,
)


class TestClaudeIntegration:
    """Tests for rate limiting integration with claude()."""

    def setup_method(self) -> None:
        """Reset rate limiters before each test."""
        reset_all_rate_limiters()

    def teardown_method(self) -> None:
        """Reset rate limiters after each test."""
        reset_all_rate_limiters()

    @pytest.mark.asyncio
    async def test_claude_applies_rate_limit(self) -> None:
        """Test that claude() applies rate limiting when configured."""
        from pydantic import BaseModel

        from smithers import claude, use_fake_llm
        from smithers.testing.fakes import FakeLLMProvider

        # Configure a rate limiter
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=100))
        set_rate_limiter(limiter)

        # Verify limiter is accessible
        assert get_rate_limiter() is limiter

        class Output(BaseModel):
            result: str

        fake = FakeLLMProvider(responses=[{"result": "test"}])

        with use_fake_llm(fake):
            await claude("test prompt", output=Output)

        # The request should have been recorded
        stats = limiter.get_stats()
        assert stats.total_requests == 1

    @pytest.mark.asyncio
    async def test_claude_without_rate_limit(self) -> None:
        """Test that claude() works without rate limiting configured."""
        from pydantic import BaseModel

        from smithers import claude, use_fake_llm
        from smithers.testing.fakes import FakeLLMProvider

        # Ensure no limiter is set
        assert get_rate_limiter() is None

        class Output(BaseModel):
            result: str

        fake = FakeLLMProvider(responses=[{"result": "test"}])

        with use_fake_llm(fake):
            result = await claude("test prompt", output=Output)
            assert result.result == "test"

    @pytest.mark.asyncio
    async def test_multiple_claude_calls_rate_limited(self) -> None:
        """Test that multiple claude() calls are rate limited."""
        from pydantic import BaseModel

        from smithers import claude, use_fake_llm
        from smithers.testing.fakes import FakeLLMProvider

        # Configure limiter
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=100))
        set_rate_limiter(limiter)

        class Output(BaseModel):
            result: str

        fake = FakeLLMProvider(
            responses=[
                {"result": "test1"},
                {"result": "test2"},
                {"result": "test3"},
            ]
        )

        with use_fake_llm(fake):
            await claude("prompt 1", output=Output)
            await claude("prompt 2", output=Output)
            await claude("prompt 3", output=Output)

        stats = limiter.get_stats()
        assert stats.total_requests == 3


class TestCLIRateLimitCommands:
    """Tests for CLI ratelimit commands."""

    def setup_method(self) -> None:
        """Reset rate limiters before each test."""
        reset_all_rate_limiters()

    def teardown_method(self) -> None:
        """Reset rate limiters after each test."""
        reset_all_rate_limiters()

    def test_ratelimit_status_not_configured(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test ratelimit status when not configured."""
        import sys

        from smithers.cli import main

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "status"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        assert "Not configured" in captured.out

    def test_ratelimit_status_json_not_configured(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test ratelimit status JSON format when not configured."""
        import json
        import sys

        from smithers.cli import main

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "status", "--format", "json"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["configured"] is False

    def test_ratelimit_configure_tier(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test configuring rate limits by tier."""
        import sys

        from smithers.cli import main

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "configure", "--tier", "1"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        assert "tier 1" in captured.out

        # Verify limiter was configured
        limiter = get_rate_limiter()
        assert limiter is not None
        assert limiter.config.requests_per_minute == 50

    def test_ratelimit_configure_custom(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test configuring custom rate limits."""
        import sys

        from smithers.cli import main

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "configure", "--rpm", "100", "--tpm", "50000"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        assert "RPM: 100" in captured.out
        assert "TPM: 50,000" in captured.out

        limiter = get_rate_limiter()
        assert limiter is not None
        assert limiter.config.requests_per_minute == 100
        assert limiter.config.tokens_per_minute == 50000

    def test_ratelimit_configure_no_options(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test configure fails without options."""
        import sys

        from smithers.cli import main

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "configure"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 1
        captured = capsys.readouterr()
        assert "Must specify" in captured.err

    def test_ratelimit_status_configured(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test ratelimit status when configured."""
        import sys

        from smithers.cli import main

        # First configure
        limiter = RateLimiter(
            RateLimitConfig(
                requests_per_minute=60,
                tokens_per_minute=100000,
            )
        )
        set_rate_limiter(limiter)

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "status"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        assert "Configured" in captured.out
        assert "RPM Limit" in captured.out

    def test_ratelimit_status_json_configured(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test ratelimit status JSON format when configured."""
        import json
        import sys

        from smithers.cli import main

        limiter = RateLimiter(
            RateLimitConfig(
                requests_per_minute=60,
                tokens_per_minute=100000,
            )
        )
        set_rate_limiter(limiter)

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "status", "--format", "json"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["configured"] is True
        assert data["config"]["requests_per_minute"] == 60
        assert data["config"]["tokens_per_minute"] == 100000

    @pytest.mark.asyncio
    async def test_ratelimit_reset(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test resetting rate limiter state."""
        import sys

        from smithers.cli import main

        # Configure and use the limiter
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=60))
        set_rate_limiter(limiter)
        await limiter.acquire()
        await limiter.acquire()

        stats_before = limiter.get_stats()
        assert stats_before.total_requests == 2

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "reset"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        assert "reset" in captured.out.lower()

        stats_after = limiter.get_stats()
        assert stats_after.total_requests == 0

    def test_ratelimit_reset_no_limiter(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test reset when no limiter configured."""
        import sys

        from smithers.cli import main

        original_argv = sys.argv
        try:
            sys.argv = ["smithers", "ratelimit", "reset"]
            result = main()
        finally:
            sys.argv = original_argv

        assert result == 0
        captured = capsys.readouterr()
        assert "No rate limiter" in captured.out


from pydantic import BaseModel


class WorkflowTestOutput(BaseModel):
    """Output model for workflow rate limit tests."""

    value: str


class TestRateLimitWithWorkflow:
    """Tests for rate limiting with workflow execution."""

    def setup_method(self) -> None:
        """Reset state before each test."""
        reset_all_rate_limiters()
        from smithers.workflow import clear_registry

        clear_registry()

    def teardown_method(self) -> None:
        """Reset state after each test."""
        reset_all_rate_limiters()
        from smithers.workflow import clear_registry

        clear_registry()

    @pytest.mark.asyncio
    async def test_workflow_with_rate_limiting(self) -> None:
        """Test that rate limiting works during workflow execution."""
        from smithers import build_graph, claude, run_graph, use_fake_llm, workflow
        from smithers.testing.fakes import FakeLLMProvider

        @workflow
        async def limited_workflow() -> WorkflowTestOutput:
            return await claude("test", output=WorkflowTestOutput)

        # Configure rate limiter
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=100))
        set_rate_limiter(limiter)

        graph = build_graph(limited_workflow)

        fake = FakeLLMProvider(responses=[{"value": "result"}])
        with use_fake_llm(fake):
            result = await run_graph(graph)

        assert result.value == "result"
        stats = limiter.get_stats()
        assert stats.total_requests == 1
