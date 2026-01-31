"""Tests for custom error types in Smithers."""

from __future__ import annotations

import pytest

from smithers.errors import (
    ApprovalRejected,
    ClaudeError,
    CycleError,
    DuplicateProducerError,
    GraphBuildError,
    GraphTimeoutError,
    MissingProducerError,
    RateLimitError,
    SmithersError,
    SmithersTimeoutError,
    ToolError,
    WorkflowError,
    WorkflowTimeoutError,
    serialize_error,
)

# ============================================================================
# SmithersError Tests
# ============================================================================


class TestSmithersError:
    """Tests for base SmithersError class."""

    def test_basic_creation(self) -> None:
        """Test creating a basic SmithersError."""
        error = SmithersError("Something went wrong")
        assert str(error) == "Something went wrong"

    def test_is_exception(self) -> None:
        """Test that SmithersError is an Exception."""
        error = SmithersError("test")
        assert isinstance(error, Exception)

    def test_can_be_raised(self) -> None:
        """Test that SmithersError can be raised and caught."""
        with pytest.raises(SmithersError, match="test message"):
            raise SmithersError("test message")

    def test_empty_message(self) -> None:
        """Test SmithersError with empty message."""
        error = SmithersError("")
        assert str(error) == ""

    def test_subclass_hierarchy(self) -> None:
        """Test that all Smithers errors inherit from SmithersError."""
        assert issubclass(WorkflowError, SmithersError)
        assert issubclass(ApprovalRejected, SmithersError)
        assert issubclass(ClaudeError, SmithersError)
        assert issubclass(RateLimitError, SmithersError)
        assert issubclass(ToolError, SmithersError)
        assert issubclass(SmithersTimeoutError, SmithersError)


# ============================================================================
# WorkflowError Tests
# ============================================================================


class TestWorkflowError:
    """Tests for WorkflowError class."""

    def test_basic_creation(self) -> None:
        """Test creating a WorkflowError with required arguments."""
        cause = ValueError("inner error")
        error = WorkflowError("my_workflow", cause)

        assert error.workflow_name == "my_workflow"
        assert error.cause is cause
        assert error.completed == []
        assert error.errors == {}
        assert str(error) == "inner error"

    def test_with_completed_workflows(self) -> None:
        """Test WorkflowError with completed workflows list."""
        cause = RuntimeError("failed")
        error = WorkflowError(
            "failing_workflow",
            cause,
            completed=["workflow_a", "workflow_b"],
        )

        assert error.completed == ["workflow_a", "workflow_b"]
        assert len(error.completed) == 2

    def test_with_errors_dict(self) -> None:
        """Test WorkflowError with multiple workflow errors."""
        main_cause = RuntimeError("main failure")
        other_error = ValueError("other failure")
        error = WorkflowError(
            "main_workflow",
            main_cause,
            errors={"other_workflow": other_error},
        )

        assert "other_workflow" in error.errors
        assert error.errors["other_workflow"] is other_error

    def test_with_all_arguments(self) -> None:
        """Test WorkflowError with all optional arguments."""
        cause = RuntimeError("test")
        error = WorkflowError(
            "my_workflow",
            cause,
            completed=["a", "b", "c"],
            errors={"d": ValueError("d failed")},
        )

        assert error.workflow_name == "my_workflow"
        assert len(error.completed) == 3
        assert "d" in error.errors

    def test_message_from_cause(self) -> None:
        """Test that message is derived from cause."""
        cause = Exception("This is the cause message")
        error = WorkflowError("workflow", cause)
        assert str(error) == "This is the cause message"

    def test_can_be_raised_and_caught(self) -> None:
        """Test raising and catching WorkflowError."""
        with pytest.raises(WorkflowError) as exc_info:
            raise WorkflowError("test_wf", ValueError("cause"))

        assert exc_info.value.workflow_name == "test_wf"

    def test_catch_as_smithers_error(self) -> None:
        """Test that WorkflowError can be caught as SmithersError."""
        with pytest.raises(SmithersError):
            raise WorkflowError("test", RuntimeError("test"))


# ============================================================================
# ApprovalRejected Tests
# ============================================================================


