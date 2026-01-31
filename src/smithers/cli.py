"""Command-line interface for Smithers."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import sys
from datetime import timedelta
from pathlib import Path
from types import ModuleType
from typing import Any

from smithers import SqliteCache, build_graph, run_graph
from smithers.errors import ApprovalRejected, WorkflowError
from smithers.workflow import clear_registry, get_all_workflows


def main() -> int:
    """Main entry point for the CLI."""
    parser = argparse.ArgumentParser(
        prog="smithers",
        description="Build AI agent workflows the way you build software",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Show version and exit",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # run command
    run_parser = subparsers.add_parser("run", help="Run a workflow file")
    run_parser.add_argument("file", help="Path to the workflow file")
    run_parser.add_argument(
        "--cache",
        help="Path to cache database",
        default=None,
    )
    run_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show execution plan without running",
    )
    run_parser.add_argument(
        "--workflow",
        help="Run specific workflow (default: last defined)",
        default=None,
    )

    # graph command
    graph_parser = subparsers.add_parser("graph", help="Visualize workflow graph")
    graph_parser.add_argument("file", help="Path to the workflow file")
    graph_parser.add_argument(
        "--output",
        "-o",
        help="Output file for the graph (default: stdout)",
        default=None,
    )
    graph_parser.add_argument(
        "--format",
        choices=["mermaid", "mermaid-styled", "dot", "json", "ascii", "tree", "table", "summary"],
        default="mermaid",
        help="Output format (ascii/tree/table for terminal viewing)",
    )
    graph_parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored output (for ascii/tree/table formats)",
    )
    graph_parser.add_argument(
        "--no-unicode",
        action="store_true",
        help="Use ASCII-only characters (for ascii/tree/table formats)",
    )
    graph_parser.add_argument(
        "--workflow",
        help="Graph specific workflow (default: last defined)",
        default=None,
    )

    # cache command
    cache_parser = subparsers.add_parser("cache", help="Manage cache")
    cache_sub = cache_parser.add_subparsers(dest="cache_command")
    cache_stats = cache_sub.add_parser("stats", help="Show cache stats")
    cache_stats.add_argument("--cache", required=True, help="Path to cache database")
    cache_clear = cache_sub.add_parser("clear", help="Clear cache")
    cache_clear.add_argument("--cache", required=True, help="Path to cache database")
    cache_clear.add_argument("--workflow", default=None, help="Workflow name to clear")
    cache_clear.add_argument("--older-than", default=None, help="Clear entries older than duration")

    # init command
    init_parser = subparsers.add_parser("init", help="Initialize a Smithers project")
    init_parser.add_argument("path", help="Project directory")

    # watch command - tail events live
    watch_parser = subparsers.add_parser("watch", help="Tail events from a run in real-time")
    watch_parser.add_argument("store", help="Path to SQLite store database")
    watch_parser.add_argument("--run", required=True, help="Run ID to watch")
    watch_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # inspect command - print run/node details
    inspect_parser = subparsers.add_parser("inspect", help="Inspect run or node details")
    inspect_parser.add_argument("store", help="Path to SQLite store database")
    inspect_parser.add_argument("--run", required=True, help="Run ID to inspect")
    inspect_parser.add_argument("--node", default=None, help="Specific node to inspect")
    inspect_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # approve command - approve/reject a pending node
    approve_parser = subparsers.add_parser("approve", help="Approve a pending workflow node")
    approve_parser.add_argument("store", help="Path to SQLite store database")
    approve_parser.add_argument("--run", required=True, help="Run ID")
    approve_parser.add_argument("--node", required=True, help="Node ID to approve")
    approve_parser.add_argument("--yes", "-y", action="store_true", help="Approve the node")
    approve_parser.add_argument("--no", "-n", action="store_true", help="Reject the node")
    approve_parser.add_argument("--user", default=None, help="User making the decision")

    # runs command - list runs
    runs_parser = subparsers.add_parser("runs", help="List execution runs")
    runs_parser.add_argument("store", help="Path to SQLite store database")
    runs_parser.add_argument(
        "--status",
        choices=["PLANNED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED", "PAUSED"],
        default=None,
        help="Filter by status",
    )
    runs_parser.add_argument("--limit", type=int, default=20, help="Maximum runs to show")
    runs_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # resume command - resume a paused run
    resume_parser = subparsers.add_parser("resume", help="Resume a paused workflow run")
    resume_parser.add_argument("store", help="Path to SQLite store database")
    resume_parser.add_argument("--run", required=True, help="Run ID to resume")
    resume_parser.add_argument("file", help="Path to the workflow file")
    resume_parser.add_argument(
        "--workflow",
        help="Target workflow name (default: auto-detect from run)",
        default=None,
    )
    resume_parser.add_argument(
        "--cache",
        help="Path to cache database",
        default=None,
    )

    # stats command - show usage analytics
    stats_parser = subparsers.add_parser("stats", help="Show LLM usage analytics")
    stats_parser.add_argument("store", help="Path to SQLite store database")
    stats_parser.add_argument("--run", default=None, help="Specific run ID to analyze")
    stats_parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of days to include (default: 7)",
    )
    stats_parser.add_argument(
        "--by-node",
        action="store_true",
        help="Include per-node breakdown",
    )
    stats_parser.add_argument(
        "--by-model",
        action="store_true",
        help="Include per-model breakdown",
    )
    stats_parser.add_argument(
        "--recalculate",
        action="store_true",
        help="Recalculate costs using current pricing",
    )
    stats_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # ratelimit command - configure and view rate limits
    ratelimit_parser = subparsers.add_parser("ratelimit", help="Configure and view rate limits")
    ratelimit_sub = ratelimit_parser.add_subparsers(dest="ratelimit_command")

    # ratelimit status
    ratelimit_status_parser = ratelimit_sub.add_parser(
        "status", help="Show current rate limit status"
    )
    ratelimit_status_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # ratelimit configure
    ratelimit_config_parser = ratelimit_sub.add_parser("configure", help="Configure rate limits")
    ratelimit_config_parser.add_argument(
        "--tier",
        type=int,
        choices=[1, 2, 3, 4],
        help="Use Claude API tier preset (1-4)",
    )
    ratelimit_config_parser.add_argument(
        "--rpm",
        type=int,
        help="Requests per minute limit",
    )
    ratelimit_config_parser.add_argument(
        "--rps",
        type=int,
        help="Requests per second limit",
    )
    ratelimit_config_parser.add_argument(
        "--tpm",
        type=int,
        help="Tokens per minute limit",
    )

    # ratelimit reset
    ratelimit_sub.add_parser("reset", help="Reset rate limiter state and statistics")

    # verify command - verify graph, cache, or run state
    verify_parser = subparsers.add_parser("verify", help="Verify system invariants")
    verify_sub = verify_parser.add_subparsers(dest="verify_command")

    # verify graph
    verify_graph_parser = verify_sub.add_parser("graph", help="Verify workflow graph invariants")
    verify_graph_parser.add_argument("file", help="Path to the workflow file")
    verify_graph_parser.add_argument(
        "--workflow",
        help="Verify specific workflow (default: last defined)",
        default=None,
    )
    verify_graph_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # verify cache
    verify_cache_parser = verify_sub.add_parser("cache", help="Verify cache integrity")
    verify_cache_parser.add_argument("--cache", required=True, help="Path to cache database")
    verify_cache_parser.add_argument(
        "--validate-schemas",
        action="store_true",
        help="Validate entries against their schemas",
    )
    verify_cache_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # verify run
    verify_run_parser = verify_sub.add_parser("run", help="Verify run state consistency")
    verify_run_parser.add_argument("store", help="Path to SQLite store database")
    verify_run_parser.add_argument("--run", required=True, help="Run ID to verify")
    verify_run_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # metrics command - Prometheus/OpenTelemetry metrics export
    metrics_parser = subparsers.add_parser("metrics", help="Prometheus/OpenTelemetry metrics")
    metrics_sub = metrics_parser.add_subparsers(dest="metrics_command")

    # metrics serve
    metrics_serve_parser = metrics_sub.add_parser(
        "serve", help="Start metrics HTTP server for Prometheus scraping"
    )
    metrics_serve_parser.add_argument(
        "--host",
        default="0.0.0.0",
        help="Host to bind to (default: 0.0.0.0)",
    )
    metrics_serve_parser.add_argument(
        "--port",
        type=int,
        default=9090,
        help="Port to listen on (default: 9090)",
    )
    metrics_serve_parser.add_argument(
        "--store",
        default=None,
        help="Path to SQLite store database for event integration",
    )

    # metrics export
    metrics_export_parser = metrics_sub.add_parser("export", help="Export metrics")
    metrics_export_parser.add_argument(
        "--format",
        choices=["prometheus", "opentelemetry"],
        default="prometheus",
        help="Output format (default: prometheus)",
    )

    # websocket command - start WebSocket server for real-time updates
    websocket_parser = subparsers.add_parser(
        "websocket", help="WebSocket server for real-time progress updates"
    )
    websocket_sub = websocket_parser.add_subparsers(dest="websocket_command")

    # websocket serve
    websocket_serve_parser = websocket_sub.add_parser("serve", help="Start WebSocket server")
    websocket_serve_parser.add_argument(
        "--host",
        default="localhost",
        help="Host to bind to (default: localhost)",
    )
    websocket_serve_parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port to listen on (default: 8765)",
    )
    websocket_serve_parser.add_argument(
        "--no-heartbeat",
        action="store_true",
        help="Disable heartbeat pings",
    )
    websocket_serve_parser.add_argument(
        "--heartbeat-interval",
        type=float,
        default=30.0,
        help="Heartbeat interval in seconds (default: 30)",
    )

    # websocket status
    websocket_status_parser = websocket_sub.add_parser(
        "status", help="Show WebSocket server status"
    )
    websocket_status_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # compose command - composition utilities
    compose_parser = subparsers.add_parser("compose", help="Workflow composition utilities")
    compose_sub = compose_parser.add_subparsers(dest="compose_command")

    # compose info
    compose_info_parser = compose_sub.add_parser(
        "info", help="Show composition information for a workflow"
    )
    compose_info_parser.add_argument("file", help="Path to the workflow file")
    compose_info_parser.add_argument(
        "--workflow",
        help="Specific workflow to inspect (default: last defined)",
        default=None,
    )
    compose_info_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # compose merge
    compose_merge_parser = compose_sub.add_parser(
        "merge", help="Merge multiple workflow files into a combined graph"
    )
    compose_merge_parser.add_argument("files", nargs="+", help="Paths to workflow files to merge")
    compose_merge_parser.add_argument(
        "--target",
        help="Target workflow name for the merged graph",
        default=None,
    )
    compose_merge_parser.add_argument(
        "--output",
        "-o",
        help="Output file for the merged graph visualization",
        default=None,
    )
    compose_merge_parser.add_argument(
        "--format",
        choices=["mermaid", "json", "ascii"],
        default="mermaid",
        help="Output format",
    )

    # snapshot command - workflow versioning and comparison
    snapshot_parser = subparsers.add_parser(
        "snapshot", help="Workflow snapshot and version comparison"
    )
    snapshot_sub = snapshot_parser.add_subparsers(dest="snapshot_command")

    # snapshot create
    snapshot_create_parser = snapshot_sub.add_parser(
        "create", help="Create a snapshot of a workflow graph"
    )
    snapshot_create_parser.add_argument("file", help="Path to the workflow file")
    snapshot_create_parser.add_argument(
        "--workflow",
        help="Specific workflow to snapshot (default: last defined)",
        default=None,
    )
    snapshot_create_parser.add_argument(
        "--version",
        "-v",
        dest="snapshot_version",
        help="Version string for the snapshot (default: 1.0.0)",
        default="1.0.0",
    )
    snapshot_create_parser.add_argument(
        "--description",
        "-d",
        help="Description of the snapshot",
        default="",
    )
    snapshot_create_parser.add_argument(
        "--output",
        "-o",
        help="Output file for the snapshot (default: stdout)",
        default=None,
    )
    snapshot_create_parser.add_argument(
        "--store",
        help="Directory to store snapshots for versioning",
        default=None,
    )

    # snapshot diff
    snapshot_diff_parser = snapshot_sub.add_parser("diff", help="Compare two workflow snapshots")
    snapshot_diff_parser.add_argument(
        "old",
        help="Path to old snapshot file or version (if --store is used)",
    )
    snapshot_diff_parser.add_argument(
        "new",
        help="Path to new snapshot file or version (if --store is used)",
    )
    snapshot_diff_parser.add_argument(
        "--store",
        help="Directory containing versioned snapshots",
        default=None,
    )
    snapshot_diff_parser.add_argument(
        "--workflow",
        help="Workflow name (required when using --store)",
        default=None,
    )
    snapshot_diff_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )
    snapshot_diff_parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored output",
    )

    # snapshot list
    snapshot_list_parser = snapshot_sub.add_parser("list", help="List available snapshots")
    snapshot_list_parser.add_argument(
        "--store",
        required=True,
        help="Directory containing versioned snapshots",
    )
    snapshot_list_parser.add_argument(
        "--workflow",
        help="Filter by workflow name",
        default=None,
    )
    snapshot_list_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    # snapshot show
    snapshot_show_parser = snapshot_sub.add_parser("show", help="Show details of a snapshot")
    snapshot_show_parser.add_argument(
        "snapshot",
        help="Path to snapshot file or version (if --store is used)",
    )
    snapshot_show_parser.add_argument(
        "--store",
        help="Directory containing versioned snapshots",
        default=None,
    )
    snapshot_show_parser.add_argument(
        "--workflow",
        help="Workflow name (required when using --store)",
        default=None,
    )
    snapshot_show_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format",
    )

    args = parser.parse_args()

    if args.version:
        from smithers import __version__

        print(f"smithers {__version__}")
        return 0

    if args.command is None:
        parser.print_help()
        return 1

    if args.command == "run":
        return _run_workflow(args)
    elif args.command == "graph":
        return _show_graph(args)
    elif args.command == "cache":
        return _cache_command(args)
    elif args.command == "init":
        return _init_project(args)
    elif args.command == "watch":
        return _watch_run(args)
    elif args.command == "inspect":
        return _inspect_run(args)
    elif args.command == "approve":
        return _approve_node(args)
    elif args.command == "runs":
        return _list_runs(args)
    elif args.command == "resume":
        return _resume_run(args)
    elif args.command == "verify":
        return _verify_command(args)
    elif args.command == "stats":
        return _show_stats(args)
    elif args.command == "ratelimit":
        return _ratelimit_command(args)
    elif args.command == "metrics":
        return _metrics_command(args)
    elif args.command == "websocket":
        return _websocket_command(args)
    elif args.command == "compose":
        return _compose_command(args)
    elif args.command == "snapshot":
        return _snapshot_command(args)

    return 0


def _run_workflow(args: argparse.Namespace) -> int:
    """Run a workflow file."""
    _load_module(args.file)
    workflow = _select_workflow(args.workflow)

    graph = build_graph(workflow)
    if args.dry_run:
        print(graph.mermaid())
        return 0

    cache = SqliteCache(args.cache) if args.cache else None
    try:
        asyncio.run(run_graph(graph, cache=cache))
    except ApprovalRejected as exc:
        print(f"Approval rejected for workflow '{exc.workflow_name}'", file=sys.stderr)
        return 3
    except WorkflowError as exc:
        print(f"Workflow '{exc.workflow_name}' failed: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 4
    return 0


def _show_graph(args: argparse.Namespace) -> int:
    """Show workflow graph."""
    from smithers.visualization import visualize_graph

    _load_module(args.file)
    workflow = _select_workflow(args.workflow)
    graph = build_graph(workflow)

    output = ""
    if args.format == "mermaid":
        output = graph.mermaid()
    elif args.format == "mermaid-styled":
        output = visualize_graph(
            graph,
            format="mermaid",
            use_colors=not args.no_color,
            use_unicode=not args.no_unicode,
        )
    elif args.format == "dot":
        output = _graph_to_dot(graph)
    elif args.format == "json":
        output = json.dumps(
            {
                "root": graph.root,
                "nodes": {
                    name: {
                        "dependencies": node.dependencies,
                        "requires_approval": node.requires_approval,
                    }
                    for name, node in graph.nodes.items()
                },
                "edges": graph.edges,
                "levels": graph.levels,
            },
            indent=2,
        )
    elif args.format in ("ascii", "tree", "table", "summary"):
        output = visualize_graph(
            graph,
            format=args.format,
            use_colors=not args.no_color,
            use_unicode=not args.no_unicode,
        )
    else:
        print(f"Unknown format: {args.format}", file=sys.stderr)
        return 1

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
    else:
        print(output)
    return 0


def _cache_command(args: argparse.Namespace) -> int:
    if args.cache_command == "stats":
        cache = SqliteCache(args.cache)
        stats = asyncio.run(cache.stats())
        print("Cache Statistics")
        print("================")
        print(f"Path: {args.cache}")
        print(f"Entries: {stats.entries}")
        print(f"Hits: {stats.hits}")
        print(f"Misses: {stats.misses}")
        size_mb = stats.size_bytes / (1024 * 1024) if stats.size_bytes else 0.0
        print(f"Size: {size_mb:.1f} MB")
        return 0

    if args.cache_command == "clear":
        cache = SqliteCache(args.cache)
        older_than = _parse_duration(args.older_than) if args.older_than else None
        asyncio.run(cache.clear(workflow=args.workflow, older_than=older_than))
        print("Cache cleared")
        return 0

    print("Unknown cache command", file=sys.stderr)
    return 1


def _init_project(args: argparse.Namespace) -> int:
    target = Path(args.path)
    target.mkdir(parents=True, exist_ok=True)
    workflows_dir = target / "workflows"
    workflows_dir.mkdir(parents=True, exist_ok=True)
    example_path = workflows_dir / "example.py"
    if not example_path.exists():
        example_path.write_text(
            _DEFAULT_WORKFLOW,
            encoding="utf-8",
        )
    readme_path = target / "README.md"
    if not readme_path.exists():
        readme_path.write_text("# Smithers Project\n", encoding="utf-8")
    print(f"Initialized Smithers project at {target}")
    return 0


def _load_module(path: str) -> ModuleType:
    clear_registry()
    module_path = Path(path)
    if not module_path.exists():
        raise SystemExit(f"File not found: {path}")
    spec = importlib.util.spec_from_file_location("smithers_workflow", module_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Unable to load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["smithers_workflow"] = module
    spec.loader.exec_module(module)
    return module


def _select_workflow(name: str | None):
    workflows = list(get_all_workflows().values())
    if not workflows:
        raise SystemExit("No workflows found in file")
    if name is None:
        return workflows[-1]
    for wf in workflows:
        if wf.name == name:
            return wf
    raise SystemExit(f"Workflow '{name}' not found")


def _graph_to_dot(graph: Any) -> str:
    lines = ["digraph workflow {"]
    for from_node, to_node in graph.edges:
        lines.append(f'  "{from_node}" -> "{to_node}";')
    lines.append("}")
    return "\n".join(lines)


def _parse_duration(value: str | None) -> timedelta | None:
    if value is None:
        return None
    unit = value[-1]
    try:
        amount = float(value[:-1])
    except ValueError as exc:
        raise SystemExit(f"Invalid duration: {value}") from exc
    if unit == "s":
        return timedelta(seconds=amount)
    if unit == "m":
        return timedelta(minutes=amount)
    if unit == "h":
        return timedelta(hours=amount)
    if unit == "d":
        return timedelta(days=amount)
    raise SystemExit(f"Invalid duration unit: {value}")


def _watch_run(args: argparse.Namespace) -> int:
    """Watch events from a run in real-time."""
    from smithers.store.sqlite import SqliteStore

    store_path = Path(args.store)
    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    store = SqliteStore(store_path)

    async def watch() -> None:
        await store.initialize()
        run = await store.get_run(args.run)
        if run is None:
            print(f"Run not found: {args.run}", file=sys.stderr)
            sys.exit(1)

        print(f"Watching run: {args.run}")
        print(f"Target: {run.target_node_id}")
        print(f"Status: {run.status.value}")
        print("-" * 60)

        async for event in store.tail_events(args.run):
            if args.format == "json":
                event_dict = {
                    "event_id": event.event_id,
                    "run_id": event.run_id,
                    "node_id": event.node_id,
                    "ts": event.ts.isoformat() if event.ts else None,
                    "type": event.type,
                    "payload": event.payload,
                }
                print(json.dumps(event_dict))
            else:
                ts = event.ts.strftime("%H:%M:%S") if event.ts else "??:??:??"
                node = event.node_id or "run"
                payload_str = ""
                if event.payload:
                    # Show key details from payload
                    interesting_keys = ["reason", "error", "duration_ms", "cache_key", "approved"]
                    parts: list[str] = []
                    for key in interesting_keys:
                        if key in event.payload:
                            parts.append(f"{key}={event.payload[key]}")
                    if parts:
                        payload_str = f" ({', '.join(parts)})"
                print(f"[{ts}] {node}: {event.type}{payload_str}")

    try:
        asyncio.run(watch())
    except KeyboardInterrupt:
        print("\nStopped watching.")
    return 0


def _inspect_run(args: argparse.Namespace) -> int:
    """Inspect a run or specific node."""
    from smithers.store.sqlite import SqliteStore

    store_path = Path(args.store)
    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    store = SqliteStore(store_path)

    async def inspect() -> dict[str, Any]:
        await store.initialize()
        run = await store.get_run(args.run)
        if run is None:
            print(f"Run not found: {args.run}", file=sys.stderr)
            sys.exit(1)

        if args.node:
            # Inspect specific node
            node = await store.get_node(args.run, args.node)
            if node is None:
                print(f"Node not found: {args.node}", file=sys.stderr)
                sys.exit(1)

            events = await store.get_events(args.run, node_id=args.node)
            llm_calls = await store.get_llm_calls(args.run, node_id=args.node)

            return {
                "node_id": node.node_id,
                "workflow_id": node.workflow_id,
                "status": node.status.value,
                "started_at": node.started_at.isoformat() if node.started_at else None,
                "finished_at": node.finished_at.isoformat() if node.finished_at else None,
                "cache_key": node.cache_key,
                "output_hash": node.output_hash,
                "skip_reason": node.skip_reason,
                "error": json.loads(node.error_json) if node.error_json else None,
                "event_count": len(events),
                "llm_call_count": len(llm_calls),
            }
        else:
            # Inspect full run
            summary = await store.get_run_summary(args.run)
            nodes = await store.get_run_nodes(args.run)

            return {
                "run_id": run.run_id,
                "plan_hash": run.plan_hash,
                "target": run.target_node_id,
                "status": run.status.value,
                "created_at": run.created_at.isoformat() if run.created_at else None,
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
                "node_count": len(nodes),
                "summary": summary,
                "nodes": [
                    {
                        "node_id": n.node_id,
                        "status": n.status.value,
                        "cache_key": n.cache_key,
                        "skip_reason": n.skip_reason,
                        "error": json.loads(n.error_json) if n.error_json else None,
                    }
                    for n in nodes
                ],
            }

    result = asyncio.run(inspect())

    if args.format == "json":
        print(json.dumps(result, indent=2))
    else:
        if args.node:
            # Node details
            print(f"Node: {result['node_id']}")
            print(f"Workflow: {result['workflow_id']}")
            print(f"Status: {result['status']}")
            if result["started_at"]:
                print(f"Started: {result['started_at']}")
            if result["finished_at"]:
                print(f"Finished: {result['finished_at']}")
            if result["cache_key"]:
                print(f"Cache Key: {result['cache_key']}")
            if result["skip_reason"]:
                print(f"Skip Reason: {result['skip_reason']}")
            if result["error"]:
                print(f"Error: {result['error']}")
            print(f"Events: {result['event_count']}")
            print(f"LLM Calls: {result['llm_call_count']}")
        else:
            # Run details
            print(f"Run: {result['run_id']}")
            print(f"Target: {result['target']}")
            print(f"Status: {result['status']}")
            print(f"Created: {result['created_at']}")
            if result["finished_at"]:
                print(f"Finished: {result['finished_at']}")
            print("-" * 40)
            print(f"{'Node':<30} {'Status':<15}")
            print("-" * 40)
            for node in result["nodes"]:
                status = node["status"]
                if node["skip_reason"]:
                    status = f"{status} ({node['skip_reason']})"
                print(f"{node['node_id']:<30} {status:<15}")

    return 0


def _approve_node(args: argparse.Namespace) -> int:
    """Approve or reject a pending workflow node."""
    from smithers.store.sqlite import SqliteStore

    if not args.yes and not args.no:
        print("Must specify --yes or --no", file=sys.stderr)
        return 1
    if args.yes and args.no:
        print("Cannot specify both --yes and --no", file=sys.stderr)
        return 1

    store_path = Path(args.store)
    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    store = SqliteStore(store_path)
    approved = args.yes

    async def approve() -> None:
        await store.initialize()

        # Check if approval exists and is pending
        approval = await store.get_approval(args.run, args.node)
        if approval is None:
            print(f"No pending approval for node: {args.node}", file=sys.stderr)
            sys.exit(1)
        if approval.status != "PENDING":
            print(f"Approval already decided: {approval.status}", file=sys.stderr)
            sys.exit(1)

        # Record the decision
        await store.decide_approval(
            args.run,
            args.node,
            approved,
            decided_by=args.user,
        )

        # Emit event
        await store.emit_event(
            args.run,
            args.node,
            "ApprovalDecided",
            {"approved": approved, "decided_by": args.user},
        )

    asyncio.run(approve())

    decision = "Approved" if approved else "Rejected"
    print(f"{decision} node '{args.node}' in run '{args.run}'")
    return 0


def _list_runs(args: argparse.Namespace) -> int:
    """List execution runs."""
    from smithers.store.sqlite import RunStatus, SqliteStore

    store_path = Path(args.store)
    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    store = SqliteStore(store_path)

    async def list_runs() -> list[dict[str, Any]]:
        await store.initialize()
        status = RunStatus(args.status) if args.status else None
        runs = await store.list_runs(status=status, limit=args.limit)
        return [
            {
                "run_id": run.run_id,
                "target": run.target_node_id,
                "status": run.status.value,
                "created_at": run.created_at.isoformat() if run.created_at else None,
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            }
            for run in runs
        ]

    runs = asyncio.run(list_runs())

    if args.format == "json":
        print(json.dumps(runs, indent=2))
    else:
        if not runs:
            print("No runs found.")
            return 0

        print(f"{'Run ID':<40} {'Target':<20} {'Status':<12} {'Created':<20}")
        print("-" * 92)
        for run in runs:
            created = run["created_at"][:19] if run["created_at"] else "N/A"
            print(f"{run['run_id']:<40} {run['target']:<20} {run['status']:<12} {created:<20}")

    return 0


def _resume_run(args: argparse.Namespace) -> int:
    """Resume a paused workflow run."""
    from smithers.executor import resume_run
    from smithers.store.sqlite import SqliteStore

    store_path = Path(args.store)
    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    store = SqliteStore(store_path)

    # Load the workflow file
    _load_module(args.file)
    workflow = _select_workflow(args.workflow)

    # Build the graph for the workflow
    graph = build_graph(workflow)

    cache = SqliteCache(args.cache) if args.cache else None

    async def do_resume() -> Any:
        await store.initialize()

        # Check run exists
        run = await store.get_run(args.run)
        if run is None:
            print(f"Run not found: {args.run}", file=sys.stderr)
            sys.exit(1)

        # Check run is paused
        if run.status.value != "PAUSED":
            print(f"Run is not paused (status: {run.status.value})", file=sys.stderr)
            sys.exit(1)

        # Check for pending approvals
        pending_approvals = await store.get_pending_approvals(args.run)
        if pending_approvals:
            print("Cannot resume: pending approvals exist", file=sys.stderr)
            print("Use 'smithers approve' to approve/reject pending nodes:", file=sys.stderr)
            for approval in pending_approvals:
                print(f"  - {approval.node_id}: {approval.prompt}", file=sys.stderr)
            sys.exit(1)

        return await resume_run(args.run, store, graph, cache=cache)

    try:
        result = asyncio.run(do_resume())
        print(f"Run '{args.run}' resumed successfully")
        if result is not None:
            print(f"Result: {result}")
        return 0
    except ApprovalRejected as exc:
        print(f"Approval rejected for workflow '{exc.workflow_name}'", file=sys.stderr)
        return 3
    except WorkflowError as exc:
        print(f"Workflow '{exc.workflow_name}' failed: {exc}", file=sys.stderr)
        return 2
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 4


def _show_stats(args: argparse.Namespace) -> int:
    """Show LLM usage analytics."""
    from datetime import UTC, datetime

    from smithers.analytics import UsageAnalytics
    from smithers.store.sqlite import SqliteStore

    store_path = Path(args.store)
    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    store = SqliteStore(store_path)

    async def get_stats() -> dict[str, Any]:
        await store.initialize()
        analytics = UsageAnalytics(store)

        result: dict[str, Any] = {}

        if args.run:
            # Get stats for a specific run
            summary = await analytics.get_run_summary(
                args.run,
                include_by_node=args.by_node,
                recalculate_costs=args.recalculate,
            )
            result["run_id"] = args.run
            result["summary"] = summary.to_dict()

            if args.by_model:
                model_breakdown = await analytics.get_model_breakdown(args.run)
                result["by_model"] = {k: v.to_dict() for k, v in model_breakdown.items()}
        else:
            # Get stats for the time period
            since = datetime.now(UTC) - timedelta(days=args.days)
            summary = await analytics.get_period_summary(
                since=since,
                recalculate_costs=args.recalculate,
            )
            result["period_days"] = args.days
            result["summary"] = summary.to_dict()

            if args.by_model:
                model_breakdown = await analytics.get_model_breakdown(since=since)
                result["by_model"] = {k: v.to_dict() for k, v in model_breakdown.items()}

        return result

    stats = asyncio.run(get_stats())

    if args.format == "json":
        print(json.dumps(stats, indent=2))
    else:
        _print_stats_text(stats, args)

    return 0


def _print_stats_text(stats: dict[str, Any], args: argparse.Namespace) -> None:
    """Print stats in human-readable text format."""
    print("LLM Usage Statistics")
    print("=" * 50)

    if "run_id" in stats:
        print(f"Run ID: {stats['run_id']}")
    else:
        print(f"Period: Last {stats['period_days']} days")

    summary = stats["summary"]
    print()
    print("Summary")
    print("-" * 30)
    print(f"  Total LLM Calls:    {summary['total_calls']:,}")
    print(f"  Input Tokens:       {summary['total_input_tokens']:,}")
    print(f"  Output Tokens:      {summary['total_output_tokens']:,}")
    print(f"  Total Tokens:       {summary['total_tokens']:,}")
    print(f"  Total Cost:         ${summary['total_cost_usd']:.4f}")

    if summary["total_calls"] > 0:
        print()
        print("  Averages per Call:")
        print(f"    Tokens:           {summary['avg_tokens_per_call']:.1f}")
        print(f"    Cost:             ${summary['avg_cost_per_call']:.6f}")

    if summary.get("models"):
        print()
        print("Models Used")
        print("-" * 30)
        for model, count in sorted(summary["models"].items(), key=lambda x: -x[1]):
            print(f"  {model}: {count} calls")

    if "by_model" in stats:
        print()
        print("Breakdown by Model")
        print("-" * 30)
        for model, model_stats in stats["by_model"].items():
            print(f"\n  {model}")
            print(f"    Calls:     {model_stats['total_calls']:,}")
            print(f"    Tokens:    {model_stats['total_tokens']:,}")
            print(f"    Cost:      ${model_stats['total_cost_usd']:.4f}")

    if summary.get("by_node"):
        print()
        print("Breakdown by Node")
        print("-" * 30)
        for node_id, node_stats in summary["by_node"].items():
            print(f"\n  {node_id}")
            print(f"    Calls:     {node_stats['total_calls']:,}")
            print(f"    Tokens:    {node_stats['total_tokens']:,}")
            print(f"    Cost:      ${node_stats['total_cost_usd']:.4f}")


def _verify_command(args: argparse.Namespace) -> int:
    """Handle verify subcommands."""
    if args.verify_command == "graph":
        return _verify_graph(args)
    elif args.verify_command == "cache":
        return _verify_cache(args)
    elif args.verify_command == "run":
        return _verify_run(args)
    else:
        print("Unknown verify command. Use: graph, cache, or run", file=sys.stderr)
        return 1


def _verify_graph(args: argparse.Namespace) -> int:
    """Verify workflow graph invariants."""
    from smithers.verification import verify_graph as do_verify_graph

    _load_module(args.file)
    workflow = _select_workflow(args.workflow)
    graph = build_graph(workflow)

    result = do_verify_graph(graph)

    if args.format == "json":
        output = {
            "valid": result.valid,
            "stats": result.stats,
            "issues": [
                {
                    "code": issue.code.value,
                    "severity": issue.severity.value,
                    "message": issue.message,
                    "node_id": issue.node_id,
                    "details": issue.details,
                }
                for issue in result.issues
            ],
        }
        print(json.dumps(output, indent=2))
    else:
        print(result.summary())
        if result.issues:
            print("\nIssues:")
            for issue in result.issues:
                node_str = f" [{issue.node_id}]" if issue.node_id else ""
                print(f"  [{issue.severity.value}] {issue.code.value}{node_str}: {issue.message}")

    return 0 if result.valid else 1


def _verify_cache(args: argparse.Namespace) -> int:
    """Verify cache integrity."""
    from smithers.verification import verify_cache_integrity

    cache_path = Path(args.cache)
    if not cache_path.exists():
        print(f"Cache not found: {args.cache}", file=sys.stderr)
        return 1

    cache = SqliteCache(cache_path)

    async def verify() -> list[Any]:
        return await verify_cache_integrity(
            cache,
            validate_schemas=args.validate_schemas,
        )

    results = asyncio.run(verify())

    valid_count = sum(1 for r in results if r.valid)
    invalid_count = sum(1 for r in results if not r.valid)

    if args.format == "json":
        output = {
            "total_entries": len(results),
            "valid_entries": valid_count,
            "invalid_entries": invalid_count,
            "all_valid": invalid_count == 0,
            "entries": [
                {
                    "cache_key": r.cache_key,
                    "valid": r.valid,
                    "computed_hash": r.computed_hash,
                    "issues": [
                        {
                            "code": issue.code.value,
                            "severity": issue.severity.value,
                            "message": issue.message,
                        }
                        for issue in r.issues
                    ],
                }
                for r in results
            ],
        }
        print(json.dumps(output, indent=2))
    else:
        print("Cache Verification")
        print("==================")
        print(f"Path: {args.cache}")
        print(f"Total entries: {len(results)}")
        print(f"Valid entries: {valid_count}")
        print(f"Invalid entries: {invalid_count}")

        if invalid_count > 0:
            print("\nInvalid entries:")
            for r in results:
                if not r.valid:
                    print(f"  - {r.cache_key}")
                    for issue in r.issues:
                        print(f"      [{issue.severity.value}] {issue.message}")

    return 0 if invalid_count == 0 else 1


def _verify_run(args: argparse.Namespace) -> int:
    """Verify run state consistency."""
    from smithers.store.sqlite import SqliteStore
    from smithers.verification import verify_run_state

    store_path = Path(args.store)
    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    store = SqliteStore(store_path)

    async def verify() -> Any:
        await store.initialize()
        return await verify_run_state(store, args.run)

    result = asyncio.run(verify())

    if args.format == "json":
        output = {
            "valid": result.valid,
            "stats": result.stats,
            "issues": [
                {
                    "code": issue.code.value,
                    "severity": issue.severity.value,
                    "message": issue.message,
                    "node_id": issue.node_id,
                    "details": issue.details,
                }
                for issue in result.issues
            ],
        }
        print(json.dumps(output, indent=2))
    else:
        status_str = "PASSED" if result.valid else "FAILED"
        print(f"Run State Verification: {status_str}")
        print(f"  Run ID: {result.stats.get('run_id', 'N/A')}")
        print(f"  Status: {result.stats.get('status', 'N/A')}")
        print(f"  Nodes: {result.stats.get('node_count', 0)}")
        print(f"  Events: {result.stats.get('event_count', 0)}")

        if result.issues:
            print("\nIssues:")
            for issue in result.issues:
                node_str = f" [{issue.node_id}]" if issue.node_id else ""
                print(f"  [{issue.severity.value}] {issue.code.value}{node_str}: {issue.message}")

    return 0 if result.valid else 1


def _ratelimit_command(args: argparse.Namespace) -> int:
    """Handle ratelimit subcommands."""
    if args.ratelimit_command == "status":
        return _ratelimit_status(args)
    elif args.ratelimit_command == "configure":
        return _ratelimit_configure(args)
    elif args.ratelimit_command == "reset":
        return _ratelimit_reset(args)
    else:
        print("Unknown ratelimit command. Use: status, configure, or reset", file=sys.stderr)
        return 1


def _ratelimit_status(args: argparse.Namespace) -> int:
    """Show current rate limit status."""
    from smithers.ratelimit import get_rate_limiter

    limiter = get_rate_limiter()

    if limiter is None:
        if args.format == "json":
            print(json.dumps({"configured": False}))
        else:
            print("Rate Limiting Status")
            print("=" * 40)
            print("Status: Not configured")
            print()
            print("To configure rate limits:")
            print("  smithers ratelimit configure --tier 1")
            print("  smithers ratelimit configure --rpm 60 --tpm 100000")
        return 0

    stats = limiter.get_stats()
    capacity = limiter.remaining_capacity()

    if args.format == "json":
        output = {
            "configured": True,
            "config": {
                "requests_per_minute": limiter.config.requests_per_minute,
                "requests_per_second": limiter.config.requests_per_second,
                "tokens_per_minute": limiter.config.tokens_per_minute,
                "strategy": limiter.config.strategy.value,
                "on_exceeded": limiter.config.on_exceeded.value,
            },
            "stats": stats.to_dict(),
            "remaining_capacity": capacity,
        }
        print(json.dumps(output, indent=2))
    else:
        print("Rate Limiting Status")
        print("=" * 40)
        print("Status: Configured")
        print()
        print("Configuration")
        print("-" * 30)
        if limiter.config.requests_per_minute is not None:
            print(f"  RPM Limit:    {limiter.config.requests_per_minute}")
        if limiter.config.requests_per_second is not None:
            print(f"  RPS Limit:    {limiter.config.requests_per_second}")
        if limiter.config.tokens_per_minute is not None:
            print(f"  TPM Limit:    {limiter.config.tokens_per_minute:,}")
        print(f"  Strategy:     {limiter.config.strategy.value}")
        print(f"  On Exceeded:  {limiter.config.on_exceeded.value}")
        print()
        print("Current Usage")
        print("-" * 30)
        print(f"  Requests in Window:  {stats.requests_in_window}")
        print(f"  Tokens in Window:    {stats.tokens_in_window:,}")
        if stats.rpm_utilization is not None:
            print(f"  RPM Utilization:     {stats.rpm_utilization:.1f}%")
        if stats.rps_utilization is not None:
            print(f"  RPS Utilization:     {stats.rps_utilization:.1f}%")
        if stats.tpm_utilization is not None:
            print(f"  TPM Utilization:     {stats.tpm_utilization:.1f}%")
        print()
        print("Totals")
        print("-" * 30)
        print(f"  Total Requests:      {stats.total_requests:,}")
        print(f"  Total Tokens:        {stats.total_tokens:,}")
        print(f"  Total Waits:         {stats.total_waits}")
        print(f"  Total Wait Time:     {stats.total_wait_time_ms:.1f}ms")
        print()
        print("Remaining Capacity")
        print("-" * 30)
        for key, value in capacity.items():
            if value is not None:
                label = key.replace("_", " ").title()
                print(f"  {label}: {value:,}")

    return 0


def _ratelimit_configure(args: argparse.Namespace) -> int:
    """Configure rate limits."""
    from smithers.ratelimit import (
        configure_claude_rate_limits,
        create_rate_limiter,
        set_rate_limiter,
    )

    if args.tier is not None:
        limiter = configure_claude_rate_limits(tier=args.tier)
        print(f"Configured rate limits for Claude API tier {args.tier}")
        print(f"  RPM: {limiter.config.requests_per_minute}")
        print(f"  TPM: {limiter.config.tokens_per_minute:,}")
        return 0

    if args.rpm is None and args.rps is None and args.tpm is None:
        print("Must specify --tier or at least one of --rpm, --rps, --tpm", file=sys.stderr)
        return 1

    limiter = create_rate_limiter(
        rpm=args.rpm,
        rps=args.rps,
        tpm=args.tpm,
    )
    set_rate_limiter(limiter)

    print("Configured custom rate limits:")
    if args.rpm is not None:
        print(f"  RPM: {args.rpm}")
    if args.rps is not None:
        print(f"  RPS: {args.rps}")
    if args.tpm is not None:
        print(f"  TPM: {args.tpm:,}")

    return 0


def _ratelimit_reset(args: argparse.Namespace) -> int:
    """Reset rate limiter state."""
    from smithers.ratelimit import get_rate_limiter

    limiter = get_rate_limiter()

    if limiter is None:
        print("No rate limiter configured")
        return 0

    limiter.reset()
    print("Rate limiter state reset")

    return 0


def _metrics_command(args: argparse.Namespace) -> int:
    """Handle metrics subcommands."""
    if args.metrics_command == "serve":
        return _metrics_serve(args)
    elif args.metrics_command == "export":
        return _metrics_export(args)
    else:
        print("Unknown metrics command. Use: serve or export", file=sys.stderr)
        return 1


def _metrics_serve(args: argparse.Namespace) -> int:
    """Start a metrics server for Prometheus scraping."""
    from smithers.metrics import get_metrics_collector

    collector = get_metrics_collector()

    # Attach to event bus if a store is provided
    if args.store:
        from smithers.events import get_event_bus

        collector.attach_to_event_bus(get_event_bus())

    print(f"Starting metrics server on http://{args.host}:{args.port}/metrics")
    print("Press Ctrl+C to stop")

    try:
        server = collector.start_server(host=args.host, port=args.port, daemon=False)
        # The server runs in the main thread when daemon=False is passed
        # But start_server starts a daemon thread, so we need to wait
        import time

        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping metrics server")
        collector.stop_server()
    return 0


def _metrics_export(args: argparse.Namespace) -> int:
    """Export metrics in the specified format."""
    from smithers.metrics import get_metrics_collector

    collector = get_metrics_collector()

    if args.format == "prometheus":
        print(collector.export_prometheus())
    elif args.format == "opentelemetry":
        import json

        print(json.dumps(collector.export_opentelemetry(), indent=2))
    else:
        print(f"Unknown format: {args.format}", file=sys.stderr)
        return 1

    return 0


def _websocket_command(args: argparse.Namespace) -> int:
    """Handle websocket subcommands."""
    if args.websocket_command == "serve":
        return _websocket_serve(args)
    elif args.websocket_command == "status":
        return _websocket_status(args)
    else:
        print("Unknown websocket command. Use: serve or status", file=sys.stderr)
        return 1


def _websocket_serve(args: argparse.Namespace) -> int:
    """Start the WebSocket server for real-time progress updates."""
    try:
        from smithers.websocket import WebSocketServer, get_websocket_server
    except ImportError:
        print("WebSocket support requires the 'websockets' package.", file=sys.stderr)
        print("Install it with: pip install smithers[websocket]", file=sys.stderr)
        return 1

    heartbeat = 0 if args.no_heartbeat else args.heartbeat_interval
    server = WebSocketServer(auto_subscribe=True, heartbeat_interval=heartbeat)

    print(f"Starting WebSocket server on ws://{args.host}:{args.port}")
    print("Press Ctrl+C to stop")
    print()
    print("Clients can connect and subscribe to workflow events.")
    print("Events from the global EventBus will be broadcast to all connected clients.")

    async def run_server() -> None:
        try:
            await server.start(host=args.host, port=args.port)
            # Keep the server running
            while server.is_running:
                await asyncio.sleep(1)
                if server.client_count > 0:
                    pass  # Server is serving clients
        except KeyboardInterrupt:
            pass
        finally:
            await server.stop()

    try:
        asyncio.run(run_server())
    except KeyboardInterrupt:
        print("\nStopping WebSocket server")

    return 0


def _websocket_status(args: argparse.Namespace) -> int:
    """Show WebSocket server status."""
    from smithers.websocket import get_websocket_server

    server = get_websocket_server()

    if args.format == "json":
        output = {
            "running": server.is_running,
            "client_count": server.client_count,
            "stats": {
                "total_connections": server.stats.total_connections,
                "active_connections": server.stats.active_connections,
                "messages_sent": server.stats.messages_sent,
                "messages_received": server.stats.messages_received,
                "events_broadcast": server.stats.events_broadcast,
                "errors": server.stats.errors,
            },
        }
        print(json.dumps(output, indent=2))
    else:
        print("WebSocket Server Status")
        print("=" * 40)
        print(f"Running: {server.is_running}")
        print(f"Connected Clients: {server.client_count}")
        print()
        print("Statistics")
        print("-" * 30)
        print(f"  Total Connections:   {server.stats.total_connections}")
        print(f"  Active Connections:  {server.stats.active_connections}")
        print(f"  Messages Sent:       {server.stats.messages_sent}")
        print(f"  Messages Received:   {server.stats.messages_received}")
        print(f"  Events Broadcast:    {server.stats.events_broadcast}")
        print(f"  Errors:              {server.stats.errors}")

    return 0


def _compose_command(args: argparse.Namespace) -> int:
    """Handle compose subcommands."""
    if args.compose_command == "info":
        return _compose_info(args)
    elif args.compose_command == "merge":
        return _compose_merge(args)
    else:
        print("Unknown compose command. Use: info or merge", file=sys.stderr)
        return 1


def _compose_info(args: argparse.Namespace) -> int:
    """Show composition information for a workflow."""
    from smithers.composition import get_composition_info

    _load_module(args.file)
    workflow = _select_workflow(args.workflow)

    info = get_composition_info(workflow)

    if args.format == "json":
        print(json.dumps(info, indent=2))
    else:
        print("Workflow Composition Info")
        print("=" * 40)
        print(f"Name: {info['name']}")
        print(f"Composed: {info['is_composed']}")
        if info["composition_type"]:
            print(f"Type: {info['composition_type']}")
        if info["components"]:
            print(f"Components: {', '.join(info['components'])}")

        # Additional workflow details
        print()
        print("Workflow Details")
        print("-" * 30)
        print(f"Output Type: {workflow.output_type.__name__}")
        if workflow.input_types:
            print(
                f"Input Types: {', '.join(f'{k}: {v.__name__}' for k, v in workflow.input_types.items())}"
            )
        if workflow.bound_args:
            print(f"Bound Arguments: {list(workflow.bound_args.keys())}")
        if workflow.bound_deps:
            print(f"Bound Dependencies: {list(workflow.bound_deps.keys())}")

    return 0


def _compose_merge(args: argparse.Namespace) -> int:
    """Merge multiple workflow files into a combined graph."""
    from smithers.composition import compose_graphs
    from smithers.visualization import visualize_graph

    graphs = []
    all_workflows = []

    for file_path in args.files:
        _load_module(file_path)
        workflows = list(get_all_workflows().values())
        if workflows:
            all_workflows.extend(workflows)
            # Build graph from last workflow in each file
            graph = build_graph(workflows[-1])
            graphs.append(graph)
        clear_registry()

    if not graphs:
        print("No workflows found in provided files", file=sys.stderr)
        return 1

    try:
        merged = compose_graphs(*graphs, target=args.target)
    except Exception as exc:
        print(f"Error merging graphs: {exc}", file=sys.stderr)
        return 1

    output = ""
    if args.format == "mermaid":
        output = merged.mermaid()
    elif args.format == "ascii":
        output = visualize_graph(merged, format="ascii")
    elif args.format == "json":
        output = json.dumps(
            {
                "root": merged.root,
                "nodes": {
                    name: {
                        "dependencies": node.dependencies,
                        "requires_approval": node.requires_approval,
                    }
                    for name, node in merged.nodes.items()
                },
                "edges": merged.edges,
                "levels": merged.levels,
            },
            indent=2,
        )

    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"Merged graph written to {args.output}")
    else:
        print(output)

    return 0


def _snapshot_command(args: argparse.Namespace) -> int:
    """Handle snapshot subcommands."""
    if args.snapshot_command == "create":
        return _snapshot_create(args)
    elif args.snapshot_command == "diff":
        return _snapshot_diff(args)
    elif args.snapshot_command == "list":
        return _snapshot_list(args)
    elif args.snapshot_command == "show":
        return _snapshot_show(args)
    else:
        print("Unknown snapshot command. Use: create, diff, list, or show", file=sys.stderr)
        return 1


def _snapshot_create(args: argparse.Namespace) -> int:
    """Create a snapshot of a workflow graph."""
    from smithers.snapshot import SnapshotStore, create_snapshot

    _load_module(args.file)
    workflow = _select_workflow(args.workflow)
    graph = build_graph(workflow)

    snapshot = create_snapshot(
        graph,
        name=workflow.name,
        version=args.snapshot_version,
        description=args.description,
    )

    if args.store:
        store = SnapshotStore(args.store)
        path = store.save(snapshot)
        print(f"Snapshot saved to: {path}")
        print(f"  Name: {snapshot.name}")
        print(f"  Version: {snapshot.version}")
        print(f"  Nodes: {snapshot.node_count}")
        print(f"  Edges: {snapshot.edge_count}")
        print(f"  Hash: {snapshot.content_hash[:12]}...")
        return 0

    output = snapshot.to_json()
    if args.output:
        Path(args.output).write_text(output, encoding="utf-8")
        print(f"Snapshot written to: {args.output}")
    else:
        print(output)

    return 0


def _snapshot_diff(args: argparse.Namespace) -> int:
    """Compare two workflow snapshots."""
    from smithers.snapshot import (
        SnapshotStore,
        diff_snapshots,
        snapshot_from_json_file,
    )

    if args.store:
        # Load from versioned store
        if not args.workflow:
            print("--workflow is required when using --store", file=sys.stderr)
            return 1

        store = SnapshotStore(args.store)
        old_snapshot = store.load(args.workflow, args.old)
        new_snapshot = store.load(args.workflow, args.new)

        if old_snapshot is None:
            print(f"Snapshot not found: {args.workflow} v{args.old}", file=sys.stderr)
            return 1
        if new_snapshot is None:
            print(f"Snapshot not found: {args.workflow} v{args.new}", file=sys.stderr)
            return 1
    else:
        # Load from files
        old_path = Path(args.old)
        new_path = Path(args.new)

        if not old_path.exists():
            print(f"Snapshot file not found: {args.old}", file=sys.stderr)
            return 1
        if not new_path.exists():
            print(f"Snapshot file not found: {args.new}", file=sys.stderr)
            return 1

        old_snapshot = snapshot_from_json_file(args.old)
        new_snapshot = snapshot_from_json_file(args.new)

    diff = diff_snapshots(old_snapshot, new_snapshot)

    if args.format == "json":
        print(diff.to_json())
    else:
        print(diff.summary(use_colors=not args.no_color))

    return 0 if not diff.has_breaking_changes else 1


def _snapshot_list(args: argparse.Namespace) -> int:
    """List available snapshots."""
    from smithers.snapshot import SnapshotStore

    store = SnapshotStore(args.store)
    store_path = Path(args.store)

    if not store_path.exists():
        print(f"Store not found: {args.store}", file=sys.stderr)
        return 1

    # Find all workflows with snapshots
    workflows: dict[str, list[str]] = {}
    for filename in store_path.iterdir():
        if filename.suffix == ".json":
            # Parse name_version.json
            name_parts = filename.stem.rsplit("_", 1)
            if len(name_parts) == 2:
                wf_name, version = name_parts
                if args.workflow is None or wf_name == args.workflow:
                    if wf_name not in workflows:
                        workflows[wf_name] = []
                    workflows[wf_name].append(version)

    if args.format == "json":
        output = {
            "store": args.store,
            "workflows": {name: sorted(versions) for name, versions in sorted(workflows.items())},
        }
        print(json.dumps(output, indent=2))
    else:
        if not workflows:
            print("No snapshots found.")
            return 0

        print("Workflow Snapshots")
        print("=" * 50)
        print(f"Store: {args.store}")
        print()

        for name, versions in sorted(workflows.items()):
            print(f"{name}:")
            for version in sorted(versions):
                print(f"  - {version}")

    return 0


def _snapshot_show(args: argparse.Namespace) -> int:
    """Show details of a snapshot."""
    from smithers.snapshot import SnapshotStore, snapshot_from_json_file

    if args.store:
        if not args.workflow:
            print("--workflow is required when using --store", file=sys.stderr)
            return 1

        store = SnapshotStore(args.store)
        snapshot = store.load(args.workflow, args.snapshot)

        if snapshot is None:
            print(f"Snapshot not found: {args.workflow} v{args.snapshot}", file=sys.stderr)
            return 1
    else:
        snapshot_path = Path(args.snapshot)
        if not snapshot_path.exists():
            print(f"Snapshot file not found: {args.snapshot}", file=sys.stderr)
            return 1

        snapshot = snapshot_from_json_file(args.snapshot)

    if args.format == "json":
        print(snapshot.to_json())
    else:
        print("Workflow Snapshot")
        print("=" * 50)
        print(f"Name:        {snapshot.name}")
        print(f"Version:     {snapshot.version}")
        print(f"Created:     {snapshot.created_at.isoformat()}")
        print(f"Description: {snapshot.description or '(none)'}")
        print(f"Root:        {snapshot.root}")
        print(f"Content Hash: {snapshot.content_hash}")
        print()
        print("Statistics")
        print("-" * 30)
        print(f"  Nodes:  {snapshot.node_count}")
        print(f"  Edges:  {snapshot.edge_count}")
        print(f"  Levels: {snapshot.level_count}")
        print()
        print("Nodes")
        print("-" * 30)
        for node in snapshot.nodes:
            deps = f" <- [{', '.join(node.dependencies)}]" if node.dependencies else ""
            approval = " [requires approval]" if node.requires_approval else ""
            print(f"  {node.name}: {node.output_type_name}{deps}{approval}")
        print()
        print("Execution Levels")
        print("-" * 30)
        for i, level in enumerate(snapshot.levels):
            print(f"  Level {i}: {', '.join(level)}")

        if snapshot.metadata:
            print()
            print("Metadata")
            print("-" * 30)
            for key, value in snapshot.metadata.items():
                print(f"  {key}: {value}")

    return 0


_DEFAULT_WORKFLOW = """from pydantic import BaseModel
from smithers import workflow, claude, build_graph, run_graph


class ExampleOutput(BaseModel):
    message: str


@workflow
async def example() -> ExampleOutput:
    return await claude("Say hello from Smithers", output=ExampleOutput)


async def main():
    graph = build_graph(example)
    result = await run_graph(graph)
    print(result.message)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
"""


if __name__ == "__main__":
    sys.exit(main())
