"""Tests for workflow snapshot and version comparison."""

from __future__ import annotations

import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import BaseModel

from smithers import build_graph, workflow
from smithers.snapshot import (
    ChangeCategory,
    ChangeType,
    EdgeChange,
    GraphDiff,
    NodeChange,
    NodeSnapshot,
    SnapshotStore,
    WorkflowSnapshot,
    create_snapshot,
    diff_snapshots,
    save_snapshot_to_file,
    snapshot_from_json_file,
    snapshots_equal,
)
from smithers.workflow import clear_registry


# Test output types
class OutputA(BaseModel):
    value: str


class OutputB(BaseModel):
    result: int


class OutputC(BaseModel):
    data: list[str]


class OutputD(BaseModel):
    combined: str


@pytest.fixture(autouse=True)
def clear_workflows() -> None:
    """Clear workflow registry before each test."""
    clear_registry()


class TestNodeSnapshot:
    """Tests for NodeSnapshot."""

    def test_create_node_snapshot(self) -> None:
        """Test creating a node snapshot."""
        snapshot = NodeSnapshot(
            name="test_node",
            output_type_name="OutputA",
            dependencies=("dep1", "dep2"),
            requires_approval=True,
            approval_message="Approve this?",
            code_hash="abc123",
        )

        assert snapshot.name == "test_node"
        assert snapshot.output_type_name == "OutputA"
        assert snapshot.dependencies == ("dep1", "dep2")
        assert snapshot.requires_approval is True
        assert snapshot.approval_message == "Approve this?"
        assert snapshot.code_hash == "abc123"

    def test_node_snapshot_to_dict(self) -> None:
        """Test converting node snapshot to dict."""
        snapshot = NodeSnapshot(
            name="test",
            output_type_name="Output",
            dependencies=("a", "b"),
            requires_approval=False,
            approval_message=None,
        )

        data = snapshot.to_dict()
        assert data["name"] == "test"
        assert data["output_type_name"] == "Output"
        assert data["dependencies"] == ["a", "b"]
        assert data["requires_approval"] is False
        assert data["approval_message"] is None

    def test_node_snapshot_from_dict(self) -> None:
        """Test creating node snapshot from dict."""
        data = {
            "name": "test",
            "output_type_name": "Output",
            "dependencies": ["x", "y"],
            "requires_approval": True,
            "approval_message": "Confirm?",
            "code_hash": "hash123",
        }

        snapshot = NodeSnapshot.from_dict(data)
        assert snapshot.name == "test"
        assert snapshot.dependencies == ("x", "y")
        assert snapshot.code_hash == "hash123"

    def test_node_snapshot_roundtrip(self) -> None:
        """Test node snapshot dict roundtrip."""
        original = NodeSnapshot(
            name="node1",
            output_type_name="TypeA",
            dependencies=("dep1",),
            requires_approval=True,
            approval_message="Please approve",
            code_hash="abc",
        )

        restored = NodeSnapshot.from_dict(original.to_dict())
        assert restored == original