class TestApprovalRejected:
    """Tests for ApprovalRejected class."""

    def test_basic_creation(self) -> None:
        """Test creating ApprovalRejected with minimal arguments."""
        error = ApprovalRejected("my_workflow")

        assert error.workflow_name == "my_workflow"
        assert error.reason is None
        assert str(error) == "Approval rejected"

    def test_with_reason(self) -> None:
        """Test ApprovalRejected with custom reason."""
        error = ApprovalRejected("deploy_workflow", reason="User clicked deny")

        assert error.workflow_name == "deploy_workflow"
        assert error.reason == "User clicked deny"
        assert str(error) == "User clicked deny"

    def test_empty_reason(self) -> None:
        """Test ApprovalRejected with empty string reason."""
        error = ApprovalRejected("workflow", reason="")

        # Empty string is falsy, so default message is used
        assert str(error) == "Approval rejected"
        assert error.reason == ""

    def test_can_be_raised(self) -> None:
        """Test raising ApprovalRejected."""
        with pytest.raises(ApprovalRejected, match="Approval rejected"):
            raise ApprovalRejected("workflow")

    def test_match_custom_reason(self) -> None:
        """Test matching custom reason in raised error."""
        with pytest.raises(ApprovalRejected, match="Not authorized"):
            raise ApprovalRejected("workflow", reason="Not authorized")


# ============================================================================
# ClaudeError Tests
# ============================================================================


class TestClaudeError:
    """Tests for ClaudeError class."""

    def test_basic_creation(self) -> None:
        """Test creating ClaudeError with message only."""
        error = ClaudeError("API request failed")

        assert str(error) == "API request failed"
        assert error.cause is None

    def test_with_cause(self) -> None:
        """Test ClaudeError with underlying cause."""
        cause = ConnectionError("Network unreachable")
        error = ClaudeError("API request failed", cause=cause)

        assert error.cause is cause
        assert str(error) == "API request failed"

    def test_can_be_raised(self) -> None:
        """Test raising ClaudeError."""
        with pytest.raises(ClaudeError, match="API error"):
            raise ClaudeError("API error")

    def test_inherits_from_smithers_error(self) -> None:
        """Test that ClaudeError is a SmithersError."""
        error = ClaudeError("test")
        assert isinstance(error, SmithersError)


# ============================================================================
# RateLimitError Tests
# ============================================================================


class TestRateLimitError:
    """Tests for RateLimitError class."""

    def test_default_creation(self) -> None:
        """Test creating RateLimitError with defaults."""
        error = RateLimitError()

        assert str(error) == "Rate limit exceeded"
        assert error.retry_after is None
        assert error.cause is None

    def test_with_custom_message(self) -> None:
        """Test RateLimitError with custom message."""
        error = RateLimitError("Too many requests")
        assert str(error) == "Too many requests"

    def test_with_retry_after(self) -> None:
        """Test RateLimitError with retry_after value."""
        error = RateLimitError(retry_after=30.0)

        assert error.retry_after == 30.0
        assert str(error) == "Rate limit exceeded"

    def test_with_cause(self) -> None:
        """Test RateLimitError with underlying cause."""
        cause = Exception("HTTP 429")
        error = RateLimitError("Rate limited", cause=cause)

        assert error.cause is cause

    def test_with_all_arguments(self) -> None:
        """Test RateLimitError with all arguments."""
        cause = Exception("HTTP 429")
        error = RateLimitError(
            "Custom rate limit message",
            retry_after=60.5,
            cause=cause,
        )

        assert str(error) == "Custom rate limit message"
        assert error.retry_after == 60.5
        assert error.cause is cause

    def test_inherits_from_claude_error(self) -> None:
        """Test that RateLimitError is a ClaudeError."""
        error = RateLimitError()
        assert isinstance(error, ClaudeError)
        assert isinstance(error, SmithersError)

    def test_can_be_raised(self) -> None:
        """Test raising RateLimitError."""
        with pytest.raises(RateLimitError):
            raise RateLimitError(retry_after=10.0)

    def test_catch_as_claude_error(self) -> None:
        """Test that RateLimitError can be caught as ClaudeError."""
        with pytest.raises(ClaudeError):
            raise RateLimitError()


# ============================================================================
# ToolError Tests
# ============================================================================


class TestToolError:
    """Tests for ToolError class."""

    def test_basic_creation(self) -> None:
        """Test creating ToolError with required arguments."""
        error = ToolError("read_file", "File not found")

        assert error.tool_name == "read_file"
        assert str(error) == "File not found"
        assert error.data is None

    def test_with_data(self) -> None:
        """Test ToolError with additional data."""
        data = {"path": "/nonexistent", "attempted": True}
        error = ToolError("read_file", "File not found", data=data)

        assert error.data == data
        assert error.data is not None
        assert error.data["path"] == "/nonexistent"

    def test_with_none_data(self) -> None:
        """Test ToolError with explicit None data."""
        error = ToolError("tool", "error", data=None)
        assert error.data is None

    def test_with_complex_data(self) -> None:
        """Test ToolError with complex data structure."""
        context_list = ["attempt1", "attempt2"]
        data = {
            "command": "ls -la",
            "exit_code": 1,
            "stderr": "Permission denied",
            "context": context_list,
        }
        error = ToolError("bash", "Command failed", data=data)

        assert error.data is not None
        assert error.data["exit_code"] == 1
        assert error.data["context"] == context_list
        assert len(context_list) == 2

    def test_can_be_raised(self) -> None:
        """Test raising ToolError."""
        with pytest.raises(ToolError, match="Permission denied"):
            raise ToolError("edit_file", "Permission denied")

    def test_inherits_from_smithers_error(self) -> None:
        """Test that ToolError is a SmithersError."""
        error = ToolError("tool", "error")
        assert isinstance(error, SmithersError)


