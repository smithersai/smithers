"""Workflow decorator and registry for Smithers.

This module provides the core @workflow decorator that transforms async functions
into Workflow objects with dependency tracking, type validation, and registry support.

Workflows are the fundamental building blocks of Smithers. A workflow is an async
function that:
- Returns a Pydantic model (for type-safe outputs)
- Declares dependencies via type-annotated parameters
- Is automatically registered by output type for dependency resolution

Key components:
- @workflow: Decorator to register an async function as a workflow
- Workflow: Dataclass representing a registered workflow with metadata
- SkipResult: Marker for conditionally skipping workflow execution
- @require_approval: Decorator for human-in-the-loop approval gates
- @retry: Decorator for configuring retry behavior

Example:
    from smithers import workflow, claude
    from pydantic import BaseModel

    class AnalysisOutput(BaseModel):
        summary: str
        files: list[str]

    class ImplementOutput(BaseModel):
        changed_files: list[str]

    @workflow
    async def analyze() -> AnalysisOutput:
        return await claude("Analyze the codebase", output=AnalysisOutput)

    # Dependencies are inferred from type hints
    @workflow
    async def implement(analysis: AnalysisOutput) -> ImplementOutput:
        return await claude(
            f"Implement fixes for: {analysis.files}",
            output=ImplementOutput,
        )

Workflow Registration:
    By default, workflows are registered in a global registry by their output type.
    This allows automatic dependency resolution during graph building. Set
    `register=False` for workflows that share output types (fan-in patterns).

    @workflow(register=False)
    async def producer1() -> SharedOutput:
        ...

    @workflow(register=False)
    async def producer2() -> SharedOutput:
        ...

Retry Configuration:
    Workflows can be configured to retry on failure:

    @workflow(max_retries=3)
    async def flaky_api_call() -> ApiOutput:
        ...

    @workflow(retry=RetryPolicy(max_attempts=5, backoff_seconds=2.0))
    async def custom_retry() -> Output:
        ...

Approval Gates:
    Use @require_approval for human-in-the-loop workflows:

    @workflow
    @require_approval("Deploy to production?")
    async def deploy() -> DeployOutput:
        ...
"""

from __future__ import annotations

import asyncio
import inspect
import types
from collections.abc import Callable, Coroutine, Sequence
from dataclasses import dataclass, field
from datetime import timedelta
from functools import wraps
from typing import Any, ParamSpec, TypeVar, get_args, get_origin, get_type_hints

from pydantic import BaseModel

from smithers.errors import ApprovalRejected, DuplicateProducerError
from smithers.types import NO_RETRY, RetryPolicy

P = ParamSpec("P")
T = TypeVar("T", bound=BaseModel)


@dataclass
class SkipResult:
    """Marker indicating a workflow should be skipped."""

    reason: str


def skip(reason: str) -> SkipResult:
    """Skip a workflow with a reason."""
    return SkipResult(reason=reason)


def _empty_str_bool_dict() -> dict[str, bool]:
    """Factory for empty dict[str, bool]."""
    return {}


def _empty_str_any_dict() -> dict[str, Any]:
    """Factory for empty dict[str, Any]."""
    return {}


def _empty_workflow_deps_dict() -> dict[str, list[Workflow]]:
    """Factory for empty workflow dependencies dict."""
    return {}


