"""Enhanced graph visualization with ASCII art, colors, and execution status.

This module provides multiple visualization formats for workflow graphs and
their execution status. Visualizations help developers understand graph structure,
monitor execution progress, and debug workflow issues.

Visualization Formats:
- ASCII art: Horizontal tree-like view showing execution flow
- Tree: Vertical dependency tree from root node
- Table: Status table with columns for node, status, duration, and cache
- Mermaid: Mermaid diagram syntax with status styling
- Summary: Brief text summary of graph execution

Features:
- Automatic terminal capability detection (colors, Unicode)
- Status icons and colors for different node states
- Execution timing display
- Cache hit visualization
- Real-time progress updates during execution

Example - Basic visualization:
    from smithers import build_graph
    from smithers.visualization import visualize_graph, print_graph

    graph = build_graph(my_workflow)

    # Print ASCII visualization
    print_graph(graph, format="ascii")

    # Get as string
    output = visualize_graph(graph, format="table")

    # Mermaid diagram for documentation
    mermaid = visualize_graph(graph, format="mermaid")

Example - With execution results:
    from smithers import run_graph
    from smithers.visualization import visualize_graph

    result = await run_graph(graph)
    output = visualize_graph(
        graph,
        format="table",
        results=result.workflow_results,
        show_timing=True,
    )
    print(output)

Example - Real-time progress:
    from smithers import run_graph
    from smithers.visualization import ProgressVisualizer, create_progress_callback

    # Option 1: Using ProgressVisualizer directly
    viz = ProgressVisualizer(graph, format="table")
    result = await run_graph(graph, on_progress=viz.update)
    print(viz.final_report())

    # Option 2: Using helper function
    viz, callback = create_progress_callback(graph)
    result = await run_graph(graph, on_progress=callback)

Terminal Support:
    Color output is automatically disabled when:
    - NO_COLOR environment variable is set
    - stdout is not a TTY
    - TERM is set to "dumb"

    Unicode output is automatically disabled when:
    - stdout encoding doesn't include "utf"
    - LANG environment variable doesn't include "utf"

    To force specific settings:
        visualize_graph(graph, use_colors=False, use_unicode=False)
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from smithers.store.sqlite import NodeStatus

if TYPE_CHECKING:
    from smithers.types import WorkflowGraph, WorkflowResult


# ANSI color codes
class Colors:
    """ANSI color codes for terminal output."""

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"

    # Status colors
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    BLUE = "\033[34m"
    CYAN = "\033[36m"
    MAGENTA = "\033[35m"
    WHITE = "\033[37m"
    GRAY = "\033[90m"

    # Background colors
    BG_GREEN = "\033[42m"
    BG_RED = "\033[41m"
    BG_YELLOW = "\033[43m"
    BG_BLUE = "\033[44m"


def _supports_color() -> bool:
    """Check if the terminal supports colors."""
    # Check for NO_COLOR environment variable (standard)
    import os

    if os.environ.get("NO_COLOR"):
        return False
    # Check if stdout is a tty
    if not hasattr(sys.stdout, "isatty") or not sys.stdout.isatty():
        return False
    # Check for TERM
    term = os.environ.get("TERM", "")
    if term == "dumb":
        return False
    return True


def _colorize(text: str, color: str, use_colors: bool = True) -> str:
    """Apply color to text if colors are enabled."""
    if not use_colors:
        return text
    return f"{color}{text}{Colors.RESET}"


# Status indicators (Unicode and ASCII fallbacks)
STATUS_ICONS = {
    NodeStatus.PENDING: ("○", "o"),  # Empty circle
    NodeStatus.READY: ("◎", "O"),  # Target
    NodeStatus.RUNNING: ("◉", "*"),  # Running spinner
    NodeStatus.CACHED: ("◆", "#"),  # Cached (diamond)
    NodeStatus.SUCCESS: ("✓", "+"),  # Checkmark
    NodeStatus.SKIPPED: ("⊘", "-"),  # Skipped
    NodeStatus.FAILED: ("✗", "x"),  # X mark
    NodeStatus.CANCELLED: ("⊗", "C"),  # Cancelled
    NodeStatus.PAUSED: ("⏸", "P"),  # Paused
}

STATUS_COLORS = {
    NodeStatus.PENDING: Colors.GRAY,
    NodeStatus.READY: Colors.BLUE,
    NodeStatus.RUNNING: Colors.CYAN,
    NodeStatus.CACHED: Colors.MAGENTA,
    NodeStatus.SUCCESS: Colors.GREEN,
    NodeStatus.SKIPPED: Colors.YELLOW,
    NodeStatus.FAILED: Colors.RED,
    NodeStatus.CANCELLED: Colors.YELLOW,
    NodeStatus.PAUSED: Colors.BLUE,
}


def _supports_unicode() -> bool:
    """Check if the terminal supports Unicode."""
    import os

    # Check encoding
    encoding = getattr(sys.stdout, "encoding", "").lower()
    if encoding and "utf" in encoding:
        return True
    # Check LANG
    lang = os.environ.get("LANG", "").lower()
    if "utf" in lang:
        return True
    return False


def _get_status_icon(status: NodeStatus, use_unicode: bool = True) -> str:
    """Get the appropriate status icon."""
    icons = STATUS_ICONS.get(status, ("?", "?"))
    return icons[0] if use_unicode else icons[1]


@dataclass
class NodeState:
    """State information for a node during visualization."""

    name: str
    status: NodeStatus = NodeStatus.PENDING
    duration_ms: float | None = None
    cached: bool = False
    error: str | None = None
    skip_reason: str | None = None


@dataclass
class GraphVisualization:
    """Enhanced visualization of a workflow graph."""

    graph: WorkflowGraph
    node_states: dict[str, NodeState] = field(default_factory=lambda: {})
    use_colors: bool = True
    use_unicode: bool = True

    def __post_init__(self) -> None:
        """Initialize node states if not provided."""
        # Auto-detect terminal capabilities
        if self.use_colors and not _supports_color():
            self.use_colors = False
        if self.use_unicode and not _supports_unicode():
            self.use_unicode = False

        # Initialize states for all nodes
        for name in self.graph.nodes:
            if name not in self.node_states:
                self.node_states[name] = NodeState(name=name)

    def update_from_results(self, results: list[WorkflowResult]) -> None:
        """Update node states from execution results."""
        for result in results:
            if result.name in self.node_states:
                state = self.node_states[result.name]
                state.duration_ms = result.duration_ms
                state.cached = result.cached
                if result.cached:
                    state.status = NodeStatus.CACHED
                elif result.output is not None:
                    state.status = NodeStatus.SUCCESS
                else:
                    state.status = NodeStatus.SKIPPED

    def update_status(
        self,
        name: str,
        status: NodeStatus,
        duration_ms: float | None = None,
        error: str | None = None,
        skip_reason: str | None = None,
    ) -> None:
        """Update the status of a specific node."""
        if name not in self.node_states:
            self.node_states[name] = NodeState(name=name)
        state = self.node_states[name]
        state.status = status
        if duration_ms is not None:
            state.duration_ms = duration_ms
        if error is not None:
            state.error = error
        if skip_reason is not None:
            state.skip_reason = skip_reason

    def ascii(self, show_status: bool = True, show_timing: bool = True) -> str:
        """
        Generate ASCII art representation of the graph.

        Creates a horizontal tree-like view showing the execution flow.

        Example output:
            analyze ─────────┬──▶ implement ──▶ deploy
                             │
                             └──▶ test ────────┘

        Or with status:
            [✓] analyze (125ms) ───┬──▶ [✓] implement (340ms) ──▶ [○] deploy
                                   │
                                   └──▶ [✓] test (210ms) ────────┘
        """
        lines: list[str] = []
        lines.append(self._build_title())
        lines.append("")

        # Build the level-by-level visualization
        levels = self.graph.levels
        if not levels:
            lines.append("  (empty graph)")
            return "\n".join(lines)

        # Calculate node widths for alignment
        node_widths = self._calculate_node_widths(show_status, show_timing)
        max_level_width = max(
            sum(node_widths.get(n, len(n)) for n in level) + len(level) * 4 for level in levels
        )

        # Build the ASCII representation
        for level_idx, level in enumerate(levels):
            level_lines = self._render_level(
                level, level_idx, levels, node_widths, show_status, show_timing
            )
            lines.extend(level_lines)
            lines.append("")

        # Add legend if showing status
        if show_status:
            lines.extend(self._build_legend())

        return "\n".join(lines)

    def _build_title(self) -> str:
        """Build the title line."""
        title = f"Workflow Graph: {self.graph.root}"
        if self.use_colors:
            return _colorize(title, Colors.BOLD, self.use_colors)
        return title

    def _calculate_node_widths(self, show_status: bool, show_timing: bool) -> dict[str, int]:
        """Calculate the display width of each node."""
        widths: dict[str, int] = {}
        for name in self.graph.nodes:
            width = len(name)
            if show_status:
                width += 4  # [X]
            if show_timing:
                state = self.node_states.get(name)
                if state and state.duration_ms is not None:
                    width += len(f" ({state.duration_ms:.0f}ms)")
            widths[name] = width
        return widths

    def _render_level(
        self,
        level: list[str],
        level_idx: int,
        all_levels: list[list[str]],
        node_widths: dict[str, int],
        show_status: bool,
        show_timing: bool,
    ) -> list[str]:
        """Render a single level of the graph."""
        lines: list[str] = []

        # Determine connections to next level
        next_level = all_levels[level_idx + 1] if level_idx < len(all_levels) - 1 else []

        # Build the main level line
        level_line = "  "
        for i, name in enumerate(level):
            node_str = self._render_node(name, show_status, show_timing)
            level_line += node_str

            # Add connector to next level
            if next_level:
                # Check if this node connects to nodes in the next level
                connections = [n for n in next_level if self._has_edge(name, n)]
                if connections:
                    arrow = " ──▶ " if self.use_unicode else " --> "
                    if len(connections) > 1 or i < len(level) - 1:
                        arrow = " ─┬─▶ " if self.use_unicode else " -+-> "
                    level_line += arrow
                else:
                    level_line += "     "
            elif i < len(level) - 1:
                level_line += "  "

        lines.append(level_line)
        return lines

    def _render_node(self, name: str, show_status: bool, show_timing: bool) -> str:
        """Render a single node with optional status and timing."""
        state = self.node_states.get(name, NodeState(name=name))
        parts: list[str] = []

        # Status indicator
        if show_status:
            icon = _get_status_icon(state.status, self.use_unicode)
            color = STATUS_COLORS.get(state.status, Colors.WHITE)
            status_str = f"[{icon}]"
            if self.use_colors:
                status_str = _colorize(status_str, color, self.use_colors)
            parts.append(status_str)

        # Node name
        name_str = name
        if self.use_colors and state.status == NodeStatus.FAILED:
            name_str = _colorize(name, Colors.RED + Colors.BOLD, self.use_colors)
        elif self.use_colors and state.status == NodeStatus.SUCCESS:
            name_str = _colorize(name, Colors.GREEN, self.use_colors)
        elif self.use_colors and state.status == NodeStatus.CACHED:
            name_str = _colorize(name, Colors.MAGENTA, self.use_colors)
        parts.append(name_str)

        # Timing information
        if show_timing and state.duration_ms is not None:
            timing_str = f"({state.duration_ms:.0f}ms)"
            if self.use_colors:
                timing_str = _colorize(timing_str, Colors.DIM, self.use_colors)
            parts.append(timing_str)

        return " ".join(parts)

    def _has_edge(self, from_node: str, to_node: str) -> bool:
        """Check if there's an edge between two nodes."""
        return (from_node, to_node) in self.graph.edges

    def _build_legend(self) -> list[str]:
        """Build the status legend."""
        lines: list[str] = []
        lines.append(_colorize("Legend:", Colors.DIM, self.use_colors))

        legend_items = [
            (NodeStatus.PENDING, "Pending"),
            (NodeStatus.RUNNING, "Running"),
            (NodeStatus.SUCCESS, "Success"),
            (NodeStatus.CACHED, "Cached"),
            (NodeStatus.SKIPPED, "Skipped"),
            (NodeStatus.FAILED, "Failed"),
        ]

        legend_line = "  "
        for status, label in legend_items:
            icon = _get_status_icon(status, self.use_unicode)
            color = STATUS_COLORS.get(status, Colors.WHITE)
            item = f"[{icon}] {label}"
            if self.use_colors:
                item = _colorize(item, color, self.use_colors)
            legend_line += item + "  "

        lines.append(legend_line)
        return lines

    def tree(self, show_status: bool = True, show_timing: bool = True) -> str:
        """
        Generate a tree-like visualization starting from root.

        Example output:
            deploy
            ├── implement
            │   └── analyze
            └── test
                └── analyze
        """
        lines: list[str] = []
        lines.append(self._build_title())
        lines.append("")

        visited: set[str] = set()
        self._render_tree_node(self.graph.root, lines, "", True, visited, show_status, show_timing)

        if show_status:
            lines.append("")
            lines.extend(self._build_legend())

        return "\n".join(lines)

    def _render_tree_node(
        self,
        name: str,
        lines: list[str],
        prefix: str,
        is_last: bool,
        visited: set[str],
        show_status: bool,
        show_timing: bool,
    ) -> None:
        """Recursively render tree nodes."""
        # Determine connector
        if prefix:
            connector = "└── " if is_last else "├── "
            if not self.use_unicode:
                connector = "`-- " if is_last else "|-- "
        else:
            connector = ""

        # Render this node
        node_str = self._render_node(name, show_status, show_timing)
        lines.append(f"{prefix}{connector}{node_str}")

        # Mark as visited to handle shared dependencies
        was_visited = name in visited
        visited.add(name)

        # Get dependencies
        node = self.graph.nodes.get(name)
        if node and node.dependencies and not was_visited:
            deps = sorted(node.dependencies)
            new_prefix = prefix + ("    " if is_last else "│   ")
            if not self.use_unicode:
                new_prefix = prefix + ("    " if is_last else "|   ")

            for i, dep in enumerate(deps):
                is_dep_last = i == len(deps) - 1
                self._render_tree_node(
                    dep, lines, new_prefix, is_dep_last, visited, show_status, show_timing
                )

    def table(self, show_all: bool = True) -> str:
        """
        Generate a table view of all nodes and their status.

        Example output:
            ┌─────────────┬──────────┬──────────┬────────┐
            │ Node        │ Status   │ Duration │ Cached │
            ├─────────────┼──────────┼──────────┼────────┤
            │ analyze     │ ✓ Success│   125ms  │   No   │
            │ implement   │ ✓ Success│   340ms  │   No   │
            │ test        │ ◆ Cached │    -     │  Yes   │
            │ deploy      │ ○ Pending│    -     │   -    │
            └─────────────┴──────────┴──────────┴────────┘
        """
        lines: list[str] = []

        # Calculate column widths (handle empty graph gracefully)
        name_width = max(len(n) for n in self.graph.nodes) + 2 if self.graph.nodes else 0
        name_width = max(name_width, 12)
        status_width = 12
        duration_width = 10
        cached_width = 8

        # Box drawing characters
        if self.use_unicode:
            h, v = "─", "│"
            tl, tr, bl, br = "┌", "┐", "└", "┘"
            ml, mr, mt, mb = "├", "┤", "┬", "┴"
            cross = "┼"
        else:
            h, v = "-", "|"
            tl, tr, bl, br = "+", "+", "+", "+"
            ml, mr, mt, mb = "+", "+", "+", "+"
            cross = "+"

        # Top border
        top = (
            f"{tl}{h * name_width}{mt}{h * status_width}{mt}"
            f"{h * duration_width}{mt}{h * cached_width}{tr}"
        )
        lines.append(top)

        # Header
        header = (
            f"{v}{'Node':^{name_width}}{v}{'Status':^{status_width}}{v}"
            f"{'Duration':^{duration_width}}{v}{'Cached':^{cached_width}}{v}"
        )
        if self.use_colors:
            header = _colorize(header, Colors.BOLD, self.use_colors)
        lines.append(header)

        # Header separator
        sep = (
            f"{ml}{h * name_width}{cross}{h * status_width}{cross}"
            f"{h * duration_width}{cross}{h * cached_width}{mr}"
        )
        lines.append(sep)

        # Rows
        for level in self.graph.levels:
            for name in sorted(level):
                state = self.node_states.get(name, NodeState(name=name))
                row = self._render_table_row(
                    name, state, name_width, status_width, duration_width, cached_width, v
                )
                lines.append(row)

        # Bottom border
        bottom = (
            f"{bl}{h * name_width}{mb}{h * status_width}{mb}"
            f"{h * duration_width}{mb}{h * cached_width}{br}"
        )
        lines.append(bottom)

        return "\n".join(lines)

    def _render_table_row(
        self,
        name: str,
        state: NodeState,
        name_w: int,
        status_w: int,
        duration_w: int,
        cached_w: int,
        v: str,
    ) -> str:
        """Render a single table row."""
        # Status
        icon = _get_status_icon(state.status, self.use_unicode)
        status_text = f"{icon} {state.status.value.capitalize()}"
        color = STATUS_COLORS.get(state.status, Colors.WHITE)
        if self.use_colors:
            status_text = _colorize(status_text, color, self.use_colors)

        # Duration
        if state.duration_ms is not None:
            duration = f"{state.duration_ms:.0f}ms"
        else:
            duration = "-"

        # Cached
        if state.cached:
            cached = "Yes"
        elif state.status in (NodeStatus.SUCCESS, NodeStatus.FAILED):
            cached = "No"
        else:
            cached = "-"

        # Build row (need to account for ANSI codes in width calculation)
        name_padded = f" {name:<{name_w - 1}}"
        duration_padded = f"{duration:^{duration_w}}"
        cached_padded = f"{cached:^{cached_w}}"

        # Status needs special handling due to ANSI codes
        visible_status_len = len(f"{icon} {state.status.value.capitalize()}")
        status_padding = status_w - visible_status_len
        status_padded = (
            " " * (status_padding // 2) + status_text + " " * (status_padding - status_padding // 2)
        )

        return f"{v}{name_padded}{v}{status_padded}{v}{duration_padded}{v}{cached_padded}{v}"

    def mermaid_styled(self) -> str:
        """
        Generate a Mermaid diagram with status styling.

        Uses Mermaid's styling capabilities to show node status.
        """
        lines = ["graph LR"]

        # Add class definitions for styling
        lines.append("    %% Status styles")
        lines.append("    classDef pending fill:#e0e0e0,stroke:#9e9e9e")
        lines.append("    classDef ready fill:#bbdefb,stroke:#1976d2")
        lines.append("    classDef running fill:#bbdefb,stroke:#1976d2")
        lines.append("    classDef success fill:#c8e6c9,stroke:#388e3c")
        lines.append("    classDef cached fill:#e1bee7,stroke:#7b1fa2")
        lines.append("    classDef skipped fill:#fff9c4,stroke:#f9a825")
        lines.append("    classDef failed fill:#ffcdd2,stroke:#d32f2f")
        lines.append("    classDef cancelled fill:#fff9c4,stroke:#f9a825")
        lines.append("    classDef paused fill:#bbdefb,stroke:#1976d2")
        lines.append("")

        # Add nodes with their display labels
        for name, node in self.graph.nodes.items():
            state = self.node_states.get(name, NodeState(name=name))
            label = name
            if state.duration_ms is not None:
                label = f"{name}<br/>{state.duration_ms:.0f}ms"
            lines.append(f"    {name}[{label}]")

        lines.append("")

        # Add edges
        for from_node, to_node in self.graph.edges:
            lines.append(f"    {from_node} --> {to_node}")

        lines.append("")

        # Apply status classes
        for status in NodeStatus:
            nodes_with_status = [
                name for name, state in self.node_states.items() if state.status == status
            ]
            if nodes_with_status:
                nodes_str = ",".join(nodes_with_status)
                lines.append(f"    class {nodes_str} {status.value.lower()}")

        return "\n".join(lines)

    def summary(self) -> str:
        """Generate a brief summary of the graph execution."""
        total = len(self.graph.nodes)
        by_status: dict[NodeStatus, int] = {}
        total_duration = 0.0

        for state in self.node_states.values():
            by_status[state.status] = by_status.get(state.status, 0) + 1
            if state.duration_ms:
                total_duration += state.duration_ms

        lines: list[str] = []
        lines.append(f"Graph: {self.graph.root}")
        lines.append(f"Total nodes: {total}")

        status_parts: list[str] = []
        for status, count in sorted(by_status.items(), key=lambda x: x[0].value):
            icon = _get_status_icon(status, self.use_unicode)
            color = STATUS_COLORS.get(status, Colors.WHITE)
            part = f"{icon} {count} {status.value.lower()}"
            if self.use_colors:
                part = _colorize(part, color, self.use_colors)
            status_parts.append(part)

        lines.append("Status: " + ", ".join(status_parts))

        if total_duration > 0:
            lines.append(f"Total duration: {total_duration:.0f}ms")

        return "\n".join(lines)


def visualize_graph(
    graph: WorkflowGraph,
    format: str = "ascii",
    *,
    show_status: bool = True,
    show_timing: bool = True,
    use_colors: bool | None = None,
    use_unicode: bool | None = None,
    results: list[WorkflowResult] | None = None,
    node_statuses: dict[str, str] | None = None,
) -> str:
    """
    Generate a visualization of a workflow graph.

    Args:
        graph: The workflow graph to visualize
        format: Output format ('ascii', 'tree', 'table', 'mermaid', 'summary')
        show_status: Whether to show node status indicators
        show_timing: Whether to show execution timing
        use_colors: Whether to use ANSI colors (auto-detect if None)
        use_unicode: Whether to use Unicode characters (auto-detect if None)
        results: Optional execution results to populate status
        node_statuses: Optional dict of node_name -> status string

    Returns:
        The visualization as a string
    """
    # Create visualization
    viz = GraphVisualization(
        graph=graph,
        use_colors=use_colors if use_colors is not None else True,
        use_unicode=use_unicode if use_unicode is not None else True,
    )

    # Update from results if provided
    if results:
        viz.update_from_results(results)

    # Update from statuses if provided
    if node_statuses:
        for name, status_str in node_statuses.items():
            try:
                status = NodeStatus(status_str.upper())
            except ValueError:
                status = NodeStatus.PENDING
            viz.update_status(name, status)

    # Generate output
    if format == "ascii":
        return viz.ascii(show_status=show_status, show_timing=show_timing)
    elif format == "tree":
        return viz.tree(show_status=show_status, show_timing=show_timing)
    elif format == "table":
        return viz.table()
    elif format == "mermaid":
        return viz.mermaid_styled()
    elif format == "summary":
        return viz.summary()
    else:
        raise ValueError(f"Unknown format: {format}")


def print_graph(
    graph: WorkflowGraph,
    format: str = "ascii",
    **kwargs: Any,
) -> None:
    """
    Print a visualization of a workflow graph.

    Convenience wrapper around visualize_graph that prints to stdout.
    """
    output = visualize_graph(graph, format, **kwargs)
    print(output)


class ProgressVisualizer:
    """
    Real-time progress visualizer for graph execution.

    Use with run_graph's on_progress callback to see live status updates.

    Example:
        from smithers import run_graph, build_graph
        from smithers.visualization import ProgressVisualizer

        graph = build_graph(my_workflow)
        progress = ProgressVisualizer(graph)

        result = await run_graph(
            graph,
            on_progress=progress.update,
        )
    """

    def __init__(
        self,
        graph: WorkflowGraph,
        *,
        format: str = "table",
        use_colors: bool = True,
        use_unicode: bool = True,
        clear_screen: bool = True,
    ) -> None:
        """
        Initialize the progress visualizer.

        Args:
            graph: The workflow graph being executed
            format: Visualization format ('table', 'summary', 'ascii')
            use_colors: Whether to use ANSI colors
            use_unicode: Whether to use Unicode characters
            clear_screen: Whether to clear screen between updates
        """
        self.viz = GraphVisualization(
            graph=graph,
            use_colors=use_colors,
            use_unicode=use_unicode,
        )
        self.format = format
        self.clear_screen = clear_screen
        self._started = False

    async def update(self, event: Any) -> None:
        """
        Handle a workflow event and update the display.

        This method is designed to be passed to run_graph's on_progress callback.
        """

        # Map event types to node statuses
        event_type = getattr(event, "type", None)
        workflow_name = getattr(event, "workflow_name", None)
        duration_ms = getattr(event, "duration_ms", None)
        message = getattr(event, "message", None)

        if workflow_name is None:
            return

        if event_type == "started":
            self.viz.update_status(workflow_name, NodeStatus.RUNNING)
        elif event_type == "completed":
            self.viz.update_status(workflow_name, NodeStatus.SUCCESS, duration_ms=duration_ms)
        elif event_type == "cached":
            self.viz.update_status(workflow_name, NodeStatus.CACHED)
            self.viz.node_states[workflow_name].cached = True
        elif event_type == "failed":
            self.viz.update_status(workflow_name, NodeStatus.FAILED, error=message)
        elif event_type == "skipped":
            self.viz.update_status(workflow_name, NodeStatus.SKIPPED, skip_reason=message)

        # Render and display
        self._render()

    def _render(self) -> None:
        """Render the current state."""
        import sys

        if self.clear_screen:
            # ANSI escape to clear screen and move cursor to top
            print("\033[2J\033[H", end="", file=sys.stdout)

        if self.format == "table":
            print(self.viz.table(), file=sys.stdout)
        elif self.format == "summary":
            print(self.viz.summary(), file=sys.stdout)
        elif self.format == "ascii":
            print(self.viz.ascii(show_status=True, show_timing=True), file=sys.stdout)
        else:
            print(self.viz.summary(), file=sys.stdout)

        sys.stdout.flush()

    def final_report(self) -> str:
        """Generate the final execution report."""
        return self.viz.table() + "\n\n" + self.viz.summary()


def create_progress_callback(
    graph: WorkflowGraph,
    format: str = "summary",
    use_colors: bool = True,
    use_unicode: bool = True,
    clear_screen: bool = False,
) -> tuple[ProgressVisualizer, Any]:
    """
    Create a progress callback function for run_graph.

    Returns a tuple of (visualizer, callback_function).

    Example:
        viz, callback = create_progress_callback(graph)
        result = await run_graph(graph, on_progress=callback)
        print(viz.final_report())
    """
    visualizer = ProgressVisualizer(
        graph,
        format=format,
        use_colors=use_colors,
        use_unicode=use_unicode,
        clear_screen=clear_screen,
    )
    return visualizer, visualizer.update