class TestWorkflowSnapshot:
    """Tests for WorkflowSnapshot."""

    def test_create_snapshot_from_graph(self) -> None:
        """Test creating snapshot from a workflow graph."""

        @workflow
        async def produce_a() -> OutputA:
            return OutputA(value="test")

        graph = build_graph(produce_a)
        snapshot = create_snapshot(
            graph,
            name="test_workflow",
            version="1.0.0",
            description="Test snapshot",
        )

        assert snapshot.name == "test_workflow"
        assert snapshot.version == "1.0.0"
        assert snapshot.description == "Test snapshot"
        assert snapshot.root == "produce_a"
        assert len(snapshot.nodes) == 1
        assert snapshot.node_count == 1
        assert snapshot.content_hash  # Should have a hash

    def test_snapshot_with_dependencies(self) -> None:
        """Test snapshot of graph with dependencies."""

        @workflow
        async def step1() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def step2(a: OutputA) -> OutputB:
            return OutputB(result=len(a.value))

        graph = build_graph(step2)
        snapshot = create_snapshot(graph)

        assert snapshot.node_count == 2
        assert snapshot.edge_count == 1
        assert "step1" in snapshot.node_names
        assert "step2" in snapshot.node_names

    def test_snapshot_to_json(self) -> None:
        """Test serializing snapshot to JSON."""

        @workflow
        async def simple() -> OutputA:
            return OutputA(value="x")

        graph = build_graph(simple)
        snapshot = create_snapshot(graph, version="2.0.0")

        json_str = snapshot.to_json()
        data = json.loads(json_str)

        assert data["version"] == "2.0.0"
        assert data["root"] == "simple"
        assert "nodes" in data
        assert "edges" in data
        assert "content_hash" in data

    def test_snapshot_from_json(self) -> None:
        """Test deserializing snapshot from JSON."""

        @workflow
        async def original() -> OutputA:
            return OutputA(value="test")

        graph = build_graph(original)
        snapshot = create_snapshot(graph, version="1.5.0")
        json_str = snapshot.to_json()

        # Clear and reload
        restored = WorkflowSnapshot.from_json(json_str)

        assert restored.version == "1.5.0"
        assert restored.root == "original"
        assert restored.content_hash == snapshot.content_hash
        assert restored.node_count == snapshot.node_count

    def test_snapshot_get_node(self) -> None:
        """Test getting a specific node from snapshot."""

        @workflow
        async def node_a() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def node_b(a: OutputA) -> OutputB:
            return OutputB(result=1)

        graph = build_graph(node_b)
        snapshot = create_snapshot(graph)

        node = snapshot.get_node("node_a")
        assert node is not None
        assert node.name == "node_a"

        missing = snapshot.get_node("nonexistent")
        assert missing is None

    def test_snapshot_metadata(self) -> None:
        """Test snapshot with custom metadata."""

        @workflow
        async def with_meta() -> OutputA:
            return OutputA(value="x")

        graph = build_graph(with_meta)
        snapshot = create_snapshot(
            graph,
            metadata={"author": "test", "env": "dev"},
        )

        assert snapshot.metadata["author"] == "test"
        assert snapshot.metadata["env"] == "dev"

        # Ensure metadata survives roundtrip
        restored = WorkflowSnapshot.from_json(snapshot.to_json())
        assert restored.metadata == snapshot.metadata

    def test_snapshot_levels(self) -> None:
        """Test that snapshot captures execution levels."""

        @workflow
        async def level0_a() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def level0_b() -> OutputB:
            return OutputB(result=1)

        @workflow
        async def level1(a: OutputA, b: OutputB) -> OutputD:
            return OutputD(combined=f"{a.value}:{b.result}")

        graph = build_graph(level1)
        snapshot = create_snapshot(graph)

        assert snapshot.level_count == 2
        # Level 0 should have 2 nodes, level 1 should have 1
        assert len(snapshot.levels[0]) == 2
        assert len(snapshot.levels[1]) == 1


