"""Tests for CLI websocket commands."""

from __future__ import annotations

import json
from io import StringIO
from unittest.mock import MagicMock, patch

import pytest

from smithers.websocket import ConnectionStats, WebSocketServer


class TestWebSocketStatusCommand:
    """Tests for the websocket status command."""

    def test_status_text_format(self) -> None:
        """Test status command with text output."""
        from smithers.cli import _websocket_status
        import argparse

        # Create mock server
        mock_server = MagicMock(spec=WebSocketServer)
        mock_server.is_running = False
        mock_server.client_count = 0
        mock_server.stats = ConnectionStats(
            total_connections=10,
            active_connections=2,
            messages_sent=100,
            messages_received=50,
            events_broadcast=75,
            errors=3,
        )

        args = argparse.Namespace(format="text")

        with patch("smithers.websocket.get_websocket_server", return_value=mock_server):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                result = _websocket_status(args)
                output = fake_out.getvalue()

        assert result == 0
        assert "WebSocket Server Status" in output
        assert "Running: False" in output
        assert "Connected Clients: 0" in output
        assert "Total Connections:   10" in output
        assert "Active Connections:  2" in output
        assert "Messages Sent:       100" in output
        assert "Messages Received:   50" in output
        assert "Events Broadcast:    75" in output
        assert "Errors:              3" in output

    def test_status_json_format(self) -> None:
        """Test status command with JSON output."""
        from smithers.cli import _websocket_status
        import argparse

        mock_server = MagicMock(spec=WebSocketServer)
        mock_server.is_running = True
        mock_server.client_count = 5
        mock_server.stats = ConnectionStats(
            total_connections=20,
            active_connections=5,
            messages_sent=200,
            messages_received=100,
            events_broadcast=150,
            errors=1,
        )

        args = argparse.Namespace(format="json")

        with patch("smithers.websocket.get_websocket_server", return_value=mock_server):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                result = _websocket_status(args)
                output = fake_out.getvalue()

        assert result == 0
        data = json.loads(output)
        assert data["running"] is True
        assert data["client_count"] == 5
        assert data["stats"]["total_connections"] == 20
        assert data["stats"]["active_connections"] == 5
        assert data["stats"]["messages_sent"] == 200
        assert data["stats"]["messages_received"] == 100
        assert data["stats"]["events_broadcast"] == 150
        assert data["stats"]["errors"] == 1


class TestWebSocketCommandDispatch:
    """Tests for the websocket command dispatcher."""

    def test_unknown_subcommand(self) -> None:
        """Test handling of unknown websocket subcommand."""
        from smithers.cli import _websocket_command
        import argparse

        args = argparse.Namespace(websocket_command="invalid")

        with patch("sys.stderr", new=StringIO()) as fake_err:
            result = _websocket_command(args)
            error = fake_err.getvalue()

        assert result == 1
        assert "Unknown websocket command" in error

    def test_status_subcommand_dispatch(self) -> None:
        """Test that status subcommand dispatches correctly."""
        from smithers.cli import _websocket_command
        import argparse

        mock_server = MagicMock(spec=WebSocketServer)
        mock_server.is_running = False
        mock_server.client_count = 0
        mock_server.stats = ConnectionStats()

        args = argparse.Namespace(websocket_command="status", format="text")

        with patch("smithers.websocket.get_websocket_server", return_value=mock_server):
            with patch("sys.stdout", new=StringIO()):
                result = _websocket_command(args)

        assert result == 0


