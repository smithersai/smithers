"""Tests for graph building."""

import pytest
from pydantic import BaseModel

from smithers.graph import _dependency_namespace, _hash_inputs, build_graph
from smithers.hashing import input_hash
from smithers.workflow import clear_registry, workflow


class A(BaseModel):
    value: str


class B(BaseModel):
    value: str


class C(BaseModel):
    value: str


class D(BaseModel):
    value: str


class TestBuildGraph:
    """Tests for build_graph function."""

    def test_single_workflow(self):
        @workflow
        async def simple() -> A:
            return A(value="a")

        graph = build_graph(simple)

        assert graph.root == "simple"
        assert len(graph.nodes) == 1
        assert "simple" in graph.nodes
        assert graph.edges == []
        assert graph.levels == [["simple"]]

    def test_linear_dependencies(self):
        @workflow
        async def step1() -> A:
            return A(value="a")

        @workflow
        async def step2(a: A) -> B:
            return B(value=a.value)

        @workflow
        async def step3(b: B) -> C:
            return C(value=b.value)

        graph = build_graph(step3)

        assert graph.root == "step3"
        assert len(graph.nodes) == 3
        assert ("step1", "step2") in graph.edges
        assert ("step2", "step3") in graph.edges
        assert graph.levels == [["step1"], ["step2"], ["step3"]]

    def test_parallel_dependencies(self):
        @workflow
        async def base() -> A:
            return A(value="a")

        @workflow
        async def branch1(a: A) -> B:
            return B(value=a.value)

        @workflow
        async def branch2(a: A) -> C:
            return C(value=a.value)

        @workflow
        async def merge(b: B, c: C) -> D:
            return D(value=b.value + c.value)

        graph = build_graph(merge)

        assert graph.root == "merge"
        assert len(graph.nodes) == 4

        # Base runs first
        assert graph.levels[0] == ["base"]
        # Branches run in parallel (order may vary but both in same level)
        assert set(graph.levels[1]) == {"branch1", "branch2"}
        # Merge runs last
        assert graph.levels[2] == ["merge"]

    def test_missing_dependency_raises(self):
        class Orphan(BaseModel):
            value: str

        @workflow
        async def needs_orphan(o: Orphan) -> A:
            return A(value=o.value)

        with pytest.raises(ValueError, match="no workflow produces"):
            build_graph(needs_orphan)

    def test_mermaid_output(self):
        @workflow
        async def step1() -> A:
            return A(value="a")

        @workflow
        async def step2(a: A) -> B:
            return B(value=a.value)

        graph = build_graph(step2)
        mermaid = graph.mermaid()

        assert "graph LR" in mermaid
        assert "step1 --> step2" in mermaid

    def test_list_dependency_hashing_and_namespace(self):
        clear_registry()
        try:
            class Item(BaseModel):
                value: int

            class Summary(BaseModel):
                total: int

            @workflow
            async def produce() -> Item:
                return Item(value=1)

            @workflow
            async def consume(items: list[Item]) -> Summary:
                return Summary(total=sum(item.value for item in items))

            item = Item(value=1)
            outputs = {"produce": item}

            expected_inputs = {"bound_args": {}, "deps": {"items": [item]}}
            expected_hash = input_hash(expected_inputs)

            assert _hash_inputs(consume, outputs) == expected_hash

            deps = _dependency_namespace(consume, outputs)
            assert deps.items == [item]
        finally:
            clear_registry()
