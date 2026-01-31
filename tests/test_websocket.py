"""Tests for WebSocket support for real-time progress updates."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import pytest

from smithers.events import Event, EventBus, EventTypes, get_event_bus, reset_event_bus
from smithers.websocket import (
    ClientConnection,
    ConnectionStats,
    WebSocketMessage,
    WebSocketServer,
    error_message,
    get_websocket_server,
    progress_message,
    reset_websocket_server,
    set_websocket_server,
    status_message,
)


@dataclass
class MockWebSocket:
    """Mock WebSocket connection for testing."""

    sent_messages: list[str] = field(default_factory=list)
    received_messages: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    _closed: bool = False
    close_code: int | None = None
    close_reason: str | None = None

    async def send(self, message: str) -> None:
        """Record sent message."""
        if self._closed:
            raise ConnectionError("Connection closed")
        self.sent_messages.append(message)

    async def recv(self) -> str:
        """Return next received message or wait."""
        if self._closed:
            raise ConnectionError("Connection closed")
        return await self.received_messages.get()

    async def close(self, code: int = 1000, reason: str = "") -> None:
        """Close the connection."""
        self._closed = True
        self.close_code = code
        self.close_reason = reason

    @property
    def closed(self) -> bool:
        """Check if connection is closed."""
        return self._closed

    def add_message(self, message: str | dict[str, Any]) -> None:
        """Add a message to be received."""
        if isinstance(message, dict):
            message = json.dumps(message)
        self.received_messages.put_nowait(message)


class TestClientConnection:
    """Tests for ClientConnection class."""

    def test_create_connection(self) -> None:
        """Test creating a client connection."""
        client = ClientConnection()
        assert client.id is not None
        assert client.websocket is None
        assert client.connected_at is not None
        assert client.subscribed_runs == set()
        assert client.event_filter == set()
        assert client.metadata == {}
        assert not client.is_closed

    def test_connection_with_websocket(self) -> None:
        """Test connection with WebSocket attached."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        assert client.websocket is ws
        assert not client.is_closed

    @pytest.mark.asyncio
    async def test_send_message(self) -> None:
        """Test sending a message through the connection."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        result = await client.send("hello")
        assert result is True
        assert ws.sent_messages == ["hello"]

    @pytest.mark.asyncio
    async def test_send_json(self) -> None:
        """Test sending JSON message."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        result = await client.send_json({"type": "test", "data": 123})
        assert result is True
        assert len(ws.sent_messages) == 1
        assert json.loads(ws.sent_messages[0]) == {"type": "test", "data": 123}

    @pytest.mark.asyncio
    async def test_send_to_closed_connection(self) -> None:
        """Test sending to a closed connection."""
        ws = MockWebSocket()
        ws._closed = True
        client = ClientConnection(websocket=ws)

        result = await client.send("hello")
        assert result is False

    @pytest.mark.asyncio
    async def test_send_without_websocket(self) -> None:
        """Test sending without a websocket attached."""
        client = ClientConnection()
        result = await client.send("hello")
        assert result is False

    def test_should_receive_event_no_filters(self) -> None:
        """Test event filtering with no filters (receives all)."""
        client = ClientConnection()
        event = Event(type="NodeStarted", run_id="run-123", node_id="node-1")

        assert client.should_receive_event(event) is True

    def test_should_receive_event_run_filter_match(self) -> None:
        """Test event filtering with matching run filter."""
        client = ClientConnection(subscribed_runs={"run-123"})
        event = Event(type="NodeStarted", run_id="run-123", node_id="node-1")

        assert client.should_receive_event(event) is True

    def test_should_receive_event_run_filter_no_match(self) -> None:
        """Test event filtering with non-matching run filter."""
        client = ClientConnection(subscribed_runs={"run-456"})
        event = Event(type="NodeStarted", run_id="run-123", node_id="node-1")

        assert client.should_receive_event(event) is False

    def test_should_receive_event_type_filter_match(self) -> None:
        """Test event filtering with matching type filter."""
        client = ClientConnection(event_filter={"NodeStarted", "NodeFinished"})
        event = Event(type="NodeStarted", run_id="run-123", node_id="node-1")

        assert client.should_receive_event(event) is True

    def test_should_receive_event_type_filter_no_match(self) -> None:
        """Test event filtering with non-matching type filter."""
        client = ClientConnection(event_filter={"NodeFinished"})
        event = Event(type="NodeStarted", run_id="run-123", node_id="node-1")

        assert client.should_receive_event(event) is False

    def test_should_receive_event_combined_filters(self) -> None:
        """Test event filtering with both run and type filters."""
        client = ClientConnection(
            subscribed_runs={"run-123"},
            event_filter={"NodeStarted"},
        )

        # Both match
        event1 = Event(type="NodeStarted", run_id="run-123", node_id="node-1")
        assert client.should_receive_event(event1) is True

        # Run doesn't match
        event2 = Event(type="NodeStarted", run_id="run-456", node_id="node-1")
        assert client.should_receive_event(event2) is False

        # Type doesn't match
        event3 = Event(type="NodeFinished", run_id="run-123", node_id="node-1")
        assert client.should_receive_event(event3) is False

    def test_close_connection(self) -> None:
        """Test closing a connection."""
        client = ClientConnection()
        assert not client.is_closed

        client.close()
        assert client.is_closed