class TestDiffSnapshots:
    """Tests for snapshot diffing."""

    def test_identical_snapshots(self) -> None:
        """Test diff of identical snapshots."""

        @workflow
        async def same_wf() -> OutputA:
            return OutputA(value="test")

        graph = build_graph(same_wf)
        snapshot1 = create_snapshot(graph, version="1.0.0")
        snapshot2 = create_snapshot(graph, version="1.0.0")

        diff = diff_snapshots(snapshot1, snapshot2)

        assert not diff.has_changes
        assert diff.nodes_added == 0
        assert diff.nodes_removed == 0
        assert diff.nodes_modified == 0

    def test_detect_added_node(self) -> None:
        """Test detecting an added node."""
        # Create snapshots manually to have precise control
        old_node = NodeSnapshot(
            name="node1",
            output_type_name="OutputA",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
        )
        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(old_node,),
            edges=(),
            levels=(("node1",),),
            content_hash="old",
        )

        new_node1 = NodeSnapshot(
            name="node1",
            output_type_name="OutputA",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
        )
        new_node2 = NodeSnapshot(
            name="node2",
            output_type_name="OutputB",
            dependencies=("node1",),
            requires_approval=False,
            approval_message=None,
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node2",
            nodes=(new_node1, new_node2),
            edges=(("node1", "node2"),),
            levels=(("node1",), ("node2",)),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.has_changes
        assert diff.nodes_added == 1
        assert "node2" in diff.get_added_nodes()

    def test_detect_removed_node(self) -> None:
        """Test detecting a removed node."""
        # Create snapshots manually
        keep_node = NodeSnapshot(
            name="keep_node",
            output_type_name="OutputA",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
        )
        remove_node_snapshot = NodeSnapshot(
            name="remove_node",
            output_type_name="OutputB",
            dependencies=("keep_node",),
            requires_approval=False,
            approval_message=None,
        )
        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="remove_node",
            nodes=(keep_node, remove_node_snapshot),
            edges=(("keep_node", "remove_node"),),
            levels=(("keep_node",), ("remove_node",)),
            content_hash="old",
        )

        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="keep_node",
            nodes=(keep_node,),
            edges=(),
            levels=(("keep_node",),),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.has_changes
        assert diff.has_breaking_changes
        assert diff.nodes_removed == 1
        assert "remove_node" in diff.get_removed_nodes()

    def test_detect_edge_changes(self) -> None:
        """Test detecting added/removed edges."""
        # Create snapshots manually
        base_node = NodeSnapshot(
            name="base",
            output_type_name="OutputA",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
        )
        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="base",
            nodes=(base_node,),
            edges=(),
            levels=(("base",),),
            content_hash="old",
        )

        dependent_node = NodeSnapshot(
            name="dependent",
            output_type_name="OutputB",
            dependencies=("base",),
            requires_approval=False,
            approval_message=None,
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="dependent",
            nodes=(base_node, dependent_node),
            edges=(("base", "dependent"),),
            levels=(("base",), ("dependent",)),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.edges_added == 1
        assert diff.edge_changes[0].from_node == "base"
        assert diff.edge_changes[0].to_node == "dependent"

    def test_detect_dependency_changes(self) -> None:
        """Test detecting changes in node dependencies."""

        @workflow
        async def dep_a() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def uses_a(a: OutputA) -> OutputB:
            return OutputB(result=1)

        graph1 = build_graph(uses_a)
        snapshot1 = create_snapshot(graph1, version="1.0.0")
        clear_registry()

        @workflow
        async def dep_a_v2() -> OutputA:
            return OutputA(value="a")

        @workflow
        async def dep_c() -> OutputC:
            return OutputC(data=["c"])

        # Create a modified version with different deps
        # Simulating by creating manually modified snapshot
        old_node = NodeSnapshot(
            name="uses_a",
            output_type_name="OutputB",
            dependencies=("dep_a",),
            requires_approval=False,
            approval_message=None,
        )
        new_node = NodeSnapshot(
            name="uses_a",
            output_type_name="OutputB",
            dependencies=("dep_a", "dep_c"),
            requires_approval=False,
            approval_message=None,
        )

        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="uses_a",
            nodes=(old_node,),
            edges=(),
            levels=(("uses_a",),),
            content_hash="old",
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="uses_a",
            nodes=(new_node,),
            edges=(),
            levels=(("uses_a",),),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.nodes_modified == 1
        dep_change = [c for c in diff.node_changes if c.category == ChangeCategory.DEPENDENCY]
        assert len(dep_change) == 1
        assert dep_change[0].new_value == ["dep_a", "dep_c"]

    def test_detect_output_type_change(self) -> None:
        """Test detecting output type changes."""
        old_node = NodeSnapshot(
            name="node1",
            output_type_name="OutputA",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
        )
        new_node = NodeSnapshot(
            name="node1",
            output_type_name="OutputB",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
        )

        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(old_node,),
            edges=(),
            levels=(("node1",),),
            content_hash="old",
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(new_node,),
            edges=(),
            levels=(("node1",),),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.nodes_modified == 1
        meta_change = [c for c in diff.node_changes if c.category == ChangeCategory.METADATA]
        assert len(meta_change) == 1
        assert "OutputA" in meta_change[0].details
        assert "OutputB" in meta_change[0].details

    def test_detect_code_change(self) -> None:
        """Test detecting code hash changes."""
        old_node = NodeSnapshot(
            name="node1",
            output_type_name="OutputA",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
            code_hash="hash_v1",
        )
        new_node = NodeSnapshot(
            name="node1",
            output_type_name="OutputA",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
            code_hash="hash_v2",
        )

        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(old_node,),
            edges=(),
            levels=(("node1",),),
            content_hash="old",
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(new_node,),
            edges=(),
            levels=(("node1",),),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.nodes_modified == 1
        code_changes = diff.get_code_changes()
        assert len(code_changes) == 1
        assert code_changes[0].old_value == "hash_v1"
        assert code_changes[0].new_value == "hash_v2"

    def test_structure_change_detection(self) -> None:
        """Test detecting structural changes (levels, root)."""
        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node_a",
            nodes=(
                NodeSnapshot(
                    name="node_a",
                    output_type_name="OutputA",
                    dependencies=(),
                    requires_approval=False,
                    approval_message=None,
                ),
            ),
            edges=(),
            levels=(("node_a",),),
            content_hash="old",
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node_b",  # Different root
            nodes=(
                NodeSnapshot(
                    name="node_a",
                    output_type_name="OutputA",
                    dependencies=(),
                    requires_approval=False,
                    approval_message=None,
                ),
            ),
            edges=(),
            levels=(("node_a",), ("node_b",)),  # Different levels
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.structure_changed
        assert diff.has_breaking_changes


class TestDiffSummary:
    """Tests for diff summary output."""

    def test_summary_no_changes(self) -> None:
        """Test summary when no changes."""
        snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(),
            edges=(),
            levels=(),
            content_hash="same",
        )

        diff = diff_snapshots(snapshot, snapshot)
        summary = diff.summary(use_colors=False)

        assert "No changes" in summary

    def test_summary_with_changes(self) -> None:
        """Test summary with various changes."""
        diff = GraphDiff(
            old_snapshot=WorkflowSnapshot(
                name="test",
                version="1.0.0",
                created_at=datetime.now(UTC),
                description="",
                root="root",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="old",
            ),
            new_snapshot=WorkflowSnapshot(
                name="test",
                version="2.0.0",
                created_at=datetime.now(UTC),
                description="",
                root="root",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="new",
            ),
        )
        diff.has_changes = True
        diff.nodes_added = 2
        diff.nodes_removed = 1
        diff.nodes_modified = 3
        diff.node_changes = [
            NodeChange(
                "new1", ChangeType.ADDED, ChangeCategory.NODE, details="Output type: OutputA"
            ),
            NodeChange(
                "new2", ChangeType.ADDED, ChangeCategory.NODE, details="Output type: OutputB"
            ),
            NodeChange(
                "old1", ChangeType.REMOVED, ChangeCategory.NODE, details="Output type: OutputC"
            ),
            NodeChange("mod1", ChangeType.MODIFIED, ChangeCategory.CODE),
        ]
        diff.has_breaking_changes = True

        summary = diff.summary(use_colors=False)

        assert "2 node(s) added" in summary
        assert "1 node(s) removed" in summary
        assert "3 node(s) modified" in summary
        assert "Breaking changes" in summary

    def test_summary_with_colors(self) -> None:
        """Test summary with color output."""
        diff = GraphDiff(
            old_snapshot=WorkflowSnapshot(
                name="test",
                version="1.0.0",
                created_at=datetime.now(UTC),
                description="",
                root="root",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="old",
            ),
            new_snapshot=WorkflowSnapshot(
                name="test",
                version="2.0.0",
                created_at=datetime.now(UTC),
                description="",
                root="root",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="new",
            ),
        )
        diff.has_changes = True
        diff.nodes_added = 1
        diff.node_changes = [
            NodeChange("new1", ChangeType.ADDED, ChangeCategory.NODE),
        ]

        summary = diff.summary(use_colors=True)

        # Should contain ANSI color codes
        assert "\033[" in summary


