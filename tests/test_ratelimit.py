"""Tests for the rate limiting module."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import patch

import pytest

from smithers.ratelimit import (
    CLAUDE_TIER_1_LIMITS,
    CLAUDE_TIER_2_LIMITS,
    RateLimiter,
    RateLimitConfig,
    RateLimitExceededAction,
    RateLimitExceededError,
    RateLimitStats,
    RateLimitStrategy,
    clear_model_rate_limiters,
    configure_claude_rate_limits,
    create_rate_limiter,
    get_rate_limiter,
    register_model_rate_limiter,
    reset_all_rate_limiters,
    set_rate_limiter,
)


class TestRateLimitConfig:
    """Tests for RateLimitConfig."""

    def test_default_config(self) -> None:
        """Test default configuration values."""
        config = RateLimitConfig()
        assert config.requests_per_minute is None
        assert config.requests_per_second is None
        assert config.tokens_per_minute is None
        assert config.strategy == RateLimitStrategy.SLIDING_WINDOW
        assert config.on_exceeded == RateLimitExceededAction.WAIT
        assert config.burst_allowance == 1.0

    def test_config_with_limits(self) -> None:
        """Test configuration with limits set."""
        config = RateLimitConfig(
            requests_per_minute=60,
            requests_per_second=5,
            tokens_per_minute=100000,
        )
        assert config.requests_per_minute == 60
        assert config.requests_per_second == 5
        assert config.tokens_per_minute == 100000

    def test_config_immutable(self) -> None:
        """Test that config is immutable (frozen)."""
        config = RateLimitConfig(requests_per_minute=60)
        with pytest.raises(AttributeError):
            config.requests_per_minute = 120  # type: ignore[misc]


class TestRateLimiterBasic:
    """Basic tests for RateLimiter."""

    @pytest.mark.asyncio
    async def test_no_limits_always_allows(self) -> None:
        """Test that no limits means no waiting."""
        limiter = RateLimiter(RateLimitConfig())

        for _ in range(100):
            wait_time = await limiter.acquire()
            assert wait_time == 0.0

    @pytest.mark.asyncio
    async def test_acquire_returns_wait_time(self) -> None:
        """Test that acquire returns the time waited."""
        limiter = RateLimiter(RateLimitConfig())
        wait_time = await limiter.acquire()
        assert isinstance(wait_time, float)
        assert wait_time >= 0.0

    @pytest.mark.asyncio
    async def test_acquire_with_tokens(self) -> None:
        """Test acquiring with token count."""
        limiter = RateLimiter(RateLimitConfig(tokens_per_minute=1000))
        await limiter.acquire(tokens=100)
        await limiter.acquire(tokens=200)

        stats = limiter.get_stats()
        assert stats.tokens_in_window == 300

    def test_try_acquire_without_waiting(self) -> None:
        """Test try_acquire returns status without blocking."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=2))

        # Should be allowed initially
        assert limiter.try_acquire() is True

    def test_get_stats_initial(self) -> None:
        """Test initial stats are zeroed."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=60))
        stats = limiter.get_stats()

        assert stats.requests_in_window == 0
        assert stats.tokens_in_window == 0
        assert stats.total_requests == 0
        assert stats.total_waits == 0

    @pytest.mark.asyncio
    async def test_stats_after_requests(self) -> None:
        """Test stats are updated after requests."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=60))

        await limiter.acquire()
        await limiter.acquire(tokens=100)
        await limiter.acquire(tokens=200)

        stats = limiter.get_stats()
        assert stats.requests_in_window == 3
        assert stats.tokens_in_window == 300
        assert stats.total_requests == 3
        assert stats.total_tokens == 300

    @pytest.mark.asyncio
    async def test_reset_clears_state(self) -> None:
        """Test that reset clears all state."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=60))

        await limiter.acquire()
        await limiter.acquire(tokens=100)

        limiter.reset()

        stats = limiter.get_stats()
        assert stats.requests_in_window == 0
        assert stats.total_requests == 0
        assert stats.total_tokens == 0


class TestRateLimiterRPM:
    """Tests for requests-per-minute limiting."""

    @pytest.mark.asyncio
    async def test_rpm_limit_enforced(self) -> None:
        """Test that RPM limit is enforced."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=3))

        # First 3 should be immediate
        for _ in range(3):
            wait = await limiter.acquire()
            assert wait == 0.0

        # 4th should require waiting
        stats = limiter.get_stats()
        assert stats.requests_in_window == 3

    @pytest.mark.asyncio
    async def test_rpm_utilization(self) -> None:
        """Test RPM utilization calculation."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=10))

        # Make 5 requests (50% utilization)
        for _ in range(5):
            await limiter.acquire()

        stats = limiter.get_stats()
        assert stats.rpm_utilization == 50.0

    @pytest.mark.asyncio
    async def test_rpm_error_mode(self) -> None:
        """Test RPM limit with ERROR action."""
        limiter = RateLimiter(RateLimitConfig(
            requests_per_minute=2,
            on_exceeded=RateLimitExceededAction.ERROR,
        ))

        await limiter.acquire()
        await limiter.acquire()

        with pytest.raises(RateLimitExceededError) as exc_info:
            await limiter.acquire()

        assert exc_info.value.limit_type == "requests"
        assert exc_info.value.retry_after > 0


class TestRateLimiterRPS:
    """Tests for requests-per-second limiting."""

    @pytest.mark.asyncio
    async def test_rps_limit_enforced(self) -> None:
        """Test that RPS limit is enforced."""
        limiter = RateLimiter(RateLimitConfig(requests_per_second=2))

        # First 2 should be immediate
        await limiter.acquire()
        await limiter.acquire()

        stats = limiter.get_stats()
        assert stats.rps_utilization == 100.0

    @pytest.mark.asyncio
    async def test_rps_error_mode(self) -> None:
        """Test RPS limit with ERROR action."""
        limiter = RateLimiter(RateLimitConfig(
            requests_per_second=1,
            on_exceeded=RateLimitExceededAction.ERROR,
        ))

        await limiter.acquire()

        with pytest.raises(RateLimitExceededError) as exc_info:
            await limiter.acquire()

        assert exc_info.value.limit_type == "requests_per_second"


class TestRateLimiterTPM:
    """Tests for tokens-per-minute limiting."""

    @pytest.mark.asyncio
    async def test_tpm_limit_enforced(self) -> None:
        """Test that TPM limit is enforced."""
        limiter = RateLimiter(RateLimitConfig(tokens_per_minute=1000))

        await limiter.acquire(tokens=500)
        await limiter.acquire(tokens=400)

        stats = limiter.get_stats()
        assert stats.tokens_in_window == 900
        assert stats.tpm_utilization == 90.0

    @pytest.mark.asyncio
    async def test_tpm_error_mode(self) -> None:
        """Test TPM limit with ERROR action."""
        limiter = RateLimiter(RateLimitConfig(
            tokens_per_minute=1000,
            on_exceeded=RateLimitExceededAction.ERROR,
        ))

        await limiter.acquire(tokens=800)

        with pytest.raises(RateLimitExceededError) as exc_info:
            await limiter.acquire(tokens=300)  # Would exceed 1000

        assert exc_info.value.limit_type == "tokens_per_minute"


class TestRateLimiterWaiting:
    """Tests for waiting behavior."""

    @pytest.mark.asyncio
    async def test_wait_mode_actually_waits(self) -> None:
        """Test that WAIT mode actually delays."""
        limiter = RateLimiter(RateLimitConfig(
            requests_per_second=1,
            on_exceeded=RateLimitExceededAction.WAIT,
        ))

        await limiter.acquire()

        start = time.monotonic()
        await limiter.acquire()
        elapsed = time.monotonic() - start

        # Should have waited close to 1 second
        assert elapsed >= 0.9

    @pytest.mark.asyncio
    async def test_wait_stats_tracked(self) -> None:
        """Test that wait statistics are tracked."""
        limiter = RateLimiter(RateLimitConfig(
            requests_per_second=1,
            on_exceeded=RateLimitExceededAction.WAIT,
        ))

        await limiter.acquire()
        await limiter.acquire()  # Will wait

        stats = limiter.get_stats()
        assert stats.total_waits >= 1
        assert stats.total_wait_time_ms > 0


class TestRateLimiterCapacity:
    """Tests for remaining capacity."""

    @pytest.mark.asyncio
    async def test_remaining_capacity_rpm(self) -> None:
        """Test remaining RPM capacity."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=10))

        capacity = limiter.remaining_capacity()
        assert capacity["requests_per_minute"] == 10

        await limiter.acquire()
        await limiter.acquire()

        capacity = limiter.remaining_capacity()
        assert capacity["requests_per_minute"] == 8

    @pytest.mark.asyncio
    async def test_remaining_capacity_tpm(self) -> None:
        """Test remaining TPM capacity."""
        limiter = RateLimiter(RateLimitConfig(tokens_per_minute=1000))

        await limiter.acquire(tokens=300)

        capacity = limiter.remaining_capacity()
        assert capacity["tokens_per_minute"] == 700


