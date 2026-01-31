"""Tests for the session store."""

import asyncio

import pytest

from agentd.protocol.events import EventType
from agentd.store.sqlite import SessionStore


class TestSessionStore:
    """Test the session store."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_initialize_creates_schema(self, tmp_path):
        """Store initialization should create database schema."""
        db_path = tmp_path / "test.db"
        store = SessionStore(db_path)
        await store.initialize()

        assert db_path.exists()

    @pytest.mark.asyncio
    async def test_create_session(self, store):
        """Should create a new session."""
        session_id = await store.create_session("/workspace", session_id="test-session")

        assert session_id == "test-session"

        session = await store.get_session(session_id)
        assert session is not None
        assert session.id == "test-session"
        assert session.workspace_root == "/workspace"
        assert session.created_at is not None
        assert session.last_active_at is not None

    @pytest.mark.asyncio
    async def test_get_nonexistent_session(self, store):
        """Getting a nonexistent session should return None."""
        session = await store.get_session("nonexistent")
        assert session is None

    @pytest.mark.asyncio
    async def test_list_sessions(self, store):
        """Should list all sessions ordered by most recent activity."""
        # Create multiple sessions
        await store.create_session("/workspace1", session_id="session1")
        await store.create_session("/workspace2", session_id="session2")
        await store.create_session("/workspace3", session_id="session3")

        # Update last_active for session1
        await asyncio.sleep(0.01)  # Small delay to ensure different timestamps
        await store.update_last_active("session1")

        sessions = await store.list_sessions()
        assert len(sessions) == 3
        # session1 should be first (most recently active)
        assert sessions[0].id == "session1"

    @pytest.mark.asyncio
    async def test_list_sessions_limit(self, store):
        """Should respect limit parameter."""
        for i in range(5):
            await store.create_session(f"/workspace{i}", session_id=f"session{i}")

        sessions = await store.list_sessions(limit=3)
        assert len(sessions) == 3

    @pytest.mark.asyncio
    async def test_update_last_active(self, store):
        """Should update last_active timestamp."""
        session_id = await store.create_session("/workspace", session_id="test-session")

        session_before = await store.get_session(session_id)
        assert session_before is not None

        await asyncio.sleep(0.01)  # Small delay
        await store.update_last_active(session_id)

        session_after = await store.get_session(session_id)
        assert session_after is not None
        assert session_after.last_active_at > session_before.last_active_at

    @pytest.mark.asyncio
    async def test_delete_session(self, store):
        """Should delete a session."""
        session_id = await store.create_session("/workspace", session_id="test-session")
        await store.append_event(session_id, EventType.RUN_STARTED, {"run_id": "123"})

        deleted = await store.delete_session(session_id)
        assert deleted is True

        session = await store.get_session(session_id)
        assert session is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_session(self, store):
        """Deleting a nonexistent session should return False."""
        deleted = await store.delete_session("nonexistent")
        assert deleted is False


class TestSessionEvents:
    """Test session event operations."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with a session."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        await store.create_session("/workspace", session_id="test-session")
        return store

    @pytest.mark.asyncio
    async def test_append_event(self, store):
        """Should append an event to session log."""
        event_id = await store.append_event(
            "test-session",
            EventType.RUN_STARTED,
            {"run_id": "123"},
        )

        assert event_id > 0

        events = await store.get_events("test-session")
        # Should have SESSION_CREATED (from create_session) + RUN_STARTED
        assert len(events) >= 2
        assert any(e.type == EventType.RUN_STARTED.value for e in events)

    @pytest.mark.asyncio
    async def test_append_event_with_string_type(self, store):
        """Should accept event type as string."""
        event_id = await store.append_event(
            "test-session",
            "custom.event",
            {"data": "test"},
        )

        assert event_id > 0

        events = await store.get_events("test-session", event_type="custom.event")
        assert len(events) == 1
        assert events[0].type == "custom.event"

    @pytest.mark.asyncio
    async def test_get_events(self, store):
        """Should retrieve events for a session."""
        # Append multiple events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        events = await store.get_events("test-session")
        # Should have SESSION_CREATED + 3 events
        assert len(events) >= 4

    @pytest.mark.asyncio
    async def test_get_events_with_type_filter(self, store):
        """Should filter events by type."""
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        events = await store.get_events(
            "test-session",
            event_type=EventType.ASSISTANT_DELTA.value,
        )
        assert len(events) == 1
        assert events[0].type == EventType.ASSISTANT_DELTA.value
        assert events[0].payload["text"] == "Hello"

    @pytest.mark.asyncio
    async def test_get_events_since_id(self, store):
        """Should retrieve events after a specific ID."""
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        first_events = await store.get_events("test-session")
        last_id = first_events[-1].id

        # Add more events
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        new_events = await store.get_events("test-session", since_id=last_id)
        assert len(new_events) == 2

    @pytest.mark.asyncio
    async def test_get_events_with_limit(self, store):
        """Should respect limit parameter."""
        # Add multiple events
        for i in range(10):
            await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": f"msg{i}"})

        events = await store.get_events("test-session", limit=5)
        assert len(events) == 5

    @pytest.mark.asyncio
    async def test_get_events_as_protocol_events(self, store):
        """Should convert events to protocol Event objects."""
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})

        events = await store.get_events_as_protocol_events("test-session")
        assert len(events) >= 2  # SESSION_CREATED + RUN_STARTED

        # Check that they're proper Event objects
        run_started = next(e for e in events if e.type == EventType.RUN_STARTED)
        assert run_started.data["run_id"] == "123"
        assert run_started.timestamp is not None

    @pytest.mark.asyncio
    async def test_get_event_count(self, store):
        """Should count events for a session."""
        count_before = await store.get_event_count("test-session")

        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        count_after = await store.get_event_count("test-session")
        assert count_after == count_before + 2

    @pytest.mark.asyncio
    async def test_get_latest_event_id(self, store):
        """Should get the latest event ID."""
        latest_before = await store.get_latest_event_id("test-session")
        assert latest_before is not None

        event_id = await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})

        latest_after = await store.get_latest_event_id("test-session")
        assert latest_after == event_id
        assert latest_after > latest_before

    @pytest.mark.asyncio
    async def test_get_latest_event_id_empty(self, store, tmp_path):
        """Should return None for session with no events."""
        # Create a new store without any sessions
        empty_store = SessionStore(tmp_path / "empty.db")
        await empty_store.initialize()

        latest = await empty_store.get_latest_event_id("nonexistent")
        assert latest is None

    @pytest.mark.asyncio
    async def test_events_ordered_by_id(self, store):
        """Events should be ordered by ID (chronological)."""
        # Add events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "First"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Second"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        events = await store.get_events("test-session")

        # Verify IDs are ascending
        for i in range(1, len(events)):
            assert events[i].id > events[i - 1].id


