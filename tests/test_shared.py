"""Tests for shared helper functions in _shared.py.

These functions are used by both graph.py and executor.py for common operations
like normalizing inputs, building kwargs, validating outputs, and computing hashes.
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel, ValidationError

from smithers._shared import (
    build_kwargs,
    compute_cache_key,
    dependency_namespace,
    hash_inputs,
    normalize_invalidate,
    resolve_workflow,
    validate_output,
)
from smithers.types import WorkflowGraph, WorkflowNode
from smithers.workflow import clear_registry, workflow


# Test output types
class OutputA(BaseModel):
    value: str


class OutputB(BaseModel):
    count: int


class OutputC(BaseModel):
    data: list[str]


class OutputD(BaseModel):
    combined: str


class OutputOptional(BaseModel):
    value: str | None = None


class MissingDep(BaseModel):
    """A type that no workflow produces - used for testing missing dependency errors."""

    z: str


@pytest.fixture(autouse=True)
def clear_workflows() -> None:
    """Clear workflow registry before each test."""
    clear_registry()
    yield
    clear_registry()


# =============================================================================
# normalize_invalidate tests
# =============================================================================


class TestNormalizeInvalidate:
    """Tests for normalize_invalidate function."""

    def test_none_returns_empty_set(self) -> None:
        """None input returns empty set."""
        result = normalize_invalidate(None)
        assert result == set()

    def test_single_string_returns_set_with_string(self) -> None:
        """A single string returns a set containing that string."""
        result = normalize_invalidate("my_workflow")
        assert result == {"my_workflow"}

    def test_workflow_object_returns_name(self) -> None:
        """A Workflow object returns a set with its name."""

        @workflow
        async def my_test_workflow() -> OutputA:
            return OutputA(value="test")

        result = normalize_invalidate(my_test_workflow)
        assert result == {"my_test_workflow"}

    def test_list_of_strings(self) -> None:
        """A list of strings returns a set of those strings."""
        result = normalize_invalidate(["workflow_a", "workflow_b", "workflow_c"])
        assert result == {"workflow_a", "workflow_b", "workflow_c"}

    def test_list_of_workflow_objects(self) -> None:
        """A list of Workflow objects returns set of their names."""

        @workflow
        async def wf_one() -> OutputA:
            return OutputA(value="one")

        @workflow
        async def wf_two() -> OutputB:
            return OutputB(count=2)

        result = normalize_invalidate([wf_one, wf_two])
        assert result == {"wf_one", "wf_two"}

    def test_mixed_list_of_strings_and_workflows(self) -> None:
        """A mixed list of strings and Workflow objects works correctly."""

        @workflow
        async def wf_mixed() -> OutputA:
            return OutputA(value="mixed")

        result = normalize_invalidate(["string_workflow", wf_mixed])
        assert result == {"string_workflow", "wf_mixed"}

    def test_set_input_works(self) -> None:
        """A set of strings works as input."""
        result = normalize_invalidate({"a", "b", "c"})
        assert result == {"a", "b", "c"}

    def test_tuple_input_works(self) -> None:
        """A tuple of strings works as input."""
        result = normalize_invalidate(("x", "y"))
        assert result == {"x", "y"}

    def test_generator_input_works(self) -> None:
        """A generator expression works as input."""

        def gen():
            yield "gen1"
            yield "gen2"

        result = normalize_invalidate(gen())
        assert result == {"gen1", "gen2"}

    def test_duplicate_strings_deduplicated(self) -> None:
        """Duplicate strings are deduplicated."""
        result = normalize_invalidate(["dup", "dup", "unique"])
        assert result == {"dup", "unique"}

    def test_invalid_item_type_raises_error(self) -> None:
        """Non-string, non-Workflow items raise TypeError."""
        with pytest.raises(TypeError, match="workflow names"):
            normalize_invalidate([123])  # type: ignore

    def test_invalid_item_type_in_mixed_list(self) -> None:
        """Invalid type in mixed list raises TypeError."""
        with pytest.raises(TypeError, match="workflow names"):
            normalize_invalidate(["valid", 3.14])  # type: ignore

    def test_empty_list_returns_empty_set(self) -> None:
        """Empty list returns empty set."""
        result = normalize_invalidate([])
        assert result == set()

    def test_wildcard_string(self) -> None:
        """Wildcard '*' is treated as a regular string."""
        result = normalize_invalidate("*")
        assert result == {"*"}

    def test_wildcard_in_list(self) -> None:
        """Wildcard '*' in a list is preserved."""
        result = normalize_invalidate(["workflow_a", "*"])
        assert result == {"workflow_a", "*"}


# =============================================================================
# validate_output tests
# =============================================================================


class TestValidateOutput:
    """Tests for validate_output function."""

    def test_valid_pydantic_model(self) -> None:
        """Valid Pydantic model passes validation."""

        @workflow
        async def valid_wf() -> OutputA:
            return OutputA(value="test")

        output = OutputA(value="test")
        result = validate_output(valid_wf, output)
        assert result == output

    def test_dict_coerced_to_model(self) -> None:
        """Dictionary is coerced to Pydantic model."""

        @workflow
        async def dict_wf() -> OutputA:
            return OutputA(value="dict")

        result = validate_output(dict_wf, {"value": "from_dict"})
        assert isinstance(result, OutputA)
        assert result.value == "from_dict"

    def test_none_allowed_when_optional(self) -> None:
        """None is allowed when output is optional."""

        @workflow(register=False)
        async def optional_wf() -> OutputOptional | None:
            return None

        # Need to mark output_optional on the workflow
        optional_wf.output_optional = True

        result = validate_output(optional_wf, None)
        assert result is None

    def test_none_rejected_when_not_optional(self) -> None:
        """None raises error when output is not optional."""

        @workflow
        async def required_wf() -> OutputA:
            return OutputA(value="required")

        with pytest.raises(ValidationError):
            validate_output(required_wf, None)

    def test_invalid_structure_raises_error(self) -> None:
        """Invalid structure raises validation error."""

        @workflow
        async def struct_wf() -> OutputA:
            return OutputA(value="struct")

        with pytest.raises(ValidationError):
            validate_output(struct_wf, {"wrong_field": "value"})

    def test_wrong_type_raises_error(self) -> None:
        """Wrong type raises validation error."""

        @workflow
        async def type_wf() -> OutputB:
            return OutputB(count=42)

        with pytest.raises(ValidationError):
            validate_output(type_wf, {"count": "not_an_int"})


# =============================================================================
# hash_inputs tests
# =============================================================================


class TestHashInputs:
    """Tests for hash_inputs function."""

    def test_empty_inputs_produces_hash(self) -> None:
        """Workflow with no inputs produces a consistent hash."""

        @workflow
        async def no_inputs() -> OutputA:
            return OutputA(value="no_inputs")

        hash1 = hash_inputs(no_inputs, {})
        hash2 = hash_inputs(no_inputs, {})
        assert hash1 == hash2
        assert len(hash1) == 64  # SHA-256 hex

    def test_same_inputs_same_hash(self) -> None:
        """Same inputs produce the same hash."""

        @workflow
        async def with_input(a: OutputA) -> OutputB:
            return OutputB(count=len(a.value))

        outputs = {"producer": OutputA(value="test")}
        hash1 = hash_inputs(with_input, outputs)
        hash2 = hash_inputs(with_input, outputs)
        assert hash1 == hash2

    def test_different_inputs_different_hash(self) -> None:
        """Different inputs produce different hashes."""

        # Create a producer workflow to register
        @workflow
        async def producer() -> OutputA:
            return OutputA(value="x")

        @workflow
        async def diff_input(a: OutputA) -> OutputB:
            return OutputB(count=1)

        hash1 = hash_inputs(diff_input, {"producer": OutputA(value="value1")})
        hash2 = hash_inputs(diff_input, {"producer": OutputA(value="value2")})
        assert hash1 != hash2

    def test_bound_args_included_in_hash(self) -> None:
        """Bound arguments are included in the hash."""

        @workflow(register=False)
        async def bound_wf(config: str) -> OutputA:
            return OutputA(value=config)

        # Simulate different bound args
        bound1 = bound_wf.bind(config="config1")
        bound2 = bound_wf.bind(config="config2")

        hash1 = hash_inputs(bound1, {})
        hash2 = hash_inputs(bound2, {})
        assert hash1 != hash2


# =============================================================================
# compute_cache_key tests
# =============================================================================


class TestComputeCacheKey:
    """Tests for compute_cache_key function."""

    def test_cache_key_is_deterministic(self) -> None:
        """Cache key is deterministic for same workflow and inputs."""

        @workflow
        async def cache_wf() -> OutputA:
            return OutputA(value="cache")

        input_hash = "abc123"
        key1 = compute_cache_key(cache_wf, input_hash)
        key2 = compute_cache_key(cache_wf, input_hash)
        assert key1 == key2

    def test_different_input_hash_different_key(self) -> None:
        """Different input hash produces different cache key."""

        @workflow
        async def key_wf() -> OutputA:
            return OutputA(value="key")

        key1 = compute_cache_key(key_wf, "hash1")
        key2 = compute_cache_key(key_wf, "hash2")
        assert key1 != key2

    def test_different_workflow_different_key(self) -> None:
        """Different workflows produce different cache keys."""

        @workflow
        async def wf_a() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def wf_b() -> OutputB:
            return OutputB(count=1)

        input_hash = "same_hash"
        key_a = compute_cache_key(wf_a, input_hash)
        key_b = compute_cache_key(wf_b, input_hash)
        assert key_a != key_b

    def test_cache_key_is_valid_hex(self) -> None:
        """Cache key is valid hex string."""

        @workflow
        async def hex_wf() -> OutputA:
            return OutputA(value="hex")

        key = compute_cache_key(hex_wf, "input")
        assert len(key) == 64
        assert all(c in "0123456789abcdef" for c in key)


# =============================================================================
# dependency_namespace tests
# =============================================================================


class TestDependencyNamespace:
    """Tests for dependency_namespace function."""

    def test_creates_namespace_with_dependencies(self) -> None:
        """Creates SimpleNamespace with dependency outputs."""

        @workflow
        async def producer() -> OutputA:
            return OutputA(value="produced")

        @workflow
        async def consumer(a: OutputA) -> OutputB:
            return OutputB(count=len(a.value))

        outputs = {"producer": OutputA(value="test_value")}
        ns = dependency_namespace(consumer, outputs)

        assert hasattr(ns, "a")
        assert ns.a.value == "test_value"

    def test_bound_args_included_in_namespace(self) -> None:
        """Bound arguments are included in the namespace.

        Note: Only bound args that are in input_types (Pydantic model types)
        are included in the namespace. The dependency_namespace function
        iterates over input_types which only contains Pydantic model params.
        """

        @workflow
        async def a_producer() -> OutputA:
            return OutputA(value="produced")

        @workflow(register=False)
        async def bound_consumer(a: OutputA) -> OutputB:
            return OutputB(count=1)

        # Bind the dependency directly
        bound = bound_consumer.bind(a=OutputA(value="bound_value"))
        ns = dependency_namespace(bound, {})

        # The bound arg should be in the namespace
        assert hasattr(ns, "a")
        assert ns.a.value == "bound_value"

    def test_missing_dependency_returns_none(self) -> None:
        """Missing dependency returns None in namespace."""

        @workflow
        async def producer() -> OutputA:
            return OutputA(value="x")

        @workflow
        async def consumer(a: OutputA) -> OutputB:
            return OutputB(count=1)

        # Empty outputs - dependency not yet computed
        ns = dependency_namespace(consumer, {})

        # The dependency should be None since it's not in outputs
        assert ns.a is None

    def test_namespace_with_multiple_deps(self) -> None:
        """Namespace contains all dependencies."""

        @workflow
        async def prod_a() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def prod_b() -> OutputB:
            return OutputB(count=1)

        @workflow
        async def multi_consumer(a: OutputA, b: OutputB) -> OutputD:
            return OutputD(combined=f"{a.value}:{b.count}")

        outputs = {
            "prod_a": OutputA(value="val_a"),
            "prod_b": OutputB(count=42),
        }
        ns = dependency_namespace(multi_consumer, outputs)

        assert hasattr(ns, "a")
        assert hasattr(ns, "b")
        assert ns.a.value == "val_a"
        assert ns.b.count == 42


# =============================================================================
# resolve_workflow tests
# =============================================================================


class TestResolveWorkflow:
    """Tests for resolve_workflow function."""

    def test_resolves_from_graph_workflows(self) -> None:
        """Resolves workflow from graph.workflows first."""

        @workflow
        async def in_graph() -> OutputA:
            return OutputA(value="in_graph")

        node = WorkflowNode(
            name="in_graph",
            output_type=OutputA,
            dependencies=[],
        )
        graph = WorkflowGraph(
            root="in_graph",
            nodes={"in_graph": node},
            edges=[],
            levels=[["in_graph"]],
            workflows={"in_graph": in_graph},
        )

        resolved = resolve_workflow(graph, node)
        assert resolved is in_graph

    def test_resolves_from_registry_if_not_in_graph(self) -> None:
        """Falls back to registry if not in graph.workflows."""

        @workflow
        async def in_registry() -> OutputA:
            return OutputA(value="registry")

        node = WorkflowNode(
            name="in_registry",
            output_type=OutputA,
            dependencies=[],
        )
        graph = WorkflowGraph(
            root="in_registry",
            nodes={"in_registry": node},
            edges=[],
            levels=[["in_registry"]],
            workflows={},  # Empty - not in graph
        )

        resolved = resolve_workflow(graph, node)
        assert resolved.name == "in_registry"

    def test_raises_if_workflow_not_found(self) -> None:
        """Raises ValueError if workflow not found."""

        class UnregisteredOutput(BaseModel):
            x: int

        node = WorkflowNode(
            name="missing",
            output_type=UnregisteredOutput,
            dependencies=[],
        )
        graph = WorkflowGraph(
            root="missing",
            nodes={"missing": node},
            edges=[],
            levels=[["missing"]],
            workflows={},
        )

        with pytest.raises(ValueError, match="No workflow registered"):
            resolve_workflow(graph, node)


# =============================================================================
# build_kwargs tests
# =============================================================================


class TestBuildKwargs:
    """Tests for build_kwargs function."""

    def test_builds_kwargs_from_outputs(self) -> None:
        """Builds kwargs from dependency outputs."""

        @workflow
        async def producer() -> OutputA:
            return OutputA(value="produced")

        @workflow
        async def consumer(a: OutputA) -> OutputB:
            return OutputB(count=len(a.value))

        outputs = {"producer": OutputA(value="hello")}
        kwargs = build_kwargs(consumer, outputs)

        assert "a" in kwargs
        assert kwargs["a"].value == "hello"

    def test_includes_bound_args(self) -> None:
        """Includes bound arguments in kwargs."""

        @workflow(register=False)
        async def with_bound(config: str, a: OutputA) -> OutputB:
            return OutputB(count=len(config))

        @workflow
        async def producer() -> OutputA:
            return OutputA(value="x")

        bound = with_bound.bind(config="my_config")
        outputs = {"producer": OutputA(value="y")}

        kwargs = build_kwargs(bound, outputs)

        assert kwargs["config"] == "my_config"
        assert kwargs["a"].value == "y"

    def test_raises_if_dependency_not_found(self) -> None:
        """Raises ValueError if dependency workflow not found."""

        @workflow
        async def needs_missing(m: MissingDep) -> OutputA:
            return OutputA(value=m.z)

        with pytest.raises(ValueError, match="no workflow produces"):
            build_kwargs(needs_missing, {})

    def test_handles_list_dependencies(self) -> None:
        """Handles list dependencies correctly."""

        @workflow
        async def single_producer() -> OutputA:
            return OutputA(value="single")

        @workflow
        async def list_consumer(items: list[OutputA]) -> OutputB:
            return OutputB(count=len(items))

        outputs = {"single_producer": OutputA(value="item")}
        kwargs = build_kwargs(list_consumer, outputs)

        assert "items" in kwargs
        assert isinstance(kwargs["items"], list)
        assert kwargs["items"][0].value == "item"

    def test_handles_bound_deps(self) -> None:
        """Handles bound dependencies correctly."""

        @workflow(register=False)
        async def dep_producer() -> OutputA:
            return OutputA(value="dep")

        @workflow(register=False)
        async def bound_consumer(deps: OutputA) -> OutputB:
            return OutputB(count=1)

        bound = bound_consumer.bind(deps=dep_producer)
        outputs = {"dep_producer": OutputA(value="bound_value")}

        kwargs = build_kwargs(bound, outputs)

        # Bound deps should be resolved
        assert "deps" in kwargs


# =============================================================================
# TypeAdapter caching tests
# =============================================================================


class TestTypeAdapterCaching:
    """Tests for TypeAdapter caching in _get_type_adapter."""

    def test_type_adapter_is_cached(self) -> None:
        """TypeAdapter is cached and reused for the same type."""
        from smithers._shared import _TYPE_ADAPTER_CACHE, _get_type_adapter

        # Clear cache to ensure a clean test
        _TYPE_ADAPTER_CACHE.clear()

        # First call should create and cache the adapter
        adapter1 = _get_type_adapter(OutputA)
        # Second call should return the same cached adapter
        adapter2 = _get_type_adapter(OutputA)

        # Should be the same object (cached)
        assert adapter1 is adapter2

    def test_different_types_get_different_adapters(self) -> None:
        """Different types get different cached adapters."""
        from smithers._shared import _TYPE_ADAPTER_CACHE, _get_type_adapter

        _TYPE_ADAPTER_CACHE.clear()

        adapter_a = _get_type_adapter(OutputA)
        adapter_b = _get_type_adapter(OutputB)

        # Different types should have different adapters
        assert adapter_a is not adapter_b

    def test_cached_adapter_validates_correctly(self) -> None:
        """Cached TypeAdapter still validates correctly."""
        from smithers._shared import _TYPE_ADAPTER_CACHE, _get_type_adapter

        _TYPE_ADAPTER_CACHE.clear()

        adapter = _get_type_adapter(OutputA)

        # Should validate correctly
        result = adapter.validate_python({"value": "test"})
        assert isinstance(result, OutputA)
        assert result.value == "test"

        # Validation should still work on second use
        adapter2 = _get_type_adapter(OutputA)
        result2 = adapter2.validate_python({"value": "test2"})
        assert result2.value == "test2"

    def test_validate_output_uses_cached_adapter(self) -> None:
        """validate_output function uses the cached TypeAdapter."""
        from smithers._shared import _TYPE_ADAPTER_CACHE

        @workflow
        async def cached_wf() -> OutputA:
            return OutputA(value="cached")

        _TYPE_ADAPTER_CACHE.clear()

        # First validation should cache the adapter
        validate_output(cached_wf, {"value": "first"})

        # Adapter should now be in the cache
        assert OutputA in _TYPE_ADAPTER_CACHE

        # Second validation should reuse the cached adapter
        result = validate_output(cached_wf, {"value": "second"})
        assert result.value == "second"
