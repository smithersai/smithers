"""Workflow snapshot and version comparison.

This module provides tools for:
1. Creating serializable snapshots of workflow graphs
2. Comparing snapshots to detect changes
3. Generating detailed diffs for code review and debugging

Example:
    from smithers import build_graph, create_snapshot, diff_snapshots

    # Create snapshots
    snapshot_v1 = create_snapshot(build_graph(workflow_v1))
    snapshot_v2 = create_snapshot(build_graph(workflow_v2))

    # Compare versions
    diff = diff_snapshots(snapshot_v1, snapshot_v2)

    # Print human-readable diff
    print(diff.summary())

    # Export as JSON for storage
    snapshot_json = snapshot_v1.to_json()
    loaded = WorkflowSnapshot.from_json(snapshot_json)
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from smithers.hashing import canonical_json, code_hash, hash_string
from smithers.types import WorkflowGraph, WorkflowNode


class ChangeType(str, Enum):
    """Type of change detected between snapshots."""

    ADDED = "added"
    REMOVED = "removed"
    MODIFIED = "modified"
    UNCHANGED = "unchanged"


class ChangeCategory(str, Enum):
    """Category of change for grouping."""

    NODE = "node"
    EDGE = "edge"
    CODE = "code"
    DEPENDENCY = "dependency"
    METADATA = "metadata"
    STRUCTURE = "structure"


@dataclass(frozen=True)
class NodeSnapshot:
    """Snapshot of a single workflow node."""

    name: str
    output_type_name: str
    dependencies: tuple[str, ...]
    requires_approval: bool
    approval_message: str | None
    code_hash: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name,
            "output_type_name": self.output_type_name,
            "dependencies": list(self.dependencies),
            "requires_approval": self.requires_approval,
            "approval_message": self.approval_message,
            "code_hash": self.code_hash,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> NodeSnapshot:
        """Create from dictionary."""
        return cls(
            name=data["name"],
            output_type_name=data["output_type_name"],
            dependencies=tuple(data.get("dependencies", [])),
            requires_approval=data.get("requires_approval", False),
            approval_message=data.get("approval_message"),
            code_hash=data.get("code_hash"),
        )

    @classmethod
    def from_node(cls, node: WorkflowNode, workflow: Any = None) -> NodeSnapshot:
        """Create from a WorkflowNode."""
        node_code_hash = None
        if workflow is not None:
            try:
                node_code_hash = code_hash(workflow)
            except Exception:
                pass

        return cls(
            name=node.name,
            output_type_name=node.output_type.__name__,
            dependencies=tuple(node.dependencies),
            requires_approval=node.requires_approval,
            approval_message=node.approval_message,
            code_hash=node_code_hash,
        )


@dataclass(frozen=True)
class WorkflowSnapshot:
    """Immutable snapshot of a workflow graph at a point in time.

    Snapshots can be serialized to JSON for storage and later comparison.
    Each snapshot includes a content hash for quick equality checks.
    """

    # Identifying information
    name: str
    version: str
    created_at: datetime
    description: str

    # Graph structure
    root: str
    nodes: tuple[NodeSnapshot, ...]
    edges: tuple[tuple[str, str], ...]
    levels: tuple[tuple[str, ...], ...]

    # Content hash for quick comparison
    content_hash: str

    # Optional metadata
    metadata: dict[str, Any] = field(default_factory=lambda: {})

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name,
            "version": self.version,
            "created_at": self.created_at.isoformat(),
            "description": self.description,
            "root": self.root,
            "nodes": [node.to_dict() for node in self.nodes],
            "edges": [list(edge) for edge in self.edges],
            "levels": [list(level) for level in self.levels],
            "content_hash": self.content_hash,
            "metadata": self.metadata,
        }

    def to_json(self, indent: int | None = 2) -> str:
        """Serialize to JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> WorkflowSnapshot:
        """Create from dictionary."""
        created_at = data.get("created_at")
        if isinstance(created_at, str):
            created_at = datetime.fromisoformat(created_at)
        elif created_at is None:
            created_at = datetime.now(UTC)

        return cls(
            name=data["name"],
            version=data.get("version", "unknown"),
            created_at=created_at,
            description=data.get("description", ""),
            root=data["root"],
            nodes=tuple(NodeSnapshot.from_dict(n) for n in data.get("nodes", [])),
            edges=tuple(tuple(e) for e in data.get("edges", [])),
            levels=tuple(tuple(level) for level in data.get("levels", [])),
            content_hash=data.get("content_hash", ""),
            metadata=data.get("metadata", {}),
        )

    @classmethod
    def from_json(cls, json_str: str) -> WorkflowSnapshot:
        """Create from JSON string."""
        return cls.from_dict(json.loads(json_str))

    def get_node(self, name: str) -> NodeSnapshot | None:
        """Get a node by name."""
        for node in self.nodes:
            if node.name == name:
                return node
        return None

    @property
    def node_names(self) -> set[str]:
        """Get all node names."""
        return {node.name for node in self.nodes}

    @property
    def node_count(self) -> int:
        """Get number of nodes."""
        return len(self.nodes)

    @property
    def edge_count(self) -> int:
        """Get number of edges."""
        return len(self.edges)

    @property
    def level_count(self) -> int:
        """Get number of execution levels."""
        return len(self.levels)