class TestSessionStats:
    """Test session statistics."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store with a session and events."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        await store.create_session("/workspace", session_id="test-session")

        # Add some events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.TOOL_START, {"tool": "bash"})
        await store.append_event("test-session", EventType.TOOL_END, {"tool": "bash"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        return store

    @pytest.mark.asyncio
    async def test_get_session_stats(self, store):
        """Should get comprehensive session statistics."""
        stats = await store.get_session_stats("test-session")

        assert stats["session_id"] == "test-session"
        assert stats["workspace_root"] == "/workspace"
        assert "created_at" in stats
        assert "last_active_at" in stats
        assert stats["total_events"] >= 5  # SESSION_CREATED + 5 events

        event_counts = stats["event_counts"]
        assert EventType.SESSION_CREATED.value in event_counts
        assert EventType.RUN_STARTED.value in event_counts
        assert EventType.ASSISTANT_DELTA.value in event_counts
        assert event_counts[EventType.RUN_STARTED.value] == 1
        assert event_counts[EventType.RUN_FINISHED.value] == 1

    @pytest.mark.asyncio
    async def test_get_stats_for_nonexistent_session(self, store):
        """Should return empty dict for nonexistent session."""
        stats = await store.get_session_stats("nonexistent")
        assert stats == {}


class TestConcurrency:
    """Test concurrent operations on the session store."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_concurrent_event_appends(self, store):
        """Should handle concurrent event appends safely."""
        await store.create_session("/workspace", session_id="test-session")

        # Append events concurrently
        tasks = [
            store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": f"msg{i}"})
            for i in range(50)
        ]
        event_ids = await asyncio.gather(*tasks)

        # All event IDs should be unique
        assert len(set(event_ids)) == 50

        # All events should be in the database
        events = await store.get_events("test-session")
        assistant_deltas = [e for e in events if e.type == EventType.ASSISTANT_DELTA.value]
        assert len(assistant_deltas) == 50

    @pytest.mark.asyncio
    async def test_concurrent_session_creation(self, store):
        """Should handle concurrent session creation safely."""
        # Create sessions concurrently
        tasks = [
            store.create_session(f"/workspace{i}", session_id=f"session{i}")
            for i in range(20)
        ]
        session_ids = await asyncio.gather(*tasks)

        # All session IDs should be unique
        assert len(set(session_ids)) == 20

        # All sessions should be in the database
        sessions = await store.list_sessions(limit=100)
        assert len(sessions) == 20