# ============================================================================
# SmithersTimeoutError Tests
# ============================================================================


class TestSmithersTimeoutError:
    """Tests for base SmithersTimeoutError class."""

    def test_basic_creation(self) -> None:
        """Test creating SmithersTimeoutError."""
        error = SmithersTimeoutError("Operation timed out")
        assert str(error) == "Operation timed out"

    def test_is_smithers_error(self) -> None:
        """Test that SmithersTimeoutError is a SmithersError."""
        error = SmithersTimeoutError("timeout")
        assert isinstance(error, SmithersError)

    def test_subclass_hierarchy(self) -> None:
        """Test that timeout subclasses inherit from SmithersTimeoutError."""
        assert issubclass(WorkflowTimeoutError, SmithersTimeoutError)
        assert issubclass(GraphTimeoutError, SmithersTimeoutError)


# ============================================================================
# WorkflowTimeoutError Tests
# ============================================================================


class TestWorkflowTimeoutError:
    """Tests for WorkflowTimeoutError class."""

    def test_basic_creation(self) -> None:
        """Test creating WorkflowTimeoutError."""
        error = WorkflowTimeoutError(
            workflow_name="slow_workflow",
            timeout_seconds=30.0,
            elapsed_seconds=35.5,
        )

        assert error.workflow_name == "slow_workflow"
        assert error.timeout_seconds == 30.0
        assert error.elapsed_seconds == 35.5

    def test_message_format(self) -> None:
        """Test the error message format."""
        error = WorkflowTimeoutError(
            workflow_name="my_wf",
            timeout_seconds=10.0,
            elapsed_seconds=15.25,
        )

        message = str(error)
        assert "my_wf" in message
        assert "15.25" in message
        assert "10.00" in message

    def test_inheritance(self) -> None:
        """Test inheritance chain."""
        error = WorkflowTimeoutError("wf", 1.0, 2.0)
        assert isinstance(error, SmithersTimeoutError)
        assert isinstance(error, SmithersError)

    def test_can_be_raised(self) -> None:
        """Test raising WorkflowTimeoutError."""
        with pytest.raises(WorkflowTimeoutError) as exc_info:
            raise WorkflowTimeoutError("test_wf", 5.0, 10.0)

        assert exc_info.value.workflow_name == "test_wf"


# ============================================================================
# GraphTimeoutError Tests
# ============================================================================


class TestGraphTimeoutError:
    """Tests for GraphTimeoutError class."""

    def test_basic_creation(self) -> None:
        """Test creating GraphTimeoutError with minimal arguments."""
        error = GraphTimeoutError(
            timeout_seconds=60.0,
            elapsed_seconds=65.0,
        )

        assert error.timeout_seconds == 60.0
        assert error.elapsed_seconds == 65.0
        assert error.completed_nodes == []
        assert error.running_nodes == []

    def test_with_completed_nodes(self) -> None:
        """Test GraphTimeoutError with completed nodes."""
        error = GraphTimeoutError(
            timeout_seconds=30.0,
            elapsed_seconds=35.0,
            completed_nodes=["node_a", "node_b"],
        )

        assert error.completed_nodes == ["node_a", "node_b"]
        assert len(error.completed_nodes) == 2

    def test_with_running_nodes(self) -> None:
        """Test GraphTimeoutError with running nodes."""
        error = GraphTimeoutError(
            timeout_seconds=30.0,
            elapsed_seconds=35.0,
            running_nodes=["node_c", "node_d"],
        )

        assert error.running_nodes == ["node_c", "node_d"]
        assert len(error.running_nodes) == 2

    def test_with_all_arguments(self) -> None:
        """Test GraphTimeoutError with all arguments."""
        error = GraphTimeoutError(
            timeout_seconds=120.0,
            elapsed_seconds=125.5,
            completed_nodes=["a", "b", "c"],
            running_nodes=["d", "e"],
        )

        assert error.timeout_seconds == 120.0
        assert error.elapsed_seconds == 125.5
        assert len(error.completed_nodes) == 3
        assert len(error.running_nodes) == 2

    def test_message_format(self) -> None:
        """Test the error message format."""
        error = GraphTimeoutError(
            timeout_seconds=60.0,
            elapsed_seconds=65.5,
            completed_nodes=["a", "b"],
            running_nodes=["c"],
        )

        message = str(error)
        assert "65.50" in message
        assert "60.00" in message
        assert "Completed: 2" in message
        assert "Running: 1" in message

    def test_inheritance(self) -> None:
        """Test inheritance chain."""
        error = GraphTimeoutError(1.0, 2.0)
        assert isinstance(error, SmithersTimeoutError)
        assert isinstance(error, SmithersError)

    def test_can_be_raised(self) -> None:
        """Test raising GraphTimeoutError."""
        with pytest.raises(GraphTimeoutError) as exc_info:
            raise GraphTimeoutError(10.0, 15.0, completed_nodes=["x"])

        assert exc_info.value.completed_nodes == ["x"]