class TestConnectionStats:
    """Tests for ConnectionStats class."""

    def test_default_stats(self) -> None:
        """Test default stats values."""
        stats = ConnectionStats()
        assert stats.total_connections == 0
        assert stats.active_connections == 0
        assert stats.messages_sent == 0
        assert stats.messages_received == 0
        assert stats.events_broadcast == 0
        assert stats.errors == 0


class TestWebSocketServer:
    """Tests for WebSocketServer class."""

    @pytest.fixture
    def server(self) -> WebSocketServer:
        """Create a test server."""
        return WebSocketServer(auto_subscribe=False, heartbeat_interval=0)

    @pytest.fixture
    def event_bus(self) -> EventBus:
        """Create a test event bus."""
        return EventBus()

    def test_create_server(self) -> None:
        """Test creating a WebSocket server."""
        server = WebSocketServer()
        assert not server.is_running
        assert server.client_count == 0

    def test_create_server_with_event_bus(self, event_bus: EventBus) -> None:
        """Test creating server with custom event bus."""
        server = WebSocketServer(event_bus=event_bus)
        assert server.get_event_bus() is event_bus

    def test_get_default_event_bus(self, server: WebSocketServer) -> None:
        """Test getting default global event bus."""
        bus = server.get_event_bus()
        assert bus is not None
        assert bus is get_event_bus()

    def test_initial_stats(self, server: WebSocketServer) -> None:
        """Test initial server stats."""
        stats = server.stats
        assert stats.total_connections == 0
        assert stats.active_connections == 0
        assert stats.messages_sent == 0

    @pytest.mark.asyncio
    async def test_broadcast_no_clients(self, server: WebSocketServer) -> None:
        """Test broadcasting with no connected clients."""
        count = await server.broadcast({"type": "test"})
        assert count == 0

    @pytest.mark.asyncio
    async def test_broadcast_to_clients(self, server: WebSocketServer) -> None:
        """Test broadcasting to connected clients."""
        # Manually add clients
        ws1 = MockWebSocket()
        ws2 = MockWebSocket()
        client1 = ClientConnection(websocket=ws1)
        client2 = ClientConnection(websocket=ws2)
        server._clients[client1.id] = client1
        server._clients[client2.id] = client2

        count = await server.broadcast({"type": "test", "data": "hello"})
        assert count == 2
        assert len(ws1.sent_messages) == 1
        assert len(ws2.sent_messages) == 1
        assert json.loads(ws1.sent_messages[0]) == {"type": "test", "data": "hello"}

    @pytest.mark.asyncio
    async def test_broadcast_with_run_filter(self, server: WebSocketServer) -> None:
        """Test broadcasting filters by run_id."""
        ws1 = MockWebSocket()
        ws2 = MockWebSocket()
        client1 = ClientConnection(websocket=ws1, subscribed_runs={"run-123"})
        client2 = ClientConnection(websocket=ws2, subscribed_runs={"run-456"})
        server._clients[client1.id] = client1
        server._clients[client2.id] = client2

        count = await server.broadcast({"type": "test"}, run_id="run-123")
        assert count == 1
        assert len(ws1.sent_messages) == 1
        assert len(ws2.sent_messages) == 0

    @pytest.mark.asyncio
    async def test_broadcast_with_event_type_filter(self, server: WebSocketServer) -> None:
        """Test broadcasting filters by event type."""
        ws1 = MockWebSocket()
        ws2 = MockWebSocket()
        client1 = ClientConnection(websocket=ws1, event_filter={"NodeStarted"})
        client2 = ClientConnection(websocket=ws2, event_filter={"NodeFinished"})
        server._clients[client1.id] = client1
        server._clients[client2.id] = client2

        count = await server.broadcast({"type": "test"}, event_type="NodeStarted")
        assert count == 1
        assert len(ws1.sent_messages) == 1
        assert len(ws2.sent_messages) == 0

    @pytest.mark.asyncio
    async def test_broadcast_removes_failed_clients(self, server: WebSocketServer) -> None:
        """Test that failed clients are removed during broadcast."""
        ws1 = MockWebSocket()
        ws2 = MockWebSocket()
        ws2._closed = True  # Simulate closed connection
        client1 = ClientConnection(websocket=ws1)
        client2 = ClientConnection(websocket=ws2)
        server._clients[client1.id] = client1
        server._clients[client2.id] = client2

        count = await server.broadcast({"type": "test"})
        assert count == 1
        assert client1.id in server._clients
        assert client2.id not in server._clients

    @pytest.mark.asyncio
    async def test_send_to_client(self, server: WebSocketServer) -> None:
        """Test sending to a specific client."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        result = await server.send_to_client(client.id, {"type": "direct"})
        assert result is True
        assert len(ws.sent_messages) == 1

    @pytest.mark.asyncio
    async def test_send_to_nonexistent_client(self, server: WebSocketServer) -> None:
        """Test sending to a client that doesn't exist."""
        result = await server.send_to_client("nonexistent", {"type": "test"})
        assert result is False

    def test_get_client(self, server: WebSocketServer) -> None:
        """Test getting a client by ID."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        found = server.get_client(client.id)
        assert found is client

        not_found = server.get_client("nonexistent")
        assert not_found is None

    def test_get_clients_for_run(self, server: WebSocketServer) -> None:
        """Test getting clients subscribed to a run."""
        client1 = ClientConnection(subscribed_runs={"run-123"})
        client2 = ClientConnection(subscribed_runs={"run-456"})
        client3 = ClientConnection()  # No filter = all runs
        server._clients[client1.id] = client1
        server._clients[client2.id] = client2
        server._clients[client3.id] = client3

        clients = server.get_clients_for_run("run-123")
        assert len(clients) == 2
        assert client1 in clients
        assert client3 in clients
        assert client2 not in clients

    @pytest.mark.asyncio
    async def test_handle_ping_message(self, server: WebSocketServer) -> None:
        """Test handling ping message from client."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        await server._handle_client_message(client, {"action": "ping"})

        assert len(ws.sent_messages) == 1
        response = json.loads(ws.sent_messages[0])
        assert response["type"] == "pong"
        assert "server_time" in response
        assert client.last_ping is not None

    @pytest.mark.asyncio
    async def test_handle_subscribe_message(self, server: WebSocketServer) -> None:
        """Test handling subscribe message from client."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        await server._handle_client_message(client, {"action": "subscribe", "run_id": "run-123"})

        assert "run-123" in client.subscribed_runs
        assert len(ws.sent_messages) == 1
        response = json.loads(ws.sent_messages[0])
        assert response["type"] == "subscribed"
        assert response["run_id"] == "run-123"

    @pytest.mark.asyncio
    async def test_handle_unsubscribe_message(self, server: WebSocketServer) -> None:
        """Test handling unsubscribe message from client."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws, subscribed_runs={"run-123", "run-456"})

        await server._handle_client_message(client, {"action": "unsubscribe", "run_id": "run-123"})

        assert "run-123" not in client.subscribed_runs
        assert "run-456" in client.subscribed_runs

    @pytest.mark.asyncio
    async def test_handle_subscribe_all_message(self, server: WebSocketServer) -> None:
        """Test handling subscribe_all message from client."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws, subscribed_runs={"run-123"})

        await server._handle_client_message(client, {"action": "subscribe_all"})

        assert client.subscribed_runs == set()
        response = json.loads(ws.sent_messages[0])
        assert response["type"] == "subscribed_all"

    @pytest.mark.asyncio
    async def test_handle_filter_message(self, server: WebSocketServer) -> None:
        """Test handling filter message from client."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        await server._handle_client_message(
            client, {"action": "filter", "event_types": ["NodeStarted", "NodeFinished"]}
        )

        assert client.event_filter == {"NodeStarted", "NodeFinished"}
        response = json.loads(ws.sent_messages[0])
        assert response["type"] == "filter_set"

    @pytest.mark.asyncio
    async def test_handle_clear_filter_message(self, server: WebSocketServer) -> None:
        """Test handling clear_filter message from client."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws, event_filter={"NodeStarted"})

        await server._handle_client_message(client, {"action": "clear_filter"})

        assert client.event_filter == set()
        response = json.loads(ws.sent_messages[0])
        assert response["type"] == "filter_cleared"

    @pytest.mark.asyncio
    async def test_handle_status_message(self, server: WebSocketServer) -> None:
        """Test handling status message from client."""
        ws = MockWebSocket()
        client = ClientConnection(
            websocket=ws, subscribed_runs={"run-123"}, event_filter={"NodeStarted"}
        )

        await server._handle_client_message(client, {"action": "status"})

        response = json.loads(ws.sent_messages[0])
        assert response["type"] == "status"
        assert response["client_id"] == client.id
        assert "run-123" in response["subscribed_runs"]
        assert "NodeStarted" in response["event_filter"]

    @pytest.mark.asyncio
    async def test_custom_message_handler(self) -> None:
        """Test custom message handler is called."""
        handler_called = []

        def custom_handler(client: ClientConnection, data: dict[str, Any]) -> None:
            handler_called.append((client.id, data))

        server = WebSocketServer(
            auto_subscribe=False, heartbeat_interval=0, message_handler=custom_handler
        )
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        await server._handle_client_message(client, {"action": "custom", "value": 42})

        assert len(handler_called) == 1
        assert handler_called[0][0] == client.id
        assert handler_called[0][1] == {"action": "custom", "value": 42}

    @pytest.mark.asyncio
    async def test_event_bus_integration(self, event_bus: EventBus) -> None:
        """Test EventBus integration broadcasts events."""
        server = WebSocketServer(event_bus=event_bus, auto_subscribe=True, heartbeat_interval=0)

        # Manually set running and subscribe
        server._running = True
        server._event_subscription = event_bus.subscribe_all(server._on_event)

        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        # Emit an event
        event = Event(
            type="NodeStarted",
            run_id="run-123",
            node_id="analyze",
            payload={"workflow": "analyze"},
        )
        await event_bus.emit(event)

        # Wait a moment for async handling
        await asyncio.sleep(0.1)

        # Check that event was broadcast
        assert len(ws.sent_messages) >= 1
        message = json.loads(ws.sent_messages[-1])
        assert message["type"] == "NodeStarted"
        assert message["run_id"] == "run-123"
        assert message["node_id"] == "analyze"

    @pytest.mark.asyncio
    async def test_broadcast_event_direct(self) -> None:
        """Test _broadcast_event method directly."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)
        server._running = True

        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        event = Event(
            type="NodeFinished",
            run_id="run-456",
            node_id="deploy",
            payload={"duration_ms": 1500},
        )
        await server._broadcast_event(event)

        assert len(ws.sent_messages) == 1
        message = json.loads(ws.sent_messages[0])
        assert message["type"] == "NodeFinished"
        assert message["run_id"] == "run-456"
        assert message["node_id"] == "deploy"
        assert message["payload"]["duration_ms"] == 1500

    @pytest.mark.asyncio
    async def test_stop_not_running(self, server: WebSocketServer) -> None:
        """Test stopping a server that's not running does nothing."""
        await server.stop()  # Should not raise


