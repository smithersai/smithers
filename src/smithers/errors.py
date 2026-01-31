"""Custom error types for Smithers."""

from __future__ import annotations

import json
from typing import Any


class SmithersError(Exception):
    """Base exception for Smithers errors."""


class WorkflowError(SmithersError):
    """Raised when one or more workflows fail during execution."""

    def __init__(
        self,
        workflow_name: str,
        cause: BaseException,
        *,
        completed: list[str] | None = None,
        errors: dict[str, BaseException] | None = None,
    ) -> None:
        super().__init__(str(cause))
        self.workflow_name = workflow_name
        self.cause = cause
        self.completed = completed or []
        self.errors = errors or {}


class ApprovalRejected(SmithersError):
    """Raised when a required approval is rejected."""

    def __init__(self, workflow_name: str, reason: str | None = None) -> None:
        message = reason or "Approval rejected"
        super().__init__(message)
        self.workflow_name = workflow_name
        self.reason = reason


class ClaudeError(SmithersError):
    """Raised when the Claude API returns an error."""

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class RateLimitError(ClaudeError):
    """Raised when the Claude API rate limits the request."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        *,
        retry_after: float | None = None,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message, cause=cause)
        self.retry_after = retry_after


class ToolError(SmithersError):
    """Raised when tool execution fails."""

    def __init__(self, tool_name: str, message: str, *, data: Any | None = None) -> None:
        super().__init__(message)
        self.tool_name = tool_name
        self.data = data


class GraphBuildError(SmithersError, ValueError):
    """Base class for errors during graph building.

    Inherits from ValueError for backwards compatibility with code that
    catches ValueError for graph building failures.
    """


class CycleError(GraphBuildError):
    """Raised when a circular dependency is detected during graph building.

    Attributes:
        workflow_name: Name of the workflow where the cycle was detected
        cycle_path: List of workflow names forming the cycle (if available)
        message: Descriptive error message

    Example:
        A workflow that depends on its own output creates a cycle::

            @workflow
            async def refine(data: RefineOutput) -> RefineOutput:
                ...  # This creates a self-referential cycle

        Two workflows that depend on each other::

            @workflow
            async def a(b_out: BOutput) -> AOutput: ...

            @workflow
            async def b(a_out: AOutput) -> BOutput: ...
    """

    def __init__(
        self,
        workflow_name: str,
        message: str | None = None,
        *,
        cycle_path: list[str] | None = None,
    ) -> None:
        self.workflow_name = workflow_name
        self.cycle_path = cycle_path or []
        if message is None:
            if cycle_path:
                message = (
                    f"Circular dependency detected in workflow '{workflow_name}': "
                    f"{' -> '.join(cycle_path)} -> {workflow_name}"
                )
            else:
                message = f"Circular dependency detected involving workflow '{workflow_name}'"
        super().__init__(message)


class MissingProducerError(GraphBuildError):
    """Raised when no workflow produces a required dependency type.

    Attributes:
        workflow_name: Name of the workflow with the missing dependency
        param_name: Name of the parameter requiring the dependency
        required_type: The type that no workflow produces
        registered_types: List of currently registered output types (for debugging)

    Example:
        When a workflow depends on a type that no other workflow produces::

            class OrphanType(BaseModel):
                value: str

            @workflow
            async def needs_orphan(o: OrphanType) -> OutputType:
                ...  # Raises MissingProducerError
    """

    def __init__(
        self,
        workflow_name: str,
        param_name: str,
        required_type: type,
        *,
        registered_types: list[str] | None = None,
    ) -> None:
        self.workflow_name = workflow_name
        self.param_name = param_name
        self.required_type = required_type
        self.registered_types = registered_types or []
        type_name = getattr(required_type, "__name__", str(required_type))
        message = (
            f"Workflow '{workflow_name}' depends on '{param_name}: {type_name}', "
            f"but no workflow produces that type"
        )
        if registered_types:
            message += f". Registered types: {', '.join(registered_types)}"
        super().__init__(message)


class DuplicateProducerError(GraphBuildError):
    """Raised when multiple workflows produce the same output type.

    Attributes:
        output_type: The output type that has multiple producers
        existing_workflow: Name of the already-registered workflow
        new_workflow: Name of the workflow attempting to register

    Example:
        When two workflows are registered with the same output type::

            @workflow
            async def producer1() -> SharedOutput:
                ...

            @workflow  # Raises DuplicateProducerError
            async def producer2() -> SharedOutput:
                ...

        To avoid this error, use `register=False` for one of the workflows.
    """

    def __init__(
        self,
        output_type: type,
        existing_workflow: str,
        new_workflow: str,
    ) -> None:
        self.output_type = output_type
        self.existing_workflow = existing_workflow
        self.new_workflow = new_workflow
        type_name = getattr(output_type, "__name__", str(output_type))
        super().__init__(
            f"Multiple workflows produce {type_name}: "
            f"'{existing_workflow}' and '{new_workflow}'. "
            f"Use @workflow(register=False) for one of them, or use explicit binding."
        )


class RalphLoopError(SmithersError):
    """Base class for errors related to Ralph loops.

    Ralph loops are declarative iteration constructs that run a workflow
    repeatedly until a condition is met.
    """


class RalphLoopConfigError(RalphLoopError, ValueError):
    """Raised when a Ralph loop is misconfigured.

    This error indicates a problem with how the Ralph loop was set up,
    such as missing required configuration or invalid parameters.

    Inherits from ValueError for backwards compatibility.

    Attributes:
        loop_name: Name of the Ralph loop workflow
        config_issue: Description of the configuration problem

    Example:
        When a Ralph loop is created without an inner workflow::

            # This would raise RalphLoopConfigError
            loop = RalphLoopWorkflow(name="my_loop", ...)
            await execute_ralph_loop(loop, input)  # No inner_workflow set
    """

    def __init__(
        self,
        loop_name: str,
        config_issue: str,
    ) -> None:
        self.loop_name = loop_name
        self.config_issue = config_issue
        super().__init__(f"Ralph loop '{loop_name}' configuration error: {config_issue}")


class RalphLoopInputError(RalphLoopError, ValueError):
    """Raised when a Ralph loop receives invalid input.

    This error indicates a problem with the input provided to the Ralph loop
    at execution time, such as missing required parameters.

    Inherits from ValueError for backwards compatibility.

    Attributes:
        loop_name: Name of the Ralph loop workflow
        param_name: Name of the missing or invalid parameter
        message: Description of the input problem

    Example:
        When a Ralph loop is called without required input::

            review_loop = ralph_loop(review_workflow, until=lambda x: x.approved)
            # This would raise RalphLoopInputError
            await execute_ralph_loop(review_loop, initial_input=None)
    """

    def __init__(
        self,
        loop_name: str,
        param_name: str,
        message: str | None = None,
    ) -> None:
        self.loop_name = loop_name
        self.param_name = param_name
        if message is None:
            message = f"Missing required input for parameter '{param_name}'"
        self.message = message
        super().__init__(f"Ralph loop '{loop_name}' input error: {message}")


class SmithersTimeoutError(SmithersError):
    """Base class for timeout-related errors.

    This is named SmithersTimeoutError to avoid shadowing the built-in
    Python TimeoutError exception.
    """


class WorkflowTimeoutError(SmithersTimeoutError):
    """
    Raised when a workflow exceeds its timeout limit.

    Attributes:
        workflow_name: Name of the workflow that timed out
        timeout_seconds: The configured timeout in seconds
        elapsed_seconds: Actual time elapsed before timeout
    """

    def __init__(
        self,
        workflow_name: str,
        timeout_seconds: float,
        elapsed_seconds: float,
    ) -> None:
        self.workflow_name = workflow_name
        self.timeout_seconds = timeout_seconds
        self.elapsed_seconds = elapsed_seconds
        super().__init__(
            f"Workflow '{workflow_name}' timed out after {elapsed_seconds:.2f}s "
            f"(limit: {timeout_seconds:.2f}s)"
        )


class GraphTimeoutError(SmithersTimeoutError):
    """
    Raised when graph execution exceeds its global timeout.

    Attributes:
        timeout_seconds: The configured global timeout in seconds
        elapsed_seconds: Actual time elapsed
        completed_nodes: List of nodes that completed before timeout
        running_nodes: List of nodes that were running when timeout occurred
    """

    def __init__(
        self,
        timeout_seconds: float,
        elapsed_seconds: float,
        completed_nodes: list[str] | None = None,
        running_nodes: list[str] | None = None,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.elapsed_seconds = elapsed_seconds
        self.completed_nodes = completed_nodes or []
        self.running_nodes = running_nodes or []
        super().__init__(
            f"Graph execution timed out after {elapsed_seconds:.2f}s "
            f"(limit: {timeout_seconds:.2f}s). "
            f"Completed: {len(self.completed_nodes)}, Running: {len(self.running_nodes)}"
        )


def serialize_error(error: BaseException, *, max_depth: int = 3) -> dict[str, Any]:
    """Serialize an exception to a JSON-safe dict."""
    return _serialize_error(error, max_depth=max_depth, seen=set())


def _serialize_error(
    error: BaseException,
    *,
    max_depth: int,
    seen: set[int],
) -> dict[str, Any]:
    message = str(error)
    if not message:
        message = repr(error)

    payload: dict[str, Any] = {"type": type(error).__name__, "message": message}

    if id(error) in seen:
        payload["note"] = "cycle"
        return payload

    seen.add(id(error))

    if isinstance(error, WorkflowError):
        payload["workflow_name"] = error.workflow_name
        if error.completed:
            payload["completed"] = list(error.completed)
        if error.errors:
            payload["errors"] = {
                name: _serialize_error(err, max_depth=max_depth - 1, seen=seen)
                if max_depth > 0
                else {"type": type(err).__name__, "message": str(err) or repr(err)}
                for name, err in error.errors.items()
            }
    elif isinstance(error, ApprovalRejected):
        payload["workflow_name"] = error.workflow_name
        if error.reason is not None:
            payload["reason"] = error.reason
    elif isinstance(error, RateLimitError):
        if error.retry_after is not None:
            payload["retry_after"] = error.retry_after
    elif isinstance(error, ToolError):
        payload["tool_name"] = error.tool_name
        if error.data is not None:
            payload["data"] = _safe_value(error.data)
    elif isinstance(error, WorkflowTimeoutError):
        payload["workflow_name"] = error.workflow_name
        payload["timeout_seconds"] = error.timeout_seconds
        payload["elapsed_seconds"] = error.elapsed_seconds
    elif isinstance(error, GraphTimeoutError):
        payload["timeout_seconds"] = error.timeout_seconds
        payload["elapsed_seconds"] = error.elapsed_seconds
        if error.completed_nodes:
            payload["completed_nodes"] = list(error.completed_nodes)
        if error.running_nodes:
            payload["running_nodes"] = list(error.running_nodes)
    elif isinstance(error, CycleError):
        payload["workflow_name"] = error.workflow_name
        if error.cycle_path:
            payload["cycle_path"] = list(error.cycle_path)
    elif isinstance(error, MissingProducerError):
        payload["workflow_name"] = error.workflow_name
        payload["param_name"] = error.param_name
        payload["required_type"] = getattr(
            error.required_type, "__name__", str(error.required_type)
        )
        if error.registered_types:
            payload["registered_types"] = list(error.registered_types)
    elif isinstance(error, DuplicateProducerError):
        payload["output_type"] = getattr(error.output_type, "__name__", str(error.output_type))
        payload["existing_workflow"] = error.existing_workflow
        payload["new_workflow"] = error.new_workflow
    elif isinstance(error, RalphLoopConfigError):
        payload["loop_name"] = error.loop_name
        payload["config_issue"] = error.config_issue
    elif isinstance(error, RalphLoopInputError):
        payload["loop_name"] = error.loop_name
        payload["param_name"] = error.param_name
    # Handle ConditionNotMetError without direct import to avoid circular dependency
    # We use getattr to access attributes dynamically to avoid circular import with conditions.py
    elif type(error).__name__ == "ConditionNotMetError":
        workflow_name = getattr(error, "workflow_name", None)
        if workflow_name is not None:
            payload["workflow_name"] = workflow_name
        reason = getattr(error, "reason", None)
        if reason is not None:
            payload["reason"] = reason

    if max_depth > 0:
        cause = error.__cause__ or (
            error.__context__ if not getattr(error, "__suppress_context__", False) else None
        )
        if cause is not None:
            payload["cause"] = _serialize_error(
                cause,
                max_depth=max_depth - 1,
                seen=seen,
            )

    return payload


def _safe_value(value: Any) -> Any:
    try:
        json.dumps(value)
    except TypeError:
        return repr(value)
    return value