class TestDiffToDict:
    """Tests for diff serialization."""

    def test_diff_to_dict(self) -> None:
        """Test converting diff to dictionary."""
        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="root",
            nodes=(),
            edges=(),
            levels=(),
            content_hash="old_hash",
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="root",
            nodes=(),
            edges=(),
            levels=(),
            content_hash="new_hash",
        )

        diff = GraphDiff(old_snapshot=old_snapshot, new_snapshot=new_snapshot)
        diff.has_changes = True
        diff.nodes_added = 1
        diff.node_changes = [
            NodeChange("node1", ChangeType.ADDED, ChangeCategory.NODE),
        ]

        data = diff.to_dict()

        assert data["old_version"] == "1.0.0"
        assert data["new_version"] == "2.0.0"
        assert data["old_content_hash"] == "old_hash"
        assert data["has_changes"] is True
        assert data["summary"]["nodes_added"] == 1
        assert len(data["node_changes"]) == 1

    def test_diff_to_json(self) -> None:
        """Test converting diff to JSON."""
        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="root",
            nodes=(),
            edges=(),
            levels=(),
            content_hash="old",
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="root",
            nodes=(),
            edges=(),
            levels=(),
            content_hash="new",
        )

        diff = GraphDiff(old_snapshot=old_snapshot, new_snapshot=new_snapshot)
        json_str = diff.to_json()

        # Should be valid JSON
        parsed = json.loads(json_str)
        assert "old_version" in parsed
        assert "new_version" in parsed