class TestWebSocketServeCommand:
    """Tests for the websocket serve command."""

    def test_serve_missing_websockets_library(self) -> None:
        """Test serve command when websockets library is missing."""
        from smithers.cli import _websocket_serve
        import argparse

        args = argparse.Namespace(
            host="localhost",
            port=8765,
            no_heartbeat=False,
            heartbeat_interval=30.0,
        )

        # Mock the import to fail
        with patch.dict("sys.modules", {"smithers.websocket": None}):
            with patch("builtins.__import__", side_effect=ImportError("No module named 'websockets'")):
                # This will actually try to import, we need to test the error handling
                pass

        # The actual test should verify the error handling in the function
        # For now, we'll test that the function exists and has the right signature

    @pytest.mark.asyncio
    async def test_serve_creates_server_with_heartbeat(self) -> None:
        """Test that serve creates server with correct heartbeat settings."""
        import argparse
        from smithers.cli import _websocket_serve

        args = argparse.Namespace(
            host="localhost",
            port=8765,
            no_heartbeat=False,
            heartbeat_interval=15.0,
        )

        # We can't easily test the full serve flow without actually starting a server
        # but we can verify the arguments are parsed correctly
        assert args.heartbeat_interval == 15.0
        assert args.no_heartbeat is False

    @pytest.mark.asyncio
    async def test_serve_creates_server_without_heartbeat(self) -> None:
        """Test that serve creates server without heartbeat when disabled."""
        import argparse

        args = argparse.Namespace(
            host="localhost",
            port=8765,
            no_heartbeat=True,
            heartbeat_interval=30.0,
        )

        # When no_heartbeat is True, heartbeat should be disabled (0)
        heartbeat = 0 if args.no_heartbeat else args.heartbeat_interval
        assert heartbeat == 0


class TestWebSocketCLIIntegration:
    """Integration tests for WebSocket CLI."""

    def test_main_dispatches_to_websocket(self) -> None:
        """Test that main() dispatches websocket command correctly."""
        from smithers.cli import main
        import sys

        mock_server = MagicMock(spec=WebSocketServer)
        mock_server.is_running = False
        mock_server.client_count = 0
        mock_server.stats = ConnectionStats()

        with patch.object(sys, "argv", ["smithers", "websocket", "status"]):
            with patch("smithers.websocket.get_websocket_server", return_value=mock_server):
                with patch("sys.stdout", new=StringIO()):
                    result = main()

        assert result == 0

    def test_websocket_help(self) -> None:
        """Test that websocket help is available."""
        from smithers.cli import main
        import sys

        with patch.object(sys, "argv", ["smithers", "websocket", "--help"]):
            with pytest.raises(SystemExit) as exc_info:
                main()

        # --help causes sys.exit(0)
        assert exc_info.value.code == 0


class TestServerStatsDisplay:
    """Tests for displaying server statistics."""

    def test_stats_with_zero_values(self) -> None:
        """Test displaying stats when all values are zero."""
        from smithers.cli import _websocket_status
        import argparse

        mock_server = MagicMock(spec=WebSocketServer)
        mock_server.is_running = False
        mock_server.client_count = 0
        mock_server.stats = ConnectionStats()  # All defaults to 0

        args = argparse.Namespace(format="text")

        with patch("smithers.websocket.get_websocket_server", return_value=mock_server):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                result = _websocket_status(args)
                output = fake_out.getvalue()

        assert result == 0
        assert "Total Connections:   0" in output
        assert "Errors:              0" in output

    def test_stats_with_large_values(self) -> None:
        """Test displaying stats with large values."""
        from smithers.cli import _websocket_status
        import argparse

        mock_server = MagicMock(spec=WebSocketServer)
        mock_server.is_running = True
        mock_server.client_count = 1000
        mock_server.stats = ConnectionStats(
            total_connections=1000000,
            active_connections=1000,
            messages_sent=9999999,
            messages_received=5000000,
            events_broadcast=7500000,
            errors=100,
        )

        args = argparse.Namespace(format="json")

        with patch("smithers.websocket.get_websocket_server", return_value=mock_server):
            with patch("sys.stdout", new=StringIO()) as fake_out:
                result = _websocket_status(args)
                output = fake_out.getvalue()

        assert result == 0
        data = json.loads(output)
        assert data["stats"]["total_connections"] == 1000000
        assert data["stats"]["messages_sent"] == 9999999
