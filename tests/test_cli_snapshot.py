"""Tests for the CLI snapshot commands."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.fixture
def simple_workflow_file(tmp_path: Path) -> Path:
    """Create a simple workflow file for testing."""
    workflow_code = """
from pydantic import BaseModel
from smithers import workflow

class OutputA(BaseModel):
    value: str

@workflow
async def simple() -> OutputA:
    return OutputA(value="simple")
"""
    file_path = tmp_path / "simple_workflow.py"
    file_path.write_text(workflow_code)
    return file_path


@pytest.fixture
def two_workflow_file(tmp_path: Path) -> Path:
    """Create a workflow file with two workflows."""
    workflow_code = """
from pydantic import BaseModel
from smithers import workflow

class OutputA(BaseModel):
    value: str

class OutputB(BaseModel):
    result: int

@workflow
async def step1() -> OutputA:
    return OutputA(value="hello")

@workflow
async def step2(a: OutputA) -> OutputB:
    return OutputB(result=len(a.value))
"""
    file_path = tmp_path / "two_workflows.py"
    file_path.write_text(workflow_code)
    return file_path


@pytest.fixture
def snapshot_store(tmp_path: Path) -> Path:
    """Create a temporary snapshot store directory."""
    store_dir = tmp_path / "snapshots"
    store_dir.mkdir()
    return store_dir


class TestSnapshotCreateCommand:
    """Tests for the `smithers snapshot create` command."""

    def test_snapshot_create_to_stdout(self, simple_workflow_file: Path) -> None:
        """Test creating a snapshot output to stdout."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # Should output valid JSON
        data = json.loads(result.stdout)
        assert "name" in data
        assert "version" in data
        assert "root" in data
        assert "nodes" in data
        assert "content_hash" in data

    def test_snapshot_create_with_version(self, simple_workflow_file: Path) -> None:
        """Test creating a snapshot with a specific version."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--version",
                "2.0.0",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["version"] == "2.0.0"

    def test_snapshot_create_with_description(self, simple_workflow_file: Path) -> None:
        """Test creating a snapshot with a description."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--description",
                "Test snapshot",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["description"] == "Test snapshot"

    def test_snapshot_create_to_file(self, simple_workflow_file: Path, tmp_path: Path) -> None:
        """Test creating a snapshot to a file."""
        output_file = tmp_path / "snapshot.json"
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(output_file),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert output_file.exists()
        data = json.loads(output_file.read_text())
        assert "name" in data
        assert "root" in data

    def test_snapshot_create_to_store(
        self, simple_workflow_file: Path, snapshot_store: Path
    ) -> None:
        """Test creating a snapshot in a store directory."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--store",
                str(snapshot_store),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Snapshot saved to" in result.stdout
        # Check that a file was created in the store
        files = list(snapshot_store.glob("*.json"))
        assert len(files) == 1

    def test_snapshot_create_specific_workflow(self, two_workflow_file: Path) -> None:
        """Test creating a snapshot for a specific workflow."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(two_workflow_file),
                "--workflow",
                "step2",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["root"] == "step2"
        # step2 depends on step1, so both should be in the snapshot
        assert len(data["nodes"]) == 2

    def test_snapshot_create_file_not_found(self, tmp_path: Path) -> None:
        """Test snapshot create with non-existent file."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(tmp_path / "nonexistent.py"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0


class TestSnapshotShowCommand:
    """Tests for the `smithers snapshot show` command."""

    def test_snapshot_show_text_format(self, simple_workflow_file: Path, tmp_path: Path) -> None:
        """Test showing a snapshot in text format."""
        # First create a snapshot
        snapshot_file = tmp_path / "snapshot.json"
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot_file),
            ],
            capture_output=True,
            text=True,
        )

        # Now show it
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "show",
                str(snapshot_file),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Workflow Snapshot" in result.stdout
        assert "Version:" in result.stdout
        assert "Root:" in result.stdout
        assert "Nodes:" in result.stdout

    def test_snapshot_show_json_format(self, simple_workflow_file: Path, tmp_path: Path) -> None:
        """Test showing a snapshot in JSON format."""
        # First create a snapshot
        snapshot_file = tmp_path / "snapshot.json"
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot_file),
            ],
            capture_output=True,
            text=True,
        )

        # Now show it as JSON
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "show",
                str(snapshot_file),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "name" in data
        assert "version" in data

    def test_snapshot_show_from_store(
        self, simple_workflow_file: Path, snapshot_store: Path
    ) -> None:
        """Test showing a snapshot from a store."""
        # First create a snapshot in the store
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--store",
                str(snapshot_store),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )

        # Now show it from the store
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "show",
                "1.0.0",
                "--store",
                str(snapshot_store),
                "--workflow",
                "simple",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Workflow Snapshot" in result.stdout
        assert "Version:" in result.stdout

    def test_snapshot_show_file_not_found(self, tmp_path: Path) -> None:
        """Test showing a non-existent snapshot file."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "show",
                str(tmp_path / "nonexistent.json"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "not found" in result.stderr.lower()

    def test_snapshot_show_store_without_workflow(self, snapshot_store: Path) -> None:
        """Test showing from store without specifying workflow."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "show",
                "1.0.0",
                "--store",
                str(snapshot_store),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "--workflow" in result.stderr


class TestSnapshotDiffCommand:
    """Tests for the `smithers snapshot diff` command."""

    def test_snapshot_diff_identical(self, simple_workflow_file: Path, tmp_path: Path) -> None:
        """Test diffing identical snapshots."""
        # Create two identical snapshots
        snapshot1 = tmp_path / "snapshot1.json"
        snapshot2 = tmp_path / "snapshot2.json"

        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot1),
            ],
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot2),
            ],
            capture_output=True,
            text=True,
        )

        # Diff them
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "diff",
                str(snapshot1),
                str(snapshot2),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "No changes" in result.stdout

    def test_snapshot_diff_with_changes(
        self, simple_workflow_file: Path, two_workflow_file: Path, tmp_path: Path
    ) -> None:
        """Test diffing snapshots with changes."""
        # Create two different snapshots
        snapshot1 = tmp_path / "snapshot1.json"
        snapshot2 = tmp_path / "snapshot2.json"

        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot1),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(two_workflow_file),
                "--output",
                str(snapshot2),
                "--version",
                "2.0.0",
            ],
            capture_output=True,
            text=True,
        )

        # Diff them
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "diff",
                str(snapshot1),
                str(snapshot2),
            ],
            capture_output=True,
            text=True,
        )
        # Should exit with 1 because there are breaking changes (nodes removed/changed)
        assert "Workflow Diff" in result.stdout
        # Should show some changes
        assert "added" in result.stdout.lower() or "removed" in result.stdout.lower()

    def test_snapshot_diff_json_format(self, simple_workflow_file: Path, tmp_path: Path) -> None:
        """Test diffing snapshots with JSON output."""
        # Create two identical snapshots
        snapshot1 = tmp_path / "snapshot1.json"
        snapshot2 = tmp_path / "snapshot2.json"

        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot1),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot2),
                "--version",
                "2.0.0",
            ],
            capture_output=True,
            text=True,
        )

        # Diff with JSON output
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "diff",
                str(snapshot1),
                str(snapshot2),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "has_changes" in data
        assert "old_version" in data
        assert "new_version" in data

    def test_snapshot_diff_no_color(
        self, simple_workflow_file: Path, two_workflow_file: Path, tmp_path: Path
    ) -> None:
        """Test diffing with no color output."""
        # Create two different snapshots
        snapshot1 = tmp_path / "snapshot1.json"
        snapshot2 = tmp_path / "snapshot2.json"

        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--output",
                str(snapshot1),
            ],
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(two_workflow_file),
                "--output",
                str(snapshot2),
            ],
            capture_output=True,
            text=True,
        )

        # Diff with no color
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "diff",
                str(snapshot1),
                str(snapshot2),
                "--no-color",
            ],
            capture_output=True,
            text=True,
        )
        # Should not contain ANSI escape codes
        assert "\033[" not in result.stdout

    def test_snapshot_diff_from_store(
        self, simple_workflow_file: Path, two_workflow_file: Path, snapshot_store: Path
    ) -> None:
        """Test diffing snapshots from a store."""
        # Create two snapshots in the store
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--store",
                str(snapshot_store),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(two_workflow_file),
                "--store",
                str(snapshot_store),
                "--version",
                "2.0.0",
            ],
            capture_output=True,
            text=True,
        )

        # Diff from store - note: different workflows create different files
        # so we need to use file diffing here
        files = sorted(snapshot_store.glob("*.json"))
        assert len(files) == 2

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "diff",
                str(files[0]),
                str(files[1]),
            ],
            capture_output=True,
            text=True,
        )
        assert "Workflow Diff" in result.stdout

    def test_snapshot_diff_file_not_found(self, tmp_path: Path) -> None:
        """Test diffing with non-existent file."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "diff",
                str(tmp_path / "nonexistent1.json"),
                str(tmp_path / "nonexistent2.json"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "not found" in result.stderr.lower()

    def test_snapshot_diff_store_without_workflow(self, snapshot_store: Path) -> None:
        """Test diffing from store without specifying workflow."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "diff",
                "1.0.0",
                "2.0.0",
                "--store",
                str(snapshot_store),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "--workflow" in result.stderr


class TestSnapshotListCommand:
    """Tests for the `smithers snapshot list` command."""

    def test_snapshot_list_empty_store(self, snapshot_store: Path) -> None:
        """Test listing from an empty store."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "list",
                "--store",
                str(snapshot_store),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "No snapshots" in result.stdout

    def test_snapshot_list_with_snapshots(
        self, simple_workflow_file: Path, snapshot_store: Path
    ) -> None:
        """Test listing snapshots."""
        # Create some snapshots
        for version in ["1.0.0", "1.1.0", "2.0.0"]:
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "smithers.cli",
                    "snapshot",
                    "create",
                    str(simple_workflow_file),
                    "--store",
                    str(snapshot_store),
                    "--version",
                    version,
                ],
                capture_output=True,
                text=True,
            )

        # List them
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "list",
                "--store",
                str(snapshot_store),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Workflow Snapshots" in result.stdout
        assert "simple" in result.stdout
        assert "1.0.0" in result.stdout
        assert "2.0.0" in result.stdout

    def test_snapshot_list_json_format(
        self, simple_workflow_file: Path, snapshot_store: Path
    ) -> None:
        """Test listing snapshots in JSON format."""
        # Create a snapshot
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--store",
                str(snapshot_store),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )

        # List as JSON
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "list",
                "--store",
                str(snapshot_store),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "workflows" in data
        assert len(data["workflows"]) > 0

    def test_snapshot_list_filter_by_workflow(
        self, simple_workflow_file: Path, two_workflow_file: Path, snapshot_store: Path
    ) -> None:
        """Test listing snapshots filtered by workflow name."""
        # Create snapshots from different workflows
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(simple_workflow_file),
                "--store",
                str(snapshot_store),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )
        subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "create",
                str(two_workflow_file),
                "--store",
                str(snapshot_store),
                "--version",
                "1.0.0",
            ],
            capture_output=True,
            text=True,
        )

        # List filtered
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "list",
                "--store",
                str(snapshot_store),
                "--workflow",
                "simple",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "simple" in result.stdout

    def test_snapshot_list_store_not_found(self, tmp_path: Path) -> None:
        """Test listing from non-existent store."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "snapshot",
                "list",
                "--store",
                str(tmp_path / "nonexistent"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "not found" in result.stderr.lower()


class TestSnapshotCommandHelp:
    """Tests for snapshot command help output."""

    def test_snapshot_help(self) -> None:
        """Test snapshot command shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "snapshot", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "snapshot" in result.stdout.lower()

    def test_snapshot_create_help(self) -> None:
        """Test snapshot create shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "snapshot", "create", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "version" in result.stdout.lower()

    def test_snapshot_diff_help(self) -> None:
        """Test snapshot diff shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "snapshot", "diff", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "old" in result.stdout.lower()
        assert "new" in result.stdout.lower()

    def test_snapshot_list_help(self) -> None:
        """Test snapshot list shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "snapshot", "list", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "store" in result.stdout.lower()

    def test_snapshot_show_help(self) -> None:
        """Test snapshot show shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "snapshot", "show", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "snapshot" in result.stdout.lower()