class TestRateLimitStats:
    """Tests for RateLimitStats."""

    def test_stats_to_dict(self) -> None:
        """Test stats serialization."""
        stats = RateLimitStats(
            requests_in_window=10,
            tokens_in_window=1000,
            rpm_utilization=50.0,
            total_requests=100,
        )

        d = stats.to_dict()
        assert d["requests_in_window"] == 10
        assert d["tokens_in_window"] == 1000
        assert d["rpm_utilization"] == 50.0
        assert d["total_requests"] == 100


class TestGlobalRateLimiter:
    """Tests for global rate limiter functions."""

    def setup_method(self) -> None:
        """Reset global state before each test."""
        reset_all_rate_limiters()

    def teardown_method(self) -> None:
        """Reset global state after each test."""
        reset_all_rate_limiters()

    def test_get_rate_limiter_none_by_default(self) -> None:
        """Test that no limiter is configured by default."""
        assert get_rate_limiter() is None

    def test_set_and_get_rate_limiter(self) -> None:
        """Test setting and getting global rate limiter."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=60))

        previous = set_rate_limiter(limiter)
        assert previous is None
        assert get_rate_limiter() is limiter

    def test_set_returns_previous(self) -> None:
        """Test that set_rate_limiter returns previous limiter."""
        limiter1 = RateLimiter(RateLimitConfig(requests_per_minute=60))
        limiter2 = RateLimiter(RateLimitConfig(requests_per_minute=120))

        set_rate_limiter(limiter1)
        previous = set_rate_limiter(limiter2)

        assert previous is limiter1
        assert get_rate_limiter() is limiter2

    def test_set_none_clears_limiter(self) -> None:
        """Test that setting None clears the limiter."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=60))
        set_rate_limiter(limiter)
        set_rate_limiter(None)

        assert get_rate_limiter() is None


