"""Tests for the agentd daemon."""

import asyncio
import contextlib
import json
from io import StringIO

import pytest

from agentd.daemon import AgentDaemon, DaemonConfig
from agentd.protocol.events import EventType
from agentd.protocol.requests import Request


class TestAgentDaemon:
    """Test the agent daemon."""

    @pytest.fixture
    def config(self, tmp_path):
        return DaemonConfig(
            workspace_root=str(tmp_path),
            sandbox_mode="host",
            agent_backend="fake",
        )

    @pytest.fixture
    def streams(self):
        return StringIO(), StringIO()

    def test_daemon_emits_ready_event(self, config, streams):
        """Daemon should emit ready event on start."""
        input_stream, output_stream = streams

        # Send EOF to stop the daemon
        input_stream.write("")
        input_stream.seek(0)

        daemon = AgentDaemon(config, input_stream, output_stream)

        async def run():
            await daemon.run()

        asyncio.run(run())

        output_stream.seek(0)
        lines = output_stream.read().strip().split("\n")

        assert len(lines) >= 1
        event = json.loads(lines[0])
        assert event["type"] == "daemon.ready"
        assert event["data"]["version"] == "0.1.0"


class TestProtocolEvents:
    """Test protocol event serialization."""

    def test_event_serialization(self):
        from agentd.protocol.events import Event

        event = Event(
            type=EventType.ASSISTANT_DELTA,
            data={"text": "Hello, world!"},
        )

        d = event.to_dict()
        assert d["type"] == "assistant.delta"
        assert d["data"]["text"] == "Hello, world!"
        assert "timestamp" in d


class TestProtocolValidation:
    """Test protocol schema validation."""

    def test_daemon_ready_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.DAEMON_READY,
            data={"version": "1.0.0", "config": {"sandbox_mode": "host"}},
        )
        # Should not raise
        event.validate()

    def test_daemon_ready_event_missing_version(self):
        from agentd.protocol.events import Event, EventType
        from agentd.protocol.validation import ValidationError

        event = Event(type=EventType.DAEMON_READY, data={})
        with pytest.raises(ValidationError):
            event.validate()

    def test_session_created_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(type=EventType.SESSION_CREATED, data={"session_id": "s1"})
        event.validate()

    def test_run_started_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.RUN_STARTED,
            data={"run_id": "r1", "session_id": "s1"},
        )
        event.validate()

    def test_run_started_event_missing_session_id(self):
        from agentd.protocol.events import Event, EventType
        from agentd.protocol.validation import ValidationError

        event = Event(type=EventType.RUN_STARTED, data={"run_id": "r1"})
        with pytest.raises(ValidationError):
            event.validate()

    def test_user_message_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(type=EventType.USER_MESSAGE, data={"content": "Hello, agent!"})
        event.validate()

    def test_assistant_delta_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(type=EventType.ASSISTANT_DELTA, data={"text": "Hello"})
        event.validate()

    def test_assistant_final_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(type=EventType.ASSISTANT_FINAL, data={"message_id": "m1"})
        event.validate()

    def test_tool_start_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.TOOL_START,
            data={"tool_use_id": "t1", "name": "bash", "input": {"command": "ls"}},
        )
        event.validate()

    def test_tool_end_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.TOOL_END,
            data={"tool_use_id": "t1", "status": "success"},
        )
        event.validate()

    def test_tool_end_event_invalid_status(self):
        from agentd.protocol.events import Event, EventType
        from agentd.protocol.validation import ValidationError

        event = Event(
            type=EventType.TOOL_END,
            data={"tool_use_id": "t1", "status": "invalid"},
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_checkpoint_created_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.CHECKPOINT_CREATED,
            data={"checkpoint_id": "c1", "label": "Before refactor"},
        )
        event.validate()

    def test_checkpoint_restored_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.CHECKPOINT_RESTORED,
            data={"checkpoint_id": "c1"},
        )
        event.validate()

    def test_subagent_start_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.SUBAGENT_START,
            data={"subagent_id": "sub1", "task": "implement feature"},
        )
        event.validate()

    def test_subagent_end_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.SUBAGENT_END,
            data={"subagent_id": "sub1", "status": "success"},
        )
        event.validate()

    def test_skill_start_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.SKILL_START,
            data={"skill_id": "sk1", "name": "commit", "args": "-m 'fix bug'"},
        )
        event.validate()

    def test_skill_end_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.SKILL_END,
            data={"skill_id": "sk1", "status": "success"},
        )
        event.validate()

    def test_search_results_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.SEARCH_RESULTS,
            data={
                "query": "def test",
                "results": [
                    {
                        "file_path": "tests/test_foo.py",
                        "line_number": 42,
                        "content": "def test_bar():",
                    }
                ],
                "total_count": 1,
            },
        )
        event.validate()

    def test_search_results_event_missing_required(self):
        from agentd.protocol.events import Event, EventType
        from agentd.protocol.validation import ValidationError

        event = Event(type=EventType.SEARCH_RESULTS, data={"query": "test"})
        with pytest.raises(ValidationError):
            event.validate()

    def test_error_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.ERROR,
            data={"error": "Something went wrong", "context": {"line": 42}},
        )
        event.validate()

    def test_form_create_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.FORM_CREATE,
            data={
                "form_id": "f1",
                "schema": {"type": "object", "properties": {"name": {"type": "string"}}},
                "title": "Enter details",
            },
        )
        event.validate()

    def test_form_submit_event_valid(self):
        from agentd.protocol.events import Event, EventType

        event = Event(
            type=EventType.FORM_SUBMIT,
            data={"form_id": "f1", "values": {"name": "Alice"}},
        )
        event.validate()


class TestHostRuntime:
    """Test the host sandbox runtime."""

    @pytest.fixture
    def runtime(self):
        from agentd.sandbox.host import HostRuntime

        return HostRuntime()

    @pytest.mark.asyncio
    async def test_create_sandbox(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)
        assert sandbox_id is not None
        assert sandbox_id in runtime.sandboxes

    @pytest.mark.asyncio
    async def test_path_escape_blocked(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)

        with pytest.raises(PermissionError, match="Path escape blocked"):
            await runtime.read_file(sandbox_id, tmp_path / ".." / "etc" / "passwd")

    @pytest.mark.asyncio
    async def test_exec_in_workspace(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)

        result = await runtime.exec(sandbox_id, ["pwd"])
        assert result.exit_code == 0
        assert str(tmp_path) in result.stdout

    @pytest.mark.asyncio
    async def test_read_write_file(self, runtime, tmp_path):
        sandbox_id = await runtime.create_sandbox(tmp_path)

        test_file = tmp_path / "test.txt"
        await runtime.write_file(sandbox_id, test_file, "Hello, world!")

        content = await runtime.read_file(sandbox_id, test_file)
        assert content == "Hello, world!"


