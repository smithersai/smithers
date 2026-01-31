"""LLM Usage Analytics Module.

This module provides comprehensive analytics for LLM usage including:
- Model pricing configuration for automatic cost calculation
- Token budget tracking and enforcement
- Usage aggregation and reporting

Example usage:
    from smithers.analytics import (
        calculate_cost,
        get_model_pricing,
        TokenBudget,
        UsageAnalytics,
    )

    # Calculate cost for a specific model call
    cost = calculate_cost("claude-sonnet-4-20250514", input_tokens=1000, output_tokens=500)

    # Create a token budget
    budget = TokenBudget(max_input_tokens=100000, max_output_tokens=50000)

    # Get usage analytics from a store
    analytics = UsageAnalytics(store)
    summary = await analytics.get_run_summary(run_id)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from smithers.store.sqlite import SqliteStore


class BudgetExceededAction(str, Enum):
    """Action to take when token budget is exceeded."""

    WARN = "warn"  # Log a warning but continue
    ERROR = "error"  # Raise an exception
    NONE = "none"  # Do nothing, just track


@dataclass(frozen=True)
class ModelPricing:
    """Pricing configuration for an LLM model.

    Prices are in USD per million tokens.

    Attributes:
        model_pattern: Model name or pattern to match (supports prefix matching)
        input_price_per_million: Cost per million input tokens
        output_price_per_million: Cost per million output tokens
        cache_read_price_per_million: Cost per million cached input tokens (if applicable)
        cache_write_price_per_million: Cost per million tokens written to cache (if applicable)
    """

    model_pattern: str
    input_price_per_million: float
    output_price_per_million: float
    cache_read_price_per_million: float | None = None
    cache_write_price_per_million: float | None = None

    def calculate_cost(
        self,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
    ) -> float:
        """Calculate the cost for a given number of tokens.

        Args:
            input_tokens: Number of input tokens (non-cached)
            output_tokens: Number of output tokens
            cache_read_tokens: Number of tokens read from cache
            cache_write_tokens: Number of tokens written to cache

        Returns:
            Cost in USD
        """
        cost = 0.0
        cost += (input_tokens / 1_000_000) * self.input_price_per_million
        cost += (output_tokens / 1_000_000) * self.output_price_per_million

        if cache_read_tokens > 0 and self.cache_read_price_per_million is not None:
            cost += (cache_read_tokens / 1_000_000) * self.cache_read_price_per_million

        if cache_write_tokens > 0 and self.cache_write_price_per_million is not None:
            cost += (cache_write_tokens / 1_000_000) * self.cache_write_price_per_million

        return cost


# Default pricing for Claude models (as of 2025)
# Prices from Anthropic's pricing page
DEFAULT_MODEL_PRICING: list[ModelPricing] = [
    # Claude Opus 4.5
    ModelPricing(
        model_pattern="claude-opus-4-5",
        input_price_per_million=15.00,
        output_price_per_million=75.00,
        cache_read_price_per_million=1.50,
        cache_write_price_per_million=18.75,
    ),
    # Claude Sonnet 4
    ModelPricing(
        model_pattern="claude-sonnet-4",
        input_price_per_million=3.00,
        output_price_per_million=15.00,
        cache_read_price_per_million=0.30,
        cache_write_price_per_million=3.75,
    ),
    # Claude Haiku 3.5
    ModelPricing(
        model_pattern="claude-3-5-haiku",
        input_price_per_million=0.80,
        output_price_per_million=4.00,
        cache_read_price_per_million=0.08,
        cache_write_price_per_million=1.00,
    ),
    # Claude Sonnet 3.5 (legacy)
    ModelPricing(
        model_pattern="claude-3-5-sonnet",
        input_price_per_million=3.00,
        output_price_per_million=15.00,
        cache_read_price_per_million=0.30,
        cache_write_price_per_million=3.75,
    ),
    # Claude Opus 3 (legacy)
    ModelPricing(
        model_pattern="claude-3-opus",
        input_price_per_million=15.00,
        output_price_per_million=75.00,
        cache_read_price_per_million=1.50,
        cache_write_price_per_million=18.75,
    ),
    # Claude Sonnet 3 (legacy)
    ModelPricing(
        model_pattern="claude-3-sonnet",
        input_price_per_million=3.00,
        output_price_per_million=15.00,
    ),
    # Claude Haiku 3 (legacy)
    ModelPricing(
        model_pattern="claude-3-haiku",
        input_price_per_million=0.25,
        output_price_per_million=1.25,
        cache_read_price_per_million=0.03,
        cache_write_price_per_million=0.30,
    ),
]

# Custom pricing registry (user-defined)
_custom_pricing: list[ModelPricing] = []


def register_model_pricing(pricing: ModelPricing) -> None:
    """Register custom pricing for a model.

    Custom pricing takes precedence over default pricing.

    Args:
        pricing: The pricing configuration to register
    """
    _custom_pricing.insert(0, pricing)


def clear_custom_pricing() -> None:
    """Clear all custom pricing configurations."""
    _custom_pricing.clear()


def get_model_pricing(model: str) -> ModelPricing | None:
    """Get pricing configuration for a model.

    Searches custom pricing first, then default pricing.
    Uses prefix matching on model names.

    Args:
        model: The model name (e.g., "claude-sonnet-4-20250514")

    Returns:
        ModelPricing if found, None otherwise
    """
    # Check custom pricing first
    for pricing in _custom_pricing:
        if model.startswith(pricing.model_pattern):
            return pricing

    # Check default pricing
    for pricing in DEFAULT_MODEL_PRICING:
        if model.startswith(pricing.model_pattern):
            return pricing

    return None


def calculate_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_read_tokens: int = 0,
    cache_write_tokens: int = 0,
) -> float | None:
    """Calculate the cost for an LLM call.

    Args:
        model: The model name
        input_tokens: Number of input tokens
        output_tokens: Number of output tokens
        cache_read_tokens: Number of tokens read from cache
        cache_write_tokens: Number of tokens written to cache

    Returns:
        Cost in USD, or None if pricing not available
    """
    pricing = get_model_pricing(model)
    if pricing is None:
        return None

    return pricing.calculate_cost(
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
    )


@dataclass
class TokenBudget:
    """Token budget for tracking and limiting LLM usage.

    A budget can track input tokens, output tokens, total tokens, and cost.
    When limits are exceeded, the configured action is taken.

    Attributes:
        max_input_tokens: Maximum input tokens allowed (None for unlimited)
        max_output_tokens: Maximum output tokens allowed (None for unlimited)
        max_total_tokens: Maximum total tokens allowed (None for unlimited)
        max_cost_usd: Maximum cost in USD (None for unlimited)
        on_exceeded: Action to take when budget is exceeded

    Example:
        budget = TokenBudget(max_total_tokens=100000, max_cost_usd=5.00)
        budget.record_usage(1000, 500, 0.015)
        print(f"Remaining: {budget.remaining_total_tokens} tokens")
    """

    max_input_tokens: int | None = None
    max_output_tokens: int | None = None
    max_total_tokens: int | None = None
    max_cost_usd: float | None = None
    on_exceeded: BudgetExceededAction = BudgetExceededAction.WARN

    # Tracking fields
    used_input_tokens: int = field(default=0, init=False)
    used_output_tokens: int = field(default=0, init=False)
    used_cost_usd: float = field(default=0.0, init=False)
    _warnings: list[str] = field(default_factory=lambda: list[str](), init=False)

    def record_usage(
        self,
        input_tokens: int,
        output_tokens: int,
        cost_usd: float | None = None,
    ) -> list[str]:
        """Record token usage and check budget limits.

        Args:
            input_tokens: Number of input tokens used
            output_tokens: Number of output tokens used
            cost_usd: Cost in USD (if known)

        Returns:
            List of warning/error messages if budget exceeded

        Raises:
            BudgetExceededError: If on_exceeded is ERROR and budget exceeded
        """
        self.used_input_tokens += input_tokens
        self.used_output_tokens += output_tokens
        if cost_usd is not None:
            self.used_cost_usd += cost_usd

        messages: list[str] = []

        # Check input tokens
        if self.max_input_tokens is not None and self.used_input_tokens > self.max_input_tokens:
            msg = f"Input token budget exceeded: {self.used_input_tokens}/{self.max_input_tokens}"
            messages.append(msg)

        # Check output tokens
        if self.max_output_tokens is not None and self.used_output_tokens > self.max_output_tokens:
            msg = (
                f"Output token budget exceeded: {self.used_output_tokens}/{self.max_output_tokens}"
            )
            messages.append(msg)

        # Check total tokens
        total = self.used_input_tokens + self.used_output_tokens
        if self.max_total_tokens is not None and total > self.max_total_tokens:
            msg = f"Total token budget exceeded: {total}/{self.max_total_tokens}"
            messages.append(msg)

        # Check cost
        if self.max_cost_usd is not None and self.used_cost_usd > self.max_cost_usd:
            msg = f"Cost budget exceeded: ${self.used_cost_usd:.4f}/${self.max_cost_usd:.2f}"
            messages.append(msg)

        # Handle exceeded budget
        if messages:
            self._warnings.extend(messages)
            if self.on_exceeded == BudgetExceededAction.ERROR:
                raise BudgetExceededError(messages[0], self)

        return messages

    @property
    def used_total_tokens(self) -> int:
        """Get total tokens used."""
        return self.used_input_tokens + self.used_output_tokens

    @property
    def remaining_input_tokens(self) -> int | None:
        """Get remaining input tokens, or None if unlimited."""
        if self.max_input_tokens is None:
            return None
        return max(0, self.max_input_tokens - self.used_input_tokens)

    @property
    def remaining_output_tokens(self) -> int | None:
        """Get remaining output tokens, or None if unlimited."""
        if self.max_output_tokens is None:
            return None
        return max(0, self.max_output_tokens - self.used_output_tokens)

    @property
    def remaining_total_tokens(self) -> int | None:
        """Get remaining total tokens, or None if unlimited."""
        if self.max_total_tokens is None:
            return None
        return max(0, self.max_total_tokens - self.used_total_tokens)

    @property
    def remaining_cost_usd(self) -> float | None:
        """Get remaining cost budget, or None if unlimited."""
        if self.max_cost_usd is None:
            return None
        return max(0.0, self.max_cost_usd - self.used_cost_usd)

    @property
    def warnings(self) -> list[str]:
        """Get all budget warning messages."""
        return list(self._warnings)

    def is_exceeded(self) -> bool:
        """Check if any budget limit is exceeded."""
        if self.max_input_tokens is not None and self.used_input_tokens > self.max_input_tokens:
            return True
        if self.max_output_tokens is not None and self.used_output_tokens > self.max_output_tokens:
            return True
        if self.max_total_tokens is not None and self.used_total_tokens > self.max_total_tokens:
            return True
        return self.max_cost_usd is not None and self.used_cost_usd > self.max_cost_usd

    def utilization(self) -> dict[str, float | None]:
        """Get budget utilization as percentages.

        Returns:
            Dict with utilization percentages (0-100+) for each limit,
            or None if that limit is not set.
        """
        result: dict[str, float | None] = {}

        if self.max_input_tokens is not None:
            result["input_tokens"] = (self.used_input_tokens / self.max_input_tokens) * 100
        else:
            result["input_tokens"] = None

        if self.max_output_tokens is not None:
            result["output_tokens"] = (self.used_output_tokens / self.max_output_tokens) * 100
        else:
            result["output_tokens"] = None

        if self.max_total_tokens is not None:
            result["total_tokens"] = (self.used_total_tokens / self.max_total_tokens) * 100
        else:
            result["total_tokens"] = None

        if self.max_cost_usd is not None:
            result["cost_usd"] = (self.used_cost_usd / self.max_cost_usd) * 100
        else:
            result["cost_usd"] = None

        return result

    def reset(self) -> None:
        """Reset usage tracking to zero."""
        self.used_input_tokens = 0
        self.used_output_tokens = 0
        self.used_cost_usd = 0.0
        self._warnings.clear()

    def to_dict(self) -> dict[str, Any]:
        """Convert budget to a dictionary for serialization."""
        return {
            "max_input_tokens": self.max_input_tokens,
            "max_output_tokens": self.max_output_tokens,
            "max_total_tokens": self.max_total_tokens,
            "max_cost_usd": self.max_cost_usd,
            "used_input_tokens": self.used_input_tokens,
            "used_output_tokens": self.used_output_tokens,
            "used_cost_usd": self.used_cost_usd,
            "is_exceeded": self.is_exceeded(),
            "utilization": self.utilization(),
        }


class BudgetExceededError(Exception):
    """Raised when a token budget is exceeded and on_exceeded is ERROR."""

    def __init__(self, message: str, budget: TokenBudget) -> None:
        super().__init__(message)
        self.budget = budget


@dataclass
class UsageSummary:
    """Summary of LLM usage statistics.

    Attributes:
        total_calls: Number of LLM calls
        total_input_tokens: Total input tokens
        total_output_tokens: Total output tokens
        total_cost_usd: Total cost in USD
        models: Dict mapping model names to call counts
        by_node: Dict mapping node IDs to usage summaries (if applicable)
        period_start: Start of the period (if applicable)
        period_end: End of the period (if applicable)
    """

    total_calls: int = 0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_cost_usd: float = 0.0
    models: dict[str, int] = field(default_factory=lambda: dict[str, int]())
    by_node: dict[str, UsageSummary] = field(default_factory=lambda: dict[str, UsageSummary]())
    period_start: datetime | None = None
    period_end: datetime | None = None

    @property
    def total_tokens(self) -> int:
        """Total tokens (input + output)."""
        return self.total_input_tokens + self.total_output_tokens

    @property
    def avg_tokens_per_call(self) -> float:
        """Average tokens per call."""
        if self.total_calls == 0:
            return 0.0
        return self.total_tokens / self.total_calls

    @property
    def avg_cost_per_call(self) -> float:
        """Average cost per call."""
        if self.total_calls == 0:
            return 0.0
        return self.total_cost_usd / self.total_calls

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        result: dict[str, Any] = {
            "total_calls": self.total_calls,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "total_tokens": self.total_tokens,
            "total_cost_usd": self.total_cost_usd,
            "avg_tokens_per_call": self.avg_tokens_per_call,
            "avg_cost_per_call": self.avg_cost_per_call,
            "models": self.models,
        }
        if self.period_start:
            result["period_start"] = self.period_start.isoformat()
        if self.period_end:
            result["period_end"] = self.period_end.isoformat()
        if self.by_node:
            result["by_node"] = {k: v.to_dict() for k, v in self.by_node.items()}
        return result


class UsageAnalytics:
    """Analytics engine for LLM usage data.

    Provides methods to aggregate and analyze LLM usage from the SQLite store.

    Example:
        analytics = UsageAnalytics(store)

        # Get summary for a specific run
        summary = await analytics.get_run_summary(run_id)

        # Get summary for all runs in a time period
        summary = await analytics.get_period_summary(
            since=datetime.now(UTC) - timedelta(days=7)
        )
    """

    def __init__(self, store: SqliteStore) -> None:
        """Initialize the analytics engine.

        Args:
            store: The SQLite store to query
        """
        self.store = store

    async def get_run_summary(
        self,
        run_id: str,
        *,
        include_by_node: bool = False,
        recalculate_costs: bool = False,
    ) -> UsageSummary:
        """Get usage summary for a specific run.

        Args:
            run_id: The run ID to summarize
            include_by_node: Include per-node breakdown
            recalculate_costs: Recalculate costs using current pricing

        Returns:
            UsageSummary with aggregated usage data
        """
        llm_calls = await self.store.get_llm_calls(run_id)

        summary = UsageSummary()
        node_summaries: dict[str, UsageSummary] = {}

        for call in llm_calls:
            input_tokens = call.input_tokens or 0
            output_tokens = call.output_tokens or 0

            # Calculate or use stored cost
            if recalculate_costs:
                cost = calculate_cost(call.model, input_tokens, output_tokens) or 0.0
            else:
                cost = call.cost_usd or 0.0

            summary.total_calls += 1
            summary.total_input_tokens += input_tokens
            summary.total_output_tokens += output_tokens
            summary.total_cost_usd += cost
            summary.models[call.model] = summary.models.get(call.model, 0) + 1

            if include_by_node:
                if call.node_id not in node_summaries:
                    node_summaries[call.node_id] = UsageSummary()
                node_summary = node_summaries[call.node_id]
                node_summary.total_calls += 1
                node_summary.total_input_tokens += input_tokens
                node_summary.total_output_tokens += output_tokens
                node_summary.total_cost_usd += cost
                node_summary.models[call.model] = node_summary.models.get(call.model, 0) + 1

        if include_by_node:
            summary.by_node = node_summaries

        return summary

    async def get_period_summary(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        recalculate_costs: bool = False,
    ) -> UsageSummary:
        """Get usage summary for a time period across all runs.

        Args:
            since: Start of period (default: no start limit)
            until: End of period (default: no end limit)
            recalculate_costs: Recalculate costs using current pricing

        Returns:
            UsageSummary with aggregated usage data
        """
        runs = await self.store.list_runs(limit=10000)

        summary = UsageSummary(
            period_start=since,
            period_end=until,
        )

        for run in runs:
            # Filter by time period
            if run.created_at:
                if since and run.created_at < since:
                    continue
                if until and run.created_at > until:
                    continue

            run_summary = await self.get_run_summary(
                run.run_id, recalculate_costs=recalculate_costs
            )

            summary.total_calls += run_summary.total_calls
            summary.total_input_tokens += run_summary.total_input_tokens
            summary.total_output_tokens += run_summary.total_output_tokens
            summary.total_cost_usd += run_summary.total_cost_usd

            for model, count in run_summary.models.items():
                summary.models[model] = summary.models.get(model, 0) + count

        return summary

    async def get_model_breakdown(
        self,
        run_id: str | None = None,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> dict[str, UsageSummary]:
        """Get usage breakdown by model.

        Args:
            run_id: Specific run to analyze (None for all runs)
            since: Start of period (if run_id is None)
            until: End of period (if run_id is None)

        Returns:
            Dict mapping model names to UsageSummary
        """
        from smithers.store.sqlite import LLMCall

        llm_calls: list[LLMCall]
        if run_id:
            llm_calls = await self.store.get_llm_calls(run_id)
        else:
            # Get all runs in period
            runs = await self.store.list_runs(limit=10000)
            llm_calls = []
            for run in runs:
                if run.created_at:
                    if since and run.created_at < since:
                        continue
                    if until and run.created_at > until:
                        continue
                llm_calls.extend(await self.store.get_llm_calls(run.run_id))

        by_model: dict[str, UsageSummary] = {}

        for call in llm_calls:
            if call.model not in by_model:
                by_model[call.model] = UsageSummary()

            summary = by_model[call.model]
            input_tokens = call.input_tokens or 0
            output_tokens = call.output_tokens or 0
            cost = call.cost_usd or calculate_cost(call.model, input_tokens, output_tokens) or 0.0

            summary.total_calls += 1
            summary.total_input_tokens += input_tokens
            summary.total_output_tokens += output_tokens
            summary.total_cost_usd += cost
            summary.models[call.model] = summary.total_calls

        return by_model

    async def estimate_remaining_budget(
        self,
        budget: TokenBudget,
        run_id: str,
    ) -> dict[str, Any]:
        """Estimate remaining budget for a run.

        Args:
            budget: The token budget to check against
            run_id: The run ID to check

        Returns:
            Dict with remaining budget info and estimates
        """
        summary = await self.get_run_summary(run_id)

        # Update budget with current usage (creates a copy to not modify original)
        budget_copy = TokenBudget(
            max_input_tokens=budget.max_input_tokens,
            max_output_tokens=budget.max_output_tokens,
            max_total_tokens=budget.max_total_tokens,
            max_cost_usd=budget.max_cost_usd,
            on_exceeded=BudgetExceededAction.NONE,  # Don't raise
        )
        budget_copy.record_usage(
            summary.total_input_tokens,
            summary.total_output_tokens,
            summary.total_cost_usd,
        )

        # Estimate calls remaining based on average
        avg_input = (
            summary.total_input_tokens / summary.total_calls if summary.total_calls > 0 else 0
        )
        avg_output = (
            summary.total_output_tokens / summary.total_calls if summary.total_calls > 0 else 0
        )
        avg_cost = summary.total_cost_usd / summary.total_calls if summary.total_calls > 0 else 0

        calls_remaining = None
        if budget.max_total_tokens and summary.total_calls > 0:
            avg_total = avg_input + avg_output
            if avg_total > 0:
                remaining_tokens = budget_copy.remaining_total_tokens or 0
                calls_remaining = int(remaining_tokens / avg_total)

        if budget.max_cost_usd and summary.total_calls > 0 and avg_cost > 0:
            remaining_cost = budget_copy.remaining_cost_usd or 0
            cost_based_remaining = int(remaining_cost / avg_cost)
            if calls_remaining is None or cost_based_remaining < calls_remaining:
                calls_remaining = cost_based_remaining

        return {
            "current_usage": summary.to_dict(),
            "budget": budget_copy.to_dict(),
            "estimated_calls_remaining": calls_remaining,
        }


# Helper functions for quick analytics


async def get_run_cost(store: SqliteStore, run_id: str) -> float:
    """Get total cost for a run.

    Args:
        store: The SQLite store
        run_id: The run ID

    Returns:
        Total cost in USD
    """
    analytics = UsageAnalytics(store)
    summary = await analytics.get_run_summary(run_id)
    return summary.total_cost_usd


async def get_run_tokens(store: SqliteStore, run_id: str) -> tuple[int, int]:
    """Get total tokens for a run.

    Args:
        store: The SQLite store
        run_id: The run ID

    Returns:
        Tuple of (input_tokens, output_tokens)
    """
    analytics = UsageAnalytics(store)
    summary = await analytics.get_run_summary(run_id)
    return summary.total_input_tokens, summary.total_output_tokens


async def recalculate_run_costs(store: SqliteStore, run_id: str) -> float:
    """Recalculate costs for a run using current pricing.

    This is useful if costs were not recorded originally or pricing has changed.

    Args:
        store: The SQLite store
        run_id: The run ID

    Returns:
        Total recalculated cost in USD
    """
    analytics = UsageAnalytics(store)
    summary = await analytics.get_run_summary(run_id, recalculate_costs=True)
    return summary.total_cost_usd


async def get_daily_usage(
    store: SqliteStore,
    days: int = 7,
) -> list[dict[str, Any]]:
    """Get daily usage breakdown for the past N days.

    Args:
        store: The SQLite store
        days: Number of days to include

    Returns:
        List of daily usage summaries
    """
    analytics = UsageAnalytics(store)
    results: list[dict[str, Any]] = []

    for i in range(days):
        day_end = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
            days=i
        )
        day_start = day_end - timedelta(days=1)

        summary = await analytics.get_period_summary(since=day_start, until=day_end)
        results.append(
            {
                "date": day_start.date().isoformat(),
                **summary.to_dict(),
            }
        )

    return list(reversed(results))