@dataclass(frozen=True)
class NodeChange:
    """Description of a change to a single node."""

    name: str
    change_type: ChangeType
    category: ChangeCategory
    old_value: Any = None
    new_value: Any = None
    details: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "change_type": self.change_type.value,
            "category": self.category.value,
            "old_value": self.old_value,
            "new_value": self.new_value,
            "details": self.details,
        }


@dataclass(frozen=True)
class EdgeChange:
    """Description of a change to an edge."""

    from_node: str
    to_node: str
    change_type: ChangeType

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "from_node": self.from_node,
            "to_node": self.to_node,
            "change_type": self.change_type.value,
        }


@dataclass
class GraphDiff:
    """Detailed diff between two workflow snapshots.

    Provides comprehensive change detection including:
    - Added/removed/modified nodes
    - Added/removed edges
    - Code changes (via hash comparison)
    - Dependency changes
    - Structural changes
    """

    # Source snapshots
    old_snapshot: WorkflowSnapshot
    new_snapshot: WorkflowSnapshot

    # Change lists
    node_changes: list[NodeChange] = field(default_factory=lambda: [])
    edge_changes: list[EdgeChange] = field(default_factory=lambda: [])

    # Summary statistics
    nodes_added: int = 0
    nodes_removed: int = 0
    nodes_modified: int = 0
    edges_added: int = 0
    edges_removed: int = 0

    # Computed flags
    has_changes: bool = False
    has_breaking_changes: bool = False
    structure_changed: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "old_version": self.old_snapshot.version,
            "new_version": self.new_snapshot.version,
            "old_content_hash": self.old_snapshot.content_hash,
            "new_content_hash": self.new_snapshot.content_hash,
            "has_changes": self.has_changes,
            "has_breaking_changes": self.has_breaking_changes,
            "structure_changed": self.structure_changed,
            "summary": {
                "nodes_added": self.nodes_added,
                "nodes_removed": self.nodes_removed,
                "nodes_modified": self.nodes_modified,
                "edges_added": self.edges_added,
                "edges_removed": self.edges_removed,
            },
            "node_changes": [c.to_dict() for c in self.node_changes],
            "edge_changes": [c.to_dict() for c in self.edge_changes],
        }

    def to_json(self, indent: int | None = 2) -> str:
        """Serialize to JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    def summary(self, *, use_colors: bool = True, use_unicode: bool = True) -> str:
        """Generate human-readable summary of changes."""
        lines: list[str] = []

        # Color codes
        if use_colors:
            RED = "\033[31m"
            GREEN = "\033[32m"
            YELLOW = "\033[33m"
            CYAN = "\033[36m"
            RESET = "\033[0m"
            BOLD = "\033[1m"
        else:
            RED = GREEN = YELLOW = CYAN = RESET = BOLD = ""

        # Symbols
        if use_unicode:
            PLUS = "+"
            MINUS = "-"
            CHANGE = "~"
            ARROW = "->"
            CHECK = "OK"
            CROSS = "!!"
        else:
            PLUS = "+"
            MINUS = "-"
            CHANGE = "~"
            ARROW = "->"
            CHECK = "OK"
            CROSS = "!!"

        # Header
        lines.append(
            f"{BOLD}Workflow Diff: {self.old_snapshot.version} {ARROW} {self.new_snapshot.version}{RESET}"
        )
        lines.append("=" * 60)

        if not self.has_changes:
            lines.append(f"{GREEN}{CHECK} No changes detected{RESET}")
            return "\n".join(lines)

        # Summary stats
        lines.append("")
        lines.append(f"{BOLD}Summary:{RESET}")
        if self.nodes_added > 0:
            lines.append(f"  {GREEN}{PLUS} {self.nodes_added} node(s) added{RESET}")
        if self.nodes_removed > 0:
            lines.append(f"  {RED}{MINUS} {self.nodes_removed} node(s) removed{RESET}")
        if self.nodes_modified > 0:
            lines.append(f"  {YELLOW}{CHANGE} {self.nodes_modified} node(s) modified{RESET}")
        if self.edges_added > 0:
            lines.append(f"  {GREEN}{PLUS} {self.edges_added} edge(s) added{RESET}")
        if self.edges_removed > 0:
            lines.append(f"  {RED}{MINUS} {self.edges_removed} edge(s) removed{RESET}")

        if self.has_breaking_changes:
            lines.append("")
            lines.append(f"{RED}{BOLD}{CROSS} Breaking changes detected!{RESET}")

        if self.structure_changed:
            lines.append(f"{YELLOW}   Structure changed (levels or root affected){RESET}")

        # Node changes
        if self.node_changes:
            lines.append("")
            lines.append(f"{BOLD}Node Changes:{RESET}")
            for change in self.node_changes:
                if change.change_type == ChangeType.ADDED:
                    lines.append(f"  {GREEN}{PLUS} {change.name}{RESET}")
                    if change.details:
                        lines.append(f"      {change.details}")
                elif change.change_type == ChangeType.REMOVED:
                    lines.append(f"  {RED}{MINUS} {change.name}{RESET}")
                    if change.details:
                        lines.append(f"      {change.details}")
                elif change.change_type == ChangeType.MODIFIED:
                    lines.append(f"  {YELLOW}{CHANGE} {change.name}{RESET}")
                    if change.category == ChangeCategory.CODE:
                        lines.append(f"      {CYAN}Code changed{RESET}")
                    elif change.category == ChangeCategory.DEPENDENCY:
                        old_deps: list[str] = change.old_value or []
                        new_deps: list[str] = change.new_value or []
                        added = set(new_deps) - set(old_deps)
                        removed = set(old_deps) - set(new_deps)
                        if added:
                            lines.append(f"      Dependencies added: {', '.join(sorted(added))}")
                        if removed:
                            lines.append(
                                f"      Dependencies removed: {', '.join(sorted(removed))}"
                            )
                    elif change.details:
                        lines.append(f"      {change.details}")

        # Edge changes
        if self.edge_changes:
            lines.append("")
            lines.append(f"{BOLD}Edge Changes:{RESET}")
            for change in self.edge_changes:
                edge_str = f"{change.from_node} {ARROW} {change.to_node}"
                if change.change_type == ChangeType.ADDED:
                    lines.append(f"  {GREEN}{PLUS} {edge_str}{RESET}")
                elif change.change_type == ChangeType.REMOVED:
                    lines.append(f"  {RED}{MINUS} {edge_str}{RESET}")

        return "\n".join(lines)

    def get_added_nodes(self) -> list[str]:
        """Get names of added nodes."""
        return [c.name for c in self.node_changes if c.change_type == ChangeType.ADDED]

    def get_removed_nodes(self) -> list[str]:
        """Get names of removed nodes."""
        return [c.name for c in self.node_changes if c.change_type == ChangeType.REMOVED]

    def get_modified_nodes(self) -> list[str]:
        """Get names of modified nodes."""
        return [c.name for c in self.node_changes if c.change_type == ChangeType.MODIFIED]

    def get_code_changes(self) -> list[NodeChange]:
        """Get changes where code was modified."""
        return [c for c in self.node_changes if c.category == ChangeCategory.CODE]


def create_snapshot(
    graph: WorkflowGraph,
    *,
    name: str | None = None,
    version: str = "1.0.0",
    description: str = "",
    metadata: dict[str, Any] | None = None,
) -> WorkflowSnapshot:
    """Create a snapshot from a workflow graph.

    Args:
        graph: The workflow graph to snapshot
        name: Optional name for the snapshot (defaults to root workflow name)
        version: Version string for this snapshot
        description: Human-readable description
        metadata: Optional metadata to attach

    Returns:
        WorkflowSnapshot capturing the graph state
    """
    # Build node snapshots
    nodes: list[NodeSnapshot] = []
    for node_name, node in sorted(graph.nodes.items()):
        workflow = graph.workflows.get(node_name)
        nodes.append(NodeSnapshot.from_node(node, workflow))

    # Compute content hash
    content = {
        "root": graph.root,
        "nodes": [n.to_dict() for n in nodes],
        "edges": sorted(graph.edges),
        "levels": graph.levels,
    }
    content_hash = hash_string(canonical_json(content))

    return WorkflowSnapshot(
        name=name or graph.root,
        version=version,
        created_at=datetime.now(UTC),
        description=description,
        root=graph.root,
        nodes=tuple(nodes),
        edges=tuple(tuple(e) for e in sorted(graph.edges)),
        levels=tuple(tuple(level) for level in graph.levels),
        content_hash=content_hash,
        metadata=metadata or {},
    )


def diff_snapshots(
    old: WorkflowSnapshot,
    new: WorkflowSnapshot,
) -> GraphDiff:
    """Compare two snapshots and generate a detailed diff.

    Args:
        old: The older/base snapshot
        new: The newer/target snapshot

    Returns:
        GraphDiff with all detected changes
    """
    diff = GraphDiff(old_snapshot=old, new_snapshot=new)

    # Quick check for identical snapshots
    if old.content_hash == new.content_hash:
        return diff

    # Track changes
    old_nodes = {n.name: n for n in old.nodes}
    new_nodes = {n.name: n for n in new.nodes}

    old_node_names = set(old_nodes.keys())
    new_node_names = set(new_nodes.keys())

    # Find added nodes
    for name in sorted(new_node_names - old_node_names):
        node = new_nodes[name]
        diff.node_changes.append(
            NodeChange(
                name=name,
                change_type=ChangeType.ADDED,
                category=ChangeCategory.NODE,
                new_value=node.to_dict(),
                details=f"Output type: {node.output_type_name}",
            )
        )
        diff.nodes_added += 1

    # Find removed nodes
    for name in sorted(old_node_names - new_node_names):
        node = old_nodes[name]
        diff.node_changes.append(
            NodeChange(
                name=name,
                change_type=ChangeType.REMOVED,
                category=ChangeCategory.NODE,
                old_value=node.to_dict(),
                details=f"Output type: {node.output_type_name}",
            )
        )
        diff.nodes_removed += 1

    # Find modified nodes
    for name in sorted(old_node_names & new_node_names):
        old_node = old_nodes[name]
        new_node = new_nodes[name]

        # Check code hash
        if (
            old_node.code_hash != new_node.code_hash
            and old_node.code_hash is not None
            and new_node.code_hash is not None
        ):
            diff.node_changes.append(
                NodeChange(
                    name=name,
                    change_type=ChangeType.MODIFIED,
                    category=ChangeCategory.CODE,
                    old_value=old_node.code_hash,
                    new_value=new_node.code_hash,
                    details="Implementation code changed",
                )
            )
            diff.nodes_modified += 1
            continue  # Don't double count

        # Check dependencies
        if old_node.dependencies != new_node.dependencies:
            diff.node_changes.append(
                NodeChange(
                    name=name,
                    change_type=ChangeType.MODIFIED,
                    category=ChangeCategory.DEPENDENCY,
                    old_value=list(old_node.dependencies),
                    new_value=list(new_node.dependencies),
                    details="Dependencies changed",
                )
            )
            diff.nodes_modified += 1
            continue

        # Check output type
        if old_node.output_type_name != new_node.output_type_name:
            diff.node_changes.append(
                NodeChange(
                    name=name,
                    change_type=ChangeType.MODIFIED,
                    category=ChangeCategory.METADATA,
                    old_value=old_node.output_type_name,
                    new_value=new_node.output_type_name,
                    details=f"Output type: {old_node.output_type_name} -> {new_node.output_type_name}",
                )
            )
            diff.nodes_modified += 1
            continue

        # Check approval settings
        if old_node.requires_approval != new_node.requires_approval:
            diff.node_changes.append(
                NodeChange(
                    name=name,
                    change_type=ChangeType.MODIFIED,
                    category=ChangeCategory.METADATA,
                    old_value=old_node.requires_approval,
                    new_value=new_node.requires_approval,
                    details=f"Approval requirement: {old_node.requires_approval} -> {new_node.requires_approval}",
                )
            )
            diff.nodes_modified += 1

    # Compare edges
    old_edges = set(old.edges)
    new_edges = set(new.edges)

    for edge in sorted(new_edges - old_edges):
        diff.edge_changes.append(
            EdgeChange(
                from_node=edge[0],
                to_node=edge[1],
                change_type=ChangeType.ADDED,
            )
        )
        diff.edges_added += 1

    for edge in sorted(old_edges - new_edges):
        diff.edge_changes.append(
            EdgeChange(
                from_node=edge[0],
                to_node=edge[1],
                change_type=ChangeType.REMOVED,
            )
        )
        diff.edges_removed += 1

    # Check structure changes
    if old.levels != new.levels:
        diff.structure_changed = True

    if old.root != new.root:
        diff.structure_changed = True

    # Compute summary flags
    diff.has_changes = bool(diff.node_changes or diff.edge_changes or diff.structure_changed)

    # Breaking changes: removed nodes, removed edges to root, or root changed
    diff.has_breaking_changes = (
        diff.nodes_removed > 0 or diff.edges_removed > 0 or old.root != new.root
    )

    return diff


def snapshots_equal(a: WorkflowSnapshot, b: WorkflowSnapshot) -> bool:
    """Check if two snapshots are equivalent.

    Uses content hash for quick comparison.
    """
    return a.content_hash == b.content_hash


def snapshot_from_json_file(path: str) -> WorkflowSnapshot:
    """Load a snapshot from a JSON file."""
    with open(path, encoding="utf-8") as f:
        return WorkflowSnapshot.from_json(f.read())


def save_snapshot_to_file(snapshot: WorkflowSnapshot, path: str) -> None:
    """Save a snapshot to a JSON file."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(snapshot.to_json())