class TestWebSocketMessage:
    """Tests for WebSocketMessage class."""

    def test_create_message(self) -> None:
        """Test creating a WebSocket message."""
        msg = WebSocketMessage(type="test", data={"value": 42})
        assert msg.type == "test"
        assert msg.data == {"value": 42}
        assert msg.run_id is None
        assert msg.node_id is None
        assert msg.timestamp is not None

    def test_create_message_with_ids(self) -> None:
        """Test creating message with run and node IDs."""
        msg = WebSocketMessage(type="test", run_id="run-123", node_id="node-1")
        assert msg.run_id == "run-123"
        assert msg.node_id == "node-1"

    def test_to_dict(self) -> None:
        """Test converting message to dictionary."""
        msg = WebSocketMessage(
            type="test",
            data={"value": 42},
            run_id="run-123",
            node_id="node-1",
        )
        d = msg.to_dict()

        assert d["type"] == "test"
        assert d["value"] == 42
        assert d["run_id"] == "run-123"
        assert d["node_id"] == "node-1"
        assert "ts" in d

    def test_to_dict_no_ids(self) -> None:
        """Test to_dict without IDs."""
        msg = WebSocketMessage(type="test", data={"value": 42})
        d = msg.to_dict()

        assert d["type"] == "test"
        assert "run_id" not in d
        assert "node_id" not in d

    def test_to_json(self) -> None:
        """Test converting message to JSON."""
        msg = WebSocketMessage(type="test", data={"value": 42})
        json_str = msg.to_json()

        parsed = json.loads(json_str)
        assert parsed["type"] == "test"
        assert parsed["value"] == 42


