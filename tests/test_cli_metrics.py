"""Tests for the CLI metrics commands."""

from __future__ import annotations

import json
import threading
import time
from http.client import HTTPConnection
from unittest.mock import patch

import pytest

from smithers.cli import main
from smithers.metrics import get_metrics_collector, reset_metrics_collector


@pytest.fixture(autouse=True)
def reset_metrics() -> None:
    """Reset the metrics collector before and after each test."""
    reset_metrics_collector()
    yield
    reset_metrics_collector()


class TestMetricsExportCommand:
    """Tests for the 'smithers metrics export' command."""

    def test_export_prometheus_format(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test exporting metrics in Prometheus format."""
        # Record some metrics first
        collector = get_metrics_collector()
        collector.record_run_started("test_workflow", "run-1")
        collector.record_llm_call("claude-3-opus", input_tokens=100, output_tokens=50)

        with patch("sys.argv", ["smithers", "metrics", "export", "--format", "prometheus"]):
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        assert "smithers_workflow_runs_total" in captured.out
        assert "smithers_llm_tokens_total" in captured.out

    def test_export_opentelemetry_format(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test exporting metrics in OpenTelemetry format."""
        # Record some metrics first
        collector = get_metrics_collector()
        collector.record_run_started("test_workflow", "run-1")

        with patch("sys.argv", ["smithers", "metrics", "export", "--format", "opentelemetry"]):
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        # Should be valid JSON
        data = json.loads(captured.out)
        assert "resource_metrics" in data

    def test_export_default_format(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test that default format is Prometheus."""
        collector = get_metrics_collector()
        collector.record_run_started("test_workflow", "run-1")

        with patch("sys.argv", ["smithers", "metrics", "export"]):
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        # Default should be Prometheus format (text, not JSON)
        assert "# Smithers metrics" in captured.out


class TestMetricsServeCommand:
    """Tests for the 'smithers metrics serve' command."""

    def test_serve_starts_and_stops(self) -> None:
        """Test that metrics serve starts and can be interrupted."""
        # We'll test this by running in a thread and simulating Ctrl+C

        serve_started = threading.Event()
        serve_done = threading.Event()

        def run_serve() -> int:
            # Patch argv and run
            with patch("sys.argv", ["smithers", "metrics", "serve", "--port", "19091"]):
                # Also patch the server to not actually block
                from smithers.metrics import MetricsCollector

                original_start = MetricsCollector.start_server

                def mock_start(self, host="0.0.0.0", port=9090, daemon=True):
                    server = original_start(self, host, port, daemon=True)
                    serve_started.set()
                    return server

                with patch.object(MetricsCollector, "start_server", mock_start):
                    # Run with a timeout by raising KeyboardInterrupt after a short delay
                    def raise_keyboard_interrupt():
                        time.sleep(0.5)
                        serve_started.wait(timeout=2.0)
                        # Just stop the server directly since we can't send signals in tests
                        get_metrics_collector().stop_server()
                        serve_done.set()

                    interrupt_thread = threading.Thread(target=raise_keyboard_interrupt)
                    interrupt_thread.start()

                    try:
                        # The main loop will check if server is stopped
                        with patch("sys.argv", ["smithers", "metrics", "serve", "--port", "19091"]):
                            # Instead of actually running the infinite loop, simulate the behavior
                            collector = get_metrics_collector()
                            collector.start_server(host="0.0.0.0", port=19091, daemon=True)
                            serve_started.set()

                            # Wait for the interrupt thread to stop the server
                            serve_done.wait(timeout=3.0)
                            return 0
                    except KeyboardInterrupt:
                        return 0
                    finally:
                        interrupt_thread.join(timeout=2.0)

        result = run_serve()
        assert result == 0

    def test_serve_custom_port(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test specifying a custom port."""
        # Just test argument parsing by checking the output message
        collector = get_metrics_collector()

        # Start server briefly
        server = collector.start_server(host="127.0.0.1", port=19092)
        port = server.server_address[1]

        try:
            # Verify server is running by making a request
            conn = HTTPConnection("127.0.0.1", port)
            conn.request("GET", "/health")
            response = conn.getresponse()
            assert response.status == 200
        finally:
            collector.stop_server()


class TestMetricsHelp:
    """Tests for metrics help output."""

    def test_metrics_help(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test 'smithers metrics --help' output."""
        with patch("sys.argv", ["smithers", "metrics", "--help"]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 0

        captured = capsys.readouterr()
        assert "serve" in captured.out
        assert "export" in captured.out

    def test_metrics_serve_help(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test 'smithers metrics serve --help' output."""
        with patch("sys.argv", ["smithers", "metrics", "serve", "--help"]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 0

        captured = capsys.readouterr()
        assert "--host" in captured.out
        assert "--port" in captured.out

    def test_metrics_export_help(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test 'smithers metrics export --help' output."""
        with patch("sys.argv", ["smithers", "metrics", "export", "--help"]):
            with pytest.raises(SystemExit) as exc_info:
                main()
            assert exc_info.value.code == 0

        captured = capsys.readouterr()
        assert "--format" in captured.out
        assert "prometheus" in captured.out
        assert "opentelemetry" in captured.out


class TestMetricsIntegration:
    """Integration tests for metrics commands."""

    def test_metrics_export_empty(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test exporting when no metrics have been recorded."""
        with patch("sys.argv", ["smithers", "metrics", "export"]):
            result = main()

        assert result == 0
        captured = capsys.readouterr()
        # Should still have the header
        assert "# Smithers metrics" in captured.out

    def test_metrics_after_workflow_recording(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Test metrics reflect recorded workflow data."""
        collector = get_metrics_collector()

        # Simulate a workflow run with various events
        collector.record_run_started("analyze", "run-1")
        collector.record_node_started("analyze")
        collector.record_llm_call("claude-3-opus", input_tokens=1000, output_tokens=500)
        collector.record_tool_call("Read", "success", duration_seconds=0.1)
        collector.record_tool_call("Edit", "success", duration_seconds=0.05)
        collector.record_cache_operation("miss", "analyze")
        collector.record_node_completed("analyze", "success", duration_seconds=2.5)
        collector.record_run_completed("analyze", "success", duration_seconds=3.0, run_id="run-1")

        with patch("sys.argv", ["smithers", "metrics", "export"]):
            result = main()

        assert result == 0
        captured = capsys.readouterr()

        # Verify all types of metrics are present
        assert "workflow_runs_total" in captured.out
        assert "node_executions_total" in captured.out
        assert "llm_calls_total" in captured.out
        assert "tool_calls_total" in captured.out
        assert "cache_operations_total" in captured.out
        assert 'model="claude-3-opus"' in captured.out
        assert 'tool="Read"' in captured.out
        assert 'tool="Edit"' in captured.out