class SnapshotStore:
    """Simple file-based storage for workflow snapshots.

    Organizes snapshots by workflow name and version.
    """

    def __init__(self, base_path: str) -> None:
        """Initialize the store.

        Args:
            base_path: Directory to store snapshot files
        """
        self.base_path = base_path

    def _get_path(self, workflow_name: str, version: str) -> str:
        """Get file path for a snapshot."""
        import os

        safe_name = workflow_name.replace("/", "_").replace("\\", "_")
        safe_version = version.replace("/", "_").replace("\\", "_")
        return os.path.join(self.base_path, f"{safe_name}_{safe_version}.json")

    def save(self, snapshot: WorkflowSnapshot) -> str:
        """Save a snapshot and return the file path."""
        import os

        os.makedirs(self.base_path, exist_ok=True)
        path = self._get_path(snapshot.name, snapshot.version)
        save_snapshot_to_file(snapshot, path)
        return path

    def load(self, workflow_name: str, version: str) -> WorkflowSnapshot | None:
        """Load a snapshot by name and version."""
        import os

        path = self._get_path(workflow_name, version)
        if os.path.exists(path):
            return snapshot_from_json_file(path)
        return None

    def list_versions(self, workflow_name: str) -> list[str]:
        """List all versions of a workflow."""
        import os

        versions = []
        safe_name = workflow_name.replace("/", "_").replace("\\", "_")
        prefix = f"{safe_name}_"
        suffix = ".json"

        if not os.path.exists(self.base_path):
            return versions

        for filename in os.listdir(self.base_path):
            if filename.startswith(prefix) and filename.endswith(suffix):
                version = filename[len(prefix) : -len(suffix)]
                versions.append(version)

        return sorted(versions)

    def list_workflows(self) -> dict[str, list[str]]:
        """List all workflows and their versions.

        Returns:
            Dict mapping workflow names to lists of version strings.
        """
        import os

        workflows: dict[str, list[str]] = {}

        if not os.path.exists(self.base_path):
            return workflows

        for filename in os.listdir(self.base_path):
            if filename.endswith(".json"):
                # Parse name_version.json
                name_parts = filename[:-5].rsplit("_", 1)  # Remove .json, split on last _
                if len(name_parts) == 2:
                    wf_name, version = name_parts
                    if wf_name not in workflows:
                        workflows[wf_name] = []
                    workflows[wf_name].append(version)

        # Sort versions for each workflow
        for wf_name in workflows:
            workflows[wf_name] = sorted(workflows[wf_name])

        return workflows

    def exists(self, workflow_name: str, version: str) -> bool:
        """Check if a snapshot exists.

        Args:
            workflow_name: Name of the workflow
            version: Version string

        Returns:
            True if the snapshot exists, False otherwise.
        """
        import os

        path = self._get_path(workflow_name, version)
        return os.path.exists(path)

    def get_latest(self, workflow_name: str) -> WorkflowSnapshot | None:
        """Get the latest version of a workflow."""
        versions = self.list_versions(workflow_name)
        if versions:
            return self.load(workflow_name, versions[-1])
        return None

    def diff_versions(
        self,
        workflow_name: str,
        old_version: str,
        new_version: str,
    ) -> GraphDiff | None:
        """Diff two versions of a workflow."""
        old = self.load(workflow_name, old_version)
        new = self.load(workflow_name, new_version)
        if old is None or new is None:
            return None
        return diff_snapshots(old, new)