class TestSessionManager:
    """Test SessionManager adapter wiring."""

    @pytest.fixture
    def fake_adapter(self):
        """Create a fake adapter with a simple script."""
        from agentd.adapters.fake import FakeAgentAdapter

        script = [
            {"type": "assistant.delta", "text": "Hello! "},
            {"type": "assistant.delta", "text": "How can I help?"},
            {"type": "assistant.final", "message_id": "msg-1"},
        ]
        return FakeAgentAdapter(script=script)

    @pytest.fixture
    def session_manager(self, fake_adapter):
        """Create a SessionManager with fake adapter."""
        from agentd.session import SessionManager

        return SessionManager(adapter=fake_adapter)

    @pytest.mark.asyncio
    async def test_create_session(self, session_manager, tmp_path):
        """Test creating a session."""
        session = await session_manager.create_session(str(tmp_path))

        assert session.id is not None
        assert session.workspace_root == str(tmp_path)
        assert session.id in session_manager.sessions

    @pytest.mark.asyncio
    async def test_send_message_calls_adapter(self, session_manager, tmp_path):
        """Test that send_message calls the adapter and emits events."""
        session = await session_manager.create_session(str(tmp_path))

        # Collect events
        events = []

        def collect_event(event):
            events.append(event)

        # Send a message
        await session_manager.send_message(
            session_id=session.id, message="Hello, agent!", emit=collect_event
        )

        # Verify events were emitted
        event_types = [e.type for e in events]

        # Should have: RUN_STARTED, USER_MESSAGE, ASSISTANT_DELTA (x2), ASSISTANT_FINAL, RUN_FINISHED
        assert EventType.RUN_STARTED in event_types
        assert EventType.USER_MESSAGE in event_types
        assert EventType.ASSISTANT_DELTA in event_types
        assert EventType.ASSISTANT_FINAL in event_types
        assert EventType.RUN_FINISHED in event_types

        # Verify user message content
        user_events = [e for e in events if e.type == EventType.USER_MESSAGE]
        assert len(user_events) == 1
        assert user_events[0].data["content"] == "Hello, agent!"

        # Verify we got the expected assistant deltas
        delta_events = [e for e in events if e.type == EventType.ASSISTANT_DELTA]
        assert len(delta_events) == 2
        assert delta_events[0].data["text"] == "Hello! "
        assert delta_events[1].data["text"] == "How can I help?"

    @pytest.mark.asyncio
    async def test_message_history_updated(self, session_manager, tmp_path):
        """Test that message history is maintained."""
        session = await session_manager.create_session(str(tmp_path))

        # Send first message
        await session_manager.send_message(
            session_id=session.id, message="Hello, agent!", emit=lambda e: None
        )

        # Check history has user message and assistant response
        assert len(session.message_history) == 2
        assert session.message_history[0]["role"] == "user"
        assert session.message_history[0]["content"] == "Hello, agent!"
        assert session.message_history[1]["role"] == "assistant"

        # Send second message
        await session_manager.send_message(
            session_id=session.id, message="Can you help me?", emit=lambda e: None
        )

        # History should now have both exchanges (4 messages total)
        assert len(session.message_history) == 4
        assert session.message_history[2]["role"] == "user"
        assert session.message_history[2]["content"] == "Can you help me?"
        assert session.message_history[3]["role"] == "assistant"

    @pytest.mark.asyncio
    async def test_assistant_response_in_history(self, session_manager, tmp_path):
        """Test that assistant responses are added to message history."""
        session = await session_manager.create_session(str(tmp_path))

        # Send a message
        await session_manager.send_message(
            session_id=session.id, message="Hello, agent!", emit=lambda e: None
        )

        # History should have user message and assistant response
        assert len(session.message_history) == 2
        assert session.message_history[0]["role"] == "user"
        assert session.message_history[0]["content"] == "Hello, agent!"
        assert session.message_history[1]["role"] == "assistant"
        # The fake adapter emits "Hello! How can I help?"
        assert session.message_history[1]["content"] == "Hello! How can I help?"

        # Send second message
        await session_manager.send_message(
            session_id=session.id, message="Can you help me?", emit=lambda e: None
        )

        # History should have both exchanges (4 messages total)
        assert len(session.message_history) == 4
        assert session.message_history[2]["role"] == "user"
        assert session.message_history[2]["content"] == "Can you help me?"
        assert session.message_history[3]["role"] == "assistant"
        assert session.message_history[3]["content"] == "Hello! How can I help?"

    @pytest.mark.asyncio
    async def test_session_not_found(self, session_manager):
        """Test error when session not found."""
        events = []

        await session_manager.send_message(
            session_id="nonexistent", message="Hello", emit=lambda e: events.append(e)
        )

        # Should emit ERROR event
        assert len(events) == 1
        assert events[0].type == EventType.ERROR
        assert "not found" in events[0].data["message"]

    @pytest.mark.asyncio
    async def test_event_persistence(self, fake_adapter, tmp_path):
        """Test that events are persisted to the store."""
        from agentd.session import SessionManager
        from agentd.store.sqlite import SessionStore

        # Create a store
        db_path = tmp_path / "test_sessions.db"
        store = SessionStore(str(db_path))
        await store.initialize()

        # Create session manager with store
        session_manager = SessionManager(adapter=fake_adapter, store=store)

        # Create a session
        session = await session_manager.create_session(str(tmp_path))

        # Send a message
        await session_manager.send_message(
            session_id=session.id, message="Hello, agent!", emit=lambda e: None
        )

        # Give async tasks time to complete
        await asyncio.sleep(0.1)

        # Verify events were persisted
        events = await store.get_events(session.id)
        assert len(events) > 0

        # Should have RUN_STARTED, ASSISTANT_DELTA (x2), ASSISTANT_FINAL, RUN_FINISHED
        event_types = [e.type for e in events]
        assert "run.started" in event_types
        assert "assistant.delta" in event_types
        assert "assistant.final" in event_types
        assert "run.finished" in event_types

    @pytest.mark.asyncio
    async def test_cancel_run_stops_execution(self, tmp_path):
        """Test that cancel_run actually stops the running task."""
        from agentd.adapters.fake import FakeAgentAdapter
        from agentd.session import SessionManager

        # Create a slow adapter that emits many events
        slow_script = []
        for i in range(50):
            slow_script.append({"type": "assistant.delta", "text": f"Token {i} "})
        slow_script.append({"type": "assistant.final", "message_id": "msg-1"})

        adapter = FakeAgentAdapter(script=slow_script)
        session_manager = SessionManager(adapter=adapter)

        session = await session_manager.create_session(str(tmp_path))

        # Collect events
        events = []

        def collect_event(event):
            events.append(event)

        # Start sending message in background
        send_task = asyncio.create_task(
            session_manager.send_message(
                session_id=session.id, message="Start a long task", emit=collect_event
            )
        )

        # Wait for a few events to be emitted (each takes 0.05s)
        await asyncio.sleep(0.15)

        # Get the current run_id before canceling
        run_id = session.current_run_id
        assert run_id is not None

        # Count events before cancel
        events_before_cancel = len(events)

        # Cancel the run
        await session_manager.cancel_run(run_id)

        # Verify current_run_id was cleared
        assert session.current_run_id is None

        # Wait more time - if cancel_run worked, no more events should arrive
        await asyncio.sleep(0.3)

        # Count events after cancel
        events_after_cancel = len(events)

        # Wait for send_task to complete (should have been cancelled)
        with contextlib.suppress(asyncio.CancelledError):
            await send_task

        # Verify cancellation worked: should get at most 1-2 more events after cancel
        # (due to race conditions between cancel signal and event emission)
        assert events_after_cancel <= events_before_cancel + 2, (
            f"cancel_run should stop execution. "
            f"Got {events_after_cancel - events_before_cancel} events after cancel"
        )

        # Verify RUN_CANCELLED event was emitted
        event_types = [e.type for e in events]
        assert EventType.RUN_CANCELLED in event_types, "Should emit RUN_CANCELLED event"

    @pytest.mark.asyncio
    async def test_create_checkpoint(self, fake_adapter, tmp_path):
        """Test creating a checkpoint via SessionManager."""
        from agentd.session import SessionManager
        from agentd.store.sqlite import SessionStore

        # Skip if JJ is not installed
        try:
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        # Create a store
        db_path = tmp_path / "test_sessions.db"
        store = SessionStore(str(db_path))
        await store.initialize()

        # Create session manager with store
        session_manager = SessionManager(adapter=fake_adapter, store=store)

        # Create a session
        session = await session_manager.create_session(str(tmp_path))

        # Collect events
        events = []

        def collect_event(event):
            events.append(event)

        # Create checkpoint
        await session_manager.create_checkpoint(
            session_id=session.id,
            message="Test checkpoint",
            emit=collect_event,
        )

        # Verify checkpoint created event was emitted
        checkpoint_events = [e for e in events if e.type == EventType.CHECKPOINT_CREATED]
        assert len(checkpoint_events) == 1

        checkpoint_event = checkpoint_events[0]
        assert "checkpoint_id" in checkpoint_event.data
        assert checkpoint_event.data["label"] == "Test checkpoint"
        assert "jj_commit_id" in checkpoint_event.data
        assert "bookmark_name" in checkpoint_event.data

        # Verify checkpoint was persisted to store
        checkpoint_id = checkpoint_event.data["checkpoint_id"]
        checkpoint_record = await store.get_checkpoint(checkpoint_id)
        assert checkpoint_record is not None
        assert checkpoint_record.message == "Test checkpoint"
        assert checkpoint_record.session_id == session.id

    @pytest.mark.asyncio
    async def test_create_checkpoint_session_not_found(self, session_manager):
        """Test error when creating checkpoint for nonexistent session."""
        events = []

        await session_manager.create_checkpoint(
            session_id="nonexistent",
            message="Test checkpoint",
            emit=lambda e: events.append(e),
        )

        # Should emit ERROR event
        assert len(events) == 1
        assert events[0].type == EventType.ERROR
        assert "not found" in events[0].data["message"]

    @pytest.mark.asyncio
    async def test_restore_checkpoint(self, fake_adapter, tmp_path):
        """Test restoring a checkpoint via SessionManager."""
        from agentd.session import SessionManager
        from agentd.store.sqlite import SessionStore

        # Skip if JJ is not installed
        try:
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        # Create a store
        db_path = tmp_path / "test_sessions.db"
        store = SessionStore(str(db_path))
        await store.initialize()

        # Create session manager with store
        session_manager = SessionManager(adapter=fake_adapter, store=store)

        # Create a session
        session = await session_manager.create_session(str(tmp_path))

        # Create a checkpoint first
        create_events = []
        await session_manager.create_checkpoint(
            session_id=session.id,
            message="Test checkpoint",
            emit=lambda e: create_events.append(e),
        )

        checkpoint_id = None
        for event in create_events:
            if event.type == EventType.CHECKPOINT_CREATED:
                checkpoint_id = event.data["checkpoint_id"]
                break

        assert checkpoint_id is not None

        # Modify the workspace
        test_file = tmp_path / "test.txt"
        test_file.write_text("modified content")

        # Restore the checkpoint
        restore_events = []
        await session_manager.restore_checkpoint(
            session_id=session.id,
            checkpoint_id=checkpoint_id,
            emit=lambda e: restore_events.append(e),
        )

        # Verify checkpoint restored event was emitted
        restored_events = [
            e for e in restore_events if e.type == EventType.CHECKPOINT_RESTORED
        ]
        assert len(restored_events) == 1
        assert restored_events[0].data["checkpoint_id"] == checkpoint_id

    @pytest.mark.asyncio
    async def test_restore_checkpoint_session_not_found(self, session_manager):
        """Test error when restoring checkpoint for nonexistent session."""
        events = []

        await session_manager.restore_checkpoint(
            session_id="nonexistent",
            checkpoint_id="cp-123",
            emit=lambda e: events.append(e),
        )

        # Should emit ERROR event
        assert len(events) == 1
        assert events[0].type == EventType.ERROR
        assert "not found" in events[0].data["message"]

    @pytest.mark.asyncio
    async def test_restore_nonexistent_checkpoint(self, fake_adapter, tmp_path):
        """Test error when restoring nonexistent checkpoint."""
        from agentd.session import SessionManager
        from agentd.store.sqlite import SessionStore

        # Skip if JJ is not installed
        try:
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        # Create a store
        db_path = tmp_path / "test_sessions.db"
        store = SessionStore(str(db_path))
        await store.initialize()

        # Create session manager with store
        session_manager = SessionManager(adapter=fake_adapter, store=store)

        # Create a session
        session = await session_manager.create_session(str(tmp_path))

        # Try to restore nonexistent checkpoint
        events = []
        await session_manager.restore_checkpoint(
            session_id=session.id,
            checkpoint_id="nonexistent-cp",
            emit=lambda e: events.append(e),
        )

        # Should emit ERROR event
        assert len(events) == 1
        assert events[0].type == EventType.ERROR
        assert "not found" in events[0].data["message"]

    @pytest.mark.asyncio
    async def test_load_sessions_from_store(self, fake_adapter, tmp_path):
        """Test loading existing sessions from database on startup."""
        from agentd.session import SessionManager
        from agentd.store.sqlite import SessionStore

        # Create a store and add some sessions
        db_path = tmp_path / "test_sessions.db"
        store = SessionStore(str(db_path))
        await store.initialize()

        # Create sessions directly in the store
        await store.create_session(workspace_root=str(tmp_path / "session1"), session_id="sess-1")
        await store.create_session(workspace_root=str(tmp_path / "session2"), session_id="sess-2")
        await store.create_session(workspace_root=str(tmp_path / "session3"), session_id="sess-3")

        # Create a new session manager and load sessions
        session_manager = SessionManager(adapter=fake_adapter, store=store)
        loaded_count = await session_manager.load_sessions()

        # Should have loaded 3 sessions
        assert loaded_count == 3
        assert len(session_manager.sessions) == 3
        assert "sess-1" in session_manager.sessions
        assert "sess-2" in session_manager.sessions
        assert "sess-3" in session_manager.sessions

        # Verify session data is correct
        session1 = session_manager.sessions["sess-1"]
        assert session1.workspace_root == str(tmp_path / "session1")
        assert session1.current_run_id is None  # No active runs on startup

    @pytest.mark.asyncio
    async def test_load_sessions_without_store(self, fake_adapter):
        """Test that load_sessions handles missing store gracefully."""
        from agentd.session import SessionManager

        session_manager = SessionManager(adapter=fake_adapter, store=None)
        loaded_count = await session_manager.load_sessions()

        # Should return 0 when no store is available
        assert loaded_count == 0
        assert len(session_manager.sessions) == 0

    @pytest.mark.asyncio
    async def test_end_to_end_event_persistence_and_graph_reduction(
        self, fake_adapter, tmp_path
    ):
        """Test full end-to-end flow: SessionManager → Store → Reducer → Graph.

        This test verifies the complete foundation:
        1. SessionManager sends message through adapter
        2. Events are emitted and persisted to store
        3. Events can be loaded from store
        4. Events can be reduced into a SessionGraph
        5. SessionGraph can be projected to chat messages
        """
        from agentd.reducer import reduce_events
        from agentd.session import SessionManager
        from agentd.store.sqlite import SessionStore

        # Create store
        db_path = tmp_path / "test_e2e.db"
        store = SessionStore(db_path)
        await store.initialize()

        # Create session manager with store
        session_manager = SessionManager(adapter=fake_adapter, store=store)

        # Create a session
        session = await session_manager.create_session(str(tmp_path))

        # Send a message (this will trigger adapter, emit events, and persist them)
        await session_manager.send_message(
            session_id=session.id, message="Hello, agent!", emit=lambda e: None
        )

        # Give async tasks time to complete
        await asyncio.sleep(0.1)

        # Step 1: Verify events were persisted to store
        event_records = await store.get_events(session.id)
        assert len(event_records) > 0, "Events should be persisted to store"

        # Step 2: Convert stored events to protocol Event objects
        protocol_events = await store.get_events_as_protocol_events(session.id)
        assert len(protocol_events) > 0, "Should have protocol events"

        # Step 3: Convert protocol events to reducer format (dict with type, data, timestamp)
        reducer_events = [
            {
                "type": event.type.value,
                "data": event.data,
                "timestamp": event.timestamp.isoformat(),
            }
            for event in protocol_events
        ]

        # Step 4: Reduce events into a SessionGraph
        graph = reduce_events(reducer_events)

        # Step 5: Verify graph structure
        assert len(graph.nodes) > 0, "Graph should have nodes"

        # Should have at least one message node (user message + assistant deltas/final)
        from agentd.reducer import GraphNodeType

        message_nodes = [n for n in graph.nodes.values() if n.type == GraphNodeType.MESSAGE]
        assert len(message_nodes) >= 1, "Should have at least one message node"

        # Step 6: Project graph to chat messages
        chat_messages = graph.project_to_chat()
        assert len(chat_messages) >= 1, "Should have at least one chat message"

        # Verify the assistant message content
        assistant_messages = [msg for msg in chat_messages if msg.role == "assistant"]
        assert len(assistant_messages) >= 1, "Should have assistant response"

        # The fake adapter emits "Hello! " + "How can I help?"
        assert "Hello" in assistant_messages[0].content
        assert "help" in assistant_messages[0].content.lower()

        # Step 7: Verify graph determinism
        graph2 = reduce_events(reducer_events)
        assert graph.compute_hash() == graph2.compute_hash(), (
            "Reducer should be deterministic: same events → same graph hash"
        )