class TestSnapshotsEqual:
    """Tests for snapshot equality check."""

    def test_equal_snapshots(self) -> None:
        """Test that identical snapshots are equal."""

        @workflow
        async def same() -> OutputA:
            return OutputA(value="x")

        graph = build_graph(same)
        s1 = create_snapshot(graph)
        s2 = create_snapshot(graph)

        assert snapshots_equal(s1, s2)

    def test_different_snapshots(self) -> None:
        """Test that different snapshots are not equal."""
        s1 = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="root",
            nodes=(),
            edges=(),
            levels=(),
            content_hash="hash1",
        )
        s2 = WorkflowSnapshot(
            name="test",
            version="1.0.0",
            created_at=datetime.now(UTC),
            description="",
            root="root",
            nodes=(),
            edges=(),
            levels=(),
            content_hash="hash2",
        )

        assert not snapshots_equal(s1, s2)


class TestFileOperations:
    """Tests for file save/load operations."""

    def test_save_and_load_snapshot(self) -> None:
        """Test saving and loading snapshot from file."""

        @workflow
        async def file_test() -> OutputA:
            return OutputA(value="test")

        graph = build_graph(file_test)
        snapshot = create_snapshot(graph, version="1.0.0")

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            path = f.name

        try:
            save_snapshot_to_file(snapshot, path)
            loaded = snapshot_from_json_file(path)

            assert loaded.version == snapshot.version
            assert loaded.content_hash == snapshot.content_hash
            assert loaded.root == snapshot.root
        finally:
            Path(path).unlink(missing_ok=True)


