"""Tests for the record/replay testing infrastructure."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import BaseModel

from smithers.testing.replay import (
    RecordedCall,
    Recording,
    RecordingLLMProvider,
    RecordingStore,
    ReplayLLMProvider,
    _compute_call_hash,
    use_replay,
    use_replay_provider,
)


# Test models
class SimpleOutput(BaseModel):
    message: str


class AnalysisOutput(BaseModel):
    files: list[str]
    summary: str


class ImplementOutput(BaseModel):
    changed_files: list[str]


class TestRecordingStore:
    """Tests for RecordingStore."""

    @pytest.fixture
    def store_path(self, tmp_path: Path) -> Path:
        return tmp_path / "test_recordings.db"

    @pytest.fixture
    async def store(self, store_path: Path) -> RecordingStore:
        store = RecordingStore(store_path)
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_initialize_creates_schema(self, store_path: Path) -> None:
        """Test that initialize creates the database schema."""
        store = RecordingStore(store_path)
        await store.initialize()
        assert store_path.exists()

    @pytest.mark.asyncio
    async def test_initialize_is_idempotent(self, store: RecordingStore) -> None:
        """Test that initialize can be called multiple times."""
        await store.initialize()
        await store.initialize()  # Should not raise

    @pytest.mark.asyncio
    async def test_create_recording(self, store: RecordingStore) -> None:
        """Test creating a recording session."""
        recording_id = await store.create_recording("test_v1", "Test recording")
        assert recording_id == "test_v1"

        recording = await store.get_recording("test_v1")
        assert recording is not None
        assert recording.recording_id == "test_v1"
        assert recording.description == "Test recording"
        assert recording.call_count == 0
        assert recording.finished_at is None

    @pytest.mark.asyncio
    async def test_recording_exists(self, store: RecordingStore) -> None:
        """Test checking if a recording exists."""
        assert not await store.recording_exists("nonexistent")

        await store.create_recording("test_v1")
        assert await store.recording_exists("test_v1")

    @pytest.mark.asyncio
    async def test_finish_recording(self, store: RecordingStore) -> None:
        """Test finishing a recording session."""
        await store.create_recording("test_v1")
        await store.finish_recording("test_v1")

        recording = await store.get_recording("test_v1")
        assert recording is not None
        assert recording.finished_at is not None

    @pytest.mark.asyncio
    async def test_record_call(self, store: RecordingStore) -> None:
        """Test recording an LLM call."""
        await store.create_recording("test_v1")

        response = SimpleOutput(message="Hello, world!")
        call_id = await store.record_call(
            "test_v1",
            prompt="Say hello",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=response,
            input_tokens=10,
            output_tokens=5,
        )

        assert call_id > 0

        calls = await store.get_calls("test_v1")
        assert len(calls) == 1
        assert calls[0].prompt == "Say hello"
        assert calls[0].output_type_name == "SimpleOutput"
        assert calls[0].response == {"message": "Hello, world!"}
        assert calls[0].input_tokens == 10
        assert calls[0].output_tokens == 5

    @pytest.mark.asyncio
    async def test_record_multiple_calls(self, store: RecordingStore) -> None:
        """Test recording multiple calls maintains sequence order."""
        await store.create_recording("test_v1")

        await store.record_call(
            "test_v1",
            prompt="First call",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="First"),
        )

        await store.record_call(
            "test_v1",
            prompt="Second call",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="Second"),
        )

        calls = await store.get_calls("test_v1")
        assert len(calls) == 2
        assert calls[0].sequence_num == 0
        assert calls[0].prompt == "First call"
        assert calls[1].sequence_num == 1
        assert calls[1].prompt == "Second call"

    @pytest.mark.asyncio
    async def test_record_call_with_tools(self, store: RecordingStore) -> None:
        """Test recording a call with tools."""
        await store.create_recording("test_v1")

        response = AnalysisOutput(files=["a.py"], summary="Analysis")
        await store.record_call(
            "test_v1",
            prompt="Analyze",
            output_type=AnalysisOutput,
            tools=["Read", "Grep"],
            system="You are an analyst",
            response=response,
        )

        calls = await store.get_calls("test_v1")
        assert len(calls) == 1
        assert calls[0].tools == ["Read", "Grep"]
        assert calls[0].system == "You are an analyst"

    @pytest.mark.asyncio
    async def test_get_call_by_hash(self, store: RecordingStore) -> None:
        """Test retrieving a call by its content hash."""
        await store.create_recording("test_v1")

        response = SimpleOutput(message="Hello")
        await store.record_call(
            "test_v1",
            prompt="Say hello",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=response,
        )

        call_hash = _compute_call_hash("Say hello", SimpleOutput, None, None)
        call = await store.get_call_by_hash("test_v1", call_hash)

        assert call is not None
        assert call.prompt == "Say hello"

    @pytest.mark.asyncio
    async def test_get_call_by_sequence(self, store: RecordingStore) -> None:
        """Test retrieving a call by its sequence number."""
        await store.create_recording("test_v1")

        await store.record_call(
            "test_v1",
            prompt="First",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="1"),
        )
        await store.record_call(
            "test_v1",
            prompt="Second",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="2"),
        )

        call = await store.get_call_by_sequence("test_v1", 1)
        assert call is not None
        assert call.prompt == "Second"

    @pytest.mark.asyncio
    async def test_list_recordings(self, store: RecordingStore) -> None:
        """Test listing all recordings."""
        await store.create_recording("test_v1", "First")
        await store.create_recording("test_v2", "Second")

        recordings = await store.list_recordings()
        assert len(recordings) == 2
        # Most recent first
        ids = [r.recording_id for r in recordings]
        assert "test_v1" in ids
        assert "test_v2" in ids

    @pytest.mark.asyncio
    async def test_delete_recording(self, store: RecordingStore) -> None:
        """Test deleting a recording."""
        await store.create_recording("test_v1")
        await store.record_call(
            "test_v1",
            prompt="Test",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="Test"),
        )

        deleted = await store.delete_recording("test_v1")
        assert deleted is True

        assert not await store.recording_exists("test_v1")
        calls = await store.get_calls("test_v1")
        assert len(calls) == 0

    @pytest.mark.asyncio
    async def test_delete_nonexistent_recording(self, store: RecordingStore) -> None:
        """Test deleting a nonexistent recording returns False."""
        deleted = await store.delete_recording("nonexistent")
        assert deleted is False


class TestCallHash:
    """Tests for call hash computation."""

    def test_same_inputs_same_hash(self) -> None:
        """Test that identical inputs produce the same hash."""
        hash1 = _compute_call_hash("Hello", SimpleOutput, None, None)
        hash2 = _compute_call_hash("Hello", SimpleOutput, None, None)
        assert hash1 == hash2

    def test_different_prompt_different_hash(self) -> None:
        """Test that different prompts produce different hashes."""
        hash1 = _compute_call_hash("Hello", SimpleOutput, None, None)
        hash2 = _compute_call_hash("Goodbye", SimpleOutput, None, None)
        assert hash1 != hash2

    def test_different_output_type_different_hash(self) -> None:
        """Test that different output types produce different hashes."""
        hash1 = _compute_call_hash("Hello", SimpleOutput, None, None)
        hash2 = _compute_call_hash("Hello", AnalysisOutput, None, None)
        assert hash1 != hash2

    def test_different_tools_different_hash(self) -> None:
        """Test that different tools produce different hashes."""
        hash1 = _compute_call_hash("Hello", SimpleOutput, ["Read"], None)
        hash2 = _compute_call_hash("Hello", SimpleOutput, ["Edit"], None)
        assert hash1 != hash2

    def test_tools_order_normalized(self) -> None:
        """Test that tool order is normalized in hash computation."""
        hash1 = _compute_call_hash("Hello", SimpleOutput, ["Read", "Edit"], None)
        hash2 = _compute_call_hash("Hello", SimpleOutput, ["Edit", "Read"], None)
        assert hash1 == hash2

    def test_different_system_different_hash(self) -> None:
        """Test that different system prompts produce different hashes."""
        hash1 = _compute_call_hash("Hello", SimpleOutput, None, "System A")
        hash2 = _compute_call_hash("Hello", SimpleOutput, None, "System B")
        assert hash1 != hash2


class TestReplayLLMProvider:
    """Tests for ReplayLLMProvider."""

    @pytest.fixture
    async def store_with_recording(self, tmp_path: Path) -> RecordingStore:
        """Create a store with a pre-recorded session."""
        store = RecordingStore(tmp_path / "recordings.db")
        await store.initialize()
        await store.create_recording("test_v1")

        await store.record_call(
            "test_v1",
            prompt="First prompt",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="First response"),
        )
        await store.record_call(
            "test_v1",
            prompt="Second prompt",
            output_type=AnalysisOutput,
            tools=["Read"],
            system=None,
            response=AnalysisOutput(files=["a.py"], summary="Analysis"),
        )

        await store.finish_recording("test_v1")
        return store

    @pytest.mark.asyncio
    async def test_load_recording(self, store_with_recording: RecordingStore) -> None:
        """Test loading a recording."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1")
        await provider.load()

        assert provider._loaded
        assert len(provider.calls) == 2

    @pytest.mark.asyncio
    async def test_sequential_replay(self, store_with_recording: RecordingStore) -> None:
        """Test replaying calls in sequential order."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1")
        await provider.load()

        result1 = provider.next_response("First prompt", SimpleOutput, None, None)
        assert isinstance(result1, SimpleOutput)
        assert result1.message == "First response"

        result2 = provider.next_response("Second prompt", AnalysisOutput, ["Read"], None)
        assert isinstance(result2, AnalysisOutput)
        assert result2.files == ["a.py"]

    @pytest.mark.asyncio
    async def test_sequential_replay_exhausted(self, store_with_recording: RecordingStore) -> None:
        """Test that sequential replay raises when exhausted."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1")
        await provider.load()

        provider.next_response("First prompt", SimpleOutput, None, None)
        provider.next_response("Second prompt", AnalysisOutput, ["Read"], None)

        with pytest.raises(RuntimeError, match="exhausted"):
            provider.next_response("Third prompt", SimpleOutput, None, None)

    @pytest.mark.asyncio
    async def test_content_addressed_replay(self, store_with_recording: RecordingStore) -> None:
        """Test content-addressed replay (order-independent)."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1", mode="content_addressed")
        await provider.load()

        # Request in reverse order - should still work
        result2 = provider.next_response("Second prompt", AnalysisOutput, ["Read"], None)
        assert result2.files == ["a.py"]

        result1 = provider.next_response("First prompt", SimpleOutput, None, None)
        assert result1.message == "First response"

    @pytest.mark.asyncio
    async def test_output_type_mismatch(self, store_with_recording: RecordingStore) -> None:
        """Test that output type mismatch raises an error."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1")
        await provider.load()

        # First call expects SimpleOutput but we request AnalysisOutput
        with pytest.raises(RuntimeError, match="type mismatch"):
            provider.next_response("First prompt", AnalysisOutput, None, None)

    @pytest.mark.asyncio
    async def test_reset(self, store_with_recording: RecordingStore) -> None:
        """Test resetting the replay provider."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1")
        await provider.load()

        provider.next_response("First prompt", SimpleOutput, None, None)
        assert len(provider.replayed_calls) == 1

        provider.reset()
        assert provider._index == 0
        assert len(provider.replayed_calls) == 0

        # Can replay again
        result = provider.next_response("First prompt", SimpleOutput, None, None)
        assert result.message == "First response"

    @pytest.mark.asyncio
    async def test_load_nonexistent_recording(self, tmp_path: Path) -> None:
        """Test that loading a nonexistent recording raises."""
        store = RecordingStore(tmp_path / "recordings.db")
        await store.initialize()

        provider = ReplayLLMProvider(store, "nonexistent")
        with pytest.raises(ValueError, match="not found"):
            await provider.load()

    @pytest.mark.asyncio
    async def test_next_response_without_load(self, store_with_recording: RecordingStore) -> None:
        """Test that next_response without load raises."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1")

        with pytest.raises(RuntimeError, match="not loaded"):
            provider.next_response("Test", SimpleOutput, None, None)