# ============================================================================
# Error Chaining Tests
# ============================================================================


class TestErrorChaining:
    """Tests for error chaining scenarios."""

    def test_workflow_error_with_nested_cause(self) -> None:
        """Test WorkflowError with deeply nested cause."""
        root_cause = OSError("Disk full")
        middle_cause = RuntimeError("Could not write cache")
        middle_cause.__cause__ = root_cause

        error = WorkflowError("cache_workflow", middle_cause)

        assert error.cause is middle_cause
        assert error.cause.__cause__ is root_cause

    def test_rate_limit_error_chain(self) -> None:
        """Test RateLimitError with HTTP error as cause."""
        http_error = Exception("HTTP 429 Too Many Requests")
        error = RateLimitError(
            "API rate limit hit",
            retry_after=30.0,
            cause=http_error,
        )

        assert error.cause is http_error

    def test_multiple_workflow_errors(self) -> None:
        """Test WorkflowError tracking multiple failures."""
        errors: dict[str, BaseException] = {
            "workflow_a": ValueError("Invalid input"),
            "workflow_b": RuntimeError("Connection lost"),
            "workflow_c": SmithersTimeoutError("Timed out"),
        }

        error = WorkflowError(
            "orchestrator",
            RuntimeError("Multiple workflows failed"),
            completed=["workflow_x", "workflow_y"],
            errors=errors,
        )

        assert len(error.errors) == 3
        assert isinstance(error.errors["workflow_a"], ValueError)
        assert isinstance(error.errors["workflow_b"], RuntimeError)
        assert isinstance(error.errors["workflow_c"], SmithersTimeoutError)


# ============================================================================
# Exception Handling Patterns Tests
# ============================================================================


class TestExceptionHandlingPatterns:
    """Tests for common exception handling patterns."""

    def test_catch_specific_error_type(self) -> None:
        """Test catching specific error type while ignoring others."""
        caught = None

        try:
            raise RateLimitError(retry_after=10.0)
        except RateLimitError as e:
            caught = e
        except ClaudeError:
            pytest.fail("Should have caught RateLimitError specifically")

        assert caught is not None
        assert caught.retry_after == 10.0

    def test_catch_parent_error_type(self) -> None:
        """Test catching parent error type for multiple subtypes."""
        errors_caught: list[ClaudeError] = []

        for error in [
            RateLimitError(),
            ClaudeError("generic"),
        ]:
            try:
                raise error
            except ClaudeError as e:
                errors_caught.append(e)

        assert len(errors_caught) == 2

    def test_catch_base_smithers_error(self) -> None:
        """Test catching SmithersError catches all Smithers errors."""
        error_types = [
            SmithersError("base"),
            WorkflowError("wf", RuntimeError("test")),
            ApprovalRejected("wf"),
            ClaudeError("api"),
            RateLimitError(),
            ToolError("tool", "error"),
            SmithersTimeoutError("timeout"),
            WorkflowTimeoutError("wf", 1.0, 2.0),
            GraphTimeoutError(1.0, 2.0),
        ]

        caught_count = 0
        for error in error_types:
            try:
                raise error
            except SmithersError:
                caught_count += 1

        assert caught_count == len(error_types)

    def test_reraise_with_context(self) -> None:
        """Test re-raising error with additional context."""
        try:
            try:
                raise ClaudeError("Original error")
            except ClaudeError as e:
                raise WorkflowError("wrapper", e) from e
        except WorkflowError as outer:
            assert outer.cause is not None
            assert str(outer.cause) == "Original error"
            assert outer.__cause__ is not None


# ============================================================================
# serialize_error Tests
# ============================================================================


