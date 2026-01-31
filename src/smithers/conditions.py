"""Conditional workflow execution.

This module provides decorators and utilities for conditional workflow execution,
allowing workflows to be skipped based on runtime conditions evaluated at execution time.

Example:
    from smithers import workflow, when, skip_if, run_if
    from pydantic import BaseModel

    class TestResult(BaseModel):
        passed: bool
        coverage: float

    class DeployOutput(BaseModel):
        deployed: bool

    # Skip deploy if tests failed
    @workflow
    @when(lambda deps: deps.tests.passed, skip_reason="Tests failed")
    async def deploy(tests: TestResult) -> DeployOutput:
        ...

    # Using skip_if (inverse logic)
    @workflow
    @skip_if(lambda deps: not deps.tests.passed, reason="Tests failed")
    async def deploy(tests: TestResult) -> DeployOutput:
        ...

    # Combining conditions
    @workflow
    @when(
        all_of(
            lambda deps: deps.tests.passed,
            lambda deps: deps.tests.coverage > 0.8,
        ),
        skip_reason="Tests must pass with >80% coverage"
    )
    async def deploy(tests: TestResult) -> DeployOutput:
        ...
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from functools import wraps
from types import SimpleNamespace
from typing import Any, ParamSpec, TypeVar

from pydantic import BaseModel

from smithers.errors import SmithersError

P = ParamSpec("P")
T = TypeVar("T", bound=BaseModel)

# Condition type: takes a namespace of dependency outputs and returns bool
ConditionFn = Callable[[SimpleNamespace], bool]


@dataclass(frozen=True)
class Condition:
    """A condition that determines whether a workflow should run.

    Attributes:
        fn: Function that evaluates the condition. Takes a SimpleNamespace
            of dependency outputs and returns True if the workflow should run.
        description: Human-readable description of the condition.
    """

    fn: ConditionFn
    description: str = ""

    def __call__(self, deps: SimpleNamespace) -> bool:
        """Evaluate the condition."""
        return self.fn(deps)

    def __and__(self, other: Condition) -> Condition:
        """Combine conditions with AND."""
        return all_of(self, other)

    def __or__(self, other: Condition) -> Condition:
        """Combine conditions with OR."""
        return any_of(self, other)

    def __invert__(self) -> Condition:
        """Negate the condition."""
        return not_(self)


@dataclass(frozen=True)
class ConditionPolicy:
    """Policy attached to a workflow for conditional execution.

    Attributes:
        condition: The condition to evaluate.
        skip_reason: Reason to log when the workflow is skipped.
        on_skip: What to do when the condition is not met.
                 "skip" - Skip the workflow (return None/SkipResult).
                 "fail" - Raise an error.
                 "default" - Return a default value.
        default_value: Default value to return when on_skip="default".
    """

    condition: Condition | ConditionFn
    skip_reason: str = "Condition not met"
    on_skip: str = "skip"  # "skip", "fail", or "default"
    default_value: Any = None


def when(
    condition: Condition | ConditionFn,
    *,
    skip_reason: str = "Condition not met",
    on_skip: str = "skip",
    default_value: Any = None,
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """
    Decorator to conditionally execute a workflow based on dependency outputs.

    The condition is evaluated before the workflow runs, using the outputs
    from upstream dependencies. If the condition returns False, the workflow
    is skipped.

    Args:
        condition: A Condition object or callable that takes a SimpleNamespace
                   of dependency outputs and returns True if the workflow should run.
        skip_reason: Reason to log when skipping. Default: "Condition not met".
        on_skip: What to do when condition is False:
                 - "skip" (default): Skip the workflow, return SkipResult.
                 - "fail": Raise a ConditionNotMetError.
                 - "default": Return the default_value.
        default_value: Value to return when on_skip="default".

    Example:
        @workflow
        @when(lambda deps: deps.analysis.needs_review)
        async def review(analysis: AnalysisOutput) -> ReviewOutput:
            ...
    """

    def decorator(fn: Callable[P, Coroutine[Any, Any, T]]) -> Callable[P, Coroutine[Any, Any, T]]:
        @wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            # The actual condition check is handled by the executor
            return await fn(*args, **kwargs)

        # Wrap raw callable in Condition if needed
        cond = condition if isinstance(condition, Condition) else Condition(condition)

        # Store the condition policy on the function
        wrapper._condition_policy = ConditionPolicy(  # type: ignore[attr-defined]
            condition=cond,
            skip_reason=skip_reason,
            on_skip=on_skip,
            default_value=default_value,
        )
        return wrapper

    return decorator


def skip_if(
    condition: Condition | ConditionFn,
    *,
    reason: str = "Skip condition met",
    on_match: str = "skip",
    default_value: Any = None,
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """
    Decorator to skip a workflow when a condition is True.

    This is the inverse of @when - the workflow is skipped when the
    condition returns True.

    Args:
        condition: A Condition or callable that returns True when the
                   workflow should be skipped.
        reason: Reason to log when skipping.
        on_match: What to do when condition is True (skip, fail, or default).
        default_value: Value to return when on_match="default".

    Example:
        @workflow
        @skip_if(lambda deps: deps.config.skip_tests)
        async def run_tests(config: ConfigOutput) -> TestOutput:
            ...
    """

    # Invert the condition
    def inverted(deps: SimpleNamespace) -> bool:
        cond = condition if isinstance(condition, Condition) else Condition(condition)
        return not cond(deps)

    return when(
        inverted,
        skip_reason=reason,
        on_skip=on_match,
        default_value=default_value,
    )


def run_if(
    condition: Condition | ConditionFn,
    *,
    skip_reason: str = "Condition not met",
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """
    Decorator to run a workflow only when a condition is True.

    Alias for @when with simpler API.

    Args:
        condition: Condition that must be True for the workflow to run.
        skip_reason: Reason to log when skipping.

    Example:
        @workflow
        @run_if(lambda deps: deps.tests.passed)
        async def deploy(tests: TestOutput) -> DeployOutput:
            ...
    """
    return when(condition, skip_reason=skip_reason)


# Condition combinators


def all_of(*conditions: Condition | ConditionFn) -> Condition:
    """
    Combine multiple conditions with AND logic.

    Returns a Condition that is True only if all sub-conditions are True.

    Example:
        @when(all_of(
            lambda deps: deps.tests.passed,
            lambda deps: deps.review.approved,
        ))
        async def deploy(...):
            ...
    """
    wrapped = [c if isinstance(c, Condition) else Condition(c) for c in conditions]
    descriptions = [c.description for c in wrapped if c.description]
    desc = " AND ".join(descriptions) if descriptions else "all conditions"

    def evaluate(deps: SimpleNamespace) -> bool:
        return all(c(deps) for c in wrapped)

    return Condition(evaluate, desc)


def any_of(*conditions: Condition | ConditionFn) -> Condition:
    """
    Combine multiple conditions with OR logic.

    Returns a Condition that is True if any sub-condition is True.

    Example:
        @when(any_of(
            lambda deps: deps.config.force_deploy,
            lambda deps: deps.tests.passed,
        ))
        async def deploy(...):
            ...
    """
    wrapped = [c if isinstance(c, Condition) else Condition(c) for c in conditions]
    descriptions = [c.description for c in wrapped if c.description]
    desc = " OR ".join(descriptions) if descriptions else "any condition"

    def evaluate(deps: SimpleNamespace) -> bool:
        return any(c(deps) for c in wrapped)

    return Condition(evaluate, desc)


def not_(condition: Condition | ConditionFn) -> Condition:
    """
    Negate a condition.

    Returns a Condition that is True when the original is False.

    Example:
        @when(not_(lambda deps: deps.tests.failed))
        async def deploy(...):
            ...
    """
    wrapped = condition if isinstance(condition, Condition) else Condition(condition)
    desc = f"NOT ({wrapped.description})" if wrapped.description else "negated condition"

    def evaluate(deps: SimpleNamespace) -> bool:
        return not wrapped(deps)

    return Condition(evaluate, desc)


# Pre-built conditions


def has_attr(name: str, value: Any = None) -> Condition:
    """
    Condition that checks if a dependency has a specific attribute.

    If value is provided, also checks that the attribute equals the value.

    Args:
        name: Dot-separated attribute path (e.g., "tests.result.passed").
        value: Optional expected value to compare against.

    Example:
        @when(has_attr("tests.passed", True))
        async def deploy(...):
            ...
    """

    def evaluate(deps: SimpleNamespace) -> bool:
        parts = name.split(".")
        obj: Any = deps
        for part in parts:
            if hasattr(obj, part):
                obj = getattr(obj, part)
            elif isinstance(obj, dict) and part in obj:
                obj = obj[part]
            else:
                return False
        if value is not None:
            return obj == value
        return True

    desc = f"has {name}" + (f" = {value}" if value is not None else "")
    return Condition(evaluate, desc)


def dep_succeeded(dep_name: str) -> Condition:
    """
    Condition that checks if a specific dependency succeeded (is not None/SkipResult).

    Args:
        dep_name: Name of the dependency to check.

    Example:
        @when(dep_succeeded("optional_analysis"))
        async def process(optional_analysis: AnalysisOutput | None) -> ProcessOutput:
            ...
    """

    def evaluate(deps: SimpleNamespace) -> bool:
        if not hasattr(deps, dep_name):
            return False
        val = getattr(deps, dep_name)
        return val is not None

    return Condition(evaluate, f"{dep_name} succeeded")


def field_equals(dep_name: str, field_name: str, expected: Any) -> Condition:
    """
    Condition that checks if a dependency field equals an expected value.

    Args:
        dep_name: Name of the dependency.
        field_name: Name of the field to check.
        expected: Expected value.

    Example:
        @when(field_equals("tests", "passed", True))
        async def deploy(...):
            ...
    """

    def evaluate(deps: SimpleNamespace) -> bool:
        if not hasattr(deps, dep_name):
            return False
        dep = getattr(deps, dep_name)
        if dep is None:
            return False
        if hasattr(dep, field_name):
            return getattr(dep, field_name) == expected
        if isinstance(dep, dict) and field_name in dep:
            return dep[field_name] == expected
        return False

    return Condition(evaluate, f"{dep_name}.{field_name} == {expected}")


def field_gt(dep_name: str, field_name: str, threshold: float) -> Condition:
    """
    Condition that checks if a dependency field is greater than a threshold.

    Args:
        dep_name: Name of the dependency.
        field_name: Name of the field to check.
        threshold: Minimum value (exclusive).

    Example:
        @when(field_gt("tests", "coverage", 0.8))
        async def deploy(...):
            ...
    """

    def evaluate(deps: SimpleNamespace) -> bool:
        if not hasattr(deps, dep_name):
            return False
        dep = getattr(deps, dep_name)
        if dep is None:
            return False
        val = None
        if hasattr(dep, field_name):
            val = getattr(dep, field_name)
        elif isinstance(dep, dict) and field_name in dep:
            val = dep[field_name]
        if val is None:
            return False
        try:
            return float(val) > threshold
        except (TypeError, ValueError):
            return False

    return Condition(evaluate, f"{dep_name}.{field_name} > {threshold}")


def field_gte(dep_name: str, field_name: str, threshold: float) -> Condition:
    """
    Condition that checks if a dependency field is greater than or equal to a threshold.

    Args:
        dep_name: Name of the dependency.
        field_name: Name of the field to check.
        threshold: Minimum value (inclusive).

    Returns:
        A Condition that evaluates to True if the field value >= threshold.

    Example:
        @when(field_gte("tests", "coverage", 0.8))
        async def deploy(...):
            ...
    """

    def evaluate(deps: SimpleNamespace) -> bool:
        if not hasattr(deps, dep_name):
            return False
        dep = getattr(deps, dep_name)
        if dep is None:
            return False
        val = None
        if hasattr(dep, field_name):
            val = getattr(dep, field_name)
        elif isinstance(dep, dict) and field_name in dep:
            val = dep[field_name]
        if val is None:
            return False
        try:
            return float(val) >= threshold
        except (TypeError, ValueError):
            return False

    return Condition(evaluate, f"{dep_name}.{field_name} >= {threshold}")


def field_lt(dep_name: str, field_name: str, threshold: float) -> Condition:
    """
    Condition that checks if a dependency field is less than a threshold.

    Args:
        dep_name: Name of the dependency.
        field_name: Name of the field to check.
        threshold: Maximum value (exclusive).

    Returns:
        A Condition that evaluates to True if the field value < threshold.

    Example:
        @when(field_lt("metrics", "error_rate", 0.01))
        async def deploy(...):
            ...
    """

    def evaluate(deps: SimpleNamespace) -> bool:
        if not hasattr(deps, dep_name):
            return False
        dep = getattr(deps, dep_name)
        if dep is None:
            return False
        val = None
        if hasattr(dep, field_name):
            val = getattr(dep, field_name)
        elif isinstance(dep, dict) and field_name in dep:
            val = dep[field_name]
        if val is None:
            return False
        try:
            return float(val) < threshold
        except (TypeError, ValueError):
            return False

    return Condition(evaluate, f"{dep_name}.{field_name} < {threshold}")


def field_in(dep_name: str, field_name: str, allowed_values: list[Any]) -> Condition:
    """
    Condition that checks if a dependency field is in a list of allowed values.

    Args:
        dep_name: Name of the dependency.
        field_name: Name of the field to check.
        allowed_values: List of allowed values.

    Example:
        @when(field_in("config", "env", ["staging", "production"]))
        async def deploy(...):
            ...
    """

    def evaluate(deps: SimpleNamespace) -> bool:
        if not hasattr(deps, dep_name):
            return False
        dep = getattr(deps, dep_name)
        if dep is None:
            return False
        val = None
        if hasattr(dep, field_name):
            val = getattr(dep, field_name)
        elif isinstance(dep, dict) and field_name in dep:
            val = dep[field_name]
        return val in allowed_values

    return Condition(evaluate, f"{dep_name}.{field_name} in {allowed_values}")


def always() -> Condition:
    """Condition that is always True (workflow always runs)."""
    return Condition(lambda _: True, "always")


def never() -> Condition:
    """Condition that is always False (workflow never runs)."""
    return Condition(lambda _: False, "never")


# Error class for condition failures


class ConditionNotMetError(SmithersError):
    """Raised when a workflow condition is not met and on_skip="fail".

    Attributes:
        workflow_name: Name of the workflow whose condition was not met.
        reason: The skip_reason from the condition policy explaining why
                the condition was not satisfied.

    Example:
        When a workflow has a condition that is not met::

            @workflow
            @when(lambda deps: deps.tests.passed, skip_reason="Tests failed", on_skip="fail")
            async def deploy(tests: TestOutput) -> DeployOutput:
                ...

            # If tests.passed is False, this raises:
            # ConditionNotMetError("deploy", "Tests failed")
    """

    def __init__(self, workflow_name: str, reason: str) -> None:
        self.workflow_name = workflow_name
        self.reason = reason
        super().__init__(f"Condition not met for workflow '{workflow_name}': {reason}")


# Helper to get condition policy from a workflow
def get_condition_policy(fn: Any) -> ConditionPolicy | None:
    """Get the condition policy from a workflow function, if any."""
    if hasattr(fn, "_condition_policy"):
        return fn._condition_policy
    if hasattr(fn, "fn") and hasattr(fn.fn, "_condition_policy"):
        return fn.fn._condition_policy
    return None


def has_condition(fn: Any) -> bool:
    """Check if a workflow function has a condition attached."""
    return get_condition_policy(fn) is not None


def evaluate_condition(
    policy: ConditionPolicy,
    deps: SimpleNamespace,
) -> bool:
    """
    Evaluate a condition policy against dependency outputs.

    Args:
        policy: The ConditionPolicy to evaluate.
        deps: SimpleNamespace containing dependency outputs.

    Returns:
        True if the condition is met, False otherwise.
    """
    condition = policy.condition
    if isinstance(condition, Condition):
        return condition(deps)
    return condition(deps)
