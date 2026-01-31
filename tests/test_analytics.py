"""Tests for the LLM usage analytics module."""

from __future__ import annotations

import tempfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from smithers.analytics import (
    DEFAULT_MODEL_PRICING,
    BudgetExceededAction,
    BudgetExceededError,
    ModelPricing,
    TokenBudget,
    UsageAnalytics,
    UsageSummary,
    calculate_cost,
    clear_custom_pricing,
    get_model_pricing,
    get_run_cost,
    get_run_tokens,
    recalculate_run_costs,
    register_model_pricing,
)
from smithers.store.sqlite import SqliteStore


class TestModelPricing:
    """Tests for ModelPricing."""

    def test_model_pricing_basic(self) -> None:
        """Test basic cost calculation."""
        pricing = ModelPricing(
            model_pattern="test-model",
            input_price_per_million=1.0,
            output_price_per_million=2.0,
        )

        # 1M tokens should cost exactly the per-million price
        cost = pricing.calculate_cost(input_tokens=1_000_000, output_tokens=0)
        assert cost == 1.0

        cost = pricing.calculate_cost(input_tokens=0, output_tokens=1_000_000)
        assert cost == 2.0

        # Combined
        cost = pricing.calculate_cost(input_tokens=1_000_000, output_tokens=1_000_000)
        assert cost == 3.0

    def test_model_pricing_small_amounts(self) -> None:
        """Test cost calculation for small token amounts."""
        pricing = ModelPricing(
            model_pattern="test-model",
            input_price_per_million=3.0,
            output_price_per_million=15.0,
        )

        # 1000 tokens
        cost = pricing.calculate_cost(input_tokens=1000, output_tokens=500)
        expected = (1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0
        assert abs(cost - expected) < 1e-10

    def test_model_pricing_with_cache(self) -> None:
        """Test cost calculation with cache tokens."""
        pricing = ModelPricing(
            model_pattern="test-model",
            input_price_per_million=3.0,
            output_price_per_million=15.0,
            cache_read_price_per_million=0.30,
            cache_write_price_per_million=3.75,
        )

        cost = pricing.calculate_cost(
            input_tokens=1000,
            output_tokens=500,
            cache_read_tokens=2000,
            cache_write_tokens=1000,
        )
        expected = (
            (1000 / 1_000_000) * 3.0
            + (500 / 1_000_000) * 15.0
            + (2000 / 1_000_000) * 0.30
            + (1000 / 1_000_000) * 3.75
        )
        assert abs(cost - expected) < 1e-10

    def test_model_pricing_no_cache_prices(self) -> None:
        """Test that cache tokens are ignored if no cache pricing."""
        pricing = ModelPricing(
            model_pattern="test-model",
            input_price_per_million=3.0,
            output_price_per_million=15.0,
        )

        cost_without_cache = pricing.calculate_cost(input_tokens=1000, output_tokens=500)
        cost_with_cache = pricing.calculate_cost(
            input_tokens=1000,
            output_tokens=500,
            cache_read_tokens=10000,  # Should be ignored
            cache_write_tokens=5000,  # Should be ignored
        )
        assert cost_without_cache == cost_with_cache


class TestPricingRegistry:
    """Tests for pricing registry functions."""

    def setup_method(self) -> None:
        """Clear custom pricing before each test."""
        clear_custom_pricing()

    def teardown_method(self) -> None:
        """Clear custom pricing after each test."""
        clear_custom_pricing()

    def test_get_default_pricing(self) -> None:
        """Test getting pricing for default models."""
        # Claude Sonnet 4
        pricing = get_model_pricing("claude-sonnet-4-20250514")
        assert pricing is not None
        assert pricing.input_price_per_million == 3.0
        assert pricing.output_price_per_million == 15.0

        # Claude Opus 4.5
        pricing = get_model_pricing("claude-opus-4-5-20251101")
        assert pricing is not None
        assert pricing.input_price_per_million == 15.0
        assert pricing.output_price_per_million == 75.0

        # Claude Haiku 3.5
        pricing = get_model_pricing("claude-3-5-haiku-20241022")
        assert pricing is not None
        assert pricing.input_price_per_million == 0.80

    def test_get_unknown_model(self) -> None:
        """Test getting pricing for unknown model."""
        pricing = get_model_pricing("unknown-model-xyz")
        assert pricing is None

    def test_register_custom_pricing(self) -> None:
        """Test registering custom pricing."""
        custom_pricing = ModelPricing(
            model_pattern="my-custom-model",
            input_price_per_million=5.0,
            output_price_per_million=10.0,
        )
        register_model_pricing(custom_pricing)

        pricing = get_model_pricing("my-custom-model-v1")
        assert pricing is not None
        assert pricing.input_price_per_million == 5.0

    def test_custom_pricing_overrides_default(self) -> None:
        """Test that custom pricing takes precedence."""
        custom_pricing = ModelPricing(
            model_pattern="claude-sonnet-4",
            input_price_per_million=0.0,
            output_price_per_million=0.0,
        )
        register_model_pricing(custom_pricing)

        pricing = get_model_pricing("claude-sonnet-4-20250514")
        assert pricing is not None
        assert pricing.input_price_per_million == 0.0

    def test_clear_custom_pricing(self) -> None:
        """Test clearing custom pricing."""
        custom_pricing = ModelPricing(
            model_pattern="my-custom-model",
            input_price_per_million=5.0,
            output_price_per_million=10.0,
        )
        register_model_pricing(custom_pricing)

        # Should find custom pricing
        assert get_model_pricing("my-custom-model-v1") is not None

        # Clear and should not find it
        clear_custom_pricing()
        assert get_model_pricing("my-custom-model-v1") is None


class TestCalculateCost:
    """Tests for calculate_cost function."""

    def test_calculate_cost_known_model(self) -> None:
        """Test calculating cost for known model."""
        cost = calculate_cost(
            "claude-sonnet-4-20250514",
            input_tokens=1000,
            output_tokens=500,
        )
        assert cost is not None
        expected = (1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0
        assert abs(cost - expected) < 1e-10

    def test_calculate_cost_unknown_model(self) -> None:
        """Test calculating cost for unknown model."""
        cost = calculate_cost(
            "unknown-model",
            input_tokens=1000,
            output_tokens=500,
        )
        assert cost is None


class TestTokenBudget:
    """Tests for TokenBudget."""

    def test_budget_creation(self) -> None:
        """Test creating a token budget."""
        budget = TokenBudget(
            max_input_tokens=10000,
            max_output_tokens=5000,
            max_total_tokens=12000,
            max_cost_usd=1.0,
        )
        assert budget.max_input_tokens == 10000
        assert budget.max_output_tokens == 5000
        assert budget.max_total_tokens == 12000
        assert budget.max_cost_usd == 1.0
        assert budget.used_input_tokens == 0
        assert budget.used_output_tokens == 0
        assert budget.used_cost_usd == 0.0

    def test_budget_record_usage(self) -> None:
        """Test recording usage."""
        budget = TokenBudget(max_total_tokens=10000)

        warnings = budget.record_usage(1000, 500, 0.01)
        assert warnings == []
        assert budget.used_input_tokens == 1000
        assert budget.used_output_tokens == 500
        assert budget.used_total_tokens == 1500
        assert budget.used_cost_usd == 0.01

        # Record more usage
        budget.record_usage(2000, 1000, 0.02)
        assert budget.used_input_tokens == 3000
        assert budget.used_output_tokens == 1500
        assert budget.used_total_tokens == 4500
        assert budget.used_cost_usd == 0.03

    def test_budget_remaining(self) -> None:
        """Test remaining budget calculation."""
        budget = TokenBudget(
            max_input_tokens=10000,
            max_output_tokens=5000,
            max_total_tokens=12000,
            max_cost_usd=1.0,
        )
        budget.record_usage(3000, 1500, 0.25)

        assert budget.remaining_input_tokens == 7000
        assert budget.remaining_output_tokens == 3500
        assert budget.remaining_total_tokens == 7500
        assert budget.remaining_cost_usd == 0.75

    def test_budget_unlimited(self) -> None:
        """Test budget with no limits."""
        budget = TokenBudget()
        budget.record_usage(1000000, 500000, 100.0)

        assert budget.remaining_input_tokens is None
        assert budget.remaining_output_tokens is None
        assert budget.remaining_total_tokens is None
        assert budget.remaining_cost_usd is None
        assert not budget.is_exceeded()

    def test_budget_exceeded_warn(self) -> None:
        """Test budget exceeded with warn action."""
        budget = TokenBudget(
            max_total_tokens=1000,
            on_exceeded=BudgetExceededAction.WARN,
        )

        warnings = budget.record_usage(1500, 500)
        assert len(warnings) == 1
        assert "Total token budget exceeded" in warnings[0]
        assert budget.is_exceeded()
        assert len(budget.warnings) == 1

    def test_budget_exceeded_error(self) -> None:
        """Test budget exceeded with error action."""
        budget = TokenBudget(
            max_total_tokens=1000,
            on_exceeded=BudgetExceededAction.ERROR,
        )

        with pytest.raises(BudgetExceededError) as exc_info:
            budget.record_usage(1500, 500)

        assert "Total token budget exceeded" in str(exc_info.value)
        assert exc_info.value.budget is budget

    def test_budget_exceeded_none(self) -> None:
        """Test budget exceeded with none action (still tracks but no exception)."""
        budget = TokenBudget(
            max_total_tokens=1000,
            on_exceeded=BudgetExceededAction.NONE,
        )

        # NONE action still returns warnings, but doesn't raise exception
        warnings = budget.record_usage(1500, 500)
        assert len(warnings) > 0  # Warnings are returned
        assert budget.is_exceeded()

    def test_budget_utilization(self) -> None:
        """Test budget utilization calculation."""
        budget = TokenBudget(
            max_input_tokens=1000,
            max_output_tokens=500,
            max_total_tokens=1200,
            max_cost_usd=0.10,
        )
        budget.record_usage(500, 250, 0.05)

        utilization = budget.utilization()
        assert utilization["input_tokens"] == 50.0
        assert utilization["output_tokens"] == 50.0
        assert abs(utilization["total_tokens"] - 62.5) < 0.1  # 750/1200
        assert utilization["cost_usd"] == 50.0

    def test_budget_utilization_partial(self) -> None:
        """Test utilization with only some limits set."""
        budget = TokenBudget(max_total_tokens=1000)
        budget.record_usage(500, 250)

        utilization = budget.utilization()
        assert utilization["input_tokens"] is None
        assert utilization["output_tokens"] is None
        assert utilization["total_tokens"] == 75.0
        assert utilization["cost_usd"] is None

    def test_budget_reset(self) -> None:
        """Test resetting budget."""
        budget = TokenBudget(max_total_tokens=1000)
        budget.record_usage(500, 250)
        budget.record_usage(600, 300)  # Will exceed and add warning

        assert budget.used_total_tokens == 1650
        assert len(budget.warnings) > 0

        budget.reset()

        assert budget.used_input_tokens == 0
        assert budget.used_output_tokens == 0
        assert budget.used_cost_usd == 0.0
        assert len(budget.warnings) == 0

    def test_budget_to_dict(self) -> None:
        """Test converting budget to dict."""
        budget = TokenBudget(
            max_input_tokens=1000,
            max_cost_usd=0.10,
        )
        budget.record_usage(500, 250, 0.05)

        data = budget.to_dict()
        assert data["max_input_tokens"] == 1000
        assert data["max_cost_usd"] == 0.10
        assert data["used_input_tokens"] == 500
        assert data["used_output_tokens"] == 250
        assert data["used_cost_usd"] == 0.05
        assert data["is_exceeded"] is False
        assert "utilization" in data

    def test_budget_multiple_limits_exceeded(self) -> None:
        """Test multiple budget limits exceeded."""
        budget = TokenBudget(
            max_input_tokens=100,
            max_output_tokens=50,
            max_cost_usd=0.001,
            on_exceeded=BudgetExceededAction.WARN,
        )

        warnings = budget.record_usage(200, 100, 0.01)
        assert len(warnings) == 3  # All three limits exceeded


class TestUsageSummary:
    """Tests for UsageSummary."""

    def test_usage_summary_basic(self) -> None:
        """Test basic usage summary."""
        summary = UsageSummary(
            total_calls=10,
            total_input_tokens=5000,
            total_output_tokens=2500,
            total_cost_usd=0.05,
            models={"claude-sonnet-4": 8, "claude-haiku-3.5": 2},
        )

        assert summary.total_tokens == 7500
        assert summary.avg_tokens_per_call == 750
        assert summary.avg_cost_per_call == 0.005

    def test_usage_summary_empty(self) -> None:
        """Test empty usage summary."""
        summary = UsageSummary()

        assert summary.total_tokens == 0
        assert summary.avg_tokens_per_call == 0.0
        assert summary.avg_cost_per_call == 0.0

    def test_usage_summary_to_dict(self) -> None:
        """Test converting summary to dict."""
        summary = UsageSummary(
            total_calls=5,
            total_input_tokens=1000,
            total_output_tokens=500,
            total_cost_usd=0.02,
            models={"claude-sonnet-4": 5},
            period_start=datetime(2025, 1, 1, tzinfo=UTC),
            period_end=datetime(2025, 1, 7, tzinfo=UTC),
        )

        data = summary.to_dict()
        assert data["total_calls"] == 5
        assert data["total_tokens"] == 1500
        assert data["models"] == {"claude-sonnet-4": 5}
        assert "period_start" in data
        assert "period_end" in data


class TestUsageAnalytics:
    """Tests for UsageAnalytics with real database."""

    @pytest.fixture
    async def store_with_data(self) -> SqliteStore:
        """Create a store with test LLM call data."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SqliteStore(Path(tmpdir) / "test.db")
            await store.initialize()

            # Create a run
            run_id = await store.create_run("test-plan-hash", "target-node")

            # Record some LLM calls
            call1 = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call1, input_tokens=1000, output_tokens=500, cost_usd=0.01
            )

            call2 = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call2, input_tokens=2000, output_tokens=1000, cost_usd=0.02
            )

            call3 = await store.record_llm_call_start(run_id, "node2", "claude-opus-4-5-20251101")
            await store.record_llm_call_end(
                call3, input_tokens=500, output_tokens=200, cost_usd=0.05
            )

            yield store

    @pytest.mark.asyncio
    async def test_get_run_summary(self, store_with_data: SqliteStore) -> None:
        """Test getting run summary."""
        store = store_with_data
        runs = await store.list_runs()
        run_id = runs[0].run_id

        analytics = UsageAnalytics(store)
        summary = await analytics.get_run_summary(run_id)

        assert summary.total_calls == 3
        assert summary.total_input_tokens == 3500
        assert summary.total_output_tokens == 1700
        assert summary.total_cost_usd == 0.08
        assert "claude-sonnet-4-20250514" in summary.models
        assert "claude-opus-4-5-20251101" in summary.models

    @pytest.mark.asyncio
    async def test_get_run_summary_by_node(self, store_with_data: SqliteStore) -> None:
        """Test getting run summary with per-node breakdown."""
        store = store_with_data
        runs = await store.list_runs()
        run_id = runs[0].run_id

        analytics = UsageAnalytics(store)
        summary = await analytics.get_run_summary(run_id, include_by_node=True)

        assert "node1" in summary.by_node
        assert "node2" in summary.by_node
        assert summary.by_node["node1"].total_calls == 2
        assert summary.by_node["node2"].total_calls == 1

    @pytest.mark.asyncio
    async def test_get_run_summary_recalculate(self, store_with_data: SqliteStore) -> None:
        """Test recalculating costs."""
        store = store_with_data
        runs = await store.list_runs()
        run_id = runs[0].run_id

        analytics = UsageAnalytics(store)
        summary = await analytics.get_run_summary(run_id, recalculate_costs=True)

        # Cost should be recalculated using current pricing
        assert summary.total_cost_usd > 0
        # Recalculated cost may differ from stored cost

    @pytest.mark.asyncio
    async def test_get_model_breakdown(self, store_with_data: SqliteStore) -> None:
        """Test getting breakdown by model."""
        store = store_with_data
        runs = await store.list_runs()
        run_id = runs[0].run_id

        analytics = UsageAnalytics(store)
        breakdown = await analytics.get_model_breakdown(run_id)

        assert "claude-sonnet-4-20250514" in breakdown
        assert "claude-opus-4-5-20251101" in breakdown
        assert breakdown["claude-sonnet-4-20250514"].total_calls == 2
        assert breakdown["claude-opus-4-5-20251101"].total_calls == 1


class TestHelperFunctions:
    """Tests for helper functions."""

    @pytest.fixture
    async def store_with_data(self) -> SqliteStore:
        """Create a store with test data."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SqliteStore(Path(tmpdir) / "test.db")
            await store.initialize()

            run_id = await store.create_run("plan-hash", "target")
            call_id = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call_id, input_tokens=1000, output_tokens=500, cost_usd=0.015
            )

            yield store

    @pytest.mark.asyncio
    async def test_get_run_cost(self, store_with_data: SqliteStore) -> None:
        """Test get_run_cost helper."""
        store = store_with_data
        runs = await store.list_runs()
        run_id = runs[0].run_id

        cost = await get_run_cost(store, run_id)
        assert cost == 0.015

    @pytest.mark.asyncio
    async def test_get_run_tokens(self, store_with_data: SqliteStore) -> None:
        """Test get_run_tokens helper."""
        store = store_with_data
        runs = await store.list_runs()
        run_id = runs[0].run_id

        input_tokens, output_tokens = await get_run_tokens(store, run_id)
        assert input_tokens == 1000
        assert output_tokens == 500

    @pytest.mark.asyncio
    async def test_recalculate_run_costs(self, store_with_data: SqliteStore) -> None:
        """Test recalculate_run_costs helper."""
        store = store_with_data
        runs = await store.list_runs()
        run_id = runs[0].run_id

        cost = await recalculate_run_costs(store, run_id)
        assert cost > 0


class TestDefaultPricing:
    """Tests for default model pricing."""

    def test_default_pricing_exists(self) -> None:
        """Test that default pricing is configured."""
        assert len(DEFAULT_MODEL_PRICING) > 0

    def test_claude_sonnet_4_pricing(self) -> None:
        """Test Claude Sonnet 4 pricing."""
        pricing = get_model_pricing("claude-sonnet-4-20250514")
        assert pricing is not None
        assert pricing.input_price_per_million == 3.0
        assert pricing.output_price_per_million == 15.0
        assert pricing.cache_read_price_per_million == 0.30
        assert pricing.cache_write_price_per_million == 3.75

    def test_claude_opus_4_5_pricing(self) -> None:
        """Test Claude Opus 4.5 pricing."""
        pricing = get_model_pricing("claude-opus-4-5-20251101")
        assert pricing is not None
        assert pricing.input_price_per_million == 15.0
        assert pricing.output_price_per_million == 75.0
        assert pricing.cache_read_price_per_million == 1.50
        assert pricing.cache_write_price_per_million == 18.75

    def test_claude_haiku_3_5_pricing(self) -> None:
        """Test Claude Haiku 3.5 pricing."""
        pricing = get_model_pricing("claude-3-5-haiku-20241022")
        assert pricing is not None
        assert pricing.input_price_per_million == 0.80
        assert pricing.output_price_per_million == 4.00

    def test_all_default_models_have_input_output_prices(self) -> None:
        """Test that all default models have required pricing."""
        for pricing in DEFAULT_MODEL_PRICING:
            assert pricing.input_price_per_million >= 0
            assert pricing.output_price_per_million >= 0
            assert pricing.model_pattern != ""