class TestUseReplayProvider:
    """Tests for the use_replay_provider context manager."""

    @pytest.fixture
    async def store_with_recording(self, tmp_path: Path) -> RecordingStore:
        """Create a store with a pre-recorded session."""
        store = RecordingStore(tmp_path / "recordings.db")
        await store.initialize()
        await store.create_recording("test_v1")
        await store.record_call(
            "test_v1",
            prompt="Test prompt",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="Test response"),
        )
        await store.finish_recording("test_v1")
        return store

    @pytest.mark.asyncio
    async def test_use_replay_provider(self, store_with_recording: RecordingStore) -> None:
        """Test using replay provider context manager."""
        provider = ReplayLLMProvider(store_with_recording, "test_v1")
        await provider.load()

        with use_replay_provider(provider):
            from smithers.testing.fakes import get_fake_llm_provider

            # The replay provider is set as the fake provider
            fake = get_fake_llm_provider()
            assert fake is provider

        # Provider is restored after context
        fake = get_fake_llm_provider()
        assert fake is None


class TestUseReplayAsync:
    """Tests for the use_replay async context manager."""

    @pytest.fixture
    async def recording_path(self, tmp_path: Path) -> Path:
        """Create a database with a recording."""
        db_path = tmp_path / "recordings.db"
        store = RecordingStore(db_path)
        await store.initialize()
        await store.create_recording("test_v1")
        await store.record_call(
            "test_v1",
            prompt="Hello",
            output_type=SimpleOutput,
            tools=None,
            system=None,
            response=SimpleOutput(message="Hello back!"),
        )
        await store.finish_recording("test_v1")
        return db_path

    @pytest.mark.asyncio
    async def test_use_replay_context_manager(self, recording_path: Path) -> None:
        """Test the high-level use_replay context manager."""
        async with use_replay(recording_path, "test_v1") as provider:
            assert provider._loaded
            result = provider.next_response("Hello", SimpleOutput, None, None)
            assert result.message == "Hello back!"