class TestSnapshotStore:
    """Tests for SnapshotStore."""

    def test_save_and_load(self) -> None:
        """Test saving and loading snapshots."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)

            snapshot = WorkflowSnapshot(
                name="my_workflow",
                version="1.0.0",
                created_at=datetime.now(UTC),
                description="Test",
                root="root",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="abc123",
            )

            path = store.save(snapshot)
            assert Path(path).exists()

            loaded = store.load("my_workflow", "1.0.0")
            assert loaded is not None
            assert loaded.version == "1.0.0"

    def test_list_versions(self) -> None:
        """Test listing workflow versions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)

            for version in ["1.0.0", "2.0.0", "1.5.0"]:
                snapshot = WorkflowSnapshot(
                    name="versioned",
                    version=version,
                    created_at=datetime.now(UTC),
                    description="",
                    root="root",
                    nodes=(),
                    edges=(),
                    levels=(),
                    content_hash=f"hash_{version}",
                )
                store.save(snapshot)

            versions = store.list_versions("versioned")
            assert len(versions) == 3
            # Should be sorted
            assert versions == ["1.0.0", "1.5.0", "2.0.0"]

    def test_get_latest(self) -> None:
        """Test getting latest version."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)

            for version in ["1.0.0", "2.0.0"]:
                snapshot = WorkflowSnapshot(
                    name="latest_test",
                    version=version,
                    created_at=datetime.now(UTC),
                    description="",
                    root="root",
                    nodes=(),
                    edges=(),
                    levels=(),
                    content_hash=f"hash_{version}",
                )
                store.save(snapshot)

            latest = store.get_latest("latest_test")
            assert latest is not None
            assert latest.version == "2.0.0"

    def test_diff_versions(self) -> None:
        """Test diffing two stored versions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)

            v1 = WorkflowSnapshot(
                name="diff_test",
                version="1.0.0",
                created_at=datetime.now(UTC),
                description="",
                root="root",
                nodes=(
                    NodeSnapshot(
                        name="node1",
                        output_type_name="Output",
                        dependencies=(),
                        requires_approval=False,
                        approval_message=None,
                    ),
                ),
                edges=(),
                levels=(("node1",),),
                content_hash="v1_hash",
            )
            store.save(v1)

            v2 = WorkflowSnapshot(
                name="diff_test",
                version="2.0.0",
                created_at=datetime.now(UTC),
                description="",
                root="root",
                nodes=(
                    NodeSnapshot(
                        name="node1",
                        output_type_name="Output",
                        dependencies=(),
                        requires_approval=False,
                        approval_message=None,
                    ),
                    NodeSnapshot(
                        name="node2",
                        output_type_name="Output2",
                        dependencies=("node1",),
                        requires_approval=False,
                        approval_message=None,
                    ),
                ),
                edges=(("node1", "node2"),),
                levels=(("node1",), ("node2",)),
                content_hash="v2_hash",
            )
            store.save(v2)

            diff = store.diff_versions("diff_test", "1.0.0", "2.0.0")
            assert diff is not None
            assert diff.has_changes
            assert diff.nodes_added == 1

    def test_load_nonexistent(self) -> None:
        """Test loading nonexistent snapshot."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)
            result = store.load("nonexistent", "1.0.0")
            assert result is None

    def test_get_latest_empty(self) -> None:
        """Test getting latest when no snapshots exist."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)
            result = store.get_latest("nonexistent")
            assert result is None

    def test_list_workflows(self) -> None:
        """Test listing all workflows with their versions."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)

            # Create snapshots for multiple workflows
            for wf_name in ["workflow_a", "workflow_b"]:
                for version in ["1.0.0", "2.0.0"]:
                    snapshot = WorkflowSnapshot(
                        name=wf_name,
                        version=version,
                        created_at=datetime.now(UTC),
                        description="",
                        root="root",
                        nodes=(),
                        edges=(),
                        levels=(),
                        content_hash=f"{wf_name}_{version}",
                    )
                    store.save(snapshot)

            workflows = store.list_workflows()
            assert len(workflows) == 2
            assert "workflow_a" in workflows
            assert "workflow_b" in workflows
            assert workflows["workflow_a"] == ["1.0.0", "2.0.0"]
            assert workflows["workflow_b"] == ["1.0.0", "2.0.0"]

    def test_list_workflows_empty(self) -> None:
        """Test listing workflows when store is empty."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)
            workflows = store.list_workflows()
            assert workflows == {}

    def test_list_workflows_nonexistent_dir(self) -> None:
        """Test listing workflows when directory doesn't exist."""
        store = SnapshotStore("/nonexistent/path/that/does/not/exist")
        workflows = store.list_workflows()
        assert workflows == {}

    def test_exists(self) -> None:
        """Test checking if a snapshot exists."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store = SnapshotStore(tmpdir)

            snapshot = WorkflowSnapshot(
                name="exists_test",
                version="1.0.0",
                created_at=datetime.now(UTC),
                description="",
                root="root",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="test_hash",
            )
            store.save(snapshot)

            assert store.exists("exists_test", "1.0.0") is True
            assert store.exists("exists_test", "2.0.0") is False
            assert store.exists("nonexistent", "1.0.0") is False


class TestNodeChangeHelpers:
    """Tests for diff helper methods."""

    def test_get_added_nodes(self) -> None:
        """Test getting list of added nodes."""
        diff = GraphDiff(
            old_snapshot=WorkflowSnapshot(
                name="test",
                version="1",
                created_at=datetime.now(UTC),
                description="",
                root="r",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="old",
            ),
            new_snapshot=WorkflowSnapshot(
                name="test",
                version="2",
                created_at=datetime.now(UTC),
                description="",
                root="r",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="new",
            ),
        )
        diff.node_changes = [
            NodeChange("a", ChangeType.ADDED, ChangeCategory.NODE),
            NodeChange("b", ChangeType.REMOVED, ChangeCategory.NODE),
            NodeChange("c", ChangeType.ADDED, ChangeCategory.NODE),
        ]

        added = diff.get_added_nodes()
        assert added == ["a", "c"]

    def test_get_removed_nodes(self) -> None:
        """Test getting list of removed nodes."""
        diff = GraphDiff(
            old_snapshot=WorkflowSnapshot(
                name="test",
                version="1",
                created_at=datetime.now(UTC),
                description="",
                root="r",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="old",
            ),
            new_snapshot=WorkflowSnapshot(
                name="test",
                version="2",
                created_at=datetime.now(UTC),
                description="",
                root="r",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="new",
            ),
        )
        diff.node_changes = [
            NodeChange("a", ChangeType.ADDED, ChangeCategory.NODE),
            NodeChange("b", ChangeType.REMOVED, ChangeCategory.NODE),
            NodeChange("c", ChangeType.REMOVED, ChangeCategory.NODE),
        ]

        removed = diff.get_removed_nodes()
        assert removed == ["b", "c"]

    def test_get_modified_nodes(self) -> None:
        """Test getting list of modified nodes."""
        diff = GraphDiff(
            old_snapshot=WorkflowSnapshot(
                name="test",
                version="1",
                created_at=datetime.now(UTC),
                description="",
                root="r",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="old",
            ),
            new_snapshot=WorkflowSnapshot(
                name="test",
                version="2",
                created_at=datetime.now(UTC),
                description="",
                root="r",
                nodes=(),
                edges=(),
                levels=(),
                content_hash="new",
            ),
        )
        diff.node_changes = [
            NodeChange("a", ChangeType.MODIFIED, ChangeCategory.CODE),
            NodeChange("b", ChangeType.ADDED, ChangeCategory.NODE),
            NodeChange("c", ChangeType.MODIFIED, ChangeCategory.DEPENDENCY),
        ]

        modified = diff.get_modified_nodes()
        assert modified == ["a", "c"]


class TestEdgeChange:
    """Tests for EdgeChange."""

    def test_edge_change_to_dict(self) -> None:
        """Test edge change serialization."""
        change = EdgeChange(
            from_node="a",
            to_node="b",
            change_type=ChangeType.ADDED,
        )

        data = change.to_dict()
        assert data["from_node"] == "a"
        assert data["to_node"] == "b"
        assert data["change_type"] == "added"


class TestApprovalChanges:
    """Tests for approval-related changes."""

    def test_detect_approval_added(self) -> None:
        """Test detecting when approval requirement is added."""
        old_node = NodeSnapshot(
            name="node1",
            output_type_name="Output",
            dependencies=(),
            requires_approval=False,
            approval_message=None,
        )
        new_node = NodeSnapshot(
            name="node1",
            output_type_name="Output",
            dependencies=(),
            requires_approval=True,
            approval_message="Please approve",
        )

        old_snapshot = WorkflowSnapshot(
            name="test",
            version="1",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(old_node,),
            edges=(),
            levels=(("node1",),),
            content_hash="old",
        )
        new_snapshot = WorkflowSnapshot(
            name="test",
            version="2",
            created_at=datetime.now(UTC),
            description="",
            root="node1",
            nodes=(new_node,),
            edges=(),
            levels=(("node1",),),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.nodes_modified == 1
        change = diff.node_changes[0]
        assert change.category == ChangeCategory.METADATA
        assert "Approval requirement" in change.details


class TestComplexGraphDiff:
    """Tests for complex workflow graph diffs."""

    def test_multi_level_changes(self) -> None:
        """Test diff with changes at multiple levels."""
        # Old graph: A -> B -> C
        old_nodes = (
            NodeSnapshot("A", "OutputA", (), False, None),
            NodeSnapshot("B", "OutputB", ("A",), False, None),
            NodeSnapshot("C", "OutputC", ("B",), False, None),
        )
        old_edges = (("A", "B"), ("B", "C"))

        # New graph: A -> B -> D, A -> E -> D (C removed, D and E added)
        new_nodes = (
            NodeSnapshot("A", "OutputA", (), False, None),
            NodeSnapshot("B", "OutputB", ("A",), False, None),
            NodeSnapshot("D", "OutputD", ("B", "E"), False, None),
            NodeSnapshot("E", "OutputE", ("A",), False, None),
        )
        new_edges = (("A", "B"), ("A", "E"), ("B", "D"), ("E", "D"))

        old_snapshot = WorkflowSnapshot(
            name="complex",
            version="1",
            created_at=datetime.now(UTC),
            description="",
            root="C",
            nodes=old_nodes,
            edges=old_edges,
            levels=(("A",), ("B",), ("C",)),
            content_hash="old",
        )
        new_snapshot = WorkflowSnapshot(
            name="complex",
            version="2",
            created_at=datetime.now(UTC),
            description="",
            root="D",
            nodes=new_nodes,
            edges=new_edges,
            levels=(("A",), ("B", "E"), ("D",)),
            content_hash="new",
        )

        diff = diff_snapshots(old_snapshot, new_snapshot)

        assert diff.has_changes
        assert diff.has_breaking_changes
        assert diff.structure_changed
        assert diff.nodes_added == 2  # D, E
        assert diff.nodes_removed == 1  # C
        assert diff.edges_added == 3  # A->E, B->D, E->D
        assert diff.edges_removed == 1  # B->C
