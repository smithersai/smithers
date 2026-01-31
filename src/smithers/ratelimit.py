"""Rate limiting module for LLM API calls.

This module provides rate limiting functionality to prevent hitting API rate limits
and control throughput. It supports multiple limiting strategies and integrates
with the RuntimeContext for automatic rate limiting.

Features:
- Requests per minute (RPM) limiting
- Requests per second (RPS) limiting
- Tokens per minute (TPM) limiting
- Per-model rate limit configuration
- Sliding window and token bucket strategies
- Async-aware with proper waiting

Example usage:
    from smithers.ratelimit import RateLimiter, RateLimitConfig, get_rate_limiter

    # Configure a rate limiter
    config = RateLimitConfig(
        requests_per_minute=60,
        requests_per_second=5,
        tokens_per_minute=100000,
    )
    limiter = RateLimiter(config)

    # Acquire permission before making an API call
    await limiter.acquire()

    # Or acquire with token count
    await limiter.acquire(tokens=1500)

    # Use the global rate limiter
    set_rate_limiter(limiter)
    global_limiter = get_rate_limiter()
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from enum import Enum
from typing import Any


class RateLimitStrategy(str, Enum):
    """Rate limiting strategy."""

    SLIDING_WINDOW = "sliding_window"  # Track requests in a sliding time window
    TOKEN_BUCKET = "token_bucket"  # Classic token bucket algorithm


class RateLimitExceededAction(str, Enum):
    """Action to take when rate limit is exceeded."""

    WAIT = "wait"  # Wait until rate limit allows (default)
    ERROR = "error"  # Raise an exception immediately


@dataclass(frozen=True)
class RateLimitConfig:
    """Configuration for rate limiting.

    All limits are optional. Set to None to disable that particular limit.

    Attributes:
        requests_per_minute: Maximum requests per minute (RPM)
        requests_per_second: Maximum requests per second (RPS)
        tokens_per_minute: Maximum tokens per minute (TPM)
        strategy: Rate limiting strategy to use
        on_exceeded: Action when limit is exceeded
        model_pattern: Optional model name pattern for per-model limits
        burst_allowance: Extra requests allowed in bursts (for token bucket)
    """

    requests_per_minute: int | None = None
    requests_per_second: int | None = None
    tokens_per_minute: int | None = None
    strategy: RateLimitStrategy = RateLimitStrategy.SLIDING_WINDOW
    on_exceeded: RateLimitExceededAction = RateLimitExceededAction.WAIT
    model_pattern: str | None = None
    burst_allowance: float = 1.0  # Multiplier for burst capacity


class RateLimitExceededError(Exception):
    """Raised when rate limit is exceeded and action is ERROR."""

    def __init__(
        self,
        message: str,
        limit_type: str,
        current_value: float,
        limit_value: float,
        retry_after: float,
    ) -> None:
        super().__init__(message)
        self.limit_type = limit_type
        self.current_value = current_value
        self.limit_value = limit_value
        self.retry_after = retry_after


@dataclass
class RateLimitStats:
    """Statistics for rate limiter status.

    Attributes:
        requests_in_window: Current requests in the sliding window
        tokens_in_window: Current tokens in the sliding window
        rpm_utilization: Current RPM utilization (0-100+)
        rps_utilization: Current RPS utilization (0-100+)
        tpm_utilization: Current TPM utilization (0-100+)
        total_requests: Total requests processed
        total_tokens: Total tokens processed
        total_waits: Number of times we had to wait
        total_wait_time_ms: Total time spent waiting in milliseconds
    """

    requests_in_window: int = 0
    tokens_in_window: int = 0
    rpm_utilization: float | None = None
    rps_utilization: float | None = None
    tpm_utilization: float | None = None
    total_requests: int = 0
    total_tokens: int = 0
    total_waits: int = 0
    total_wait_time_ms: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "requests_in_window": self.requests_in_window,
            "tokens_in_window": self.tokens_in_window,
            "rpm_utilization": self.rpm_utilization,
            "rps_utilization": self.rps_utilization,
            "tpm_utilization": self.tpm_utilization,
            "total_requests": self.total_requests,
            "total_tokens": self.total_tokens,
            "total_waits": self.total_waits,
            "total_wait_time_ms": self.total_wait_time_ms,
        }


@dataclass
class _TimestampedRequest:
    """A request with its timestamp for sliding window tracking."""

    timestamp: float
    tokens: int = 0


class RateLimiter:
    """Rate limiter for LLM API calls.

    Implements rate limiting using either sliding window or token bucket
    strategies. Supports requests per minute (RPM), requests per second (RPS),
    and tokens per minute (TPM) limits.

    Example:
        limiter = RateLimiter(RateLimitConfig(
            requests_per_minute=60,
            tokens_per_minute=100000,
        ))

        # Before each API call
        await limiter.acquire(tokens=1500)

        # Check status
        stats = limiter.get_stats()
        print(f"RPM utilization: {stats.rpm_utilization}%")
    """

    def __init__(self, config: RateLimitConfig) -> None:
        """Initialize the rate limiter.

        Args:
            config: Rate limit configuration
        """
        self.config = config
        self._lock = asyncio.Lock()

        # Sliding window tracking
        self._requests: deque[_TimestampedRequest] = deque()

        # Token bucket state (for TOKEN_BUCKET strategy)
        self._bucket_tokens: float = 0.0
        self._last_refill: float = time.monotonic()

        # Statistics
        self._total_requests = 0
        self._total_tokens = 0
        self._total_waits = 0
        self._total_wait_time_ms = 0.0

    def _cleanup_old_requests(self, now: float) -> None:
        """Remove requests outside the sliding window."""
        # Keep requests from the last minute for RPM/TPM
        window_start = now - 60.0

        while self._requests and self._requests[0].timestamp < window_start:
            self._requests.popleft()

    def _count_requests_in_window(self, now: float, window_seconds: float) -> int:
        """Count requests in the specified time window."""
        window_start = now - window_seconds
        return sum(1 for req in self._requests if req.timestamp >= window_start)

    def _count_tokens_in_window(self, now: float, window_seconds: float) -> int:
        """Count tokens in the specified time window."""
        window_start = now - window_seconds
        return sum(req.tokens for req in self._requests if req.timestamp >= window_start)

    def _calculate_wait_time(self, now: float, tokens: int = 0) -> float:
        """Calculate how long to wait before making a request.

        Returns 0.0 if no wait is needed.
        """
        max_wait = 0.0

        # Check RPM limit
        if self.config.requests_per_minute is not None:
            requests_in_minute = self._count_requests_in_window(now, 60.0)
            if requests_in_minute >= self.config.requests_per_minute:
                # Find oldest request in window and wait until it expires
                oldest = min(
                    (req.timestamp for req in self._requests if req.timestamp >= now - 60.0),
                    default=now,
                )
                wait = (oldest + 60.0) - now
                max_wait = max(max_wait, wait)

        # Check RPS limit
        if self.config.requests_per_second is not None:
            requests_in_second = self._count_requests_in_window(now, 1.0)
            if requests_in_second >= self.config.requests_per_second:
                oldest = min(
                    (req.timestamp for req in self._requests if req.timestamp >= now - 1.0),
                    default=now,
                )
                wait = (oldest + 1.0) - now
                max_wait = max(max_wait, wait)

        # Check TPM limit
        if self.config.tokens_per_minute is not None and tokens > 0:
            tokens_in_minute = self._count_tokens_in_window(now, 60.0)
            if tokens_in_minute + tokens > self.config.tokens_per_minute:
                # Need to wait for enough tokens to expire
                # Find how many tokens need to expire
                needed = (tokens_in_minute + tokens) - self.config.tokens_per_minute
                expired = 0
                wait = 0.0
                for req in sorted(self._requests, key=lambda r: r.timestamp):
                    if req.timestamp < now - 60.0:
                        continue  # Already expired
                    expired += req.tokens
                    if expired >= needed:
                        wait = (req.timestamp + 60.0) - now
                        break
                max_wait = max(max_wait, wait)

        return max(0.0, max_wait)

    def _refill_bucket(self, now: float) -> None:
        """Refill the token bucket based on elapsed time."""
        if self.config.strategy != RateLimitStrategy.TOKEN_BUCKET:
            return

        elapsed = now - self._last_refill
        self._last_refill = now

        # Refill rate based on RPM (tokens per second = RPM / 60)
        if self.config.requests_per_minute is not None:
            refill_rate = self.config.requests_per_minute / 60.0
            max_tokens = self.config.requests_per_minute * self.config.burst_allowance
            self._bucket_tokens = min(
                max_tokens,
                self._bucket_tokens + (elapsed * refill_rate),
            )

    async def acquire(self, tokens: int = 0) -> float:
        """Acquire permission to make an API call.

        This method will wait if necessary (when on_exceeded is WAIT)
        or raise an exception (when on_exceeded is ERROR).

        Args:
            tokens: Number of tokens this request will use (for TPM limiting)

        Returns:
            Time spent waiting in seconds

        Raises:
            RateLimitExceededError: If on_exceeded is ERROR and limit is exceeded
        """
        async with self._lock:
            now = time.monotonic()
            self._cleanup_old_requests(now)

            if self.config.strategy == RateLimitStrategy.TOKEN_BUCKET:
                self._refill_bucket(now)

            wait_time = self._calculate_wait_time(now, tokens)

            if wait_time > 0:
                if self.config.on_exceeded == RateLimitExceededAction.ERROR:
                    # Determine which limit was exceeded
                    limit_type = "requests"
                    current = self._count_requests_in_window(now, 60.0)
                    limit = self.config.requests_per_minute or 0

                    if self.config.requests_per_second is not None:
                        rps_count = self._count_requests_in_window(now, 1.0)
                        if rps_count >= self.config.requests_per_second:
                            limit_type = "requests_per_second"
                            current = rps_count
                            limit = self.config.requests_per_second

                    if self.config.tokens_per_minute is not None and tokens > 0:
                        tpm_count = self._count_tokens_in_window(now, 60.0)
                        if tpm_count + tokens > self.config.tokens_per_minute:
                            limit_type = "tokens_per_minute"
                            current = tpm_count
                            limit = self.config.tokens_per_minute

                    raise RateLimitExceededError(
                        f"Rate limit exceeded: {limit_type}",
                        limit_type=limit_type,
                        current_value=current,
                        limit_value=limit,
                        retry_after=wait_time,
                    )

                # Wait
                self._total_waits += 1
                self._total_wait_time_ms += wait_time * 1000.0

                await asyncio.sleep(wait_time)
                now = time.monotonic()
                self._cleanup_old_requests(now)

            # Record this request
            self._requests.append(_TimestampedRequest(timestamp=now, tokens=tokens))
            self._total_requests += 1
            self._total_tokens += tokens

            # Consume from bucket if using token bucket strategy
            if self.config.strategy == RateLimitStrategy.TOKEN_BUCKET:
                self._bucket_tokens = max(0.0, self._bucket_tokens - 1.0)

            return wait_time

    def try_acquire(self, tokens: int = 0) -> bool:
        """Try to acquire permission without waiting (DEPRECATED - not thread-safe).

        WARNING: This method is not thread-safe. Use try_acquire_async() instead
        for async code, or ensure external synchronization when calling this method.

        Returns True if the request is allowed, False if rate limited.
        Does not record the request - use acquire() if you want to proceed.

        Args:
            tokens: Number of tokens this request will use

        Returns:
            True if the request would be allowed
        """
        now = time.monotonic()
        self._cleanup_old_requests(now)
        wait_time = self._calculate_wait_time(now, tokens)
        return wait_time <= 0

    async def try_acquire_async(self, tokens: int = 0) -> bool:
        """Try to acquire permission without waiting (thread-safe async version).

        This is the thread-safe async version of try_acquire. It properly
        acquires the lock before checking rate limit state.

        Returns True if the request is allowed, False if rate limited.
        Does not record the request - use acquire() if you want to proceed.

        Args:
            tokens: Number of tokens this request will use

        Returns:
            True if the request would be allowed
        """
        async with self._lock:
            now = time.monotonic()
            self._cleanup_old_requests(now)
            wait_time = self._calculate_wait_time(now, tokens)
            return wait_time <= 0

    def get_stats(self) -> RateLimitStats:
        """Get current rate limiter statistics.

        Returns:
            RateLimitStats with current utilization and totals
        """
        now = time.monotonic()
        self._cleanup_old_requests(now)

        requests_in_minute = self._count_requests_in_window(now, 60.0)
        requests_in_second = self._count_requests_in_window(now, 1.0)
        tokens_in_minute = self._count_tokens_in_window(now, 60.0)

        rpm_util = None
        if self.config.requests_per_minute is not None:
            rpm_util = (requests_in_minute / self.config.requests_per_minute) * 100

        rps_util = None
        if self.config.requests_per_second is not None:
            rps_util = (requests_in_second / self.config.requests_per_second) * 100

        tpm_util = None
        if self.config.tokens_per_minute is not None:
            tpm_util = (tokens_in_minute / self.config.tokens_per_minute) * 100

        return RateLimitStats(
            requests_in_window=requests_in_minute,
            tokens_in_window=tokens_in_minute,
            rpm_utilization=rpm_util,
            rps_utilization=rps_util,
            tpm_utilization=tpm_util,
            total_requests=self._total_requests,
            total_tokens=self._total_tokens,
            total_waits=self._total_waits,
            total_wait_time_ms=self._total_wait_time_ms,
        )

    def reset(self) -> None:
        """Reset all rate limiter state and statistics."""
        self._requests.clear()
        self._bucket_tokens = 0.0
        self._last_refill = time.monotonic()
        self._total_requests = 0
        self._total_tokens = 0
        self._total_waits = 0
        self._total_wait_time_ms = 0.0

    def remaining_capacity(self) -> dict[str, int | None]:
        """Get remaining capacity before hitting limits.

        Returns:
            Dict with remaining requests/tokens before each limit
        """
        now = time.monotonic()
        self._cleanup_old_requests(now)

        result: dict[str, int | None] = {
            "requests_per_minute": None,
            "requests_per_second": None,
            "tokens_per_minute": None,
        }

        if self.config.requests_per_minute is not None:
            current = self._count_requests_in_window(now, 60.0)
            result["requests_per_minute"] = max(0, self.config.requests_per_minute - current)

        if self.config.requests_per_second is not None:
            current = self._count_requests_in_window(now, 1.0)
            result["requests_per_second"] = max(0, self.config.requests_per_second - current)

        if self.config.tokens_per_minute is not None:
            current = self._count_tokens_in_window(now, 60.0)
            result["tokens_per_minute"] = max(0, self.config.tokens_per_minute - current)

        return result


# Global rate limiter registry
_global_rate_limiter: RateLimiter | None = None
_model_rate_limiters: dict[str, RateLimiter] = {}


def get_rate_limiter(model: str | None = None) -> RateLimiter | None:
    """Get the rate limiter for a model or the global limiter.

    Args:
        model: Optional model name to get a model-specific limiter

    Returns:
        The rate limiter, or None if not configured
    """
    if model is not None:
        # Check for model-specific limiter
        for pattern, limiter in _model_rate_limiters.items():
            if model.startswith(pattern):
                return limiter

    return _global_rate_limiter


def set_rate_limiter(limiter: RateLimiter | None) -> RateLimiter | None:
    """Set the global rate limiter.

    Args:
        limiter: The rate limiter to use, or None to disable

    Returns:
        The previous rate limiter
    """
    global _global_rate_limiter
    previous = _global_rate_limiter
    _global_rate_limiter = limiter
    return previous


def register_model_rate_limiter(model_pattern: str, limiter: RateLimiter) -> None:
    """Register a rate limiter for a specific model pattern.

    Model patterns use prefix matching (e.g., "claude-opus" matches
    "claude-opus-4-20250514").

    Args:
        model_pattern: Model name pattern (prefix)
        limiter: The rate limiter to use for this model
    """
    _model_rate_limiters[model_pattern] = limiter


def clear_model_rate_limiters() -> None:
    """Clear all model-specific rate limiters."""
    _model_rate_limiters.clear()


def reset_all_rate_limiters() -> None:
    """Reset all rate limiters (global and model-specific)."""
    global _global_rate_limiter
    _global_rate_limiter = None
    _model_rate_limiters.clear()


# Convenience functions for common configurations


def create_rate_limiter(
    *,
    rpm: int | None = None,
    rps: int | None = None,
    tpm: int | None = None,
    strategy: RateLimitStrategy = RateLimitStrategy.SLIDING_WINDOW,
    on_exceeded: RateLimitExceededAction = RateLimitExceededAction.WAIT,
) -> RateLimiter:
    """Create a rate limiter with the specified limits.

    Args:
        rpm: Requests per minute limit
        rps: Requests per second limit
        tpm: Tokens per minute limit
        strategy: Rate limiting strategy
        on_exceeded: Action when limit exceeded

    Returns:
        Configured RateLimiter
    """
    config = RateLimitConfig(
        requests_per_minute=rpm,
        requests_per_second=rps,
        tokens_per_minute=tpm,
        strategy=strategy,
        on_exceeded=on_exceeded,
    )
    return RateLimiter(config)


# Default rate limit configurations for Claude models
# Based on Anthropic's rate limits as of 2025

CLAUDE_TIER_1_LIMITS = RateLimitConfig(
    requests_per_minute=50,
    tokens_per_minute=40000,
)

CLAUDE_TIER_2_LIMITS = RateLimitConfig(
    requests_per_minute=1000,
    tokens_per_minute=80000,
)

CLAUDE_TIER_3_LIMITS = RateLimitConfig(
    requests_per_minute=2000,
    tokens_per_minute=160000,
)

CLAUDE_TIER_4_LIMITS = RateLimitConfig(
    requests_per_minute=4000,
    tokens_per_minute=400000,
)


def configure_claude_rate_limits(tier: int = 1) -> RateLimiter:
    """Configure rate limits based on Anthropic API tier.

    Args:
        tier: API tier (1-4), affects rate limits

    Returns:
        Configured RateLimiter set as global
    """
    configs = {
        1: CLAUDE_TIER_1_LIMITS,
        2: CLAUDE_TIER_2_LIMITS,
        3: CLAUDE_TIER_3_LIMITS,
        4: CLAUDE_TIER_4_LIMITS,
    }

    config = configs.get(tier, CLAUDE_TIER_1_LIMITS)
    limiter = RateLimiter(config)
    set_rate_limiter(limiter)
    return limiter
