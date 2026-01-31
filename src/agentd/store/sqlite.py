"""SQLite-based session storage for agentd.

This module implements persistent storage for agent sessions, following
the event sourcing pattern described in ARCHITECTURE.md.

Key features:
- Append-only event log per session
- Session metadata (workspace, created_at)
- Efficient event retrieval for rebuilding session state
- Migration-ready schema
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiosqlite

from agentd.protocol.events import Event, EventType


@dataclass
class SessionRecord:
    """A session record from the database."""

    id: str
    workspace_root: str
    created_at: datetime
    last_active_at: datetime


@dataclass
class SessionEventRecord:
    """A session event record from the database."""

    id: int
    session_id: str
    ts: datetime
    type: str
    payload: dict[str, Any]


# SQL schema for session tables
_SCHEMA = """
-- sessions: metadata for each session
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_root TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
);

-- session_events: append-only event log
CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- indexes for common queries
CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_ts ON session_events(ts);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at);
"""


class SessionStore:
    """
    SQLite-based persistent store for agent sessions.

    This store implements event sourcing for sessions:
    - Sessions are created with metadata
    - All state changes are recorded as events
    - Session state can be reconstructed by replaying events
    - Events are append-only and immutable

    Usage:
        store = SessionStore("./agentd.db")
        await store.initialize()

        # Create a session
        session_id = await store.create_session("/path/to/workspace")

        # Append events
        await store.append_event(session_id, EventType.RUN_STARTED, {"run_id": "123"})

        # Retrieve events
        events = await store.get_events(session_id)

        # Load all sessions
        sessions = await store.list_sessions()
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
        async with self._connect() as db:
            # Enable foreign key constraints
            await db.execute("PRAGMA foreign_keys = ON")
            await db.executescript(_SCHEMA)
            await db.commit()
        self._initialized = True

    async def _ensure_initialized(self) -> None:
        """Ensure the database is initialized."""
        if not self._initialized:
            await self.initialize()

    @asynccontextmanager
    async def _connect(self) -> AsyncIterator[aiosqlite.Connection]:
        """Create a database connection with foreign keys enabled."""
        async with aiosqlite.connect(self.path) as db:
            await db.execute("PRAGMA foreign_keys = ON")
            yield db

    # ==================== Session Operations ====================

    async def create_session(self, workspace_root: str, *, session_id: str) -> str:
        """Create a new session.

        Args:
            workspace_root: The workspace directory path
            session_id: The session ID to use

        Returns:
            The session ID
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT INTO sessions (id, workspace_root, created_at, last_active_at)
                VALUES (?, ?, ?, ?)
                """,
                (session_id, workspace_root, now, now),
            )
            await db.commit()

            # Emit SESSION_CREATED event
            await self._append_event_internal(
                db,
                session_id,
                EventType.SESSION_CREATED.value,
                {"workspace_root": workspace_root},
                now,
            )
            await db.commit()

        return session_id

    async def get_session(self, session_id: str) -> SessionRecord | None:
        """Get a session by ID.

        Args:
            session_id: The session ID

        Returns:
            SessionRecord if found, None otherwise
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM sessions WHERE id = ?",
                (session_id,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return SessionRecord(
                id=row["id"],
                workspace_root=row["workspace_root"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
                last_active_at=_parse_timestamp(row["last_active_at"]) or datetime.now(UTC),
            )

    async def list_sessions(self, *, limit: int = 100) -> list[SessionRecord]:
        """List all sessions, ordered by most recently active.

        Args:
            limit: Maximum number of sessions to return

        Returns:
            List of SessionRecord objects
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ?",
                (limit,),
            ) as cursor:
                rows = await cursor.fetchall()

        return [
            SessionRecord(
                id=row["id"],
                workspace_root=row["workspace_root"],
                created_at=_parse_timestamp(row["created_at"]) or datetime.now(UTC),
                last_active_at=_parse_timestamp(row["last_active_at"]) or datetime.now(UTC),
            )
            for row in rows
        ]

    async def update_last_active(self, session_id: str) -> None:
        """Update the last_active_at timestamp for a session.

        Args:
            session_id: The session ID
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                "UPDATE sessions SET last_active_at = ? WHERE id = ?",
                (now, session_id),
            )
            await db.commit()

    async def delete_session(self, session_id: str) -> bool:
        """Delete a session and all its events.

        Args:
            session_id: The session ID

        Returns:
            True if the session was deleted, False if it didn't exist
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            cursor = await db.execute(
                "DELETE FROM sessions WHERE id = ?",
                (session_id,),
            )
            deleted = cursor.rowcount > 0
            await db.commit()
            return deleted

    # ==================== Event Operations ====================

    async def append_event(
        self,
        session_id: str,
        event_type: EventType | str,
        payload: dict[str, Any],
    ) -> int:
        """Append an event to the session's event log.

        Args:
            session_id: The session ID
            event_type: The event type (EventType enum or string)
            payload: Event payload data

        Returns:
            The event ID
        """
        await self._ensure_initialized()
        now = _timestamp_now()

        # Convert EventType to string
        type_str = event_type.value if isinstance(event_type, EventType) else event_type

        async with self._lock, aiosqlite.connect(self.path) as db:
            event_id = await self._append_event_internal(db, session_id, type_str, payload, now)
            # Update last_active_at
            await db.execute(
                "UPDATE sessions SET last_active_at = ? WHERE id = ?",
                (now, session_id),
            )
            await db.commit()
            return event_id

    async def _append_event_internal(
        self,
        db: aiosqlite.Connection,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
        timestamp: str,
    ) -> int:
        """Internal method to append an event (used within transactions).

        Args:
            db: Database connection
            session_id: The session ID
            event_type: The event type string
            payload: Event payload data
            timestamp: ISO timestamp string

        Returns:
            The event ID
        """
        payload_json = json.dumps(payload, default=str)
        cursor = await db.execute(
            """
            INSERT INTO session_events (session_id, ts, type, payload_json)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, timestamp, event_type, payload_json),
        )
        return cursor.lastrowid or 0

    async def get_events(
        self,
        session_id: str,
        *,
        event_type: str | None = None,
        since_id: int | None = None,
        limit: int = 10000,
    ) -> list[SessionEventRecord]:
        """Get events for a session, optionally filtered.

        Args:
            session_id: The session ID
            event_type: Optional event type filter
            since_id: Optional - only return events after this ID
            limit: Maximum number of events to return

        Returns:
            List of SessionEventRecord objects
        """
        await self._ensure_initialized()
        query = "SELECT * FROM session_events WHERE session_id = ?"
        params: list[Any] = [session_id]

        if event_type is not None:
            query += " AND type = ?"
            params.append(event_type)
        if since_id is not None:
            query += " AND id > ?"
            params.append(since_id)

        query += " ORDER BY id ASC LIMIT ?"
        params.append(limit)

        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()

        return [
            SessionEventRecord(
                id=row["id"],
                session_id=row["session_id"],
                ts=_parse_timestamp(row["ts"]) or datetime.now(UTC),
                type=row["type"],
                payload=json.loads(row["payload_json"]),
            )
            for row in rows
        ]

    async def get_events_as_protocol_events(
        self,
        session_id: str,
        *,
        event_type: str | None = None,
        since_id: int | None = None,
        limit: int = 10000,
    ) -> list[Event]:
        """Get events as protocol Event objects.

        Args:
            session_id: The session ID
            event_type: Optional event type filter
            since_id: Optional - only return events after this ID
            limit: Maximum number of events to return

        Returns:
            List of Event objects
        """
        records = await self.get_events(
            session_id,
            event_type=event_type,
            since_id=since_id,
            limit=limit,
        )
        return [
            Event(
                type=EventType(record.type) if record.type in EventType.__members__.values() else EventType.ERROR,
                data=record.payload,
                timestamp=record.ts,
            )
            for record in records
        ]

    async def get_event_count(self, session_id: str) -> int:
        """Get the total number of events for a session.

        Args:
            session_id: The session ID

        Returns:
            Number of events
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db, db.execute(
            "SELECT COUNT(*) FROM session_events WHERE session_id = ?",
            (session_id,),
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def get_latest_event_id(self, session_id: str) -> int | None:
        """Get the ID of the most recent event for a session.

        Args:
            session_id: The session ID

        Returns:
            The latest event ID, or None if no events exist
        """
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db, db.execute(
            "SELECT MAX(id) FROM session_events WHERE session_id = ?",
            (session_id,),
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row and row[0] is not None else None

    # ==================== Utility Methods ====================

    async def get_session_stats(self, session_id: str) -> dict[str, Any]:
        """Get statistics for a session.

        Args:
            session_id: The session ID

        Returns:
            Dict with stats including event counts by type
        """
        session = await self.get_session(session_id)
        if session is None:
            return {}

        events = await self.get_events(session_id)

        # Count events by type
        event_counts: dict[str, int] = {}
        for event in events:
            event_counts[event.type] = event_counts.get(event.type, 0) + 1

        return {
            "session_id": session.id,
            "workspace_root": session.workspace_root,
            "created_at": session.created_at.isoformat(),
            "last_active_at": session.last_active_at.isoformat(),
            "total_events": len(events),
            "event_counts": event_counts,
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
