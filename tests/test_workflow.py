"""Tests for workflow decorator and registry."""

import pytest
from pydantic import BaseModel

from smithers.workflow import (
    Workflow,
    clear_registry,
    get_all_workflows,
    get_workflow_by_output,
    skip,
    workflow,
)


class TestPublicApiExports:
    """Tests verifying public API exports from smithers module."""

    def test_workflow_class_exported(self):
        """Verify Workflow class is exported from smithers."""
        from smithers import Workflow as PublicWorkflow

        assert PublicWorkflow is Workflow

    def test_clear_registry_exported(self):
        """Verify clear_registry is exported from smithers."""
        from smithers import clear_registry as public_clear_registry

        assert public_clear_registry is clear_registry

    def test_get_all_workflows_exported(self):
        """Verify get_all_workflows is exported from smithers."""
        from smithers import get_all_workflows as public_get_all_workflows

        assert public_get_all_workflows is get_all_workflows

    def test_get_workflow_by_output_exported(self):
        """Verify get_workflow_by_output is exported from smithers."""
        from smithers import get_workflow_by_output as public_get_workflow_by_output

        assert public_get_workflow_by_output is get_workflow_by_output

    def test_skip_result_exported(self):
        """Verify SkipResult is exported from smithers."""
        from smithers import SkipResult as PublicSkipResult
        from smithers.workflow import SkipResult

        assert PublicSkipResult is SkipResult

    def test_workflow_node_exported(self):
        """Verify WorkflowNode is exported from smithers."""
        from smithers import WorkflowNode
        from smithers.types import WorkflowNode as TypesWorkflowNode

        assert WorkflowNode is TypesWorkflowNode

    def test_workflow_result_exported(self):
        """Verify WorkflowResult is exported from smithers."""
        from smithers import WorkflowResult
        from smithers.types import WorkflowResult as TypesWorkflowResult

        assert WorkflowResult is TypesWorkflowResult


class OutputA(BaseModel):
    value: str


class OutputB(BaseModel):
    count: int


class TestWorkflowDecorator:
    """Tests for the @workflow decorator."""

    def test_creates_workflow_object(self):
        @workflow
        async def my_workflow() -> OutputA:
            return OutputA(value="test")

        assert isinstance(my_workflow, Workflow)
        assert my_workflow.name == "my_workflow"
        assert my_workflow.output_type == OutputA

    def test_registers_in_global_registry(self):
        @workflow
        async def my_workflow() -> OutputA:
            return OutputA(value="test")

        found = get_workflow_by_output(OutputA)
        assert found is not None
        assert found.name == "my_workflow"

    def test_extracts_input_types(self):
        @workflow
        async def step1() -> OutputA:
            return OutputA(value="test")

        @workflow
        async def step2(a: OutputA) -> OutputB:
            return OutputB(count=len(a.value))

        assert step2.input_types == {"a": OutputA}

    def test_requires_return_type(self):
        with pytest.raises(TypeError, match="must have a return type"):

            @workflow
            async def no_return():
                pass

    def test_duplicate_output_type_raises(self):
        @workflow
        async def first() -> OutputA:
            return OutputA(value="first")

        with pytest.raises(ValueError, match="Multiple workflows produce"):

            @workflow
            async def second() -> OutputA:
                return OutputA(value="second")

    async def test_workflow_is_callable(self):
        @workflow
        async def my_workflow() -> OutputA:
            return OutputA(value="called")

        result = await my_workflow()
        assert result.value == "called"


class TestRegistry:
    """Tests for the workflow registry."""

    def test_get_all_workflows(self):
        @workflow
        async def wf1() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def wf2() -> OutputB:
            return OutputB(count=1)

        all_wfs = get_all_workflows()
        assert len(all_wfs) == 2
        assert OutputA in all_wfs
        assert OutputB in all_wfs

    def test_clear_registry(self):
        @workflow
        async def my_workflow() -> OutputA:
            return OutputA(value="test")

        assert get_workflow_by_output(OutputA) is not None

        clear_registry()

        assert get_workflow_by_output(OutputA) is None


class TestSkip:
    """Tests for the skip function."""

    def test_skip_creates_skip_result(self):
        result = skip("Tests failed")
        assert result.reason == "Tests failed"