class TestMessageFactoryFunctions:
    """Tests for message factory functions."""

    def test_progress_message(self) -> None:
        """Test creating progress message."""
        msg = progress_message("run-123", completed=5, total=10, current_node="analyze")

        d = msg.to_dict()
        assert d["type"] == "progress"
        assert d["run_id"] == "run-123"
        assert d["completed"] == 5
        assert d["total"] == 10
        assert d["percent"] == 50.0
        assert d["current_node"] == "analyze"

    def test_progress_message_zero_total(self) -> None:
        """Test progress message with zero total."""
        msg = progress_message("run-123", completed=0, total=0)
        d = msg.to_dict()
        assert d["percent"] == 0

    def test_error_message(self) -> None:
        """Test creating error message."""
        msg = error_message(
            "Something went wrong",
            run_id="run-123",
            node_id="deploy",
            details={"code": "ERR001"},
        )

        d = msg.to_dict()
        assert d["type"] == "error"
        assert d["run_id"] == "run-123"
        assert d["node_id"] == "deploy"
        assert d["error"] == "Something went wrong"
        assert d["details"] == {"code": "ERR001"}

    def test_error_message_minimal(self) -> None:
        """Test error message with minimal params."""
        msg = error_message("Error")
        d = msg.to_dict()
        assert d["type"] == "error"
        assert d["error"] == "Error"
        assert "details" not in d

    def test_status_message(self) -> None:
        """Test creating status message."""
        nodes = {"analyze": "success", "deploy": "running"}
        msg = status_message("run-123", status="running", nodes=nodes)

        d = msg.to_dict()
        assert d["type"] == "run_status"
        assert d["run_id"] == "run-123"
        assert d["status"] == "running"
        assert d["nodes"] == nodes

    def test_status_message_no_nodes(self) -> None:
        """Test status message without nodes."""
        msg = status_message("run-123", status="completed")
        d = msg.to_dict()
        assert d["status"] == "completed"
        assert "nodes" not in d