@dataclass
class Workflow:
    """A registered workflow."""

    name: str
    fn: Callable[..., Coroutine[Any, Any, BaseModel]]
    output_type: type[BaseModel]
    input_types: dict[str, type[BaseModel]]
    input_is_list: dict[str, bool] = field(default_factory=_empty_str_bool_dict)
    input_optional: dict[str, bool] = field(default_factory=_empty_str_bool_dict)
    requires_approval: bool = False
    approval_message: str | None = None
    approval_context: Callable[[Any], str] | None = None
    approval_timeout: timedelta | None = None
    output_optional: bool = False
    bound_args: dict[str, Any] = field(default_factory=_empty_str_any_dict)
    bound_deps: dict[str, list[Workflow]] = field(default_factory=_empty_workflow_deps_dict)
    retry_policy: RetryPolicy = field(default_factory=lambda: NO_RETRY)
    timeout_policy: Any = None  # TimeoutPolicy or None, avoiding circular import
    condition_policy: Any = None  # ConditionPolicy or None, avoiding circular import

    async def __call__(self, *args: Any, **kwargs: Any) -> BaseModel:
        """Execute the workflow function."""
        call_kwargs = {**self.bound_args, **kwargs}
        return await self.fn(*args, **call_kwargs)

    def bind(self, **kwargs: Any) -> Workflow:
        """Bind concrete arguments or explicit dependencies to this workflow."""
        bound_args: dict[str, Any] = dict(self.bound_args)
        bound_deps: dict[str, list[Workflow]] = {
            key: list(value) for key, value in self.bound_deps.items()
        }

        for key, value in kwargs.items():
            if isinstance(value, Workflow):
                bound_deps[key] = [value]
            elif isinstance(value, Sequence) and value:
                # Check if all items are Workflows
                workflow_items: list[Workflow] = []
                all_workflows = True
                seq_value: Sequence[object] = value  # type: ignore[assignment]
                for item in seq_value:
                    if isinstance(item, Workflow):
                        workflow_items.append(item)
                    else:
                        all_workflows = False
                        break
                if all_workflows:
                    bound_deps[key] = workflow_items
                else:
                    bound_args[key] = value
            else:
                bound_args[key] = value

        bound_name = _make_bound_name(self.name, bound_args, bound_deps)

        return Workflow(
            name=bound_name,
            fn=self.fn,
            output_type=self.output_type,
            input_types=dict(self.input_types),
            input_is_list=dict(self.input_is_list),
            input_optional=dict(self.input_optional),
            requires_approval=self.requires_approval,
            approval_message=self.approval_message,
            approval_context=self.approval_context,
            approval_timeout=self.approval_timeout,
            output_optional=self.output_optional,
            bound_args=bound_args,
            bound_deps=bound_deps,
            retry_policy=self.retry_policy,
            timeout_policy=self.timeout_policy,
            condition_policy=self.condition_policy,
        )


# Global registry of workflows by output type
_registry: dict[type[BaseModel], Workflow] = {}


def get_workflow_by_output(output_type: type[BaseModel]) -> Workflow | None:
    """Get a workflow by its output type."""
    return _registry.get(output_type)


def get_all_workflows() -> dict[type[BaseModel], Workflow]:
    """Get all registered workflows."""
    return _registry.copy()


def clear_registry() -> None:
    """Clear the workflow registry (mainly for testing)."""
    _registry.clear()