class TestEventSourcing:
    """Test event sourcing patterns."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_event_log_is_append_only(self, store):
        """Events should never be modified or deleted (except with session)."""
        await store.create_session("/workspace", session_id="test-session")

        # Add initial events
        id1 = await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        id2 = await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})

        # Add more events
        id3 = await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        # Original events should still be there with same IDs
        events = await store.get_events("test-session")
        event_ids = [e.id for e in events]

        assert id1 in event_ids
        assert id2 in event_ids
        assert id3 in event_ids

    @pytest.mark.asyncio
    async def test_session_reconstruction_from_events(self, store):
        """Should be able to reconstruct session state from event log."""
        await store.create_session("/workspace", session_id="test-session")

        # Simulate a conversation
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "run1"})
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "Hello"})
        await store.append_event("test-session", EventType.TOOL_START, {"tool": "bash", "args": "ls"})
        await store.append_event("test-session", EventType.TOOL_END, {"tool": "bash", "result": "file1.txt"})
        await store.append_event("test-session", EventType.ASSISTANT_FINAL, {"text": "Done"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "run1"})

        # Retrieve all events
        events = await store.get_events("test-session")

        # Verify we can see the full conversation flow
        event_types = [e.type for e in events]
        assert EventType.SESSION_CREATED.value in event_types
        assert EventType.RUN_STARTED.value in event_types
        assert EventType.ASSISTANT_DELTA.value in event_types
        assert EventType.TOOL_START.value in event_types
        assert EventType.TOOL_END.value in event_types
        assert EventType.RUN_FINISHED.value in event_types

    @pytest.mark.asyncio
    async def test_incremental_event_loading(self, store):
        """Should support incremental event loading for real-time updates."""
        await store.create_session("/workspace", session_id="test-session")

        # Initial events
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        initial_events = await store.get_events("test-session")
        last_id = initial_events[-1].id

        # Add more events
        await store.append_event("test-session", EventType.ASSISTANT_DELTA, {"text": "New"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        # Get only new events
        new_events = await store.get_events("test-session", since_id=last_id)
        assert len(new_events) == 2
        assert all(e.id > last_id for e in new_events)


class TestDatabaseIntegrity:
    """Test database integrity and constraints."""

    @pytest.fixture
    async def store(self, tmp_path):
        """Create a temporary session store."""
        store = SessionStore(tmp_path / "sessions.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_multiple_initializations_safe(self, tmp_path):
        """Multiple initializations should be safe."""
        db_path = tmp_path / "test.db"

        store1 = SessionStore(db_path)
        await store1.initialize()
        await store1.create_session("/workspace1", session_id="session1")

        # Create another store pointing to same DB
        store2 = SessionStore(db_path)
        await store2.initialize()

        # Both should see the same data
        session = await store2.get_session("session1")
        assert session is not None
        assert session.workspace_root == "/workspace1"

    @pytest.mark.asyncio
    async def test_events_reference_session(self, store):
        """Events should reference their session."""
        await store.create_session("/workspace", session_id="test-session")
        await store.append_event("test-session", EventType.RUN_STARTED, {"run_id": "123"})
        await store.append_event("test-session", EventType.RUN_FINISHED, {"run_id": "123"})

        # Verify events exist
        events = await store.get_events("test-session")
        assert len(events) >= 2
        assert all(e.session_id == "test-session" for e in events)
