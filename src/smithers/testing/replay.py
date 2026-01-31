"""Record/Replay testing infrastructure for deterministic tests.

This module provides the ability to:
1. Record real Claude/tool interactions during integration tests or manual runs
2. Replay those interactions deterministically without network calls
3. Enable fast, deterministic CI/CD tests without API costs

The implementation stores transcripts in SQLite using the existing store infrastructure,
allowing replays to be tied to specific runs for traceability.

Example - Recording:
    from smithers.testing.replay import RecordingLLMProvider, use_recording

    # Record a real run (requires ANTHROPIC_API_KEY)
    async with use_recording("./recordings.db", "my_test_v1") as recorder:
        result = await my_workflow()
        # All Claude calls are recorded to SQLite

Example - Replay:
    from smithers.testing.replay import ReplayLLMProvider, use_replay

    # Replay deterministically (no network calls)
    async with use_replay("./recordings.db", "my_test_v1") as replayer:
        result = await my_workflow()
        # Responses are read from SQLite

Example - Auto mode (record if missing, replay if exists):
    from smithers.testing.replay import use_recording_or_replay

    async with use_recording_or_replay("./recordings.db", "my_test_v1"):
        result = await my_workflow()
        # First run: records. Subsequent runs: replays.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

import aiosqlite
from pydantic import BaseModel, TypeAdapter

T = TypeVar("T", bound=BaseModel)


# Schema for recording storage
_RECORDING_SCHEMA = """
-- recordings: metadata for a recording session
CREATE TABLE IF NOT EXISTS recordings (
    recording_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    description TEXT,
    finished_at TEXT,
    call_count INTEGER DEFAULT 0
);

-- recorded_calls: individual LLM calls in a recording
CREATE TABLE IF NOT EXISTS recorded_calls (
    call_id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id TEXT NOT NULL,
    sequence_num INTEGER NOT NULL,
    call_hash TEXT NOT NULL,
    prompt TEXT NOT NULL,
    output_type_name TEXT NOT NULL,
    output_type_schema TEXT NOT NULL,
    tools_json TEXT,
    system TEXT,
    response_json TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (recording_id) REFERENCES recordings(recording_id)
);