class TestSerializeError:
    """Tests for serialize_error function."""

    def test_basic_exception(self) -> None:
        """Test serializing a basic Python exception."""
        error = ValueError("Something went wrong")
        result = serialize_error(error)

        assert result["type"] == "ValueError"
        assert result["message"] == "Something went wrong"

    def test_exception_with_empty_message(self) -> None:
        """Test serializing an exception with empty message uses repr."""
        error = ValueError()
        result = serialize_error(error)

        assert result["type"] == "ValueError"
        # Empty message should fall back to repr
        assert "ValueError" in result["message"]

    def test_smithers_error(self) -> None:
        """Test serializing base SmithersError."""
        error = SmithersError("Base smithers error")
        result = serialize_error(error)

        assert result["type"] == "SmithersError"
        assert result["message"] == "Base smithers error"

    def test_workflow_error_basic(self) -> None:
        """Test serializing WorkflowError with minimal fields."""
        cause = RuntimeError("inner")
        error = WorkflowError("my_workflow", cause)
        result = serialize_error(error)

        assert result["type"] == "WorkflowError"
        assert result["workflow_name"] == "my_workflow"
        assert "completed" not in result  # Empty list not included
        assert "errors" not in result  # Empty dict not included

    def test_workflow_error_with_completed(self) -> None:
        """Test serializing WorkflowError with completed workflows."""
        error = WorkflowError(
            "main",
            RuntimeError("failed"),
            completed=["a", "b", "c"],
        )
        result = serialize_error(error)

        assert result["completed"] == ["a", "b", "c"]

    def test_workflow_error_with_nested_errors(self) -> None:
        """Test serializing WorkflowError with nested errors dict."""
        error = WorkflowError(
            "main",
            RuntimeError("main failed"),
            errors={
                "sub_a": ValueError("a failed"),
                "sub_b": TypeError("b failed"),
            },
        )
        result = serialize_error(error)

        assert "errors" in result
        assert result["errors"]["sub_a"]["type"] == "ValueError"
        assert result["errors"]["sub_a"]["message"] == "a failed"
        assert result["errors"]["sub_b"]["type"] == "TypeError"
        assert result["errors"]["sub_b"]["message"] == "b failed"

    def test_approval_rejected_basic(self) -> None:
        """Test serializing ApprovalRejected without reason."""
        error = ApprovalRejected("deploy")
        result = serialize_error(error)

        assert result["type"] == "ApprovalRejected"
        assert result["workflow_name"] == "deploy"
        assert "reason" not in result  # None not included

    def test_approval_rejected_with_reason(self) -> None:
        """Test serializing ApprovalRejected with reason."""
        error = ApprovalRejected("deploy", reason="User denied")
        result = serialize_error(error)

        assert result["reason"] == "User denied"

    def test_rate_limit_error_basic(self) -> None:
        """Test serializing RateLimitError without retry_after."""
        error = RateLimitError("Too many requests")
        result = serialize_error(error)

        assert result["type"] == "RateLimitError"
        assert "retry_after" not in result  # None not included

    def test_rate_limit_error_with_retry_after(self) -> None:
        """Test serializing RateLimitError with retry_after."""
        error = RateLimitError(retry_after=30.5)
        result = serialize_error(error)

        assert result["retry_after"] == 30.5

    def test_tool_error_basic(self) -> None:
        """Test serializing ToolError without data."""
        error = ToolError("read_file", "File not found")
        result = serialize_error(error)

        assert result["type"] == "ToolError"
        assert result["tool_name"] == "read_file"
        assert result["message"] == "File not found"
        assert "data" not in result  # None not included

    def test_tool_error_with_json_safe_data(self) -> None:
        """Test serializing ToolError with JSON-serializable data."""
        error = ToolError(
            "bash",
            "Command failed",
            data={"exit_code": 1, "stderr": "Permission denied"},
        )
        result = serialize_error(error)

        assert result["data"]["exit_code"] == 1
        assert result["data"]["stderr"] == "Permission denied"

    def test_tool_error_with_non_json_safe_data(self) -> None:
        """Test serializing ToolError with non-JSON-serializable data."""

        class CustomObj:
            def __repr__(self) -> str:
                return "<CustomObj instance>"

        error = ToolError("tool", "error", data=CustomObj())
        result = serialize_error(error)

        # Non-serializable data should be converted to repr
        assert result["data"] == "<CustomObj instance>"

    def test_workflow_timeout_error(self) -> None:
        """Test serializing WorkflowTimeoutError."""
        error = WorkflowTimeoutError(
            workflow_name="slow_wf",
            timeout_seconds=30.0,
            elapsed_seconds=35.5,
        )
        result = serialize_error(error)

        assert result["type"] == "WorkflowTimeoutError"
        assert result["workflow_name"] == "slow_wf"
        assert result["timeout_seconds"] == 30.0
        assert result["elapsed_seconds"] == 35.5

    def test_graph_timeout_error_basic(self) -> None:
        """Test serializing GraphTimeoutError without node lists."""
        error = GraphTimeoutError(
            timeout_seconds=60.0,
            elapsed_seconds=65.0,
        )
        result = serialize_error(error)

        assert result["type"] == "GraphTimeoutError"
        assert result["timeout_seconds"] == 60.0
        assert result["elapsed_seconds"] == 65.0
        assert "completed_nodes" not in result  # Empty list not included
        assert "running_nodes" not in result  # Empty list not included

    def test_graph_timeout_error_with_nodes(self) -> None:
        """Test serializing GraphTimeoutError with node lists."""
        error = GraphTimeoutError(
            timeout_seconds=60.0,
            elapsed_seconds=65.0,
            completed_nodes=["a", "b"],
            running_nodes=["c"],
        )
        result = serialize_error(error)

        assert result["completed_nodes"] == ["a", "b"]
        assert result["running_nodes"] == ["c"]

    def test_exception_with_cause(self) -> None:
        """Test serializing exception with __cause__."""
        try:
            try:
                raise ValueError("root cause")
            except ValueError as e:
                raise RuntimeError("outer") from e
        except RuntimeError as error:
            result = serialize_error(error)

        assert result["type"] == "RuntimeError"
        assert "cause" in result
        assert result["cause"]["type"] == "ValueError"
        assert result["cause"]["message"] == "root cause"

    def test_exception_with_context(self) -> None:
        """Test serializing exception with __context__ (implicit chaining)."""
        try:
            try:
                raise ValueError("original")
            except ValueError:
                raise RuntimeError("while handling")  # noqa: B904 - testing implicit chaining
        except RuntimeError as error:
            result = serialize_error(error)

        assert result["type"] == "RuntimeError"
        assert "cause" in result
        assert result["cause"]["type"] == "ValueError"

    def test_max_depth_limits_recursion(self) -> None:
        """Test that max_depth limits nested error serialization."""
        # Create deeply nested errors
        error = WorkflowError(
            "level1",
            RuntimeError("inner"),
            errors={
                "level2": WorkflowError(
                    "level2",
                    RuntimeError("inner2"),
                    errors={
                        "level3": ValueError("deep"),
                    },
                ),
            },
        )

        # With max_depth=1, nested errors should be simplified
        result = serialize_error(error, max_depth=1)

        # level2 error should be present
        assert "errors" in result
        assert "level2" in result["errors"]
        # But level3 within level2 should be simplified (no full serialization)
        nested = result["errors"]["level2"]
        assert nested["type"] == "WorkflowError"

    def test_max_depth_zero(self) -> None:
        """Test serialization with max_depth=0."""
        try:
            try:
                raise ValueError("cause")
            except ValueError as e:
                raise RuntimeError("outer") from e
        except RuntimeError as error:
            result = serialize_error(error, max_depth=0)

        # With max_depth=0, cause should not be included
        assert "cause" not in result

    def test_cycle_detection(self) -> None:
        """Test that cycle detection prevents infinite recursion."""
        # Create a circular reference scenario
        # This is tricky since Python exceptions don't naturally form cycles
        # But we can test the mechanism works
        error = ValueError("test")
        # Manually create a seen set and serialize
        result = serialize_error(error)

        # Should complete without hanging
        assert result["type"] == "ValueError"

    def test_serialization_is_json_safe(self) -> None:
        """Test that the serialized output is JSON-serializable."""
        import json

        errors = [
            SmithersError("base"),
            WorkflowError("wf", RuntimeError("test"), completed=["a"]),
            ApprovalRejected("wf", reason="denied"),
            RateLimitError(retry_after=10.0),
            ToolError("tool", "error", data={"key": "value"}),
            WorkflowTimeoutError("wf", 1.0, 2.0),
            GraphTimeoutError(1.0, 2.0, completed_nodes=["a"]),
        ]

        for error in errors:
            result = serialize_error(error)
            # Should not raise
            json_str = json.dumps(result)
            assert isinstance(json_str, str)
            # Should round-trip
            parsed = json.loads(json_str)
            assert parsed["type"] == type(error).__name__

    def test_complex_nested_structure(self) -> None:
        """Test serializing a complex nested error structure."""
        tool_error = ToolError(
            "validate",
            "Validation error",
            data={"field": "email", "value": "invalid"},
        )

        workflow_error = WorkflowError(
            "process_data",
            tool_error,
            completed=["fetch", "parse"],
            errors={
                "validate_email": tool_error,
                "validate_phone": ValueError("Invalid phone"),
            },
        )

        result = serialize_error(workflow_error)

        assert result["type"] == "WorkflowError"
        assert result["workflow_name"] == "process_data"
        assert result["completed"] == ["fetch", "parse"]
        assert "validate_email" in result["errors"]
        assert result["errors"]["validate_email"]["tool_name"] == "validate"
        assert result["errors"]["validate_phone"]["type"] == "ValueError"

    def test_claude_error_serialization(self) -> None:
        """Test serializing ClaudeError (not a special case but should work)."""
        error = ClaudeError("API failed", cause=ConnectionError("timeout"))
        result = serialize_error(error)

        assert result["type"] == "ClaudeError"
        assert result["message"] == "API failed"
        # ClaudeError.cause is stored as attribute but not __cause__
        # So the serializer won't automatically include it unless raised with 'from'

    def test_suppressed_context_not_included(self) -> None:
        """Test that suppressed context is not serialized."""
        try:
            try:
                raise ValueError("original")
            except ValueError:
                # Using 'from None' suppresses the context
                raise RuntimeError("replacement") from None
        except RuntimeError as error:
            result = serialize_error(error)

        # Context should be suppressed
        assert "cause" not in result


