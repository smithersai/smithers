"""Tests for conditional workflow execution."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from smithers import (
    Condition,
    ConditionNotMetError,
    ConditionPolicy,
    all_of,
    always,
    any_of,
    build_graph,
    dep_succeeded,
    evaluate_condition,
    field_equals,
    field_gt,
    field_gte,
    field_in,
    field_lt,
    get_condition_policy,
    has_attr,
    has_condition,
    never,
    not_,
    run_graph,
    run_if,
    skip_if,
    when,
    workflow,
)
from smithers.workflow import clear_registry


class CheckOutput(BaseModel):
    passed: bool
    coverage: float = 0.8


class DeployOutput(BaseModel):
    deployed: bool


class ConfigOutput(BaseModel):
    env: str
    force_deploy: bool = False
    skip_tests: bool = False


@pytest.fixture(autouse=True)
def clean_registry():
    """Clear registry before each test."""
    clear_registry()
    yield
    clear_registry()


# ========================
# Condition class tests
# ========================


class TestConditionClass:
    """Tests for the Condition class."""

    def test_condition_creation(self):
        """Condition can be created with a function."""
        cond = Condition(lambda deps: True, "always true")
        assert cond.description == "always true"

    def test_condition_call(self):
        """Condition can be called like a function."""
        cond = Condition(lambda deps: deps.value > 5)
        assert cond(SimpleNamespace(value=10)) is True
        assert cond(SimpleNamespace(value=3)) is False

    def test_condition_and(self):
        """Conditions can be combined with AND."""
        cond1 = Condition(lambda deps: deps.a > 0)
        cond2 = Condition(lambda deps: deps.b > 0)
        combined = cond1 & cond2

        assert combined(SimpleNamespace(a=1, b=1)) is True
        assert combined(SimpleNamespace(a=1, b=-1)) is False
        assert combined(SimpleNamespace(a=-1, b=1)) is False

    def test_condition_or(self):
        """Conditions can be combined with OR."""
        cond1 = Condition(lambda deps: deps.a > 0)
        cond2 = Condition(lambda deps: deps.b > 0)
        combined = cond1 | cond2

        assert combined(SimpleNamespace(a=1, b=-1)) is True
        assert combined(SimpleNamespace(a=-1, b=1)) is True
        assert combined(SimpleNamespace(a=-1, b=-1)) is False

    def test_condition_not(self):
        """Conditions can be negated."""
        cond = Condition(lambda deps: deps.value > 0)
        negated = ~cond

        assert negated(SimpleNamespace(value=-1)) is True
        assert negated(SimpleNamespace(value=1)) is False


# ========================
# Condition combinator tests
# ========================


class TestConditionCombinators:
    """Tests for condition combinator functions."""

    def test_all_of(self):
        """all_of combines conditions with AND."""
        cond = all_of(
            lambda deps: deps.a > 0,
            lambda deps: deps.b > 0,
            lambda deps: deps.c > 0,
        )

        assert cond(SimpleNamespace(a=1, b=1, c=1)) is True
        assert cond(SimpleNamespace(a=1, b=1, c=-1)) is False

    def test_any_of(self):
        """any_of combines conditions with OR."""
        cond = any_of(
            lambda deps: deps.a > 0,
            lambda deps: deps.b > 0,
        )

        assert cond(SimpleNamespace(a=1, b=-1)) is True
        assert cond(SimpleNamespace(a=-1, b=1)) is True
        assert cond(SimpleNamespace(a=-1, b=-1)) is False

    def test_not_(self):
        """not_ negates a condition."""
        cond = not_(lambda deps: deps.value > 0)

        assert cond(SimpleNamespace(value=-1)) is True
        assert cond(SimpleNamespace(value=1)) is False

    def test_always(self):
        """always returns a condition that is always True."""
        cond = always()
        assert cond(SimpleNamespace()) is True

    def test_never(self):
        """never returns a condition that is always False."""
        cond = never()
        assert cond(SimpleNamespace()) is False


# ========================
# Pre-built condition tests
# ========================


class TestPreBuiltConditions:
    """Tests for pre-built condition helpers."""

    def test_has_attr_exists(self):
        """has_attr checks if attribute exists."""
        cond = has_attr("foo")
        assert cond(SimpleNamespace(foo="bar")) is True
        assert cond(SimpleNamespace()) is False

    def test_has_attr_nested(self):
        """has_attr supports nested paths."""
        cond = has_attr("foo.bar.baz")
        inner = SimpleNamespace(baz=True)
        middle = SimpleNamespace(bar=inner)
        outer = SimpleNamespace(foo=middle)
        assert cond(outer) is True
        assert cond(SimpleNamespace(foo=SimpleNamespace())) is False

    def test_has_attr_with_value(self):
        """has_attr can check for specific value."""
        cond = has_attr("foo", "bar")
        assert cond(SimpleNamespace(foo="bar")) is True
        assert cond(SimpleNamespace(foo="baz")) is False

    def test_dep_succeeded(self):
        """dep_succeeded checks if dependency is not None."""
        cond = dep_succeeded("result")
        assert cond(SimpleNamespace(result=CheckOutput(passed=True))) is True
        assert cond(SimpleNamespace(result=None)) is False
        assert cond(SimpleNamespace()) is False

    def test_field_equals(self):
        """field_equals checks field value."""
        cond = field_equals("tests", "passed", True)
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True))) is True
        assert cond(SimpleNamespace(tests=CheckOutput(passed=False))) is False
        assert cond(SimpleNamespace(tests=None)) is False

    def test_field_gt(self):
        """field_gt checks field > threshold."""
        cond = field_gt("tests", "coverage", 0.7)
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.8))) is True
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.5))) is False
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.7))) is False  # Not >

    def test_field_gte(self):
        """field_gte checks field >= threshold."""
        cond = field_gte("tests", "coverage", 0.8)
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.8))) is True
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.9))) is True
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.7))) is False

    def test_field_lt(self):
        """field_lt checks field < threshold."""
        cond = field_lt("tests", "coverage", 0.8)
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.5))) is True
        assert cond(SimpleNamespace(tests=CheckOutput(passed=True, coverage=0.8))) is False

    def test_field_in(self):
        """field_in checks field in allowed values."""
        cond = field_in("config", "env", ["staging", "production"])
        assert cond(SimpleNamespace(config=ConfigOutput(env="staging"))) is True
        assert cond(SimpleNamespace(config=ConfigOutput(env="dev"))) is False


# ========================
# Decorator tests
# ========================


class TestWhenDecorator:
    """Tests for @when decorator."""

    def test_when_attaches_policy(self):
        """@when attaches condition policy to function."""

        @when(lambda deps: deps.foo, skip_reason="No foo")
        async def my_func() -> None:
            pass

        policy = get_condition_policy(my_func)
        assert policy is not None
        assert policy.skip_reason == "No foo"

    def test_when_with_condition_object(self):
        """@when accepts Condition objects."""

        @when(Condition(lambda deps: deps.ok, "check ok"), skip_reason="Not OK")
        async def my_func() -> None:
            pass

        policy = get_condition_policy(my_func)
        assert policy is not None
        assert isinstance(policy.condition, Condition)

    def test_skip_if_inverts_condition(self):
        """@skip_if inverts the condition."""

        @skip_if(lambda deps: deps.skip, reason="Should skip")
        async def my_func() -> None:
            pass

        policy = get_condition_policy(my_func)
        assert policy is not None
        # Should run when skip=False (condition inverted)
        assert evaluate_condition(policy, SimpleNamespace(skip=False)) is True
        assert evaluate_condition(policy, SimpleNamespace(skip=True)) is False

    def test_run_if_alias(self):
        """@run_if is an alias for @when."""

        @run_if(lambda deps: deps.run)
        async def my_func() -> None:
            pass

        policy = get_condition_policy(my_func)
        assert policy is not None


class TestHasCondition:
    """Tests for has_condition helper."""

    def test_has_condition_true(self):
        """has_condition returns True for decorated function."""

        @when(lambda deps: True)
        async def decorated() -> None:
            pass

        assert has_condition(decorated) is True

    def test_has_condition_false(self):
        """has_condition returns False for undecorated function."""

        async def undecorated() -> None:
            pass

        assert has_condition(undecorated) is False


# ========================
# Workflow integration tests
# ========================


class TestConditionWorkflowIntegration:
    """Tests for conditions integrated with workflows."""

    @pytest.mark.asyncio
    async def test_workflow_with_condition(self):
        """Workflow picks up condition from decorator."""

        @workflow
        @when(lambda deps: deps.tests.passed, skip_reason="Tests failed")
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        assert deploy.condition_policy is not None
        assert deploy.condition_policy.skip_reason == "Tests failed"

    @pytest.mark.asyncio
    async def test_condition_skips_workflow(self):
        """Workflow is skipped when condition not met."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=False, coverage=0.5)

        @workflow
        @when(lambda deps: deps.tests.passed, skip_reason="Tests failed")
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        result = await run_graph(graph, return_all=True)

        # Deploy should be skipped
        assert result.outputs["deploy"] is None
        deploy_result = next(r for r in result.results if r.name == "deploy")
        assert deploy_result.output is None

    @pytest.mark.asyncio
    async def test_condition_runs_workflow(self):
        """Workflow runs when condition is met."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.9)

        @workflow
        @when(lambda deps: deps.tests.passed, skip_reason="Tests failed")
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        result = await run_graph(graph, return_all=True)

        # Deploy should run
        assert result.outputs["deploy"] is not None
        assert result.outputs["deploy"].deployed is True

    @pytest.mark.asyncio
    async def test_condition_with_multiple_deps(self):
        """Condition can check multiple dependencies."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.9)

        @workflow(register=False)
        async def get_config() -> ConfigOutput:
            return ConfigOutput(env="production")

        @workflow
        @when(
            all_of(
                lambda deps: deps.tests.passed,
                lambda deps: deps.tests.coverage > 0.8,
            ),
            skip_reason="Tests must pass with >80% coverage",
        )
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        result = await run_graph(graph, return_all=True)

        assert result.outputs["deploy"] is not None
        assert result.outputs["deploy"].deployed is True

    @pytest.mark.asyncio
    async def test_condition_fails_workflow(self):
        """Workflow fails when condition not met with on_skip='fail'."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=False, coverage=0.5)

        @workflow
        @when(lambda deps: deps.tests.passed, skip_reason="Tests failed", on_skip="fail")
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)

        with pytest.raises(Exception) as exc_info:
            await run_graph(graph)

        # Should raise ConditionNotMetError (wrapped in WorkflowError)
        assert "Tests failed" in str(exc_info.value) or "condition" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_condition_returns_default(self):
        """Workflow returns default value when condition not met with on_skip='default'."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=False, coverage=0.5)

        default_deploy = DeployOutput(deployed=False)

        @workflow
        @when(
            lambda deps: deps.tests.passed,
            skip_reason="Tests failed",
            on_skip="default",
            default_value=default_deploy,
        )
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        result = await run_graph(graph, return_all=True)

        # Should return default value
        assert result.outputs["deploy"] == default_deploy
        assert result.outputs["deploy"].deployed is False


