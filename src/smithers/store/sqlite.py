"""SQLite-based persistent store for execution state.

This module implements the full SqliteStore as described in ARCHITECTURE.md,
providing persistent storage for:
- Cache entries (content-addressed workflow results)
- Runs (plan executions)
- Run nodes (node status within runs)
- Events (append-only log)
- Approvals (human-in-the-loop gates)
- LLM calls (tracking and costs)
- Tool calls (tracking)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import uuid4

import aiosqlite

from smithers.errors import serialize_error

if TYPE_CHECKING:
    from smithers.types import WorkflowGraph


class NodeStatus(str, Enum):
    """Status of a workflow node during execution."""

    PENDING = "PENDING"
    READY = "READY"
    RUNNING = "RUNNING"
    CACHED = "CACHED"
    SUCCESS = "SUCCESS"
    SKIPPED = "SKIPPED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    PAUSED = "PAUSED"


class RunStatus(str, Enum):
    """Status of an execution run."""

    PLANNED = "PLANNED"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    PAUSED = "PAUSED"


@dataclass
class CacheEntry:
    """A cached workflow result."""

    cache_key: str
    workflow_id: str
    code_hash: str
    input_hash: str
    runtime_hash: str
    output_json: str
    output_hash: str
    created_at: datetime
    last_accessed_at: datetime


@dataclass
class Run:
    """An execution run record."""

    run_id: str
    plan_hash: str
    target_node_id: str
    status: RunStatus
    created_at: datetime | None
    finished_at: datetime | None = None


@dataclass
class RunNode:
    """Status of a node within an execution run."""

    run_id: str
    node_id: str
    workflow_id: str
    status: NodeStatus
    started_at: datetime | None = None
    finished_at: datetime | None = None
    cache_key: str | None = None
    output_hash: str | None = None
    skip_reason: str | None = None
    error_json: str | None = None


@dataclass
class Event:
    """An execution event."""

    event_id: int
    run_id: str
    node_id: str | None
    ts: datetime | None
    type: str
    payload: dict[str, Any]


@dataclass
class Approval:
    """A human approval record."""

    run_id: str
    node_id: str
    prompt: str
    status: str
    decided_by: str | None = None
    decided_at: datetime | None = None


@dataclass
class LLMCall:
    """A record of an LLM API call."""

    call_id: int
    run_id: str
    node_id: str
    ts_start: datetime | None
    ts_end: datetime | None
    model: str
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    request_json: str | None
    response_json: str | None


@dataclass
class ToolCall:
    """A record of a tool invocation."""

    tool_call_id: int
    run_id: str
    node_id: str
    ts_start: datetime | None
    ts_end: datetime | None
    tool_name: str
    input_json: str
    output_json: str | None
    status: str
    error_json: str | None


@dataclass
class LoopIteration:
    """A record of a Ralph loop iteration.

    Implements Invariant I7: Ralph loop iterations are individually tracked
    with their own events, timing, and optional caching.
    """

    run_id: str
    loop_node_id: str
    iteration: int
    input_hash: str
    output_hash: str | None
    status: str
    started_at: datetime | None
    finished_at: datetime | None = None
    duration_ms: float | None = None


@dataclass
class SessionEvent:
    """A record of an event in an agent session.

    Session events are append-only logs that track all events
    within agent sessions, enabling session replay and state recovery.
    """

    event_id: int
    session_id: str
    ts: datetime | None
    type: str
    payload_json: str


# SQL schema for all tables
_SCHEMA = """
-- cache entries: content-addressed results
CREATE TABLE IF NOT EXISTS cache_entries (
    cache_key TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    runtime_hash TEXT NOT NULL,
    output_json TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL
);

-- runs: each plan execution
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    plan_hash TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finished_at TEXT
);

-- run_nodes: current status per node within a run
CREATE TABLE IF NOT EXISTS run_nodes (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    cache_key TEXT,
    output_hash TEXT,
    skip_reason TEXT,
    error_json TEXT,
    PRIMARY KEY (run_id, node_id)
);

-- events: append-only log for constant visibility
CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

-- approvals: gates
CREATE TABLE IF NOT EXISTS approvals (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    PRIMARY KEY (run_id, node_id)
);

-- llm_calls: tracking for visibility + cost
CREATE TABLE IF NOT EXISTS llm_calls (
    call_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    ts_start TEXT NOT NULL,
    ts_end TEXT,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    request_json TEXT,
    response_json TEXT
);

-- tool_calls: tracking
CREATE TABLE IF NOT EXISTS tool_calls (
    tool_call_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    ts_start TEXT NOT NULL,
    ts_end TEXT,
    tool_name TEXT NOT NULL,
    input_json TEXT NOT NULL,
    output_json TEXT,
    status TEXT NOT NULL,
    error_json TEXT
);

-- node_outputs: persisted outputs for resumable runs
CREATE TABLE IF NOT EXISTS node_outputs (
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    output_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, node_id)
);