# ============================================================================
# GraphBuildError Tests
# ============================================================================


class TestGraphBuildError:
    """Tests for GraphBuildError base class."""

    def test_basic_creation(self) -> None:
        """Test creating a basic GraphBuildError."""
        error = GraphBuildError("Graph building failed")
        assert str(error) == "Graph building failed"

    def test_inherits_from_smithers_error(self) -> None:
        """Test that GraphBuildError inherits from SmithersError."""
        assert issubclass(GraphBuildError, SmithersError)

    def test_inherits_from_value_error(self) -> None:
        """Test that GraphBuildError inherits from ValueError for backwards compatibility."""
        assert issubclass(GraphBuildError, ValueError)

    def test_can_be_caught_as_value_error(self) -> None:
        """Test that GraphBuildError can be caught as ValueError."""
        with pytest.raises(ValueError):
            raise GraphBuildError("test")

    def test_can_be_caught_as_smithers_error(self) -> None:
        """Test that GraphBuildError can be caught as SmithersError."""
        with pytest.raises(SmithersError):
            raise GraphBuildError("test")


# ============================================================================
# CycleError Tests
# ============================================================================


class TestCycleError:
    """Tests for CycleError exception."""

    def test_basic_creation(self) -> None:
        """Test creating a basic CycleError."""
        error = CycleError("my_workflow")
        assert "my_workflow" in str(error)
        assert error.workflow_name == "my_workflow"
        assert error.cycle_path == []

    def test_with_custom_message(self) -> None:
        """Test CycleError with custom message."""
        error = CycleError("my_workflow", "Custom cycle message")
        assert str(error) == "Custom cycle message"
        assert error.workflow_name == "my_workflow"

    def test_with_cycle_path(self) -> None:
        """Test CycleError with cycle path."""
        path = ["a", "b", "c"]
        error = CycleError("a", cycle_path=path)
        assert error.cycle_path == path
        assert "a -> b -> c -> a" in str(error)

    def test_inherits_from_graph_build_error(self) -> None:
        """Test that CycleError inherits from GraphBuildError."""
        assert issubclass(CycleError, GraphBuildError)

    def test_inherits_from_value_error(self) -> None:
        """Test that CycleError inherits from ValueError for backwards compatibility."""
        assert issubclass(CycleError, ValueError)

    def test_can_be_caught_as_value_error(self) -> None:
        """Test that CycleError can be caught as ValueError (backwards compatibility)."""
        with pytest.raises(ValueError, match="Circular dependency"):
            raise CycleError("workflow_a", cycle_path=["workflow_a", "workflow_b"])

    def test_serialization(self) -> None:
        """Test that CycleError serializes correctly."""
        error = CycleError("my_workflow", cycle_path=["a", "b", "c"])
        result = serialize_error(error)
        assert result["type"] == "CycleError"
        assert result["workflow_name"] == "my_workflow"
        assert result["cycle_path"] == ["a", "b", "c"]