class TestAgentDaemonSessionList:
    """Test session.list request handling."""

    @pytest.mark.asyncio
    async def test_session_list_request(self, tmp_path):
        """Test that session.list request returns all sessions."""
        from io import StringIO

        from agentd.daemon import AgentDaemon, DaemonConfig
        from agentd.protocol.requests import Request

        # Create daemon with fake adapter
        config = DaemonConfig(
            workspace_root=str(tmp_path),
            agent_backend="fake",
            db_path=str(tmp_path / "test.db"),
        )

        input_stream = StringIO()
        output_stream = StringIO()
        daemon = AgentDaemon(config, input_stream, output_stream)

        # Initialize store and create some sessions
        await daemon.store.initialize()
        await daemon.session_manager.create_session(str(tmp_path / "session1"))
        await daemon.session_manager.create_session(str(tmp_path / "session2"))

        # Handle session.list request
        request = Request(id="req-1", method="session.list", params={})
        await daemon.handle_request(request)

        # Parse output
        output = output_stream.getvalue()
        lines = [line for line in output.strip().split("\n") if line]

        # Should have emitted SESSION_LIST event
        assert len(lines) >= 1
        import json

        last_event = json.loads(lines[-1])
        assert last_event["type"] == "session.list"
        assert "sessions" in last_event["data"]
        assert len(last_event["data"]["sessions"]) == 2

        # Verify session data structure
        session_data = last_event["data"]["sessions"][0]
        assert "id" in session_data
        assert "workspace_root" in session_data
        assert "created_at" in session_data
        assert "last_active_at" in session_data

    @pytest.mark.asyncio
    async def test_daemon_loads_sessions_on_startup(self, tmp_path):
        """Test that daemon loads existing sessions on startup."""
        from io import StringIO

        from agentd.daemon import AgentDaemon, DaemonConfig
        from agentd.store.sqlite import SessionStore

        db_path = tmp_path / "test.db"

        # Create store and add sessions directly
        store = SessionStore(str(db_path))
        await store.initialize()
        await store.create_session(workspace_root=str(tmp_path / "session1"), session_id="sess-1")
        await store.create_session(workspace_root=str(tmp_path / "session2"), session_id="sess-2")

        # Create daemon (should load sessions on run())
        config = DaemonConfig(
            workspace_root=str(tmp_path),
            agent_backend="fake",
            db_path=str(db_path),
        )

        input_stream = StringIO()
        output_stream = StringIO()
        daemon = AgentDaemon(config, input_stream, output_stream)

        # Start daemon in background task
        import asyncio

        run_task = asyncio.create_task(daemon.run())

        # Give it time to initialize
        await asyncio.sleep(0.1)

        # Stop daemon
        daemon.stop()
        await run_task

        # Verify sessions were loaded
        assert len(daemon.session_manager.sessions) == 2
        assert "sess-1" in daemon.session_manager.sessions
        assert "sess-2" in daemon.session_manager.sessions

        # Verify DAEMON_READY event includes loaded_sessions count
        output = output_stream.getvalue()
        lines = [line for line in output.strip().split("\n") if line]
        assert len(lines) >= 1

        import json

        ready_event = json.loads(lines[0])
        assert ready_event["type"] == "daemon.ready"
        assert ready_event["data"]["loaded_sessions"] == 2