class TestRecordedCall:
    """Tests for RecordedCall dataclass."""

    def test_recorded_call_creation(self) -> None:
        """Test creating a RecordedCall."""
        call = RecordedCall(
            call_id=1,
            recording_id="test",
            sequence_num=0,
            call_hash="abc123",
            prompt="Hello",
            output_type_name="SimpleOutput",
            output_type_schema={"type": "object"},
            tools=["Read"],
            system="System",
            response={"message": "Hi"},
            input_tokens=10,
            output_tokens=5,
            recorded_at=None,
        )
        assert call.call_id == 1
        assert call.tools == ["Read"]


class TestRecording:
    """Tests for Recording dataclass."""

    def test_recording_creation(self) -> None:
        """Test creating a Recording."""
        recording = Recording(
            recording_id="test",
            created_at=None,
            description="Test",
            finished_at=None,
            call_count=5,
        )
        assert recording.recording_id == "test"
        assert recording.call_count == 5


class TestRecordingLLMProvider:
    """Tests for RecordingLLMProvider (unit tests without real API)."""

    @pytest.fixture
    async def store(self, tmp_path: Path) -> RecordingStore:
        store = RecordingStore(tmp_path / "recordings.db")
        await store.initialize()
        return store

    @pytest.mark.asyncio
    async def test_start_creates_recording(self, store: RecordingStore) -> None:
        """Test that starting a provider creates a recording."""
        provider = RecordingLLMProvider(store, "test_v1", "Test description")
        await provider.start()

        recording = await store.get_recording("test_v1")
        assert recording is not None
        assert recording.description == "Test description"

    @pytest.mark.asyncio
    async def test_finish_updates_recording(self, store: RecordingStore) -> None:
        """Test that finishing a provider updates the recording."""
        provider = RecordingLLMProvider(store, "test_v1")
        await provider.start()
        await provider.finish()

        recording = await store.get_recording("test_v1")
        assert recording is not None
        assert recording.finished_at is not None