def workflow(
    fn: Callable[P, Coroutine[Any, Any, T]] | None = None,
    *,
    register: bool = True,
    retry: RetryPolicy | None = None,
    max_retries: int | None = None,
    retry_on: tuple[type[BaseException], ...] | None = None,
) -> Workflow | Callable[[Callable[P, Coroutine[Any, Any, T]]], Workflow]:
    """
    Decorator to register a function as a workflow.

    Args:
        fn: The async function to wrap
        register: Whether to register in global registry (default: True).
                  Set to False for workflows used only with explicit binding.
        retry: A RetryPolicy for configuring retry behavior.
        max_retries: Shorthand for RetryPolicy(max_attempts=max_retries+1).
                     Cannot be used with `retry` parameter.
        retry_on: Tuple of exception types to retry on. Only used with max_retries.

    Example:
        @workflow
        async def analyze() -> AnalysisOutput:
            return await claude("Analyze", output=AnalysisOutput)

        # With retry policy
        @workflow(retry=RetryPolicy(max_attempts=3, backoff_seconds=1.0))
        async def flaky_workflow() -> Output:
            ...

        # Shorthand for simple retries
        @workflow(max_retries=2)  # 3 total attempts
        async def another_workflow() -> Output:
            ...

        # Only retry on specific exceptions
        @workflow(max_retries=3, retry_on=(RateLimitError, ConnectionError))
        async def api_workflow() -> Output:
            ...

        # For fan-in patterns with duplicate output types:
        @workflow(register=False)
        async def producer1() -> SharedOutput:
            ...

        @workflow(register=False)
        async def producer2() -> SharedOutput:
            ...
    """
    # Determine retry policy
    if retry is not None and max_retries is not None:
        raise ValueError("Cannot specify both 'retry' and 'max_retries'")

    if retry is not None:
        retry_policy = retry
    elif max_retries is not None:
        retry_policy = RetryPolicy(
            max_attempts=max_retries + 1,
            retry_on=retry_on or (),
        )
    else:
        retry_policy = NO_RETRY

    def decorator(func: Callable[P, Coroutine[Any, Any, T]]) -> Workflow:
        if not inspect.iscoroutinefunction(func):
            raise TypeError(f"Workflow {func.__name__} must be async")

        hints = get_type_hints(func, include_extras=True)
        return_annotation = hints.get("return")

        if return_annotation is None:
            raise TypeError(f"Workflow {func.__name__} must have a return type annotation")

        output_type, output_optional = _parse_output_type(return_annotation)

        input_types: dict[str, type[BaseModel]] = {}
        input_is_list: dict[str, bool] = {}
        input_optional: dict[str, bool] = {}

        for param_name, param_type in hints.items():
            if param_name == "return":
                continue
            dep_type, is_list, is_optional = _extract_dependency_type(param_type)
            if dep_type is not None:
                input_types[param_name] = dep_type
                input_is_list[param_name] = is_list
                input_optional[param_name] = is_optional

        # Check if a @retry decorator was applied (stores policy on the function)
        # This allows @workflow @retry(...) pattern to work
        final_retry_policy = getattr(func, "_retry_policy", None) or retry_policy

        # Check if a @timeout decorator was applied
        timeout_policy = getattr(func, "_timeout_policy", None)

        # Check if a @when/@skip_if/@run_if decorator was applied
        condition_policy = getattr(func, "_condition_policy", None)

        wf = Workflow(
            name=func.__name__,
            fn=func,
            output_type=output_type,
            input_types=input_types,
            input_is_list=input_is_list,
            input_optional=input_optional,
            requires_approval=getattr(func, "_requires_approval", False),
            approval_message=getattr(func, "_approval_message", None),
            approval_context=getattr(func, "_approval_context", None),
            approval_timeout=getattr(func, "_approval_timeout", None),
            output_optional=output_optional,
            retry_policy=final_retry_policy,
            timeout_policy=timeout_policy,
            condition_policy=condition_policy,
        )

        if register:
            if output_type in _registry:
                existing = _registry[output_type]
                raise DuplicateProducerError(
                    output_type=output_type,
                    existing_workflow=existing.name,
                    new_workflow=func.__name__,
                )
            _registry[wf.output_type] = wf

        return wf

    if fn is not None:
        # Called as @workflow without parentheses
        return decorator(fn)

    # Called as @workflow() or @workflow(register=False)
    return decorator


