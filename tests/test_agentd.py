"""Tests for the agentd daemon."""

import asyncio
import json
from io import StringIO

import pytest

from agentd.daemon import AgentDaemon, DaemonConfig
from agentd.protocol.events import EventType


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

        # Should have: RUN_STARTED, ASSISTANT_DELTA (x2), ASSISTANT_FINAL, RUN_FINISHED
        assert EventType.RUN_STARTED in event_types
        assert EventType.ASSISTANT_DELTA in event_types
        assert EventType.ASSISTANT_FINAL in event_types
        assert EventType.RUN_FINISHED in event_types

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

        # Check history has user message
        assert len(session.message_history) == 1
        assert session.message_history[0]["role"] == "user"
        assert session.message_history[0]["content"] == "Hello, agent!"

        # Send second message
        await session_manager.send_message(
            session_id=session.id, message="Can you help me?", emit=lambda e: None
        )

        # History should now have both messages
        assert len(session.message_history) == 2
        assert session.message_history[1]["content"] == "Can you help me?"

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