-- loop_iterations: tracking for Ralph loop iterations (Invariant I7)
CREATE TABLE IF NOT EXISTS loop_iterations (
    run_id TEXT NOT NULL,
    loop_node_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    input_hash TEXT NOT NULL,
    output_hash TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms REAL,
    PRIMARY KEY (run_id, loop_node_id, iteration)
);

-- session_events: append-only log for agent session events
CREATE TABLE IF NOT EXISTS session_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

-- indexes for common queries
CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_run_nodes_run_id ON run_nodes(run_id);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run_id ON llm_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX IF NOT EXISTS idx_cache_entries_workflow_id ON cache_entries(workflow_id);
CREATE INDEX IF NOT EXISTS idx_node_outputs_run_id ON node_outputs(run_id);
CREATE INDEX IF NOT EXISTS idx_loop_iterations_run_id ON loop_iterations(run_id);
CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_ts ON session_events(ts);
CREATE INDEX IF NOT EXISTS idx_loop_iterations_loop_node ON loop_iterations(run_id, loop_node_id);
"""


class SqliteStore:
    """
    SQLite-based persistent store for Smithers execution state.

    This is the system of record for all execution state, including:
    - Cached workflow results
    - Execution runs
    - Node statuses
    - Events for observability
    - Human approvals
    - LLM and tool call tracking

    Usage:
        store = SqliteStore("./smithers.db")
        await store.initialize()

        # Create a run
        run_id = await store.create_run(plan_hash="abc123", target_node_id="deploy")

        # Record events
        await store.emit_event(run_id, "RunStarted", {})

        # Update node status
        await store.update_node_status(run_id, "analyze", NodeStatus.RUNNING)
    """

    def __init__(self, path: str | Path) -> None:
        """Initialize the store with a path to the SQLite database."""
        self.path = Path(path)
        self._initialized = False
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize the database schema."""
        if self._initialized:
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.path) as db:
            await db.executescript(_SCHEMA)
            await db.commit()
        self._initialized = True

    async def _ensure_initialized(self) -> None:
        """Ensure the database is initialized."""
        if not self._initialized:
            await self.initialize()

    # ==================== Cache Operations ====================

    async def cache_get(self, cache_key: str) -> Any | None:
        """Get a cached value by key."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT output_json, created_at FROM cache_entries WHERE cache_key = ?",
                (cache_key,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            # Update last accessed time
            await db.execute(
                "UPDATE cache_entries SET last_accessed_at = ? WHERE cache_key = ?",
                (_timestamp_now(), cache_key),
            )
            await db.commit()

            try:
                return json.loads(row["output_json"])
            except json.JSONDecodeError:
                return None

    async def cache_put(
        self,
        cache_key: str,
        value: Any,
        *,
        workflow_id: str,
        code_hash: str,
        input_hash: str,
        runtime_hash: str = "",
        output_hash: str = "",
    ) -> None:
        """Store a value in the cache."""
        await self._ensure_initialized()
        output_json = json.dumps(value, default=str)
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    INSERT OR REPLACE INTO cache_entries
                        (cache_key, workflow_id, code_hash, input_hash, runtime_hash,
                         output_json, output_hash, created_at, last_accessed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                (
                    cache_key,
                    workflow_id,
                    code_hash,
                    input_hash,
                    runtime_hash,
                    output_json,
                    output_hash,
                    now,
                    now,
                ),
            )
            await db.commit()

    async def cache_has(self, cache_key: str) -> bool:
        """Check if a key exists in the cache."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            async with db.execute(
                "SELECT 1 FROM cache_entries WHERE cache_key = ?",
                (cache_key,),
            ) as cursor:
                row = await cursor.fetchone()
            return row is not None

    async def cache_clear(
        self,
        *,
        workflow_id: str | None = None,
        older_than: timedelta | None = None,
    ) -> int:
        """Clear cache entries matching criteria. Returns number deleted."""
        await self._ensure_initialized()
        clauses: list[str] = []
        params: list[Any] = []

        if workflow_id is not None:
            clauses.append("workflow_id = ?")
            params.append(workflow_id)
        if older_than is not None:
            cutoff = datetime.now(UTC) - older_than
            clauses.append("created_at < ?")
            params.append(cutoff.isoformat())

        query = "DELETE FROM cache_entries"
        if clauses:
            query += " WHERE " + " AND ".join(clauses)

        async with self._lock, aiosqlite.connect(self.path) as db:
            cursor = await db.execute(query, params)
            deleted = cursor.rowcount
            await db.commit()
            return deleted

    # ==================== Run Operations ====================

    async def create_run(
        self,
        graph_or_plan_hash: WorkflowGraph | str,
        target_node_id: str | None = None,
        *,
        run_id: str | None = None,
    ) -> str:
        """Create a new execution run.

        Can be called with either:
        - A WorkflowGraph (automatically extracts plan_hash and creates nodes)
        - A plan_hash string and target_node_id (low-level API)

        Returns the run_id.
        """
        await self._ensure_initialized()
        run_id = run_id or str(uuid4())
        now = _timestamp_now()

        # Determine if we were passed a WorkflowGraph or raw values
        from smithers.hashing import hash_json
        from smithers.types import WorkflowGraph as WFGraph

        if isinstance(graph_or_plan_hash, WFGraph):
            graph = graph_or_plan_hash
            plan_hash = hash_json({"root": graph.root, "nodes": list(graph.nodes.keys())})
            target = graph.root
            nodes_to_create = graph.nodes
        else:
            plan_hash = graph_or_plan_hash
            target = target_node_id or ""
            nodes_to_create = {}

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    INSERT INTO runs (run_id, plan_hash, target_node_id, status, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                (run_id, plan_hash, target, RunStatus.PLANNED.value, now),
            )

            # Create run_node entries for each node in the graph
            for node_name in nodes_to_create:
                await db.execute(
                    """
                        INSERT INTO run_nodes (run_id, node_id, workflow_id, status)
                        VALUES (?, ?, ?, ?)
                        """,
                    (run_id, node_name, node_name, NodeStatus.PENDING.value),
                )

            # Emit RunCreated event if we have a graph
            if nodes_to_create:
                payload_json = json.dumps({"target": target, "node_count": len(nodes_to_create)})
                await db.execute(
                    """
                        INSERT INTO events (run_id, node_id, ts, type, payload_json)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                    (run_id, None, now, "RunCreated", payload_json),
                )

            await db.commit()

        return run_id

    async def get_run(self, run_id: str) -> Run | None:
        """Get a run by ID."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM runs WHERE run_id = ?",
                (run_id,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return Run(
                run_id=row["run_id"],
                plan_hash=row["plan_hash"],
                target_node_id=row["target_node_id"],
                status=RunStatus(row["status"]),
                created_at=_parse_timestamp(row["created_at"]),
                finished_at=_parse_timestamp(row["finished_at"]),
            )

    async def update_run_status(
        self,
        run_id: str,
        status: RunStatus,
        *,
        finished: bool = False,
    ) -> None:
        """Update the status of a run."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            if finished:
                await db.execute(
                    "UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?",
                    (status.value, _timestamp_now(), run_id),
                )
            else:
                await db.execute(
                    "UPDATE runs SET status = ? WHERE run_id = ?",
                    (status.value, run_id),
                )
            await db.commit()

    async def list_runs(
        self,
        *,
        status: RunStatus | None = None,
        limit: int = 100,
    ) -> list[Run]:
        """List runs, optionally filtered by status."""
        await self._ensure_initialized()
        query = "SELECT * FROM runs"
        params: list[Any] = []

        if status is not None:
            query += " WHERE status = ?"
            params.append(status.value)

        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            Run(
                run_id=row["run_id"],
                plan_hash=row["plan_hash"],
                target_node_id=row["target_node_id"],
                status=RunStatus(row["status"]),
                created_at=_parse_timestamp(row["created_at"]),
                finished_at=_parse_timestamp(row["finished_at"]),
            )
            for row in rows
        ]

    # ==================== Run Node Operations ====================

    async def create_run_node(
        self,
        run_id: str,
        node_id: str,
        workflow_id: str,
        status: NodeStatus = NodeStatus.PENDING,
    ) -> None:
        """Create a run node record."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    INSERT INTO run_nodes (run_id, node_id, workflow_id, status)
                    VALUES (?, ?, ?, ?)
                    """,
                (run_id, node_id, workflow_id, status.value),
            )
            await db.commit()

    async def update_node_status(
        self,
        run_id: str,
        node_id: str,
        status: NodeStatus,
        *,
        cache_key: str | None = None,
        output_hash: str | None = None,
        skip_reason: str | None = None,
        error: Exception | None = None,
    ) -> None:
        """Update the status of a node within a run."""
        await self._ensure_initialized()
        now = _timestamp_now()

        updates = ["status = ?"]
        params: list[Any] = [status.value]

        if status == NodeStatus.RUNNING:
            updates.append("started_at = ?")
            params.append(now)
        elif status in (
            NodeStatus.SUCCESS,
            NodeStatus.CACHED,
            NodeStatus.FAILED,
            NodeStatus.SKIPPED,
        ):
            updates.append("finished_at = ?")
            params.append(now)

        if cache_key is not None:
            updates.append("cache_key = ?")
            params.append(cache_key)
        if output_hash is not None:
            updates.append("output_hash = ?")
            params.append(output_hash)
        if skip_reason is not None:
            updates.append("skip_reason = ?")
            params.append(skip_reason)
        if error is not None:
            updates.append("error_json = ?")
            params.append(json.dumps(serialize_error(error), default=str))

        params.extend([run_id, node_id])

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                f"UPDATE run_nodes SET {', '.join(updates)} WHERE run_id = ? AND node_id = ?",
                params,
            )
            await db.commit()

    async def get_run_nodes(self, run_id: str) -> list[RunNode]:
        """Get all nodes for a run."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM run_nodes WHERE run_id = ?",
                (run_id,),
            ) as cursor:
                rows = await cursor.fetchall()

        return [
            RunNode(
                run_id=row["run_id"],
                node_id=row["node_id"],
                workflow_id=row["workflow_id"],
                status=NodeStatus(row["status"]),
                started_at=_parse_timestamp(row["started_at"]),
                finished_at=_parse_timestamp(row["finished_at"]),
                cache_key=row["cache_key"],
                output_hash=row["output_hash"],
                skip_reason=row["skip_reason"],
                error_json=row["error_json"],
            )
            for row in rows
        ]

    async def get_nodes(self, run_id: str) -> list[RunNode]:
        """Get all nodes for a run. Alias for get_run_nodes."""
        return await self.get_run_nodes(run_id)

    async def get_node(self, run_id: str, node_id: str) -> RunNode | None:
        """Get a specific node by run_id and node_id."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM run_nodes WHERE run_id = ? AND node_id = ?",
                (run_id, node_id),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return RunNode(
                run_id=row["run_id"],
                node_id=row["node_id"],
                workflow_id=row["workflow_id"],
                status=NodeStatus(row["status"]),
                started_at=_parse_timestamp(row["started_at"]),
                finished_at=_parse_timestamp(row["finished_at"]),
                cache_key=row["cache_key"],
                output_hash=row["output_hash"],
                skip_reason=row["skip_reason"],
                error_json=row["error_json"],
            )

    # ==================== Event Operations ====================

    async def emit_event(
        self,
        run_id: str,
        node_id: str | None,
        event_type: str,
        payload: dict[str, Any],
    ) -> int:
        """Emit an event to the event log. Returns the event_id.

        Args:
            run_id: The run ID
            node_id: The node ID (or None for run-level events)
            event_type: The event type (e.g., "NodeStarted", "RunCreated")
            payload: Event payload data
        """
        await self._ensure_initialized()
        now = _timestamp_now()
        payload_json = json.dumps(payload, default=str)

        async with self._lock, aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                """
                    INSERT INTO events (run_id, node_id, ts, type, payload_json)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                (run_id, node_id, now, event_type, payload_json),
            )
            event_id = cursor.lastrowid
            await db.commit()
            return event_id or 0

    async def get_events(
        self,
        run_id: str,
        *,
        event_type: str | None = None,
        node_id: str | None = None,
        since_id: int | None = None,
        limit: int = 1000,
    ) -> list[Event]:
        """Get events for a run, optionally filtered."""
        await self._ensure_initialized()
        query = "SELECT * FROM events WHERE run_id = ?"
        params: list[Any] = [run_id]

        if event_type is not None:
            query += " AND type = ?"
            params.append(event_type)
        if node_id is not None:
            query += " AND node_id = ?"
            params.append(node_id)
        if since_id is not None:
            query += " AND event_id > ?"
            params.append(since_id)

        query += " ORDER BY event_id ASC LIMIT ?"
        params.append(limit)

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            Event(
                event_id=row["event_id"],
                run_id=row["run_id"],
                node_id=row["node_id"],
                ts=_parse_timestamp(row["ts"]),
                type=row["type"],
                payload=json.loads(row["payload_json"]),
            )
            for row in rows
        ]

    async def tail_events(
        self,
        run_id: str,
        *,
        since_id: int = 0,
        poll_interval: float = 0.5,
    ):
        """Async generator that yields new events as they arrive."""
        last_id = since_id
        while True:
            events = await self.get_events(run_id, since_id=last_id)
            for event in events:
                yield event
                last_id = event.event_id

            # Check if run is finished
            run = await self.get_run(run_id)
            if run and run.status in (
                RunStatus.SUCCESS,
                RunStatus.FAILED,
                RunStatus.CANCELLED,
            ):
                # Yield any remaining events
                events = await self.get_events(run_id, since_id=last_id)
                for event in events:
                    yield event
                break

            await asyncio.sleep(poll_interval)

    # ==================== Session Event Operations ====================

    async def append_session_event(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> int:
        """Append an event to a session's event log. Returns the event_id.

        Args:
            session_id: The session ID
            event_type: The event type (e.g., "assistant.delta", "tool.start")
            payload: Event payload data
        """
        await self._ensure_initialized()
        now = _timestamp_now()
        payload_json = json.dumps(payload, default=str)

        async with self._lock, aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                """
                    INSERT INTO session_events (session_id, ts, type, payload_json)
                    VALUES (?, ?, ?, ?)
                    """,
                (session_id, now, event_type, payload_json),
            )
            event_id = cursor.lastrowid
            await db.commit()
            return event_id or 0

    async def get_session_events(
        self,
        session_id: str,
        *,
        event_type: str | None = None,
        since_id: int | None = None,
        since_ts: datetime | None = None,
        limit: int = 1000,
    ) -> list[SessionEvent]:
        """Get events for a session, optionally filtered.

        Args:
            session_id: The session ID to query
            event_type: Optional filter by event type
            since_id: Optional filter for events after this ID
            since_ts: Optional filter for events after this timestamp
            limit: Maximum number of events to return
        """
        await self._ensure_initialized()
        query = "SELECT * FROM session_events WHERE session_id = ?"
        params: list[Any] = [session_id]

        if event_type is not None:
            query += " AND type = ?"
            params.append(event_type)
        if since_id is not None:
            query += " AND event_id > ?"
            params.append(since_id)
        if since_ts is not None:
            query += " AND ts > ?"
            params.append(since_ts.isoformat())

        query += " ORDER BY event_id ASC LIMIT ?"
        params.append(limit)

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            SessionEvent(
                event_id=row["event_id"],
                session_id=row["session_id"],
                ts=_parse_timestamp(row["ts"]),
                type=row["type"],
                payload_json=row["payload_json"],
            )
            for row in rows
        ]

    async def tail_session_events(
        self,
        session_id: str,
        *,
        since_id: int = 0,
        poll_interval: float = 0.5,
    ):
        """Async generator that yields new session events as they arrive.

        Args:
            session_id: The session ID to tail
            since_id: Start from events after this ID
            poll_interval: How often to poll for new events in seconds
        """
        last_id = since_id
        while True:
            events = await self.get_session_events(session_id, since_id=last_id)
            for event in events:
                yield event
                last_id = event.event_id

            await asyncio.sleep(poll_interval)

    # ==================== Approval Operations ====================

    async def request_approval(
        self,
        run_id: str,
        node_id: str,
        prompt: str,
    ) -> None:
        """Request approval for a node."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    INSERT OR REPLACE INTO approvals (run_id, node_id, prompt, status)
                    VALUES (?, ?, ?, ?)
                    """,
                (run_id, node_id, prompt, "PENDING"),
            )
            await db.commit()

    async def decide_approval(
        self,
        run_id: str,
        node_id: str,
        approved: bool,
        *,
        decided_by: str | None = None,
    ) -> None:
        """Record an approval decision."""
        await self._ensure_initialized()
        status = "APPROVED" if approved else "REJECTED"
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    UPDATE approvals
                    SET status = ?, decided_by = ?, decided_at = ?
                    WHERE run_id = ? AND node_id = ?
                    """,
                (status, decided_by, now, run_id, node_id),
            )
            await db.commit()

    async def get_approval(self, run_id: str, node_id: str) -> Approval | None:
        """Get the approval status for a node."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM approvals WHERE run_id = ? AND node_id = ?",
                (run_id, node_id),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return Approval(
                run_id=row["run_id"],
                node_id=row["node_id"],
                prompt=row["prompt"],
                status=row["status"],
                decided_by=row["decided_by"],
                decided_at=_parse_timestamp(row["decided_at"]),
            )

    async def get_pending_approvals(self, run_id: str | None = None) -> list[Approval]:
        """Get all pending approvals, optionally for a specific run."""
        await self._ensure_initialized()
        query = "SELECT * FROM approvals WHERE status = 'PENDING'"
        params: list[Any] = []

        if run_id is not None:
            query += " AND run_id = ?"
            params.append(run_id)

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            Approval(
                run_id=row["run_id"],
                node_id=row["node_id"],
                prompt=row["prompt"],
                status=row["status"],
                decided_by=row["decided_by"],
                decided_at=_parse_timestamp(row["decided_at"]),
            )
            for row in rows
        ]

    # ==================== LLM Call Tracking ====================

    async def record_llm_call_start(
        self,
        run_id: str,
        node_id: str,
        model: str,
        request: dict[str, Any] | None = None,
        *,
        request_json: str | None = None,
    ) -> int:
        """Record the start of an LLM call. Returns the call_id.

        Args:
            run_id: The run ID
            node_id: The node ID
            model: The LLM model name
            request: Request data as a dict (will be JSON-serialized)
            request_json: Request data as a JSON string (alternative to request)
        """
        await self._ensure_initialized()
        now = _timestamp_now()
        # Use request_json if provided, otherwise serialize request dict
        if request_json is None and request is not None:
            request_json = json.dumps(request, default=str)

        async with self._lock, aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                """
                    INSERT INTO llm_calls (run_id, node_id, ts_start, model, request_json)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                (run_id, node_id, now, model, request_json),
            )
            call_id = cursor.lastrowid
            await db.commit()
            return call_id or 0

    async def record_llm_call_end(
        self,
        call_id: int,
        *,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        cost_usd: float | None = None,
        response: dict[str, Any] | None = None,
        response_json: str | None = None,
    ) -> None:
        """Record the completion of an LLM call.

        Args:
            call_id: The call ID returned by record_llm_call_start
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
            cost_usd: Cost in USD
            response: Response data as a dict (will be JSON-serialized)
            response_json: Response data as a JSON string (alternative to response)
        """
        await self._ensure_initialized()
        now = _timestamp_now()
        # Use response_json if provided, otherwise serialize response dict
        if response_json is None and response is not None:
            response_json = json.dumps(response, default=str)

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    UPDATE llm_calls
                    SET ts_end = ?, input_tokens = ?, output_tokens = ?,
                        cost_usd = ?, response_json = ?
                    WHERE call_id = ?
                    """,
                (now, input_tokens, output_tokens, cost_usd, response_json, call_id),
            )
            await db.commit()

    async def get_llm_calls(self, run_id: str, *, node_id: str | None = None) -> list[LLMCall]:
        """Get LLM calls for a run, optionally filtered by node.

        Args:
            run_id: The run ID
            node_id: Optional node ID to filter by
        """
        await self._ensure_initialized()
        query = "SELECT * FROM llm_calls WHERE run_id = ?"
        params: list[Any] = [run_id]

        if node_id is not None:
            query += " AND node_id = ?"
            params.append(node_id)

        query += " ORDER BY ts_start"

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            LLMCall(
                call_id=row["call_id"],
                run_id=row["run_id"],
                node_id=row["node_id"],
                ts_start=_parse_timestamp(row["ts_start"]),
                ts_end=_parse_timestamp(row["ts_end"]),
                model=row["model"],
                input_tokens=row["input_tokens"],
                output_tokens=row["output_tokens"],
                cost_usd=row["cost_usd"],
                request_json=row["request_json"],
                response_json=row["response_json"],
            )
            for row in rows
        ]

    # ==================== Tool Call Tracking ====================

    async def record_tool_call_start(
        self,
        run_id: str,
        node_id: str,
        tool_name: str,
        input_data: dict[str, Any] | str,
    ) -> int:
        """Record the start of a tool call. Returns the tool_call_id.

        Args:
            run_id: The run ID
            node_id: The node ID
            tool_name: The tool name
            input_data: Input data as a dict (will be JSON-serialized) or a JSON string
        """
        await self._ensure_initialized()
        now = _timestamp_now()
        # Accept either a dict or a pre-serialized JSON string
        if isinstance(input_data, str):
            input_json = input_data
        else:
            input_json = json.dumps(input_data, default=str)

        async with self._lock, aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                """
                    INSERT INTO tool_calls
                        (run_id, node_id, ts_start, tool_name, input_json, status)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                (run_id, node_id, now, tool_name, input_json, "RUNNING"),
            )
            tool_call_id = cursor.lastrowid
            await db.commit()
            return tool_call_id or 0

    async def record_tool_call_end(
        self,
        tool_call_id: int,
        *,
        output: dict[str, Any] | None = None,
        error: Exception | None = None,
        output_json: str | None = None,
        error_json: str | None = None,
    ) -> None:
        """Record the completion of a tool call.

        Args:
            tool_call_id: The tool call ID returned by record_tool_call_start
            output: Output data as a dict (will be JSON-serialized)
            error: Exception if the tool call failed
            output_json: Output data as a JSON string (alternative to output)
            error_json: Error data as a JSON string (alternative to error)
        """
        await self._ensure_initialized()
        now = _timestamp_now()
        # Determine status - error takes precedence over error_json
        status = "FAILED" if (error is not None or error_json is not None) else "SUCCESS"

        # Use output_json if provided, otherwise serialize output dict
        if output_json is None and output is not None:
            output_json = json.dumps(output, default=str)

        # Use error_json if provided, otherwise serialize error
        if error_json is None and error is not None:
            error_json = json.dumps(serialize_error(error), default=str)

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    UPDATE tool_calls
                    SET ts_end = ?, status = ?, output_json = ?, error_json = ?
                    WHERE tool_call_id = ?
                    """,
                (now, status, output_json, error_json, tool_call_id),
            )
            await db.commit()

    async def get_tool_calls(self, run_id: str) -> list[ToolCall]:
        """Get all tool calls for a run."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY ts_start",
                (run_id,),
            ) as cursor:
                rows = await cursor.fetchall()

        return [
            ToolCall(
                tool_call_id=row["tool_call_id"],
                run_id=row["run_id"],
                node_id=row["node_id"],
                ts_start=_parse_timestamp(row["ts_start"]),
                ts_end=_parse_timestamp(row["ts_end"]),
                tool_name=row["tool_name"],
                input_json=row["input_json"],
                output_json=row["output_json"],
                status=row["status"],
                error_json=row["error_json"],
            )
            for row in rows
        ]

    # ==================== Node Output Operations ====================

    async def store_node_output(
        self,
        run_id: str,
        node_id: str,
        output: Any,
    ) -> None:
        """Store the output of a completed node for potential resume.

        Args:
            run_id: The run ID
            node_id: The node ID
            output: The output value (will be JSON-serialized)
        """
        await self._ensure_initialized()
        now = _timestamp_now()
        output_json = json.dumps(output, default=str)

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                    INSERT OR REPLACE INTO node_outputs (run_id, node_id, output_json, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                (run_id, node_id, output_json, now),
            )
            await db.commit()

    async def get_node_output(self, run_id: str, node_id: str) -> Any | None:
        """Get the stored output for a node.

        Args:
            run_id: The run ID
            node_id: The node ID

        Returns:
            The output value, or None if not found
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT output_json FROM node_outputs WHERE run_id = ? AND node_id = ?",
                (run_id, node_id),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            try:
                return json.loads(row["output_json"])
            except json.JSONDecodeError:
                return None

    async def get_all_node_outputs(self, run_id: str) -> dict[str, Any]:
        """Get all stored outputs for a run.

        Args:
            run_id: The run ID

        Returns:
            Dict mapping node_id to output value
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT node_id, output_json FROM node_outputs WHERE run_id = ?",
                (run_id,),
            ) as cursor:
                rows = await cursor.fetchall()

        outputs: dict[str, Any] = {}
        for row in rows:
            with contextlib.suppress(json.JSONDecodeError):
                outputs[row["node_id"]] = json.loads(row["output_json"])
        return outputs

    async def clear_node_outputs(self, run_id: str) -> int:
        """Clear all node outputs for a run.

        Args:
            run_id: The run ID

        Returns:
            Number of entries deleted
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                "DELETE FROM node_outputs WHERE run_id = ?",
                (run_id,),
            )
            deleted = cursor.rowcount
            await db.commit()
            return deleted

    # ==================== Utility Methods ====================

    async def get_run_summary(self, run_id: str) -> dict[str, Any]:
        """Get a summary of a run including stats."""
        run = await self.get_run(run_id)
        if run is None:
            return {}

        nodes = await self.get_run_nodes(run_id)
        llm_calls = await self.get_llm_calls(run_id)
        tool_calls = await self.get_tool_calls(run_id)

        total_tokens = sum((c.input_tokens or 0) + (c.output_tokens or 0) for c in llm_calls)
        total_cost = sum(c.cost_usd or 0 for c in llm_calls)

        node_statuses = {n.node_id: n.status.value for n in nodes}
        success_count = sum(1 for n in nodes if n.status == NodeStatus.SUCCESS)
        cached_count = sum(1 for n in nodes if n.status == NodeStatus.CACHED)
        failed_count = sum(1 for n in nodes if n.status == NodeStatus.FAILED)

        return {
            "run_id": run.run_id,
            "status": run.status.value,
            "created_at": run.created_at.isoformat() if run.created_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "node_count": len(nodes),
            "success_count": success_count,
            "cached_count": cached_count,
            "failed_count": failed_count,
            "llm_call_count": len(llm_calls),
            "tool_call_count": len(tool_calls),
            "total_tokens": total_tokens,
            "total_cost_usd": total_cost,
            "node_statuses": node_statuses,
        }

    async def get_run_stats(self, run_id: str) -> dict[str, Any]:
        """Get statistics for a run.

        Returns:
            A dict with:
            - node_counts: Dict mapping status names to counts
            - input_tokens: Total input tokens from LLM calls
            - output_tokens: Total output tokens from LLM calls
            - tool_counts: Dict mapping tool call status to counts
        """
        await self._ensure_initialized()

        nodes = await self.get_run_nodes(run_id)
        llm_calls = await self.get_llm_calls(run_id)
        tool_calls = await self.get_tool_calls(run_id)

        # Count nodes by status
        node_counts: dict[str, int] = {}
        for node in nodes:
            status = node.status.value
            node_counts[status] = node_counts.get(status, 0) + 1

        # Sum tokens from LLM calls
        input_tokens = sum(c.input_tokens or 0 for c in llm_calls)
        output_tokens = sum(c.output_tokens or 0 for c in llm_calls)

        # Count tool calls by status
        tool_counts: dict[str, int] = {}
        for tool_call in tool_calls:
            status = tool_call.status
            tool_counts[status] = tool_counts.get(status, 0) + 1

        return {
            "node_counts": node_counts,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "tool_counts": tool_counts,
        }

    # ==================== Loop Iteration Operations (Invariant I7) ====================

    async def emit_loop_iteration_started(
        self,
        run_id: str,
        loop_node_id: str,
        iteration: int,
        input_hash: str,
    ) -> None:
        """Record the start of a Ralph loop iteration.

        Args:
            run_id: The run ID
            loop_node_id: The loop node ID
            iteration: The iteration number (0-indexed)
            input_hash: Hash of the input to this iteration
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT OR REPLACE INTO loop_iterations
                    (run_id, loop_node_id, iteration, input_hash, status, started_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (run_id, loop_node_id, iteration, input_hash, "RUNNING", now),
            )
            await db.commit()

        # Also emit an event for visibility
        await self.emit_event(
            run_id,
            loop_node_id,
            "LoopIterationStarted",
            {"iteration": iteration, "input_hash": input_hash},
        )

    async def emit_loop_iteration_finished(
        self,
        run_id: str,
        loop_node_id: str,
        iteration: int,
        output_hash: str,
        *,
        status: str = "SUCCESS",
        error: str | None = None,
    ) -> None:
        """Record the completion of a Ralph loop iteration.

        Args:
            run_id: The run ID
            loop_node_id: The loop node ID
            iteration: The iteration number (0-indexed)
            output_hash: Hash of the output from this iteration
            status: Status of the iteration (SUCCESS or FAILED)
            error: Error message if status is FAILED
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            # Get started_at to calculate duration
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT started_at FROM loop_iterations
                WHERE run_id = ? AND loop_node_id = ? AND iteration = ?
                """,
                (run_id, loop_node_id, iteration),
            ) as cursor:
                row = await cursor.fetchone()

            duration_ms = None
            if row and row["started_at"]:
                started = _parse_timestamp(row["started_at"])
                if started:
                    finished = datetime.fromisoformat(now)
                    if started.tzinfo is None:
                        started = started.replace(tzinfo=UTC)
                    if finished.tzinfo is None:
                        finished = finished.replace(tzinfo=UTC)
                    duration_ms = (finished - started).total_seconds() * 1000

            await db.execute(
                """
                UPDATE loop_iterations
                SET output_hash = ?, status = ?, finished_at = ?, duration_ms = ?
                WHERE run_id = ? AND loop_node_id = ? AND iteration = ?
                """,
                (output_hash, status, now, duration_ms, run_id, loop_node_id, iteration),
            )
            await db.commit()

        # Also emit an event for visibility
        payload: dict[str, Any] = {
            "iteration": iteration,
            "output_hash": output_hash,
            "status": status,
        }
        if duration_ms is not None:
            payload["duration_ms"] = duration_ms
        if error is not None:
            payload["error"] = error

        await self.emit_event(
            run_id,
            loop_node_id,
            "LoopIterationFinished",
            payload,
        )

    async def get_loop_iterations(
        self,
        run_id: str,
        loop_node_id: str | None = None,
    ) -> list[LoopIteration]:
        """Get loop iterations for a run, optionally filtered by loop node.

        Args:
            run_id: The run ID
            loop_node_id: Optional loop node ID to filter by

        Returns:
            List of LoopIteration records
        """
        await self._ensure_initialized()
        query = "SELECT * FROM loop_iterations WHERE run_id = ?"
        params: list[Any] = [run_id]

        if loop_node_id is not None:
            query += " AND loop_node_id = ?"
            params.append(loop_node_id)

        query += " ORDER BY loop_node_id, iteration"

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            LoopIteration(
                run_id=row["run_id"],
                loop_node_id=row["loop_node_id"],
                iteration=row["iteration"],
                input_hash=row["input_hash"],
                output_hash=row["output_hash"],
                status=row["status"],
                started_at=_parse_timestamp(row["started_at"]),
                finished_at=_parse_timestamp(row["finished_at"]),
                duration_ms=row["duration_ms"],
            )
            for row in rows
        ]

    async def get_loop_iteration(
        self,
        run_id: str,
        loop_node_id: str,
        iteration: int,
    ) -> LoopIteration | None:
        """Get a specific loop iteration.

        Args:
            run_id: The run ID
            loop_node_id: The loop node ID
            iteration: The iteration number

        Returns:
            LoopIteration if found, None otherwise
        """
        await self._ensure_initialized()

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM loop_iterations
                WHERE run_id = ? AND loop_node_id = ? AND iteration = ?
                """,
                (run_id, loop_node_id, iteration),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return LoopIteration(
                run_id=row["run_id"],
                loop_node_id=row["loop_node_id"],
                iteration=row["iteration"],
                input_hash=row["input_hash"],
                output_hash=row["output_hash"],
                status=row["status"],
                started_at=_parse_timestamp(row["started_at"]),
                finished_at=_parse_timestamp(row["finished_at"]),
                duration_ms=row["duration_ms"],
            )

    async def get_loop_stats(self, run_id: str) -> dict[str, Any]:
        """Get statistics about loop iterations for a run.

        Returns:
            A dict with:
            - loop_count: Number of loop nodes
            - total_iterations: Total iterations across all loops
            - loops: Dict mapping loop_node_id to iteration counts and status
        """
        iterations = await self.get_loop_iterations(run_id)

        loops: dict[str, dict[str, Any]] = {}
        for it in iterations:
            if it.loop_node_id not in loops:
                loops[it.loop_node_id] = {
                    "iteration_count": 0,
                    "success_count": 0,
                    "failed_count": 0,
                    "total_duration_ms": 0.0,
                }
            loops[it.loop_node_id]["iteration_count"] += 1
            if it.status == "SUCCESS":
                loops[it.loop_node_id]["success_count"] += 1
            elif it.status == "FAILED":
                loops[it.loop_node_id]["failed_count"] += 1
            if it.duration_ms is not None:
                loops[it.loop_node_id]["total_duration_ms"] += it.duration_ms

        return {
            "loop_count": len(loops),
            "total_iterations": len(iterations),
            "loops": loops,
        }


def _timestamp_now() -> str:
    """Get the current UTC timestamp as an ISO string."""
    return datetime.now(UTC).isoformat()


def _parse_timestamp(value: str | None) -> datetime | None:
    """Parse an ISO timestamp string to datetime."""
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None