def require_approval(
    message: str,
    *,
    context: Callable[[Any], str] | None = None,
    timeout: timedelta | None = None,
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """
    Decorator to require human approval before executing a workflow.

    Example:
        @workflow
        @require_approval("Deploy to production?")
        async def deploy() -> DeployOutput:
            ...
    """

    def decorator(fn: Callable[P, Coroutine[Any, Any, T]]) -> Callable[P, Coroutine[Any, Any, T]]:
        @wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            # Approval logic will be handled by the executor
            return await fn(*args, **kwargs)

        # Mark the function as requiring approval
        wrapper._requires_approval = True  # type: ignore[attr-defined]
        wrapper._approval_message = message  # type: ignore[attr-defined]
        wrapper._approval_context = context  # type: ignore[attr-defined]
        wrapper._approval_timeout = timeout  # type: ignore[attr-defined]
        return wrapper

    return decorator


async def require_approval_async(message: str) -> None:
    """Request approval during workflow execution."""
    prompt = f"{message}\n\nProceed? [y/N]: "
    response = await asyncio.to_thread(input, prompt)
    if response.strip().lower() not in {"y", "yes"}:
        raise ApprovalRejected("manual", "Approval rejected")


def retry(
    policy: RetryPolicy | None = None,
    *,
    max_attempts: int | None = None,
    backoff_seconds: float = 1.0,
    backoff_multiplier: float = 2.0,
    max_backoff_seconds: float = 60.0,
    jitter: bool = True,
    retry_on: tuple[type[BaseException], ...] = (),
) -> Callable[[Callable[P, Coroutine[Any, Any, T]]], Callable[P, Coroutine[Any, Any, T]]]:
    """
    Decorator to configure retry behavior for a workflow.

    This decorator is applied before @workflow to configure retry policies.
    It can be used with a pre-configured RetryPolicy or with individual parameters.

    Args:
        policy: A pre-configured RetryPolicy. If provided, other parameters are ignored.
        max_attempts: Maximum number of attempts (including initial try). Default is 3.
        backoff_seconds: Initial delay between retries in seconds. Default is 1.0.
        backoff_multiplier: Multiplier for exponential backoff. Default is 2.0.
        max_backoff_seconds: Maximum delay between retries. Default is 60.0.
        jitter: Whether to add random jitter to delays. Default is True.
        retry_on: Tuple of exception types to retry on. Empty means all exceptions.

    Example:
        @workflow
        @retry(max_attempts=3)
        async def flaky_workflow() -> Output:
            ...

        @workflow
        @retry(policy=RetryPolicy(max_attempts=5, backoff_seconds=2.0))
        async def api_workflow() -> Output:
            ...

        @workflow
        @retry(max_attempts=4, retry_on=(RateLimitError,))
        async def rate_limited_workflow() -> Output:
            ...
    """
    if policy is not None:
        actual_policy = policy
    else:
        actual_policy = RetryPolicy(
            max_attempts=max_attempts if max_attempts is not None else 3,
            backoff_seconds=backoff_seconds,
            backoff_multiplier=backoff_multiplier,
            max_backoff_seconds=max_backoff_seconds,
            jitter=jitter,
            retry_on=retry_on,
        )

    def decorator(fn: Callable[P, Coroutine[Any, Any, T]]) -> Callable[P, Coroutine[Any, Any, T]]:
        @wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            # The actual retry logic is handled by the executor
            return await fn(*args, **kwargs)

        # Store the retry policy on the function for the @workflow decorator to pick up
        wrapper._retry_policy = actual_policy  # type: ignore[attr-defined]
        return wrapper

    return decorator


def _parse_output_type(
    annotation: Any,
) -> tuple[type[BaseModel], bool]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation, False

    origin = get_origin(annotation)
    if origin is None:
        raise TypeError("Workflow return type must be a Pydantic BaseModel")

    if origin is list or origin is Sequence:
        raise TypeError("Workflow return type cannot be a collection")

    if origin is type(None):
        raise TypeError("Workflow return type cannot be None")

    if origin in (types.UnionType, getattr(__import__("typing"), "Union", None)):
        args = [arg for arg in get_args(annotation) if arg is not type(None)]
        if len(args) == 1 and isinstance(args[0], type) and issubclass(args[0], BaseModel):
            return args[0], True

    raise TypeError("Workflow return type must be a Pydantic BaseModel")


def _extract_dependency_type(
    annotation: Any,
) -> tuple[type[BaseModel] | None, bool, bool]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation, False, False

    origin = get_origin(annotation)
    if origin is None:
        return None, False, False

    if origin in (types.UnionType, getattr(__import__("typing"), "Union", None)):
        args = [arg for arg in get_args(annotation) if arg is not type(None)]
        if len(args) == 1 and isinstance(args[0], type) and issubclass(args[0], BaseModel):
            return args[0], False, True

    if origin in (list, Sequence):
        args = get_args(annotation)
        if not args:
            return None, False, False
        inner = args[0]
        if isinstance(inner, type) and issubclass(inner, BaseModel):
            return inner, True, False
        if get_origin(inner) in (types.UnionType, getattr(__import__("typing"), "Union", None)):
            inner_args = [arg for arg in get_args(inner) if arg is not type(None)]
            if (
                len(inner_args) == 1
                and isinstance(inner_args[0], type)
                and issubclass(inner_args[0], BaseModel)
            ):
                return inner_args[0], True, True

    return None, False, False


def _make_bound_name(
    base_name: str,
    bound_args: dict[str, Any],
    bound_deps: dict[str, list[Workflow]],
) -> str:
    if not bound_args and not bound_deps:
        return base_name

    def normalize(value: object) -> object:
        if isinstance(value, Workflow):
            return {"workflow": value.name}
        if isinstance(value, BaseModel):
            return value.model_dump(mode="json")
        if isinstance(value, dict):
            return {str(k): normalize(v) for k, v in value.items()}  # type: ignore[union-attr]
        if isinstance(value, (list, tuple, set)):
            return [normalize(v) for v in value]  # type: ignore[union-attr]
        return value

    payload = {
        "args": normalize(bound_args),
        "deps": {key: [dep.name for dep in deps] for key, deps in bound_deps.items()},
    }
    import hashlib
    import json

    digest = hashlib.sha1(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:10]
    return f"{base_name}__{digest}"