class TestModelRateLimiters:
    """Tests for per-model rate limiters."""

    def setup_method(self) -> None:
        """Reset global state before each test."""
        reset_all_rate_limiters()

    def teardown_method(self) -> None:
        """Reset global state after each test."""
        reset_all_rate_limiters()

    def test_register_model_rate_limiter(self) -> None:
        """Test registering a model-specific limiter."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=30))
        register_model_rate_limiter("claude-opus", limiter)

        assert get_rate_limiter("claude-opus-4-20250514") is limiter

    def test_model_limiter_prefix_matching(self) -> None:
        """Test that model limiters use prefix matching."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=30))
        register_model_rate_limiter("claude-sonnet", limiter)

        assert get_rate_limiter("claude-sonnet-4-20250514") is limiter
        assert get_rate_limiter("claude-sonnet-3-5-20241022") is limiter
        assert get_rate_limiter("claude-opus-4-20250514") is None

    def test_model_limiter_over_global(self) -> None:
        """Test that model limiter takes precedence over global."""
        global_limiter = RateLimiter(RateLimitConfig(requests_per_minute=60))
        model_limiter = RateLimiter(RateLimitConfig(requests_per_minute=30))

        set_rate_limiter(global_limiter)
        register_model_rate_limiter("claude-opus", model_limiter)

        # Model-specific should be returned for matching models
        assert get_rate_limiter("claude-opus-4-20250514") is model_limiter
        # Global should be returned for non-matching models (when passed None)
        assert get_rate_limiter() is global_limiter

    def test_clear_model_rate_limiters(self) -> None:
        """Test clearing all model limiters."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=30))
        register_model_rate_limiter("claude-opus", limiter)

        clear_model_rate_limiters()

        assert get_rate_limiter("claude-opus-4-20250514") is None


class TestCreateRateLimiter:
    """Tests for create_rate_limiter helper."""

    def test_create_with_rpm(self) -> None:
        """Test creating limiter with RPM."""
        limiter = create_rate_limiter(rpm=60)
        assert limiter.config.requests_per_minute == 60

    def test_create_with_rps(self) -> None:
        """Test creating limiter with RPS."""
        limiter = create_rate_limiter(rps=5)
        assert limiter.config.requests_per_second == 5

    def test_create_with_tpm(self) -> None:
        """Test creating limiter with TPM."""
        limiter = create_rate_limiter(tpm=100000)
        assert limiter.config.tokens_per_minute == 100000

    def test_create_with_all_options(self) -> None:
        """Test creating limiter with all options."""
        limiter = create_rate_limiter(
            rpm=60,
            rps=5,
            tpm=100000,
            strategy=RateLimitStrategy.TOKEN_BUCKET,
            on_exceeded=RateLimitExceededAction.ERROR,
        )

        assert limiter.config.requests_per_minute == 60
        assert limiter.config.requests_per_second == 5
        assert limiter.config.tokens_per_minute == 100000
        assert limiter.config.strategy == RateLimitStrategy.TOKEN_BUCKET
        assert limiter.config.on_exceeded == RateLimitExceededAction.ERROR


class TestClaudeTierLimits:
    """Tests for Claude tier configurations."""

    def setup_method(self) -> None:
        """Reset global state before each test."""
        reset_all_rate_limiters()

    def teardown_method(self) -> None:
        """Reset global state after each test."""
        reset_all_rate_limiters()

    def test_tier_1_limits(self) -> None:
        """Test tier 1 limits configuration."""
        assert CLAUDE_TIER_1_LIMITS.requests_per_minute == 50
        assert CLAUDE_TIER_1_LIMITS.tokens_per_minute == 40000

    def test_tier_2_limits(self) -> None:
        """Test tier 2 limits configuration."""
        assert CLAUDE_TIER_2_LIMITS.requests_per_minute == 1000
        assert CLAUDE_TIER_2_LIMITS.tokens_per_minute == 80000

    def test_configure_claude_rate_limits_tier_1(self) -> None:
        """Test configuring tier 1 limits."""
        limiter = configure_claude_rate_limits(tier=1)

        assert get_rate_limiter() is limiter
        assert limiter.config.requests_per_minute == 50

    def test_configure_claude_rate_limits_tier_4(self) -> None:
        """Test configuring tier 4 limits."""
        limiter = configure_claude_rate_limits(tier=4)

        assert limiter.config.requests_per_minute == 4000
        assert limiter.config.tokens_per_minute == 400000

    def test_configure_invalid_tier_uses_tier_1(self) -> None:
        """Test that invalid tier defaults to tier 1."""
        limiter = configure_claude_rate_limits(tier=99)
        assert limiter.config.requests_per_minute == 50


class TestRateLimiterConcurrency:
    """Tests for concurrent access to rate limiter."""

    @pytest.mark.asyncio
    async def test_concurrent_acquire(self) -> None:
        """Test concurrent acquire calls are thread-safe."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=100))

        async def make_request() -> float:
            return await limiter.acquire()

        # Make 50 concurrent requests
        tasks = [make_request() for _ in range(50)]
        await asyncio.gather(*tasks)

        stats = limiter.get_stats()
        assert stats.total_requests == 50

    @pytest.mark.asyncio
    async def test_concurrent_acquire_with_limit(self) -> None:
        """Test concurrent acquire respects limits."""
        limiter = RateLimiter(RateLimitConfig(
            requests_per_second=5,
            on_exceeded=RateLimitExceededAction.WAIT,
        ))

        start = time.monotonic()

        async def make_request() -> None:
            await limiter.acquire()

        # Make 10 concurrent requests with limit of 5/s
        # Should take at least 1 second
        tasks = [make_request() for _ in range(10)]
        await asyncio.gather(*tasks)

        elapsed = time.monotonic() - start
        assert elapsed >= 0.9  # At least ~1 second


