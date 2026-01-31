"""
Tests for protocol schema validation.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from agentd.protocol import (
    PROTOCOL_VERSION,
    Event,
    EventType,
    Request,
    ValidationError,
    get_protocol_version,
    validate_event,
    validate_request,
)
from agentd.protocol.validation import VALIDATION_AVAILABLE


class TestProtocolVersion:
    """Tests for protocol version."""

    def test_protocol_version_exists(self):
        assert PROTOCOL_VERSION == "1.0.0"

    def test_get_protocol_version(self):
        assert get_protocol_version() == "1.0.0"


class TestSchemaValidation:
    """Tests for schema validation functions."""

    def test_validate_valid_daemon_ready_event(self):
        event = {
            "type": "daemon.ready",
            "data": {"version": "0.1.0"},
            "timestamp": datetime.now().isoformat(),
        }
        # Should not raise
        validate_event(event)

    def test_validate_invalid_event_missing_type(self):
        event = {
            "data": {},
            "timestamp": datetime.now().isoformat(),
        }
        with pytest.raises(ValidationError, match="type"):
            validate_event(event)

    def test_validate_invalid_event_missing_data(self):
        event = {
            "type": "daemon.ready",
            "timestamp": datetime.now().isoformat(),
        }
        with pytest.raises(ValidationError, match="data"):
            validate_event(event)

    def test_validate_invalid_event_missing_timestamp(self):
        event = {
            "type": "daemon.ready",
            "data": {"version": "0.1.0"},
        }
        with pytest.raises(ValidationError, match="timestamp"):
            validate_event(event)

    @pytest.mark.skipif(not VALIDATION_AVAILABLE, reason="Requires jsonschema for full validation")
    def test_validate_invalid_event_unknown_type(self):
        event = {
            "type": "unknown.type",
            "data": {},
            "timestamp": datetime.now().isoformat(),
        }
        with pytest.raises(ValidationError):
            validate_event(event)

    def test_validate_valid_request(self):
        request = {
            "id": "req-1",
            "method": "session.create",
            "params": {},
        }
        # Should not raise
        validate_request(request)

    def test_validate_invalid_request_missing_id(self):
        request = {
            "method": "session.create",
            "params": {},
        }
        with pytest.raises(ValidationError, match="id"):
            validate_request(request)

    @pytest.mark.skipif(not VALIDATION_AVAILABLE, reason="Requires jsonschema for full validation")
    def test_validate_invalid_request_unknown_method(self):
        request = {
            "id": "req-1",
            "method": "unknown.method",
            "params": {},
        }
        with pytest.raises(ValidationError):
            validate_request(request)


class TestEventValidation:
    """Tests for Event.validate() method."""

    def test_event_validate_success(self):
        event = Event(
            type=EventType.DAEMON_READY,
            data={"version": "0.1.0"},
        )
        # Should not raise
        event.validate()

    def test_event_validate_session_created(self):
        event = Event(
            type=EventType.SESSION_CREATED,
            data={"session_id": "sess-1"},
        )
        event.validate()

    def test_event_validate_run_started(self):
        event = Event(
            type=EventType.RUN_STARTED,
            data={"run_id": "run-1", "session_id": "sess-1"},
        )
        event.validate()

    def test_event_validate_assistant_delta(self):
        event = Event(
            type=EventType.ASSISTANT_DELTA,
            data={"text": "Hello world"},
        )
        event.validate()

    def test_event_validate_tool_start(self):
        event = Event(
            type=EventType.TOOL_START,
            data={
                "tool_use_id": "t1",
                "name": "Read",
                "input": {"path": "/test"},
            },
        )
        event.validate()

    def test_event_validate_checkpoint_created(self):
        event = Event(
            type=EventType.CHECKPOINT_CREATED,
            data={
                "checkpoint_id": "cp-1",
                "label": "Test checkpoint",
                "stack_position": 0,
            },
        )
        event.validate()


class TestRequestValidation:
    """Tests for Request.validate() method."""

    def test_request_validate_success(self):
        request = Request(
            id="req-1",
            method="session.create",
            params={},
        )
        # Should not raise
        request.validate()

    def test_request_validate_session_send(self):
        request = Request(
            id="req-2",
            method="session.send",
            params={"message": "Hello"},
        )
        request.validate()

    def test_request_validate_run_cancel(self):
        request = Request(
            id="req-3",
            method="run.cancel",
            params={"run_id": "run-1"},
        )
        request.validate()


class TestGoldenFixtures:
    """Test that golden fixtures validate correctly."""

    def test_golden_events_validate(self):
        fixtures_path = Path(__file__).parent / "fixtures" / "golden_events.json"
        with open(fixtures_path) as f:
            events = json.load(f)

        for event_dict in events:
            # Should not raise
            validate_event(event_dict)


@pytest.mark.skipif(not VALIDATION_AVAILABLE, reason="Requires jsonschema for full validation")
class TestEventDataRequirements:
    """Test specific data requirements for each event type."""

    def test_daemon_ready_requires_version(self):
        event = Event(
            type=EventType.DAEMON_READY,
            data={},  # Missing version
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_session_created_requires_session_id(self):
        event = Event(
            type=EventType.SESSION_CREATED,
            data={},  # Missing session_id
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_run_started_requires_run_id_and_session_id(self):
        event = Event(
            type=EventType.RUN_STARTED,
            data={"run_id": "run-1"},  # Missing session_id
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_assistant_delta_requires_text(self):
        event = Event(
            type=EventType.ASSISTANT_DELTA,
            data={},  # Missing text
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_assistant_final_requires_message_id(self):
        event = Event(
            type=EventType.ASSISTANT_FINAL,
            data={},  # Missing message_id
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_tool_start_requires_all_fields(self):
        # Missing input
        event = Event(
            type=EventType.TOOL_START,
            data={
                "tool_use_id": "t1",
                "name": "Read",
            },
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_tool_end_requires_status(self):
        event = Event(
            type=EventType.TOOL_END,
            data={"tool_use_id": "t1"},  # Missing status
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_tool_end_status_must_be_valid(self):
        event = Event(
            type=EventType.TOOL_END,
            data={
                "tool_use_id": "t1",
                "status": "invalid",  # Not "success" or "error"
            },
        )
        with pytest.raises(ValidationError):
            event.validate()

    def test_checkpoint_created_requires_id_and_label(self):
        event = Event(
            type=EventType.CHECKPOINT_CREATED,
            data={"checkpoint_id": "cp-1"},  # Missing label
        )
        with pytest.raises(ValidationError):
            event.validate()


@pytest.mark.skipif(not VALIDATION_AVAILABLE, reason="Requires jsonschema for full validation")
class TestRequestDataRequirements:
    """Test request method validation."""

    def test_request_method_must_be_valid(self):
        request = Request(
            id="req-1",
            method="invalid.method",
            params={},
        )
        with pytest.raises(ValidationError):
            request.validate()

    def test_request_to_dict(self):
        request = Request(
            id="req-1",
            method="session.create",
            params={"workspace": "/test"},
        )
        data = request.to_dict()
        assert data == {
            "id": "req-1",
            "method": "session.create",
            "params": {"workspace": "/test"},
        }


class TestEventToDict:
    """Test Event.to_dict() serialization."""

    def test_event_to_dict_includes_all_fields(self):
        ts = datetime.now()
        event = Event(
            type=EventType.DAEMON_READY,
            data={"version": "0.1.0"},
            timestamp=ts,
        )
        data = event.to_dict()
        assert data["type"] == "daemon.ready"
        assert data["data"] == {"version": "0.1.0"}
        assert data["timestamp"] == ts.isoformat()

    def test_event_to_dict_validates(self):
        event = Event(
            type=EventType.SESSION_CREATED,
            data={"session_id": "test"},
        )
        data = event.to_dict()
        # Should not raise
        validate_event(data)