# ========================
# Complex condition tests
# ========================


class TestComplexConditions:
    """Tests for complex condition scenarios."""

    @pytest.mark.asyncio
    async def test_chained_conditions(self):
        """Multiple workflows with conditions in a chain."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.9)

        @workflow
        @when(field_equals("tests", "passed", True))
        async def build(tests: CheckOutput) -> ConfigOutput:
            return ConfigOutput(env="production")

        @workflow
        @when(
            all_of(
                field_equals("tests", "passed", True),
                field_in("config", "env", ["staging", "production"]),
            )
        )
        async def deploy(tests: CheckOutput, config: ConfigOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        result = await run_graph(graph, return_all=True)

        assert result.outputs["deploy"] is not None
        assert result.outputs["deploy"].deployed is True

    @pytest.mark.asyncio
    async def test_skip_propagation(self):
        """Downstream nodes are skipped when upstream is skipped."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=False, coverage=0.3)

        @workflow
        @when(lambda deps: deps.tests.passed, skip_reason="Tests failed")
        async def build(tests: CheckOutput) -> ConfigOutput:
            return ConfigOutput(env="staging")

        @workflow
        async def deploy(config: ConfigOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        result = await run_graph(graph, return_all=True)

        # build is skipped due to condition
        assert result.outputs["build"] is None

        # deploy is skipped due to dependency failure
        assert result.outputs["deploy"] is None

    @pytest.mark.asyncio
    async def test_combined_conditions(self):
        """Conditions can use all combinators."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.85)

        @workflow
        @when(
            any_of(
                all_of(
                    field_equals("tests", "passed", True),
                    field_gte("tests", "coverage", 0.8),
                ),
                has_attr("tests.force_deploy"),  # Won't exist, but test OR logic
            ),
            skip_reason="Deploy conditions not met",
        )
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        result = await run_graph(graph, return_all=True)

        assert result.outputs["deploy"] is not None


# ========================
# Edge case tests
# ========================


class TestConditionEdgeCases:
    """Tests for edge cases in conditions."""

    def test_condition_with_missing_dep(self):
        """Condition handles missing dependencies gracefully."""
        cond = has_attr("missing.nested.path")
        assert cond(SimpleNamespace()) is False

    def test_field_equals_with_none_dep(self):
        """field_equals handles None dependency."""
        cond = field_equals("dep", "field", True)
        assert cond(SimpleNamespace(dep=None)) is False

    def test_field_gt_with_non_numeric(self):
        """field_gt handles non-numeric fields."""
        cond = field_gt("dep", "field", 5)
        assert cond(SimpleNamespace(dep=SimpleNamespace(field="not a number"))) is False

    def test_condition_description_preserved(self):
        """Condition descriptions are preserved in combinators."""
        cond1 = Condition(lambda deps: True, "first")
        cond2 = Condition(lambda deps: True, "second")
        combined = all_of(cond1, cond2)
        assert "first" in combined.description
        assert "second" in combined.description

    def test_evaluate_condition_with_raw_callable(self):
        """evaluate_condition works with raw callables in policy."""
        policy = ConditionPolicy(
            condition=lambda deps: deps.ok,
            skip_reason="Not OK",
        )
        assert evaluate_condition(policy, SimpleNamespace(ok=True)) is True
        assert evaluate_condition(policy, SimpleNamespace(ok=False)) is False


# ========================
# ConditionNotMetError tests
# ========================


class TestConditionNotMetError:
    """Tests for ConditionNotMetError."""

    def test_error_attributes(self):
        """Error has correct attributes."""
        err = ConditionNotMetError("my_workflow", "Custom reason")
        assert err.workflow_name == "my_workflow"
        assert err.reason == "Custom reason"
        assert "my_workflow" in str(err)
        assert "Custom reason" in str(err)

    def test_inherits_from_smithers_error(self):
        """ConditionNotMetError inherits from SmithersError for consistency."""
        from smithers.errors import SmithersError

        err = ConditionNotMetError("deploy", "Tests failed")
        assert isinstance(err, SmithersError)
        assert isinstance(err, Exception)

    def test_error_serialization(self):
        """ConditionNotMetError can be serialized for logging/storage."""
        from smithers.errors import serialize_error

        err = ConditionNotMetError("deploy_workflow", "Coverage below threshold")
        serialized = serialize_error(err)

        assert serialized["type"] == "ConditionNotMetError"
        assert serialized["workflow_name"] == "deploy_workflow"
        assert serialized["reason"] == "Coverage below threshold"
        assert "Condition not met" in serialized["message"]

    def test_error_can_be_caught_as_smithers_error(self):
        """ConditionNotMetError can be caught as SmithersError."""
        from smithers.errors import SmithersError

        def raise_condition_error():
            raise ConditionNotMetError("test_workflow", "Some reason")

        # Should be catchable as SmithersError
        try:
            raise_condition_error()
        except SmithersError as e:
            assert e.workflow_name == "test_workflow"
            assert e.reason == "Some reason"


# ========================
# Policy tests
# ========================


class TestConditionPolicy:
    """Tests for ConditionPolicy."""

    def test_policy_defaults(self):
        """Policy has sensible defaults."""
        policy = ConditionPolicy(condition=always())
        assert policy.skip_reason == "Condition not met"
        assert policy.on_skip == "skip"
        assert policy.default_value is None

    def test_policy_custom_values(self):
        """Policy accepts custom values."""
        policy = ConditionPolicy(
            condition=never(),
            skip_reason="Custom reason",
            on_skip="default",
            default_value={"foo": "bar"},
        )
        assert policy.skip_reason == "Custom reason"
        assert policy.on_skip == "default"
        assert policy.default_value == {"foo": "bar"}


# ========================
# Decorator order tests
# ========================


class TestDecoratorOrder:
    """Tests for decorator ordering."""

    def test_when_before_workflow(self):
        """@when can be applied before @workflow."""

        @workflow
        @when(lambda deps: True)
        async def my_workflow() -> CheckOutput:
            return CheckOutput(passed=True)

        assert my_workflow.condition_policy is not None

    def test_skip_if_with_workflow(self):
        """@skip_if works with @workflow."""

        @workflow
        @skip_if(lambda deps: deps.skip, reason="Skipping")
        async def maybe_run(skip: bool = False) -> CheckOutput:  # noqa: FBT
            return CheckOutput(passed=True)

        assert maybe_run.condition_policy is not None
        assert maybe_run.condition_policy.skip_reason == "Skipping"


# ========================
# Integration with run_graph_with_store tests
# ========================


class TestConditionWithStore:
    """Tests for conditions with run_graph_with_store."""

    @pytest.mark.asyncio
    async def test_condition_skips_with_store(self):
        """Condition skips workflow when using run_graph_with_store."""
        import tempfile

        from smithers import run_graph_with_store
        from smithers.store.sqlite import SqliteStore

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=False, coverage=0.5)

        @workflow
        @when(lambda deps: deps.tests.passed, skip_reason="Tests failed")
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)

        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            store = SqliteStore(f.name)
            result = await run_graph_with_store(graph, store=store, return_all=True)

            assert result.outputs["deploy"] is None

    @pytest.mark.asyncio
    async def test_condition_emits_event_with_store(self):
        """Condition skip emits proper event when using run_graph_with_store."""
        import tempfile

        from smithers import run_graph_with_store
        from smithers.store.sqlite import SqliteStore

        events: list = []

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=False, coverage=0.5)

        @workflow
        @when(lambda deps: deps.tests.passed, skip_reason="Tests failed")
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)

        async def capture_events(event):
            events.append(event)

        with tempfile.NamedTemporaryFile(suffix=".db") as f:
            store = SqliteStore(f.name)
            await run_graph_with_store(
                graph,
                store=store,
                return_all=True,
                on_progress=capture_events,
            )

            # Should have a skipped event for deploy
            skip_events = [e for e in events if e.type == "skipped" and e.workflow_name == "deploy"]
            assert len(skip_events) == 1
            assert (
                "condition" in skip_events[0].message.lower()
                or "Tests failed" in skip_events[0].message
            )


# ========================
# Bound workflow tests
# ========================


class TestConditionWithBoundWorkflows:
    """Tests for conditions with bound workflows."""

    @pytest.mark.asyncio
    async def test_condition_with_bound_dependency(self):
        """Condition works with workflows that have bound dependencies."""

        @workflow(register=False)
        async def get_tests() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.9)

        @workflow(register=False)
        @when(
            # Bound deps for non-list params are now accessed directly like regular deps
            lambda deps: deps.tests.passed and deps.tests.coverage > 0.8,
            skip_reason="Coverage below threshold",
        )
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        # Bind the dependency
        bound_deploy = deploy.bind(tests=get_tests)
        graph = build_graph(bound_deploy)
        result = await run_graph(graph, return_all=True)

        assert result.outputs[bound_deploy.name] is not None
        assert result.outputs[bound_deploy.name].deployed is True

    @pytest.mark.asyncio
    async def test_condition_skips_bound_workflow(self):
        """Condition can skip a bound workflow."""

        @workflow(register=False)
        async def get_tests() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.6)  # Below threshold

        @workflow(register=False)
        @when(
            # Bound deps for non-list params are now accessed directly like regular deps
            lambda deps: deps.tests.passed and deps.tests.coverage > 0.8,
            skip_reason="Coverage below threshold",
        )
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        # Bind the dependency
        bound_deploy = deploy.bind(tests=get_tests)
        graph = build_graph(bound_deploy)
        result = await run_graph(graph, return_all=True)

        # Should be skipped because coverage (0.6) < threshold (0.8)
        assert result.outputs[bound_deploy.name] is None


# ========================
# Visualization tests
# ========================


class TestConditionVisualization:
    """Tests for condition-related visualization."""

    def test_graph_mermaid_shows_conditional_nodes(self):
        """Graph mermaid diagram includes conditional nodes."""

        @workflow
        async def run_tests() -> CheckOutput:
            return CheckOutput(passed=True)

        @workflow
        @when(lambda deps: deps.tests.passed)
        async def deploy(tests: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        graph = build_graph(deploy)
        mermaid = graph.mermaid()

        assert "run_tests" in mermaid
        assert "deploy" in mermaid
        assert "-->" in mermaid  # Shows dependency relationship


# ========================
# Parallel execution tests
# ========================


class TestConditionParallelExecution:
    """Tests for conditions in parallel execution."""

    @pytest.mark.asyncio
    async def test_parallel_conditions_evaluated_independently(self):
        """Conditions in parallel nodes are evaluated independently."""

        # Test branch_a - condition passes
        @workflow(register=False)
        @when(lambda deps: deps.source.passed)  # Bound deps for non-list params accessed directly
        async def test_branch_a(source: CheckOutput) -> ConfigOutput:
            return ConfigOutput(env="a")

        @workflow(register=False)
        async def test_source_a() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.7)

        bound_a = test_branch_a.bind(source=test_source_a)
        result_a = await run_graph(build_graph(bound_a), return_all=True)
        assert result_a.outputs[bound_a.name] is not None

        # Test branch_b - condition fails
        @workflow(register=False)
        @when(
            lambda deps: deps.source.coverage > 0.8
        )  # Bound deps for non-list params accessed directly
        async def test_branch_b(source: CheckOutput) -> DeployOutput:
            return DeployOutput(deployed=True)

        @workflow(register=False)
        async def test_source_b() -> CheckOutput:
            return CheckOutput(passed=True, coverage=0.7)

        bound_b = test_branch_b.bind(source=test_source_b)
        result_b = await run_graph(build_graph(bound_b), return_all=True)
        assert result_b.outputs[bound_b.name] is None  # Skipped due to condition
