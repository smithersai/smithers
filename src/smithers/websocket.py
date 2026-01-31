"""WebSocket support for real-time progress updates to web UIs.

This module provides WebSocket server functionality for broadcasting workflow
execution events to connected clients in real-time. It integrates with the
EventBus to automatically forward events to WebSocket clients.

Key Features:
- Broadcast events to all connected clients
- Subscribe to specific runs via rooms
- Filter events by type
- Automatic reconnection support on client side
- Heartbeat/ping-pong for connection health
- JSON message protocol for easy integration

Example usage:
    from smithers.websocket import WebSocketServer, get_websocket_server

    # Create and start server
    server = get_websocket_server()
    await server.start(host="localhost", port=8765)

    # The server automatically subscribes to the global EventBus
    # All events are broadcast to connected clients

    # Or manually broadcast messages
    await server.broadcast({"type": "custom", "data": "hello"})

    # Stop the server
    await server.stop()

Client Protocol:
    Connect: ws://localhost:8765

    Subscribe to specific run:
        {"action": "subscribe", "run_id": "run-123"}

    Unsubscribe from run:
        {"action": "unsubscribe", "run_id": "run-123"}

    Filter by event types:
        {"action": "filter", "event_types": ["NodeStarted", "NodeFinished"]}

    Ping/heartbeat:
        {"action": "ping"}

    Server responses are JSON events:
        {"type": "NodeStarted", "run_id": "run-123", "node_id": "analyze", ...}
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Protocol
from uuid import uuid4

from smithers.events import Event, EventBus, Subscription, get_event_bus

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class WebSocketProtocol(Protocol):
    """Protocol for WebSocket connection objects."""

    async def send(self, message: str) -> None:
        """Send a message to the client."""
        ...

    async def recv(self) -> str:
        """Receive a message from the client."""
        ...

    async def close(self, code: int = 1000, reason: str = "") -> None:
        """Close the connection."""
        ...

    @property
    def closed(self) -> bool:
        """Check if connection is closed."""
        ...


@dataclass
class ClientConnection:
    """Represents a connected WebSocket client.

    Attributes:
        id: Unique identifier for this connection
        websocket: The underlying WebSocket connection
        connected_at: When the client connected
        subscribed_runs: Set of run_ids this client is subscribed to (empty = all runs)
        event_filter: Set of event types to receive (empty = all events)
        metadata: Optional client-provided metadata
    """

    id: str = field(default_factory=lambda: str(uuid4()))
    websocket: WebSocketProtocol | None = None
    connected_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    subscribed_runs: set[str] = field(default_factory=lambda: set[str]())
    event_filter: set[str] = field(default_factory=lambda: set[str]())
    metadata: dict[str, Any] = field(default_factory=lambda: {})
    last_ping: datetime | None = None
    _send_queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue[str]())
    _closed: bool = False

    async def send(self, message: str) -> bool:
        """Send a message to this client.

        Returns:
            True if message was sent, False if connection is closed
        """
        if self._closed or self.websocket is None:
            return False
        try:
            await self.websocket.send(message)
            return True
        except Exception:
            self._closed = True
            return False

    async def send_json(self, data: dict[str, Any]) -> bool:
        """Send a JSON message to this client.

        Returns:
            True if message was sent, False if connection is closed
        """
        try:
            message = json.dumps(data, default=str)
            return await self.send(message)
        except Exception:
            return False

    def should_receive_event(self, event: Event) -> bool:
        """Check if this client should receive the given event.

        Returns:
            True if the event passes the client's filters
        """
        # Check run filter
        if self.subscribed_runs and event.run_id not in self.subscribed_runs:
            return False

        # Check event type filter
        if self.event_filter and event.type not in self.event_filter:
            return False

        return True

    def close(self) -> None:
        """Mark connection as closed."""
        self._closed = True

    @property
    def is_closed(self) -> bool:
        """Check if connection is closed."""
        return self._closed


@dataclass
class ConnectionStats:
    """Statistics about WebSocket connections."""

    total_connections: int = 0
    active_connections: int = 0
    messages_sent: int = 0
    messages_received: int = 0
    events_broadcast: int = 0
    errors: int = 0


class WebSocketServer:
    """WebSocket server for broadcasting workflow events to connected clients.

    The server integrates with the Smithers EventBus to automatically forward
    workflow execution events to all connected WebSocket clients.

    Features:
    - Broadcast events to all clients or filtered subsets
    - Room-based subscriptions for specific runs
    - Event type filtering per client
    - Connection lifecycle management
    - Heartbeat/ping-pong for connection health
    - Statistics and monitoring

    Example:
        server = WebSocketServer()
        await server.start(host="localhost", port=8765)

        # Server is now accepting connections and broadcasting events
        # ...

        await server.stop()
    """

    def __init__(
        self,
        event_bus: EventBus | None = None,
        auto_subscribe: bool = True,
        heartbeat_interval: float = 30.0,
        message_handler: Callable[[ClientConnection, dict[str, Any]], None] | None = None,
    ) -> None:
        """Initialize the WebSocket server.

        Args:
            event_bus: EventBus to subscribe to (defaults to global bus)
            auto_subscribe: If True, automatically subscribe to EventBus on start
            heartbeat_interval: Seconds between heartbeat pings (0 to disable)
            message_handler: Optional custom handler for client messages
        """
        self._event_bus = event_bus
        self._auto_subscribe = auto_subscribe
        self._heartbeat_interval = heartbeat_interval
        self._custom_message_handler = message_handler

        self._clients: dict[str, ClientConnection] = {}
        self._server: Any = None  # Will be set when started
        self._running = False
        self._event_subscription: Subscription | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None

        self._stats = ConnectionStats()
        self._lock = asyncio.Lock()

    @property
    def is_running(self) -> bool:
        """Check if the server is currently running."""
        return self._running

    @property
    def client_count(self) -> int:
        """Get the number of connected clients."""
        return len(self._clients)

    @property
    def stats(self) -> ConnectionStats:
        """Get server statistics."""
        return self._stats

    def get_event_bus(self) -> EventBus:
        """Get the event bus (creates global if not set)."""
        if self._event_bus is None:
            self._event_bus = get_event_bus()
        return self._event_bus

    async def start(
        self,
        host: str = "localhost",
        port: int = 8765,
    ) -> None:
        """Start the WebSocket server.

        Args:
            host: Host to bind to
            port: Port to listen on

        Raises:
            RuntimeError: If server is already running
            ImportError: If websockets library is not installed
        """
        if self._running:
            raise RuntimeError("WebSocket server is already running")

        try:
            import websockets
        except ImportError as e:
            raise ImportError(
                "websockets library required for WebSocket support. "
                "Install it with: pip install websockets"
            ) from e

        # Subscribe to event bus if requested
        if self._auto_subscribe:
            bus = self.get_event_bus()
            self._event_subscription = bus.subscribe_all(self._on_event)

        # Start the WebSocket server
        self._server = await websockets.serve(
            self._handle_connection,
            host,
            port,
        )
        self._running = True

        # Start heartbeat task if configured
        if self._heartbeat_interval > 0:
            self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

        logger.info(f"WebSocket server started on ws://{host}:{port}")

    async def stop(self) -> None:
        """Stop the WebSocket server and disconnect all clients."""
        if not self._running:
            return

        self._running = False

        # Cancel heartbeat task
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

        # Unsubscribe from event bus
        if self._event_subscription:
            self._event_subscription.unsubscribe()
            self._event_subscription = None

        # Close all client connections
        async with self._lock:
            for client in list(self._clients.values()):
                try:
                    if client.websocket and not client.is_closed:
                        await client.websocket.close(1001, "Server shutting down")
                except Exception:
                    pass
            self._clients.clear()

        # Stop the server
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

        logger.info("WebSocket server stopped")

    async def broadcast(
        self,
        message: dict[str, Any],
        run_id: str | None = None,
        event_type: str | None = None,
    ) -> int:
        """Broadcast a message to connected clients.

        Args:
            message: The message to broadcast (will be JSON-encoded)
            run_id: If provided, only send to clients subscribed to this run
            event_type: If provided, only send to clients accepting this event type

        Returns:
            Number of clients the message was sent to
        """
        sent_count = 0
        json_message = json.dumps(message, default=str)

        async with self._lock:
            for client in list(self._clients.values()):
                # Check run filter
                if run_id and client.subscribed_runs and run_id not in client.subscribed_runs:
                    continue

                # Check event type filter
                if event_type and client.event_filter and event_type not in client.event_filter:
                    continue

                if await client.send(json_message):
                    sent_count += 1
                    self._stats.messages_sent += 1
                else:
                    # Remove failed clients
                    self._clients.pop(client.id, None)

        self._stats.events_broadcast += 1
        return sent_count

    async def send_to_client(
        self,
        client_id: str,
        message: dict[str, Any],
    ) -> bool:
        """Send a message to a specific client.

        Args:
            client_id: The client ID to send to
            message: The message to send

        Returns:
            True if message was sent, False if client not found or send failed
        """
        async with self._lock:
            client = self._clients.get(client_id)
            if not client:
                return False

            if await client.send_json(message):
                self._stats.messages_sent += 1
                return True
            else:
                self._clients.pop(client_id, None)
                return False

    def get_client(self, client_id: str) -> ClientConnection | None:
        """Get a client connection by ID."""
        return self._clients.get(client_id)

    def get_clients_for_run(self, run_id: str) -> list[ClientConnection]:
        """Get all clients subscribed to a specific run."""
        return [
            client
            for client in self._clients.values()
            if not client.subscribed_runs or run_id in client.subscribed_runs
        ]

    async def _handle_connection(
        self,
        websocket: WebSocketProtocol,
        path: str = "/",
    ) -> None:
        """Handle a new WebSocket connection."""
        client = ClientConnection(websocket=websocket)

        async with self._lock:
            self._clients[client.id] = client
            self._stats.total_connections += 1
            self._stats.active_connections = len(self._clients)

        logger.debug(f"Client {client.id} connected")

        # Send welcome message
        await client.send_json(
            {
                "type": "connected",
                "client_id": client.id,
                "server_time": datetime.now(UTC).isoformat(),
            }
        )

        try:
            async for message in self._receive_messages(websocket):
                try:
                    data = json.loads(message)
                    self._stats.messages_received += 1
                    await self._handle_client_message(client, data)
                except json.JSONDecodeError:
                    await client.send_json(
                        {
                            "type": "error",
                            "error": "Invalid JSON message",
                        }
                    )
                    self._stats.errors += 1
        except Exception as e:
            logger.debug(f"Client {client.id} connection error: {e}")
        finally:
            async with self._lock:
                self._clients.pop(client.id, None)
                self._stats.active_connections = len(self._clients)
                client.close()

            logger.debug(f"Client {client.id} disconnected")

    async def _receive_messages(self, websocket: WebSocketProtocol) -> Any:
        """Async generator to receive messages from a WebSocket."""
        try:
            import websockets

            while True:
                try:
                    message = await websocket.recv()
                    yield message
                except websockets.exceptions.ConnectionClosed:
                    break
        except ImportError:
            # Fallback for testing without websockets installed
            pass

    async def _handle_client_message(
        self,
        client: ClientConnection,
        data: dict[str, Any],
    ) -> None:
        """Handle a message from a client."""
        action = data.get("action", "")

        if action == "ping":
            client.last_ping = datetime.now(UTC)
            await client.send_json(
                {
                    "type": "pong",
                    "server_time": datetime.now(UTC).isoformat(),
                }
            )

        elif action == "subscribe":
            run_id = data.get("run_id")
            if run_id:
                client.subscribed_runs.add(run_id)
                await client.send_json(
                    {
                        "type": "subscribed",
                        "run_id": run_id,
                    }
                )

        elif action == "unsubscribe":
            run_id = data.get("run_id")
            if run_id:
                client.subscribed_runs.discard(run_id)
                await client.send_json(
                    {
                        "type": "unsubscribed",
                        "run_id": run_id,
                    }
                )

        elif action == "subscribe_all":
            client.subscribed_runs.clear()
            await client.send_json(
                {
                    "type": "subscribed_all",
                }
            )

        elif action == "filter":
            event_types = data.get("event_types", [])
            if isinstance(event_types, list):
                client.event_filter = set(event_types)
                await client.send_json(
                    {
                        "type": "filter_set",
                        "event_types": list(client.event_filter),
                    }
                )

        elif action == "clear_filter":
            client.event_filter.clear()
            await client.send_json(
                {
                    "type": "filter_cleared",
                }
            )

        elif action == "status":
            await client.send_json(
                {
                    "type": "status",
                    "client_id": client.id,
                    "connected_at": client.connected_at.isoformat(),
                    "subscribed_runs": list(client.subscribed_runs),
                    "event_filter": list(client.event_filter),
                }
            )

        # Call custom handler if provided
        if self._custom_message_handler:
            try:
                self._custom_message_handler(client, data)
            except Exception:
                pass

    def _on_event(self, event: Event) -> None:
        """Handle an event from the EventBus (sync entry point)."""
        if not self._running:
            return

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._broadcast_event(event))
        except RuntimeError:
            # No running loop
            pass

    async def _broadcast_event(self, event: Event) -> None:
        """Broadcast an event to all interested clients."""
        message = {
            "type": event.type,
            "run_id": event.run_id,
            "node_id": event.node_id,
            "ts": event.ts.isoformat(),
            "payload": event.payload,
        }
        if event.event_id is not None:
            message["event_id"] = event.event_id

        await self.broadcast(
            message,
            run_id=event.run_id,
            event_type=event.type,
        )

    async def _heartbeat_loop(self) -> None:
        """Periodic heartbeat to check client connections."""
        while self._running:
            await asyncio.sleep(self._heartbeat_interval)

            async with self._lock:
                for client in list(self._clients.values()):
                    try:
                        # Send ping
                        if not await client.send_json(
                            {
                                "type": "heartbeat",
                                "server_time": datetime.now(UTC).isoformat(),
                            }
                        ):
                            self._clients.pop(client.id, None)
                    except Exception:
                        self._clients.pop(client.id, None)

                self._stats.active_connections = len(self._clients)


# Global WebSocket server instance
_global_websocket_server: WebSocketServer | None = None


def get_websocket_server() -> WebSocketServer:
    """Get the global WebSocket server instance.

    Creates the instance on first call.
    """
    global _global_websocket_server
    if _global_websocket_server is None:
        _global_websocket_server = WebSocketServer()
    return _global_websocket_server


def set_websocket_server(server: WebSocketServer | None) -> WebSocketServer | None:
    """Set the global WebSocket server instance.

    Args:
        server: The server instance to set (None to clear)

    Returns:
        The previous server instance
    """
    global _global_websocket_server
    previous = _global_websocket_server
    _global_websocket_server = server
    return previous


def reset_websocket_server() -> None:
    """Reset the global WebSocket server to a fresh instance."""
    global _global_websocket_server
    _global_websocket_server = WebSocketServer()


@dataclass
class WebSocketMessage:
    """A message to be sent over WebSocket.

    This is a convenience class for constructing messages.
    """

    type: str
    data: dict[str, Any] = field(default_factory=lambda: {})
    run_id: str | None = None
    node_id: str | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))

    def to_dict(self) -> dict[str, Any]:
        """Convert to a dictionary for JSON serialization."""
        result: dict[str, Any] = {
            "type": self.type,
            "ts": self.timestamp.isoformat(),
            **self.data,
        }
        if self.run_id:
            result["run_id"] = self.run_id
        if self.node_id:
            result["node_id"] = self.node_id
        return result

    def to_json(self) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), default=str)


# Message factory functions for common messages
def progress_message(
    run_id: str,
    completed: int,
    total: int,
    current_node: str | None = None,
) -> WebSocketMessage:
    """Create a progress update message."""
    return WebSocketMessage(
        type="progress",
        run_id=run_id,
        data={
            "completed": completed,
            "total": total,
            "percent": round(completed / total * 100, 1) if total > 0 else 0,
            "current_node": current_node,
        },
    )


def error_message(
    error: str,
    run_id: str | None = None,
    node_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> WebSocketMessage:
    """Create an error message."""
    data: dict[str, Any] = {"error": error}
    if details:
        data["details"] = details
    return WebSocketMessage(
        type="error",
        run_id=run_id,
        node_id=node_id,
        data=data,
    )


def status_message(
    run_id: str,
    status: str,
    nodes: dict[str, str] | None = None,
) -> WebSocketMessage:
    """Create a run status message."""
    data: dict[str, Any] = {"status": status}
    if nodes:
        data["nodes"] = nodes
    return WebSocketMessage(
        type="run_status",
        run_id=run_id,
        data=data,
    )