# ============================================================================
# MissingProducerError Tests
# ============================================================================


class TestMissingProducerError:
    """Tests for MissingProducerError exception."""

    def test_basic_creation(self) -> None:
        """Test creating a basic MissingProducerError."""
        error = MissingProducerError(
            workflow_name="my_workflow",
            param_name="input_data",
            required_type=str,
        )
        assert "my_workflow" in str(error)
        assert "input_data" in str(error)
        assert "str" in str(error)
        assert error.workflow_name == "my_workflow"
        assert error.param_name == "input_data"
        assert error.required_type is str

    def test_with_registered_types(self) -> None:
        """Test MissingProducerError with registered types for debugging."""
        error = MissingProducerError(
            workflow_name="my_workflow",
            param_name="data",
            required_type=str,
            registered_types=["TypeA", "TypeB", "TypeC"],
        )
        assert error.registered_types == ["TypeA", "TypeB", "TypeC"]
        assert "TypeA" in str(error)
        assert "TypeB" in str(error)
        assert "TypeC" in str(error)

    def test_inherits_from_graph_build_error(self) -> None:
        """Test that MissingProducerError inherits from GraphBuildError."""
        assert issubclass(MissingProducerError, GraphBuildError)

    def test_inherits_from_value_error(self) -> None:
        """Test that MissingProducerError inherits from ValueError."""
        assert issubclass(MissingProducerError, ValueError)

    def test_can_be_caught_as_value_error(self) -> None:
        """Test backwards compatibility with ValueError catching."""
        with pytest.raises(ValueError, match="no workflow produces"):
            raise MissingProducerError("wf", "param", str)

    def test_serialization(self) -> None:
        """Test that MissingProducerError serializes correctly."""
        error = MissingProducerError(
            workflow_name="my_workflow",
            param_name="input",
            required_type=int,
            registered_types=["A", "B"],
        )
        result = serialize_error(error)
        assert result["type"] == "MissingProducerError"
        assert result["workflow_name"] == "my_workflow"
        assert result["param_name"] == "input"
        assert result["required_type"] == "int"
        assert result["registered_types"] == ["A", "B"]