class TestGlobalServer:
    """Tests for global server management functions."""

    def teardown_method(self) -> None:
        """Reset global state after each test."""
        reset_websocket_server()
        reset_event_bus()

    def test_get_websocket_server(self) -> None:
        """Test getting global server instance."""
        server = get_websocket_server()
        assert server is not None
        assert isinstance(server, WebSocketServer)

    def test_get_websocket_server_same_instance(self) -> None:
        """Test getting same instance multiple times."""
        server1 = get_websocket_server()
        server2 = get_websocket_server()
        assert server1 is server2

    def test_set_websocket_server(self) -> None:
        """Test setting a custom server."""
        custom_server = WebSocketServer()
        old = set_websocket_server(custom_server)

        current = get_websocket_server()
        assert current is custom_server

        # Restore
        set_websocket_server(old)

    def test_set_websocket_server_returns_previous(self) -> None:
        """Test that set returns previous instance."""
        server1 = get_websocket_server()
        server2 = WebSocketServer()

        returned = set_websocket_server(server2)
        assert returned is server1

    def test_reset_websocket_server(self) -> None:
        """Test resetting the global server."""
        server1 = get_websocket_server()
        reset_websocket_server()
        server2 = get_websocket_server()

        assert server1 is not server2


class TestServerWithMockedWebsockets:
    """Tests that mock the websockets library."""

    @pytest.mark.asyncio
    async def test_start_without_websockets_raises(self) -> None:
        """Test that starting without websockets library raises ImportError."""
        server = WebSocketServer(auto_subscribe=False)

        # This will fail if websockets is not installed
        # We expect an ImportError
        try:
            await server.start()
            # If we get here, websockets is installed - stop the server
            await server.stop()
        except ImportError as e:
            assert "websockets" in str(e).lower()

    @pytest.mark.asyncio
    async def test_stop_clears_clients(self) -> None:
        """Test that stopping server clears clients."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)
        server._running = True

        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        await server.stop()

        assert server.client_count == 0
        assert not server.is_running


class TestEventIntegration:
    """Integration tests for WebSocket + EventBus."""

    def teardown_method(self) -> None:
        """Clean up after tests."""
        reset_event_bus()
        reset_websocket_server()

    @pytest.mark.asyncio
    async def test_full_event_flow(self) -> None:
        """Test full flow from event emission to client delivery."""
        bus = EventBus()
        server = WebSocketServer(event_bus=bus, auto_subscribe=True, heartbeat_interval=0)
        server._running = True
        server._event_subscription = bus.subscribe_all(server._on_event)

        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        # Emit workflow events
        events = [
            Event(type=EventTypes.RUN_STARTED, run_id="run-1", payload={"target": "deploy"}),
            Event(type=EventTypes.NODE_STARTED, run_id="run-1", node_id="analyze"),
            Event(type=EventTypes.NODE_FINISHED, run_id="run-1", node_id="analyze"),
            Event(type=EventTypes.RUN_FINISHED, run_id="run-1", payload={"status": "success"}),
        ]

        for event in events:
            await bus.emit(event)

        # Wait for async processing
        await asyncio.sleep(0.2)

        # Check all events were received
        assert len(ws.sent_messages) >= 4
        types = [json.loads(m)["type"] for m in ws.sent_messages]
        assert EventTypes.RUN_STARTED in types
        assert EventTypes.NODE_STARTED in types
        assert EventTypes.NODE_FINISHED in types
        assert EventTypes.RUN_FINISHED in types

    @pytest.mark.asyncio
    async def test_filtered_event_flow(self) -> None:
        """Test that client filters work in full flow."""
        bus = EventBus()
        server = WebSocketServer(event_bus=bus, auto_subscribe=True, heartbeat_interval=0)
        server._running = True
        server._event_subscription = bus.subscribe_all(server._on_event)

        # Client only wants NodeStarted events for run-1
        ws = MockWebSocket()
        client = ClientConnection(
            websocket=ws,
            subscribed_runs={"run-1"},
            event_filter={EventTypes.NODE_STARTED},
        )
        server._clients[client.id] = client

        # Emit various events
        await bus.emit(Event(type=EventTypes.RUN_STARTED, run_id="run-1"))
        await bus.emit(Event(type=EventTypes.NODE_STARTED, run_id="run-1", node_id="a"))
        await bus.emit(
            Event(type=EventTypes.NODE_STARTED, run_id="run-2", node_id="b")
        )  # Wrong run
        await bus.emit(Event(type=EventTypes.NODE_FINISHED, run_id="run-1", node_id="a"))
        await bus.emit(Event(type=EventTypes.NODE_STARTED, run_id="run-1", node_id="c"))

        await asyncio.sleep(0.2)

        # Should only get NodeStarted events for run-1
        messages = [json.loads(m) for m in ws.sent_messages]
        assert len(messages) == 2
        assert all(m["type"] == EventTypes.NODE_STARTED for m in messages)
        assert all(m["run_id"] == "run-1" for m in messages)


class TestServerStatsTracking:
    """Tests for server statistics tracking."""

    @pytest.mark.asyncio
    async def test_stats_updated_on_broadcast(self) -> None:
        """Test that stats are updated during broadcast."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)

        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        await server.broadcast({"type": "test1"})
        await server.broadcast({"type": "test2"})
        await server.broadcast({"type": "test3"})

        assert server.stats.messages_sent == 3
        assert server.stats.events_broadcast == 3

    @pytest.mark.asyncio
    async def test_stats_updated_on_send_to_client(self) -> None:
        """Test that stats are updated on direct send."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)

        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        await server.send_to_client(client.id, {"type": "direct"})

        assert server.stats.messages_sent == 1


class TestClientConnectionEdgeCases:
    """Edge case tests for ClientConnection."""

    @pytest.mark.asyncio
    async def test_send_json_with_datetime(self) -> None:
        """Test sending JSON with datetime values."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        now = datetime.now(UTC)
        result = await client.send_json({"time": now, "type": "test"})

        assert result is True
        parsed = json.loads(ws.sent_messages[0])
        assert "time" in parsed

    @pytest.mark.asyncio
    async def test_send_exception_marks_closed(self) -> None:
        """Test that send exception marks connection as closed."""
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        # Make send raise an exception
        async def failing_send(msg: str) -> None:
            raise ConnectionError("Connection lost")

        ws.send = failing_send  # type: ignore

        result = await client.send("test")
        assert result is False
        assert client.is_closed