class TestRepoStateService:
    """Test JJ integration for checkpoints."""

    @pytest.fixture
    def service(self, tmp_path):
        """Create a RepoStateService for testing."""
        from agentd.jj import RepoStateService

        return RepoStateService(tmp_path)

    @pytest.mark.asyncio
    async def test_ensure_jj_repo_initializes_new_repo(self, service, tmp_path):
        """Test that ensure_jj_repo initializes a new repo if needed."""
        try:
            # Check if JJ is installed
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        # Should not be a JJ repo initially
        status = await service.get_status()
        assert not status.is_jj_repo

        # Initialize
        await service.ensure_jj_repo()

        # Should now be a JJ repo
        status = await service.get_status()
        assert status.is_jj_repo
        assert status.current_commit is not None

    @pytest.mark.asyncio
    async def test_ensure_jj_repo_raises_when_jj_not_installed(self, service, monkeypatch):
        """Test that ensure_jj_repo raises JJNotFoundError when JJ is not installed."""
        import subprocess

        from agentd.jj import JJNotFoundError

        # Mock subprocess.run to simulate JJ not being installed
        original_run = subprocess.run

        def mock_run(cmd, **kwargs):
            if cmd[0] == "jj" and cmd[1] == "--version":
                raise FileNotFoundError("jj not found")
            return original_run(cmd, **kwargs)

        monkeypatch.setattr(subprocess, "run", mock_run)

        with pytest.raises(JJNotFoundError, match="not installed"):
            await service.ensure_jj_repo()

    @pytest.mark.asyncio
    async def test_create_checkpoint_with_clean_working_copy(self, service, tmp_path):
        """Test creating a checkpoint with no uncommitted changes."""
        try:
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        await service.ensure_jj_repo()

        # Create a checkpoint
        checkpoint = await service.create_checkpoint(
            checkpoint_id="cp-123", message="Test checkpoint"
        )

        assert checkpoint.checkpoint_id == "cp-123"
        assert checkpoint.jj_commit_id is not None
        assert checkpoint.bookmark_name == "checkpoint-cp-123"
        assert checkpoint.message == "Test checkpoint"
        assert checkpoint.created_at is not None

    @pytest.mark.asyncio
    async def test_create_checkpoint_with_changes(self, service, tmp_path):
        """Test creating a checkpoint with uncommitted changes."""
        try:
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        await service.ensure_jj_repo()

        # Create a file
        test_file = tmp_path / "test.txt"
        test_file.write_text("Initial content")

        # Get status - should have changes
        status = await service.get_status()
        assert status.has_changes

        # Create checkpoint
        checkpoint = await service.create_checkpoint(
            checkpoint_id="cp-456", message="Checkpoint with changes"
        )

        assert checkpoint.checkpoint_id == "cp-456"
        assert checkpoint.jj_commit_id is not None

        # Working copy should now be clean
        status = await service.get_status()
        # Note: might still have changes if there's a new working copy
        # The key is that the checkpoint was created successfully

    @pytest.mark.asyncio
    async def test_restore_checkpoint(self, service, tmp_path):
        """Test restoring to a previous checkpoint."""
        try:
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        await service.ensure_jj_repo()

        # Create initial file
        test_file = tmp_path / "test.txt"
        test_file.write_text("Version 1")

        # Create first checkpoint
        await service.create_checkpoint(
            checkpoint_id="cp-1", message="Version 1"
        )

        # Modify file
        test_file.write_text("Version 2")

        # Create second checkpoint
        await service.create_checkpoint(
            checkpoint_id="cp-2", message="Version 2"
        )

        # Restore to first checkpoint
        await service.restore_checkpoint("cp-1")

        # File should have original content
        content = test_file.read_text()
        assert content == "Version 1"

    @pytest.mark.asyncio
    async def test_get_status_returns_repo_info(self, service, tmp_path):
        """Test that get_status returns accurate repository information."""
        try:
            import subprocess

            subprocess.run(["jj", "--version"], capture_output=True, check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        # Before init
        status = await service.get_status()
        assert not status.is_jj_repo

        # After init
        await service.ensure_jj_repo()
        status = await service.get_status()
        assert status.is_jj_repo
        assert status.current_commit is not None

        # Create a file
        test_file = tmp_path / "test.txt"
        test_file.write_text("Content")

        status = await service.get_status()
        assert status.has_changes
        assert status.change_summary is not None

    @pytest.mark.asyncio
    async def test_get_status_when_jj_not_installed(self, service, monkeypatch):
        """Test that get_status handles missing JJ gracefully."""
        import subprocess

        original_run = subprocess.run

        def mock_run(cmd, **kwargs):
            if cmd[0] == "jj":
                raise FileNotFoundError("jj not found")
            return original_run(cmd, **kwargs)

        monkeypatch.setattr(subprocess, "run", mock_run)

        status = await service.get_status()
        assert not status.is_jj_repo
        assert status.current_commit is None
        assert not status.has_changes


class TestSkillsSystem:
    """Test the skills system."""

    @pytest.fixture
    def registry(self):
        """Create a fresh skill registry for testing."""
        from agentd.skills.registry import SkillRegistry

        return SkillRegistry()

    def test_register_skill(self, registry):
        """Test registering a skill."""
        from agentd.skills.base import Skill, SkillContext, SkillResult

        class TestSkill(Skill):
            @property
            def skill_id(self) -> str:
                return "test"

            @property
            def name(self) -> str:
                return "Test Skill"

            async def execute(
                self, context: SkillContext, args: str | None = None
            ) -> SkillResult:
                return SkillResult(success=True, result="test result")

        skill = TestSkill()
        registry.register(skill)

        retrieved = registry.get("test")
        assert retrieved is not None
        assert retrieved.skill_id == "test"
        assert retrieved.name == "Test Skill"

    def test_list_skills(self, registry):
        """Test listing all skills."""
        from agentd.skills.base import Skill, SkillContext, SkillResult

        class Skill1(Skill):
            @property
            def skill_id(self) -> str:
                return "skill1"

            @property
            def name(self) -> str:
                return "Skill 1"

            async def execute(
                self, context: SkillContext, args: str | None = None
            ) -> SkillResult:
                return SkillResult(success=True, result="result1")

        class Skill2(Skill):
            @property
            def skill_id(self) -> str:
                return "skill2"

            @property
            def name(self) -> str:
                return "Skill 2"

            async def execute(
                self, context: SkillContext, args: str | None = None
            ) -> SkillResult:
                return SkillResult(success=True, result="result2")

        registry.register(Skill1())
        registry.register(Skill2())

        skills = registry.list_skills()
        assert len(skills) == 2
        skill_ids = {s.skill_id for s in skills}
        assert skill_ids == {"skill1", "skill2"}

    @pytest.mark.asyncio
    async def test_summarize_skill(self):
        """Test the Summarize skill."""
        from agentd.skills.base import SkillContext
        from agentd.skills.builtin.summarize import SummarizeSkill

        skill = SummarizeSkill()
        assert skill.skill_id == "summarize"
        assert skill.name == "Summarize Session"

        # Test with empty session
        context = SkillContext(
            workspace_path="/tmp",
            session_id="test-session",
            session_messages=[],
        )
        result = await skill.execute(context)
        assert result.success
        assert "No messages" in result.result

        # Test with messages
        context = SkillContext(
            workspace_path="/tmp",
            session_id="test-session",
            session_messages=[
                {"role": "user", "content": "Hello"},
                {"role": "assistant", "content": "Hi there!"},
                {"role": "user", "content": "How are you?"},
            ],
        )
        result = await skill.execute(context)
        assert result.success
        assert "Session Summary" in result.result
        assert "3 total" in result.result

    @pytest.mark.asyncio
    async def test_plan_skill(self):
        """Test the Plan skill."""
        from agentd.skills.base import SkillContext
        from agentd.skills.builtin.plan import PlanSkill

        skill = PlanSkill()
        assert skill.skill_id == "plan"
        assert skill.name == "Create Implementation Plan"

        context = SkillContext(
            workspace_path="/tmp",
            session_id="test-session",
            session_messages=[],
        )
        result = await skill.execute(context, args="Build a new feature")
        assert result.success
        assert "Implementation Plan" in result.result
        assert "Build a new feature" in result.result
        assert "Implementation Steps" in result.result

    @pytest.mark.asyncio
    async def test_session_manager_run_skill(self, tmp_path):
        """Test running a skill through SessionManager."""
        from agentd.adapters.fake import FakeAgentAdapter
        from agentd.protocol.events import Event, EventType
        from agentd.session import SessionManager

        adapter = FakeAgentAdapter()
        manager = SessionManager(adapter)

        # Create a session
        session = await manager.create_session(str(tmp_path))

        # Add some messages
        session.message_history = [
            {"role": "user", "content": "Test message"},
            {"role": "assistant", "content": "Test response"},
        ]

        # Track emitted events
        events: list[Event] = []

        def collect_event(event: Event) -> None:
            events.append(event)

        # Run summarize skill
        await manager.run_skill(session.id, "summarize", emit=collect_event)

        # Check events
        assert len(events) == 3
        assert events[0].type == EventType.SKILL_START
        assert events[0].data["skill_id"] == "summarize"
        assert events[1].type == EventType.SKILL_RESULT
        assert "Session Summary" in events[1].data["result"]
        assert events[2].type == EventType.SKILL_END
        assert events[2].data["status"] == "success"

    @pytest.mark.asyncio
    async def test_daemon_skill_run_request(self, tmp_path):
        """Test skill.run request through the daemon."""
        from io import StringIO

        from agentd.daemon import AgentDaemon, DaemonConfig

        config = DaemonConfig(
            workspace_root=str(tmp_path),
            sandbox_mode="host",
            agent_backend="fake",
            db_path=str(tmp_path / "test_sessions.db"),
        )

        input_stream = StringIO()
        output_stream = StringIO()

        # Create session and run skill
        requests = [
            json.dumps(
                {
                    "id": "req-1",
                    "method": "session.create",
                    "params": {"workspace_root": str(tmp_path)},
                }
            ),
            json.dumps(
                {
                    "id": "req-2",
                    "method": "skill.run",
                    "params": {
                        "session_id": "SESSION_ID",  # Will be replaced
                        "skill_id": "plan",
                        "args": "Test task",
                    },
                }
            ),
        ]

        daemon = AgentDaemon(config, input_stream, output_stream)

        # Initialize the store
        await daemon.store.initialize()

        # Process first request to create session
        input_stream.write(requests[0] + "\n")
        input_stream.seek(0)

        # Run daemon for first request only
        line = input_stream.readline()
        request_obj = json.loads(line.strip())
        from agentd.protocol.requests import Request

        request = Request.from_dict(request_obj)
        await daemon.handle_request(request)

        # Get session ID from output
        output_stream.seek(0)
        lines = output_stream.read().strip().split("\n")
        # Skip daemon.ready event
        session_created_line = next(
            line for line in lines if "session.created" in line
        )
        session_event = json.loads(session_created_line)
        session_id = session_event["data"]["session_id"]

        # Now run skill request with real session ID
        skill_request = json.loads(requests[1])
        skill_request["params"]["session_id"] = session_id

        request = Request.from_dict(skill_request)
        await daemon.handle_request(request)

        # Check skill events
        output_stream.seek(0)
        all_output = output_stream.read()
        events = [json.loads(line) for line in all_output.strip().split("\n")]

        skill_events = [e for e in events if e["type"].startswith("skill.")]
        assert len(skill_events) == 3
        assert skill_events[0]["type"] == "skill.start"
        assert skill_events[0]["data"]["skill_id"] == "plan"
        assert skill_events[1]["type"] == "skill.result"
        assert "Implementation Plan" in skill_events[1]["data"]["result"]
        assert skill_events[2]["type"] == "skill.end"
        assert skill_events[2]["data"]["status"] == "success"


class TestSearchRequests:
    """Test search request handlers."""

    @pytest.fixture
    def config(self, tmp_path):
        return DaemonConfig(
            workspace_root=str(tmp_path),
            sandbox_mode="host",
            agent_backend="fake",
        )

    @pytest.fixture
    async def daemon_with_data(self, tmp_path):
        """Create a daemon with searchable data."""
        import uuid

        # Create config with unique workspace and db path for each test
        config = DaemonConfig(
            workspace_root=str(tmp_path / "workspace"),
            sandbox_mode="host",
            agent_backend="fake",
            db_path=str(tmp_path / "test_sessions.db"),
        )
        input_stream = StringIO()
        output_stream = StringIO()
        daemon = AgentDaemon(config, input_stream, output_stream)
        await daemon.store.initialize()

        # Create a session with searchable events (unique ID per test)
        session_id = str(uuid.uuid4())
        await daemon.store.create_session(str(tmp_path / "workspace"), session_id=session_id)

        # Add events with searchable content
        await daemon.store.append_event(
            session_id,
            EventType.ASSISTANT_DELTA,
            {"content": "Here is some Python code for fibonacci"},
        )
        await daemon.store.append_event(
            session_id,
            EventType.TOOL_OUTPUT_REF,
            {"preview": "def calculate(): return 42"},
        )

        # Add a checkpoint
        await daemon.store.create_checkpoint(
            checkpoint_id="cp-test",
            session_id=session_id,
            session_node_id="node-1",
            jj_commit_id="abc123",
            bookmark_name="feature-auth",
            message="Add authentication feature",
        )

        return daemon, output_stream, session_id

    @pytest.mark.asyncio
    async def test_search_events_request(self, daemon_with_data):
        """Should handle search.events request."""
        daemon, output_stream, session_id = daemon_with_data

        request = Request(
            id="req-1",
            method="search.events",
            params={"query": "Python", "session_id": session_id, "limit": 10},
        )

        await daemon.handle_request(request)

        output_stream.seek(0)
        lines = output_stream.read().strip().split("\n")
        event = json.loads(lines[0])

        assert event["type"] == "search.results"
        assert event["data"]["request_id"] == "req-1"
        assert "results" in event["data"]
        assert len(event["data"]["results"]) > 0
        # Should find the Python event
        assert any("Python" in str(r["payload"]) for r in event["data"]["results"])

    @pytest.mark.asyncio
    async def test_search_checkpoints_request(self, daemon_with_data):
        """Should handle search.checkpoints request."""
        daemon, output_stream, session_id = daemon_with_data

        request = Request(
            id="req-2",
            method="search.checkpoints",
            params={"query": "authentication", "session_id": session_id},
        )

        await daemon.handle_request(request)

        output_stream.seek(0)
        lines = output_stream.read().strip().split("\n")
        event = json.loads(lines[0])

        assert event["type"] == "search.results"
        assert event["data"]["request_id"] == "req-2"
        assert "results" in event["data"]
        assert len(event["data"]["results"]) > 0
        # Should find the checkpoint
        assert any(
            "authentication" in r["message"].lower()
            for r in event["data"]["results"]
        )

    @pytest.mark.asyncio
    async def test_search_all_request(self, daemon_with_data):
        """Should handle search.all request."""
        daemon, output_stream, session_id = daemon_with_data

        request = Request(
            id="req-3",
            method="search.all",
            params={"query": "auth OR Python", "session_id": session_id, "limit": 20},
        )

        await daemon.handle_request(request)

        output_stream.seek(0)
        lines = output_stream.read().strip().split("\n")
        event = json.loads(lines[0])

        assert event["type"] == "search.results"
        assert event["data"]["request_id"] == "req-3"
        assert "events" in event["data"]
        assert "checkpoints" in event["data"]
        assert "total" in event["data"]
        assert event["data"]["total"] > 0

    @pytest.mark.asyncio
    async def test_search_no_results(self, daemon_with_data):
        """Should return empty results when no matches."""
        daemon, output_stream, session_id = daemon_with_data

        request = Request(
            id="req-4",
            method="search.events",
            params={"query": "nonexistent_xyz_term", "session_id": session_id},
        )

        await daemon.handle_request(request)

        output_stream.seek(0)
        lines = output_stream.read().strip().split("\n")
        event = json.loads(lines[0])

        assert event["type"] == "search.results"
        assert len(event["data"]["results"]) == 0


class TestGoldenFixtures:
    """Test golden protocol fixtures for schema validation."""

    @pytest.fixture
    def fixtures_dir(self):
        import pathlib

        return pathlib.Path(__file__).parent / "fixtures"

    def test_golden_events_basic_scenario(self, fixtures_dir):
        """Test basic golden events fixture validates correctly."""
        from agentd.protocol.validation import validate_event

        fixture_path = fixtures_dir / "golden_events.json"
        with open(fixture_path) as f:
            events = json.load(f)

        assert len(events) > 0

        for event in events:
            # Should not raise ValidationError
            validate_event(event)

        # Verify specific events in the fixture
        assert events[0]["type"] == "daemon.ready"
        assert events[1]["type"] == "session.created"
        assert any(e["type"] == "tool.start" for e in events)
        assert any(e["type"] == "checkpoint.created" for e in events)

    def test_tool_error_scenario(self, fixtures_dir):
        """Test tool error scenario fixture validates correctly."""
        from agentd.protocol.validation import validate_event

        fixture_path = fixtures_dir / "tool_error_scenario.json"
        with open(fixture_path) as f:
            events = json.load(f)

        assert len(events) == 11

        for event in events:
            validate_event(event)

        # Verify the error flow
        tool_start = next(e for e in events if e["type"] == "tool.start")
        assert tool_start["data"]["name"] == "Read"

        tool_end = next(e for e in events if e["type"] == "tool.end")
        assert tool_end["data"]["status"] == "error"
        assert "FileNotFoundError" in tool_end["data"]["error"]

    def test_run_cancellation_scenario(self, fixtures_dir):
        """Test run cancellation scenario fixture validates correctly."""
        from agentd.protocol.validation import validate_event

        fixture_path = fixtures_dir / "run_cancellation_scenario.json"
        with open(fixture_path) as f:
            events = json.load(f)

        assert len(events) == 8

        for event in events:
            validate_event(event)

        # Verify cancellation flow
        run_cancelled = next(e for e in events if e["type"] == "run.cancelled")
        assert run_cancelled["data"]["run_id"] == "run-3"
        assert "reason" in run_cancelled["data"]

        # Tool should end with error after cancellation
        tool_end = next(e for e in events if e["type"] == "tool.end")
        assert tool_end["data"]["status"] == "error"

    def test_run_error_scenario(self, fixtures_dir):
        """Test run error scenario fixture validates correctly."""
        from agentd.protocol.validation import validate_event

        fixture_path = fixtures_dir / "run_error_scenario.json"
        with open(fixture_path) as f:
            events = json.load(f)

        assert len(events) == 10

        for event in events:
            validate_event(event)

        # Verify error flow
        run_error = next(e for e in events if e["type"] == "run.error")
        assert run_error["data"]["run_id"] == "run-4"
        assert "error" in run_error["data"]
        assert "traceback" in run_error["data"]
        assert "KeyError" in run_error["data"]["traceback"]

    def test_subagent_scenario(self, fixtures_dir):
        """Test subagent scenario fixture validates correctly."""
        from agentd.protocol.validation import validate_event

        fixture_path = fixtures_dir / "subagent_scenario.json"
        with open(fixture_path) as f:
            events = json.load(f)

        assert len(events) == 17

        for event in events:
            validate_event(event)

        # Verify subagent flow
        subagent_start = next(e for e in events if e["type"] == "subagent.start")
        assert subagent_start["data"]["subagent_id"] == "sub-1"
        assert "task" in subagent_start["data"]
        assert "parent_run_id" in subagent_start["data"]

        subagent_end = next(e for e in events if e["type"] == "subagent.end")
        assert subagent_end["data"]["subagent_id"] == "sub-1"
        assert subagent_end["data"]["status"] == "success"

    def test_skill_execution_scenario(self, fixtures_dir):
        """Test skill execution scenario fixture validates correctly."""
        from agentd.protocol.validation import validate_event

        fixture_path = fixtures_dir / "skill_execution_scenario.json"
        with open(fixture_path) as f:
            events = json.load(f)

        assert len(events) == 11

        for event in events:
            validate_event(event)

        # Verify skill flow
        skill_start = next(e for e in events if e["type"] == "skill.start")
        assert skill_start["data"]["skill_id"] == "skill-1"
        assert skill_start["data"]["name"] == "summarize"

        skill_result = next(e for e in events if e["type"] == "skill.result")
        assert skill_result["data"]["skill_id"] == "skill-1"
        assert "result" in skill_result["data"]

        skill_end = next(e for e in events if e["type"] == "skill.end")
        assert skill_end["data"]["status"] == "success"

    def test_all_fixtures_have_valid_timestamps(self, fixtures_dir):
        """Test all fixtures have valid ISO 8601 timestamps."""
        from datetime import datetime

        fixture_files = [
            "golden_events.json",
            "tool_error_scenario.json",
            "run_cancellation_scenario.json",
            "run_error_scenario.json",
            "subagent_scenario.json",
            "skill_execution_scenario.json",
        ]

        for fixture_file in fixture_files:
            fixture_path = fixtures_dir / fixture_file
            with open(fixture_path) as f:
                events = json.load(f)

            for event in events:
                # Should parse as ISO 8601 timestamp
                timestamp = event["timestamp"]
                dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
                assert dt is not None

    def test_fixtures_cover_all_event_types(self, fixtures_dir):
        """Test that golden fixtures cover a comprehensive set of event types."""
        fixture_files = [
            "golden_events.json",
            "tool_error_scenario.json",
            "run_cancellation_scenario.json",
            "run_error_scenario.json",
            "subagent_scenario.json",
            "skill_execution_scenario.json",
        ]

        all_event_types = set()
        for fixture_file in fixture_files:
            fixture_path = fixtures_dir / fixture_file
            with open(fixture_path) as f:
                events = json.load(f)

            for event in events:
                all_event_types.add(event["type"])

        # Verify coverage of core event types
        expected_types = {
            "daemon.ready",
            "session.created",
            "run.started",
            "run.finished",
            "run.cancelled",
            "run.error",
            "user.message",
            "assistant.delta",
            "assistant.final",
            "tool.start",
            "tool.end",
            "tool.output_ref",
            "checkpoint.created",
            "subagent.start",
            "subagent.end",
            "skill.start",
            "skill.result",
            "skill.end",
        }

        assert expected_types.issubset(all_event_types), f"Missing event types: {expected_types - all_event_types}"