class TestRateLimiterWindowCleanup:
    """Tests for sliding window cleanup."""

    @pytest.mark.asyncio
    async def test_old_requests_counted_correctly(self) -> None:
        """Test that requests are tracked correctly."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=100))

        # Make some requests
        await limiter.acquire()
        await limiter.acquire()

        # Requests should be in window
        stats = limiter.get_stats()
        assert stats.requests_in_window == 2
        assert stats.total_requests == 2

    @pytest.mark.asyncio
    async def test_cleanup_called_on_acquire(self) -> None:
        """Test that cleanup is called when acquiring."""
        limiter = RateLimiter(RateLimitConfig(requests_per_minute=100))

        # Add a request manually with old timestamp
        from smithers.ratelimit import _TimestampedRequest
        old_time = time.monotonic() - 120  # 2 minutes ago
        limiter._requests.append(_TimestampedRequest(timestamp=old_time, tokens=100))

        # Now acquire a new request - should cleanup old one
        await limiter.acquire()

        stats = limiter.get_stats()
        # Only the new request should be in window
        assert stats.requests_in_window == 1
        # Old tokens should be cleaned up too
        assert stats.tokens_in_window == 0


class TestRateLimitExceededError:
    """Tests for RateLimitExceededError."""

    def test_error_attributes(self) -> None:
        """Test error has all required attributes."""
        error = RateLimitExceededError(
            "Rate limit exceeded",
            limit_type="requests_per_minute",
            current_value=60,
            limit_value=50,
            retry_after=5.5,
        )

        assert error.limit_type == "requests_per_minute"
        assert error.current_value == 60
        assert error.limit_value == 50
        assert error.retry_after == 5.5
        assert "Rate limit exceeded" in str(error)


class TestTokenBucketStrategy:
    """Tests for token bucket rate limiting strategy."""

    @pytest.mark.asyncio
    async def test_token_bucket_basic(self) -> None:
        """Test basic token bucket behavior."""
        limiter = RateLimiter(RateLimitConfig(
            requests_per_minute=60,
            strategy=RateLimitStrategy.TOKEN_BUCKET,
        ))

        # Should allow initial burst
        for _ in range(5):
            wait = await limiter.acquire()
            assert wait == 0.0

    @pytest.mark.asyncio
    async def test_token_bucket_with_burst(self) -> None:
        """Test token bucket with burst allowance."""
        limiter = RateLimiter(RateLimitConfig(
            requests_per_minute=60,
            strategy=RateLimitStrategy.TOKEN_BUCKET,
            burst_allowance=2.0,  # Allow 2x burst
        ))

        # Config allows up to 120 requests in burst (60 * 2)
        stats = limiter.get_stats()
        assert stats.total_requests == 0