class TestWebSocketServerMessageHandling:
    """Tests for message handling edge cases."""

    @pytest.mark.asyncio
    async def test_handle_invalid_filter_type(self) -> None:
        """Test handling filter with invalid event_types value."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        # Send filter with non-list value
        await server._handle_client_message(
            client, {"action": "filter", "event_types": "not_a_list"}
        )

        # Should not crash, filter remains unchanged
        assert client.event_filter == set()

    @pytest.mark.asyncio
    async def test_handle_subscribe_without_run_id(self) -> None:
        """Test handling subscribe without run_id."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        await server._handle_client_message(client, {"action": "subscribe"})

        # Should not add anything
        assert client.subscribed_runs == set()
        assert len(ws.sent_messages) == 0

    @pytest.mark.asyncio
    async def test_handle_unknown_action(self) -> None:
        """Test handling unknown action."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        await server._handle_client_message(client, {"action": "unknown_action"})

        # Should not crash, no messages sent
        assert len(ws.sent_messages) == 0

    @pytest.mark.asyncio
    async def test_custom_handler_exception_ignored(self) -> None:
        """Test that custom handler exceptions are caught."""

        def failing_handler(client: ClientConnection, data: dict[str, Any]) -> None:
            raise ValueError("Handler failed")

        server = WebSocketServer(
            auto_subscribe=False, heartbeat_interval=0, message_handler=failing_handler
        )
        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)

        # Should not raise
        await server._handle_client_message(client, {"action": "test"})


class TestOnEventSyncEntry:
    """Tests for _on_event sync entry point."""

    def test_on_event_not_running(self) -> None:
        """Test _on_event when server not running."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)
        event = Event(type="test", run_id="run-1")

        # Should not raise
        server._on_event(event)

    @pytest.mark.asyncio
    async def test_on_event_running(self) -> None:
        """Test _on_event when server is running."""
        server = WebSocketServer(auto_subscribe=False, heartbeat_interval=0)
        server._running = True

        ws = MockWebSocket()
        client = ClientConnection(websocket=ws)
        server._clients[client.id] = client

        event = Event(type="test", run_id="run-1")
        server._on_event(event)

        # Wait for async task
        await asyncio.sleep(0.1)

        assert len(ws.sent_messages) >= 1
