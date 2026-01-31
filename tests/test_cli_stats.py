"""Tests for the CLI stats command."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import pytest

from smithers.store.sqlite import SqliteStore


class TestCliStats:
    """Tests for smithers stats CLI command."""

    @pytest.fixture
    async def store_with_data(self) -> tuple[Path, str]:
        """Create a store with test data and return path and run_id."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store_path = Path(tmpdir) / "test.db"
            store = SqliteStore(store_path)
            await store.initialize()

            # Create a run
            run_id = await store.create_run("test-plan-hash", "target-node")
            await store.update_run_status(store.store.sqlite.RunStatus.RUNNING)

            # Record some LLM calls
            call1 = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call1, input_tokens=1000, output_tokens=500, cost_usd=0.0105
            )

            call2 = await store.record_llm_call_start(run_id, "node2", "claude-opus-4-5-20251101")
            await store.record_llm_call_end(
                call2, input_tokens=2000, output_tokens=1000, cost_usd=0.105
            )

            yield store_path, run_id

    @pytest.mark.asyncio
    async def test_stats_no_store(self) -> None:
        """Test stats command with non-existent store."""
        result = subprocess.run(
            ["uv", "run", "python", "-m", "smithers.cli", "stats", "/nonexistent/store.db"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1
        assert "Store not found" in result.stderr

    @pytest.mark.asyncio
    async def test_stats_basic(self) -> None:
        """Test basic stats command."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store_path = Path(tmpdir) / "test.db"
            store = SqliteStore(store_path)
            await store.initialize()

            # Create a run with LLM calls
            run_id = await store.create_run("plan-hash", "target")
            call_id = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call_id, input_tokens=1000, output_tokens=500, cost_usd=0.0105
            )

            result = subprocess.run(
                ["uv", "run", "python", "-m", "smithers.cli", "stats", str(store_path)],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0
            assert "LLM Usage Statistics" in result.stdout
            assert "Total LLM Calls" in result.stdout

    @pytest.mark.asyncio
    async def test_stats_json_format(self) -> None:
        """Test stats command with JSON output."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store_path = Path(tmpdir) / "test.db"
            store = SqliteStore(store_path)
            await store.initialize()

            run_id = await store.create_run("plan-hash", "target")
            call_id = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call_id, input_tokens=1000, output_tokens=500, cost_usd=0.015
            )

            result = subprocess.run(
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "smithers.cli",
                    "stats",
                    str(store_path),
                    "--format",
                    "json",
                ],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0

            # Parse JSON output
            data = json.loads(result.stdout)
            assert "summary" in data
            assert data["summary"]["total_calls"] == 1
            assert data["summary"]["total_input_tokens"] == 1000
            assert data["summary"]["total_output_tokens"] == 500

    @pytest.mark.asyncio
    async def test_stats_specific_run(self) -> None:
        """Test stats command for a specific run."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store_path = Path(tmpdir) / "test.db"
            store = SqliteStore(store_path)
            await store.initialize()

            run_id = await store.create_run("plan-hash", "target")
            call_id = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call_id, input_tokens=1000, output_tokens=500, cost_usd=0.015
            )

            result = subprocess.run(
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "smithers.cli",
                    "stats",
                    str(store_path),
                    "--run",
                    run_id,
                    "--format",
                    "json",
                ],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0

            data = json.loads(result.stdout)
            assert data["run_id"] == run_id
            assert data["summary"]["total_calls"] == 1

    @pytest.mark.asyncio
    async def test_stats_by_model(self) -> None:
        """Test stats command with per-model breakdown."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store_path = Path(tmpdir) / "test.db"
            store = SqliteStore(store_path)
            await store.initialize()

            run_id = await store.create_run("plan-hash", "target")

            # Add calls for different models
            call1 = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call1, input_tokens=1000, output_tokens=500, cost_usd=0.015
            )

            call2 = await store.record_llm_call_start(run_id, "node2", "claude-opus-4-5-20251101")
            await store.record_llm_call_end(
                call2, input_tokens=500, output_tokens=200, cost_usd=0.03
            )

            result = subprocess.run(
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "smithers.cli",
                    "stats",
                    str(store_path),
                    "--by-model",
                    "--format",
                    "json",
                ],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0

            data = json.loads(result.stdout)
            assert "by_model" in data
            assert "claude-sonnet-4-20250514" in data["by_model"]
            assert "claude-opus-4-5-20251101" in data["by_model"]

    @pytest.mark.asyncio
    async def test_stats_empty_store(self) -> None:
        """Test stats command with empty store."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store_path = Path(tmpdir) / "test.db"
            store = SqliteStore(store_path)
            await store.initialize()

            result = subprocess.run(
                ["uv", "run", "python", "-m", "smithers.cli", "stats", str(store_path)],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0
            # Should show 0 calls
            assert "Total LLM Calls:    0" in result.stdout

    @pytest.mark.asyncio
    async def test_stats_with_days(self) -> None:
        """Test stats command with custom days parameter."""
        with tempfile.TemporaryDirectory() as tmpdir:
            store_path = Path(tmpdir) / "test.db"
            store = SqliteStore(store_path)
            await store.initialize()

            run_id = await store.create_run("plan-hash", "target")
            call_id = await store.record_llm_call_start(run_id, "node1", "claude-sonnet-4-20250514")
            await store.record_llm_call_end(
                call_id, input_tokens=1000, output_tokens=500, cost_usd=0.015
            )

            result = subprocess.run(
                [
                    "uv",
                    "run",
                    "python",
                    "-m",
                    "smithers.cli",
                    "stats",
                    str(store_path),
                    "--days",
                    "30",
                ],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0
            assert "Last 30 days" in result.stdout