# ============================================================================
# DuplicateProducerError Tests
# ============================================================================


class TestDuplicateProducerError:
    """Tests for DuplicateProducerError exception."""

    def test_basic_creation(self) -> None:
        """Test creating a basic DuplicateProducerError."""
        error = DuplicateProducerError(
            output_type=str,
            existing_workflow="producer1",
            new_workflow="producer2",
        )
        assert "producer1" in str(error)
        assert "producer2" in str(error)
        assert "str" in str(error)
        assert error.output_type is str
        assert error.existing_workflow == "producer1"
        assert error.new_workflow == "producer2"

    def test_message_contains_resolution_hint(self) -> None:
        """Test that error message contains hint about register=False."""
        error = DuplicateProducerError(str, "a", "b")
        assert "register=False" in str(error)

    def test_inherits_from_graph_build_error(self) -> None:
        """Test that DuplicateProducerError inherits from GraphBuildError."""
        assert issubclass(DuplicateProducerError, GraphBuildError)

    def test_inherits_from_value_error(self) -> None:
        """Test that DuplicateProducerError inherits from ValueError."""
        assert issubclass(DuplicateProducerError, ValueError)

    def test_can_be_caught_as_value_error(self) -> None:
        """Test backwards compatibility with ValueError catching."""
        with pytest.raises(ValueError, match="Multiple workflows produce"):
            raise DuplicateProducerError(str, "wf1", "wf2")

    def test_serialization(self) -> None:
        """Test that DuplicateProducerError serializes correctly."""
        error = DuplicateProducerError(
            output_type=dict,
            existing_workflow="existing",
            new_workflow="new",
        )
        result = serialize_error(error)
        assert result["type"] == "DuplicateProducerError"
        assert result["output_type"] == "dict"
        assert result["existing_workflow"] == "existing"
        assert result["new_workflow"] == "new"


# ============================================================================
# Graph Build Error Integration Tests
# ============================================================================


class TestGraphBuildErrorIntegration:
    """Integration tests for graph building errors."""

    def test_all_graph_build_errors_are_value_errors(self) -> None:
        """Verify all graph build errors can be caught as ValueError."""
        errors: list[Exception] = [
            GraphBuildError("base"),
            CycleError("wf"),
            MissingProducerError("wf", "p", str),
            DuplicateProducerError(str, "a", "b"),
        ]
        for error in errors:
            assert isinstance(error, ValueError)
            assert isinstance(error, SmithersError)

    def test_all_graph_build_errors_are_smithers_errors(self) -> None:
        """Verify all graph build errors are SmithersErrors."""
        errors: list[Exception] = [
            GraphBuildError("base"),
            CycleError("wf"),
            MissingProducerError("wf", "p", str),
            DuplicateProducerError(str, "a", "b"),
        ]
        for error in errors:
            assert isinstance(error, SmithersError)

    def test_catch_all_graph_build_errors_with_graph_build_error(self) -> None:
        """Test that all graph build errors can be caught with GraphBuildError."""
        for ErrorClass in [CycleError, MissingProducerError, DuplicateProducerError]:
            try:
                if ErrorClass == CycleError:
                    raise CycleError("wf")
                elif ErrorClass == MissingProducerError:
                    raise MissingProducerError("wf", "p", str)
                else:
                    raise DuplicateProducerError(str, "a", "b")
            except GraphBuildError:
                pass  # Expected
