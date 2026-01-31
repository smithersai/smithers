"""Tests for the verification CLI commands (verify graph, cache, run)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import BaseModel

from smithers import SqliteCache
from smithers.store.sqlite import NodeStatus, RunStatus, SqliteStore


class VerifyTestOutput(BaseModel):
    value: str


@pytest.fixture
def workflow_file(tmp_path: Path) -> Path:
    """Create a test workflow file."""
    workflow_content = """
from pydantic import BaseModel
from smithers import workflow


class StepAOutput(BaseModel):
    value: str


class StepBOutput(BaseModel):
    count: int


@workflow
async def step_a() -> StepAOutput:
    return StepAOutput(value="hello")


@workflow
async def step_b(a: StepAOutput) -> StepBOutput:
    return StepBOutput(count=len(a.value))
"""
    workflow_path = tmp_path / "test_workflow.py"
    workflow_path.write_text(workflow_content)
    return workflow_path


@pytest.fixture
async def store_with_run(tmp_path: Path) -> tuple[Path, str]:
    """Create a store with a test run."""
    store_path = tmp_path / "test.db"
    store = SqliteStore(store_path)
    await store.initialize()

    # Create a run
    run_id = await store.create_run("test-plan-hash", "root", run_id="verify-test-run")

    # Create nodes
    await store.create_run_node(run_id, "step_a", "step_a", NodeStatus.SUCCESS)
    await store.create_run_node(run_id, "step_b", "step_b", NodeStatus.SUCCESS)

    # Update run status
    await store.update_run_status(run_id, RunStatus.SUCCESS, finished=True)

    # Add events
    await store.emit_event(run_id, None, "RunStarted", {"target": "root"})
    await store.emit_event(run_id, "step_a", "NodeStarted", {})
    await store.emit_event(run_id, "step_a", "NodeFinished", {"duration_ms": 100})
    await store.emit_event(run_id, "step_b", "NodeStarted", {})
    await store.emit_event(run_id, "step_b", "NodeFinished", {"duration_ms": 50})
    await store.emit_event(run_id, None, "RunFinished", {})

    return store_path, run_id


class TestVerifyGraphCommand:
    """Tests for the `smithers verify graph` command."""

    def test_verify_graph_valid(self, workflow_file: Path) -> None:
        """Test verifying a valid workflow graph."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "graph",
                str(workflow_file),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "PASSED" in result.stdout

    def test_verify_graph_json_format(self, workflow_file: Path) -> None:
        """Test verifying graph with JSON output."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "graph",
                str(workflow_file),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["valid"] is True
        assert "stats" in data
        assert data["stats"]["node_count"] == 2

    def test_verify_graph_specific_workflow(self, workflow_file: Path) -> None:
        """Test verifying a specific workflow by name."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "graph",
                str(workflow_file),
                "--workflow",
                "step_a",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "PASSED" in result.stdout


class TestVerifyCacheCommand:
    """Tests for the `smithers verify cache` command."""

    @pytest.mark.asyncio
    async def test_verify_cache_empty(self, tmp_path: Path) -> None:
        """Test verifying an empty cache."""
        cache_path = tmp_path / "empty_cache.db"
        cache = SqliteCache(cache_path)
        await cache._ensure_initialized()

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "cache",
                "--cache",
                str(cache_path),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Total entries: 0" in result.stdout

    @pytest.mark.asyncio
    async def test_verify_cache_with_entries(self, tmp_path: Path) -> None:
        """Test verifying cache with valid entries."""
        cache_path = tmp_path / "test_cache.db"
        cache = SqliteCache(cache_path)

        # Add some entries
        await cache.set("key1", VerifyTestOutput(value="test1"), workflow_name="wf1")
        await cache.set("key2", VerifyTestOutput(value="test2"), workflow_name="wf2")

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "cache",
                "--cache",
                str(cache_path),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Total entries: 2" in result.stdout
        assert "Valid entries: 2" in result.stdout

    @pytest.mark.asyncio
    async def test_verify_cache_json_format(self, tmp_path: Path) -> None:
        """Test verifying cache with JSON output."""
        cache_path = tmp_path / "test_cache.db"
        cache = SqliteCache(cache_path)
        await cache.set("key1", VerifyTestOutput(value="test"), workflow_name="wf")

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "cache",
                "--cache",
                str(cache_path),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["total_entries"] == 1
        assert data["all_valid"] is True

    def test_verify_cache_not_found(self, tmp_path: Path) -> None:
        """Test error when cache file doesn't exist."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "cache",
                "--cache",
                str(tmp_path / "nonexistent.db"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1
        assert "not found" in result.stderr.lower()


class TestVerifyRunCommand:
    """Tests for the `smithers verify run` command."""

    @pytest.mark.asyncio
    async def test_verify_run_valid(self, store_with_run: tuple[Path, str]) -> None:
        """Test verifying a valid run."""
        store_path, run_id = store_with_run

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "run",
                str(store_path),
                "--run",
                run_id,
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "PASSED" in result.stdout

    @pytest.mark.asyncio
    async def test_verify_run_json_format(self, store_with_run: tuple[Path, str]) -> None:
        """Test verifying run with JSON output."""
        store_path, run_id = store_with_run

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "run",
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
        assert data["valid"] is True
        assert data["stats"]["run_id"] == run_id

    @pytest.mark.asyncio
    async def test_verify_run_not_found(self, tmp_path: Path) -> None:
        """Test error when run doesn't exist."""
        store_path = tmp_path / "test.db"
        store = SqliteStore(store_path)
        await store.initialize()

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "run",
                str(store_path),
                "--run",
                "nonexistent-run",
            ],
            capture_output=True,
            text=True,
        )
        # Should return non-zero because run is not found
        assert result.returncode == 1

    def test_verify_run_store_not_found(self, tmp_path: Path) -> None:
        """Test error when store file doesn't exist."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "verify",
                "run",
                str(tmp_path / "nonexistent.db"),
                "--run",
                "some-run",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 1
        assert "not found" in result.stderr.lower()


class TestVerifyCommandHelp:
    """Tests for verify command help messages."""

    def test_verify_help(self) -> None:
        """Test verify --help shows subcommands."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "verify", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "graph" in result.stdout
        assert "cache" in result.stdout
        assert "run" in result.stdout

    def test_verify_graph_help(self) -> None:
        """Test verify graph --help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "verify", "graph", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "--workflow" in result.stdout
        assert "--format" in result.stdout

    def test_verify_cache_help(self) -> None:
        """Test verify cache --help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "verify", "cache", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "--cache" in result.stdout
        assert "--validate-schemas" in result.stdout

    def test_verify_run_help(self) -> None:
        """Test verify run --help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "verify", "run", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "--run" in result.stdout
        assert "--format" in result.stdout