-- indexes for efficient lookup
CREATE INDEX IF NOT EXISTS idx_recorded_calls_recording_id ON recorded_calls(recording_id);
CREATE INDEX IF NOT EXISTS idx_recorded_calls_hash ON recorded_calls(recording_id, call_hash);
CREATE INDEX IF NOT EXISTS idx_recorded_calls_sequence ON recorded_calls(recording_id, sequence_num);
"""


@dataclass
class RecordedCall:
    """A recorded LLM call."""

    call_id: int
    recording_id: str
    sequence_num: int
    call_hash: str
    prompt: str
    output_type_name: str
    output_type_schema: dict[str, Any]
    tools: list[str] | None
    system: str | None
    response: dict[str, Any]
    input_tokens: int | None
    output_tokens: int | None
    recorded_at: datetime | None


@dataclass
class Recording:
    """A recording session."""

    recording_id: str
    created_at: datetime | None
    description: str | None
    finished_at: datetime | None
    call_count: int


class RecordingStore:
    """
    SQLite-based storage for recorded LLM calls.

    This can be a standalone database or can share a database
    with the main SqliteStore for integrated recording during runs.
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
            await db.executescript(_RECORDING_SCHEMA)
            await db.commit()
        self._initialized = True

    async def _ensure_initialized(self) -> None:
        """Ensure the database is initialized."""
        if not self._initialized:
            await self.initialize()

    async def create_recording(
        self,
        recording_id: str,
        description: str | None = None,
    ) -> str:
        """Create a new recording session."""
        await self._ensure_initialized()
        now = datetime.now(UTC).isoformat()

        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                """
                INSERT OR REPLACE INTO recordings (recording_id, created_at, description, call_count)
                VALUES (?, ?, ?, 0)
                """,
                (recording_id, now, description),
            )
            await db.commit()

        return recording_id

    async def finish_recording(self, recording_id: str) -> None:
        """Mark a recording as finished."""
        await self._ensure_initialized()
        now = datetime.now(UTC).isoformat()

        async with self._lock, aiosqlite.connect(self.path) as db:
            # Update call count
            async with db.execute(
                "SELECT COUNT(*) FROM recorded_calls WHERE recording_id = ?",
                (recording_id,),
            ) as cursor:
                row = await cursor.fetchone()
                call_count = row[0] if row else 0

            await db.execute(
                """
                UPDATE recordings
                SET finished_at = ?, call_count = ?
                WHERE recording_id = ?
                """,
                (now, call_count, recording_id),
            )
            await db.commit()

    async def recording_exists(self, recording_id: str) -> bool:
        """Check if a recording exists."""
        await self._ensure_initialized()
        async with (
            self._lock,
            aiosqlite.connect(self.path) as db,
            db.execute(
                "SELECT 1 FROM recordings WHERE recording_id = ?",
                (recording_id,),
            ) as cursor,
        ):
            row = await cursor.fetchone()
            return row is not None

    async def get_recording(self, recording_id: str) -> Recording | None:
        """Get a recording by ID."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM recordings WHERE recording_id = ?",
                (recording_id,),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            return Recording(
                recording_id=row["recording_id"],
                created_at=_parse_timestamp(row["created_at"]),
                description=row["description"],
                finished_at=_parse_timestamp(row["finished_at"]),
                call_count=row["call_count"] or 0,
            )

    async def list_recordings(self, limit: int = 100) -> list[Recording]:
        """List all recordings."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM recordings ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ) as cursor:
                rows = await cursor.fetchall()

        return [
            Recording(
                recording_id=row["recording_id"],
                created_at=_parse_timestamp(row["created_at"]),
                description=row["description"],
                finished_at=_parse_timestamp(row["finished_at"]),
                call_count=row["call_count"] or 0,
            )
            for row in rows
        ]

    async def record_call(
        self,
        recording_id: str,
        prompt: str,
        output_type: type[BaseModel],
        tools: list[str] | None,
        system: str | None,
        response: BaseModel,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
    ) -> int:
        """Record an LLM call."""
        await self._ensure_initialized()
        now = datetime.now(UTC).isoformat()

        # Compute call hash for lookup during replay
        call_hash = _compute_call_hash(prompt, output_type, tools, system)

        # Get next sequence number
        async with self._lock, aiosqlite.connect(self.path) as db:
            async with db.execute(
                "SELECT COALESCE(MAX(sequence_num), -1) + 1 FROM recorded_calls WHERE recording_id = ?",
                (recording_id,),
            ) as cursor:
                row = await cursor.fetchone()
                sequence_num = row[0] if row else 0

            # Serialize the response
            response_json = json.dumps(response.model_dump(), default=str)
            schema_json = json.dumps(output_type.model_json_schema(), default=str)
            tools_json = json.dumps(tools) if tools else None

            cursor = await db.execute(
                """
                INSERT INTO recorded_calls
                    (recording_id, sequence_num, call_hash, prompt, output_type_name,
                     output_type_schema, tools_json, system, response_json,
                     input_tokens, output_tokens, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    recording_id,
                    sequence_num,
                    call_hash,
                    prompt,
                    output_type.__name__,
                    schema_json,
                    tools_json,
                    system,
                    response_json,
                    input_tokens,
                    output_tokens,
                    now,
                ),
            )
            call_id = cursor.lastrowid
            await db.commit()
            return call_id or 0

    async def get_calls(self, recording_id: str) -> list[RecordedCall]:
        """Get all calls for a recording in order."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM recorded_calls
                WHERE recording_id = ?
                ORDER BY sequence_num ASC
                """,
                (recording_id,),
            ) as cursor:
                rows = await cursor.fetchall()

        return [_row_to_recorded_call(row) for row in rows]

    async def get_call_by_hash(
        self,
        recording_id: str,
        call_hash: str,
    ) -> RecordedCall | None:
        """Get a call by its hash (for content-addressed replay)."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM recorded_calls
                WHERE recording_id = ? AND call_hash = ?
                ORDER BY sequence_num ASC
                LIMIT 1
                """,
                (recording_id, call_hash),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None
            return _row_to_recorded_call(row)

    async def get_call_by_sequence(
        self,
        recording_id: str,
        sequence_num: int,
    ) -> RecordedCall | None:
        """Get a call by its sequence number (for sequential replay)."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT * FROM recorded_calls
                WHERE recording_id = ? AND sequence_num = ?
                """,
                (recording_id, sequence_num),
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None
            return _row_to_recorded_call(row)

    async def delete_recording(self, recording_id: str) -> bool:
        """Delete a recording and all its calls."""
        await self._ensure_initialized()
        async with self._lock, aiosqlite.connect(self.path) as db:
            await db.execute(
                "DELETE FROM recorded_calls WHERE recording_id = ?",
                (recording_id,),
            )
            cursor = await db.execute(
                "DELETE FROM recordings WHERE recording_id = ?",
                (recording_id,),
            )
            deleted = cursor.rowcount > 0
            await db.commit()
            return deleted


def _row_to_recorded_call(row: aiosqlite.Row) -> RecordedCall:
    """Convert a database row to a RecordedCall."""
    tools = json.loads(row["tools_json"]) if row["tools_json"] else None
    return RecordedCall(
        call_id=row["call_id"],
        recording_id=row["recording_id"],
        sequence_num=row["sequence_num"],
        call_hash=row["call_hash"],
        prompt=row["prompt"],
        output_type_name=row["output_type_name"],
        output_type_schema=json.loads(row["output_type_schema"]),
        tools=tools,
        system=row["system"],
        response=json.loads(row["response_json"]),
        input_tokens=row["input_tokens"],
        output_tokens=row["output_tokens"],
        recorded_at=_parse_timestamp(row["recorded_at"]),
    )


def _parse_timestamp(value: str | None) -> datetime | None:
    """Parse an ISO timestamp string to datetime."""
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _compute_call_hash(
    prompt: str,
    output_type: type[BaseModel],
    tools: list[str] | None,
    system: str | None,
) -> str:
    """Compute a content-addressed hash for a call."""
    data = {
        "prompt": prompt,
        "output_type": output_type.__name__,
        "output_schema": output_type.model_json_schema(),
        "tools": sorted(tools) if tools else None,
        "system": system,
    }
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


@dataclass
class RecordingLLMProvider:
    """
    LLM provider that records real Claude calls to SQLite.

    This wraps the real Claude API and records all calls for later replay.
    Requires ANTHROPIC_API_KEY to be set.

    Usage:
        store = RecordingStore("./recordings.db")
        await store.initialize()

        recorder = RecordingLLMProvider(store, "test_v1")
        await recorder.start()

        with use_recording_provider(recorder):
            result = await my_workflow()

        await recorder.finish()
    """

    store: RecordingStore
    recording_id: str
    description: str | None = None
    calls: list[RecordedCall] = field(default_factory=list)
    _started: bool = field(default=False, init=False)

    async def start(self) -> None:
        """Start the recording session."""
        await self.store.create_recording(self.recording_id, self.description)
        self._started = True

    async def finish(self) -> None:
        """Finish the recording session."""
        if self._started:
            await self.store.finish_recording(self.recording_id)

    async def next_response(
        self,
        prompt: str,
        output_type: type[T],
        tools: list[str] | None,
        system: str | None,
    ) -> T:
        """
        Call the real Claude API and record the response.

        This method is called by the claude() function when recording is active.
        """
        # Import here to avoid circular imports
        import smithers.testing.fakes as fakes_module
        from smithers.claude import claude as real_claude

        # Temporarily disable fake provider to call real Claude
        old_provider = fakes_module._fake_llm_provider
        fakes_module._fake_llm_provider = None

        try:
            result = await real_claude(
                prompt,
                output=output_type,
                tools=tools,
                system=system,
                track_usage=True,
            )

            # Extract usage info if available
            usage = getattr(result, "_usage", None)
            input_tokens = usage.input_tokens if usage else None
            output_tokens = usage.output_tokens if usage else None

            # Record the call
            call_id = await self.store.record_call(
                self.recording_id,
                prompt,
                output_type,
                tools,
                system,
                result,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )

            # Keep track locally
            recorded = RecordedCall(
                call_id=call_id,
                recording_id=self.recording_id,
                sequence_num=len(self.calls),
                call_hash=_compute_call_hash(prompt, output_type, tools, system),
                prompt=prompt,
                output_type_name=output_type.__name__,
                output_type_schema=output_type.model_json_schema(),
                tools=tools,
                system=system,
                response=result.model_dump(),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                recorded_at=datetime.now(UTC),
            )
            self.calls.append(recorded)

            return result

        finally:
            fakes_module._fake_llm_provider = old_provider


@dataclass
class ReplayLLMProvider:
    """
    LLM provider that replays recorded calls from SQLite.

    This reads transcripts from SQLite and replays responses without
    making any network calls, enabling fast, deterministic tests.

    Supports two replay modes:
    - Sequential: Replays calls in order (default)
    - Content-addressed: Matches calls by content hash (for parallel execution)

    Usage:
        store = RecordingStore("./recordings.db")
        await store.initialize()

        replayer = ReplayLLMProvider(store, "test_v1")
        await replayer.load()

        with use_replay_provider(replayer):
            result = await my_workflow()  # No network calls!
    """

    store: RecordingStore
    recording_id: str
    mode: str = "sequential"  # "sequential" or "content_addressed"
    calls: list[RecordedCall] = field(default_factory=list)
    replayed_calls: list[RecordedCall] = field(default_factory=list)
    _index: int = field(default=0, init=False)
    _loaded: bool = field(default=False, init=False)

    async def load(self) -> None:
        """Load the recording from the store."""
        recording = await self.store.get_recording(self.recording_id)
        if recording is None:
            raise ValueError(f"Recording not found: {self.recording_id}")

        self.calls = await self.store.get_calls(self.recording_id)
        self._loaded = True

    def next_response(
        self,
        prompt: str,
        output_type: type[T],
        tools: list[str] | None,
        system: str | None,
    ) -> T:
        """
        Get the next response from the recording.

        This method is called by the claude() function when replay is active.
        """
        if not self._loaded:
            raise RuntimeError("ReplayLLMProvider not loaded. Call load() first.")

        recorded: RecordedCall | None = None

        if self.mode == "content_addressed":
            # Find by content hash
            call_hash = _compute_call_hash(prompt, output_type, tools, system)
            for call in self.calls:
                if call.call_hash == call_hash and call not in self.replayed_calls:
                    recorded = call
                    break
        else:
            # Sequential mode
            if self._index >= len(self.calls):
                raise RuntimeError(
                    f"ReplayLLMProvider exhausted: expected call for {output_type.__name__}, "
                    f"but recording only has {len(self.calls)} calls"
                )
            recorded = self.calls[self._index]
            self._index += 1

        if recorded is None:
            raise RuntimeError(
                f"No matching recorded call found for {output_type.__name__}. "
                f"Prompt: {prompt[:100]}..."
            )

        # Validate output type matches
        if recorded.output_type_name != output_type.__name__:
            raise RuntimeError(
                f"Output type mismatch: expected {output_type.__name__}, "
                f"but recording has {recorded.output_type_name}"
            )

        self.replayed_calls.append(recorded)

        # Parse and validate the response
        adapter = TypeAdapter(output_type)
        return adapter.validate_python(recorded.response)

    def reset(self) -> None:
        """Reset the replay index for reuse."""
        self._index = 0
        self.replayed_calls.clear()


# Global state for provider injection
_recording_provider: RecordingLLMProvider | None = None
_replay_provider: ReplayLLMProvider | None = None


def get_recording_provider() -> RecordingLLMProvider | None:
    """Get the currently active recording provider."""
    return _recording_provider


def get_replay_provider() -> ReplayLLMProvider | None:
    """Get the currently active replay provider."""
    return _replay_provider


@contextlib.contextmanager
def use_recording_provider(provider: RecordingLLMProvider) -> Iterator[RecordingLLMProvider]:
    """Context manager to use a recording provider.

    Note: Recording requires async operations to call real Claude API.
    Use use_recording() high-level API for recording scenarios.
    """
    global _recording_provider
    old_provider = _recording_provider
    _recording_provider = provider

    try:
        yield provider
    finally:
        _recording_provider = old_provider


@contextlib.contextmanager
def use_replay_provider(provider: ReplayLLMProvider) -> Iterator[ReplayLLMProvider]:
    """Context manager to use a replay provider."""
    global _replay_provider
    import smithers.testing.fakes as fakes_module

    old_provider = _replay_provider
    _replay_provider = provider

    # Set as fake LLM provider so claude() uses it
    old_fake = fakes_module._fake_llm_provider
    fakes_module._fake_llm_provider = provider  # type: ignore

    try:
        yield provider
    finally:
        _replay_provider = old_provider
        fakes_module._fake_llm_provider = old_fake


@contextlib.asynccontextmanager
async def use_replay_provider_async(
    provider: ReplayLLMProvider,
) -> AsyncIterator[ReplayLLMProvider]:
    """Async context manager to use a replay provider."""
    with use_replay_provider(provider):
        yield provider


# High-level convenience APIs


@contextlib.asynccontextmanager
async def use_recording(
    store_path: str | Path,
    recording_id: str,
    *,
    description: str | None = None,
) -> AsyncIterator[RecordingLLMProvider]:
    """
    High-level context manager to record Claude calls.

    Example:
        async with use_recording("./recordings.db", "my_test_v1"):
            result = await my_workflow()
    """
    store = RecordingStore(store_path)
    await store.initialize()

    provider = RecordingLLMProvider(store, recording_id, description)
    await provider.start()

    # We need a special mechanism since recording needs async calls
    # Let's use a hook approach
    global _recording_provider
    old_provider = _recording_provider
    _recording_provider = provider

    try:
        yield provider
    finally:
        _recording_provider = old_provider
        await provider.finish()


@contextlib.asynccontextmanager
async def use_replay(
    store_path: str | Path,
    recording_id: str,
    *,
    mode: str = "sequential",
) -> AsyncIterator[ReplayLLMProvider]:
    """
    High-level context manager to replay recorded Claude calls.

    Example:
        async with use_replay("./recordings.db", "my_test_v1"):
            result = await my_workflow()  # No network calls!

    Args:
        store_path: Path to the SQLite database with recordings
        recording_id: ID of the recording to replay
        mode: "sequential" or "content_addressed"
    """
    store = RecordingStore(store_path)
    await store.initialize()

    provider = ReplayLLMProvider(store, recording_id, mode)
    await provider.load()

    async with use_replay_provider_async(provider):
        yield provider


@contextlib.asynccontextmanager
async def use_recording_or_replay(
    store_path: str | Path,
    recording_id: str,
    *,
    description: str | None = None,
    mode: str = "sequential",
) -> AsyncIterator[RecordingLLMProvider | ReplayLLMProvider]:
    """
    Auto-select recording or replay based on whether recording exists.

    If the recording exists, replay it. Otherwise, record a new one.
    This is useful for tests that should record on first run and replay thereafter.

    Example:
        async with use_recording_or_replay("./recordings.db", "my_test_v1"):
            result = await my_workflow()
            # First run: records. Subsequent runs: replays.
    """
    store = RecordingStore(store_path)
    await store.initialize()

    if await store.recording_exists(recording_id):
        # Replay existing recording
        provider = ReplayLLMProvider(store, recording_id, mode)
        await provider.load()

        async with use_replay_provider_async(provider):
            yield provider
    else:
        # Record new
        async with use_recording(store_path, recording_id, description=description) as provider:
            yield provider
