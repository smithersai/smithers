"""Tests for the CLI compose commands."""

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
def chained_workflow_file(tmp_path: Path) -> Path:
    """Create a chained workflow file for testing."""
    # Note: For CLI to find the workflow, we need to register at least one
    # The chain itself doesn't auto-register, so we register the final step
    workflow_code = """
from pydantic import BaseModel
from smithers import workflow

class OutputA(BaseModel):
    value: str

class OutputB(BaseModel):
    data: int

@workflow
async def step1() -> OutputA:
    return OutputA(value="hello")

@workflow
async def step2(a: OutputA) -> OutputB:
    return OutputB(data=len(a.value))
"""
    file_path = tmp_path / "chained_workflow.py"
    file_path.write_text(workflow_code)
    return file_path


@pytest.fixture
def multi_workflow_file_1(tmp_path: Path) -> Path:
    """Create first workflow file for merge testing."""
    workflow_code = """
from pydantic import BaseModel
from smithers import workflow

class AnalysisOutput(BaseModel):
    result: str

@workflow
async def analyze() -> AnalysisOutput:
    return AnalysisOutput(result="analyzed")
"""
    file_path = tmp_path / "workflow1.py"
    file_path.write_text(workflow_code)
    return file_path


@pytest.fixture
def multi_workflow_file_2(tmp_path: Path) -> Path:
    """Create second workflow file for merge testing."""
    workflow_code = """
from pydantic import BaseModel
from smithers import workflow

class ProcessOutput(BaseModel):
    processed: bool

@workflow
async def process() -> ProcessOutput:
    return ProcessOutput(processed=True)
"""
    file_path = tmp_path / "workflow2.py"
    file_path.write_text(workflow_code)
    return file_path


class TestComposeInfoCommand:
    """Tests for the `smithers compose info` command."""

    def test_compose_info_simple_workflow(self, simple_workflow_file: Path) -> None:
        """Test compose info for a simple (non-composed) workflow."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "compose", "info", str(simple_workflow_file)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Composed: False" in result.stdout
        assert "simple" in result.stdout

    def test_compose_info_json_format(self, simple_workflow_file: Path) -> None:
        """Test compose info with JSON output."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "info",
                str(simple_workflow_file),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["name"] == "simple"
        assert data["is_composed"] is False

    def test_compose_info_chained_workflow(self, chained_workflow_file: Path) -> None:
        """Test compose info for a regular workflow with dependencies."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "compose", "info", str(chained_workflow_file)],
            capture_output=True,
            text=True,
        )
        # The workflow should be found and info displayed
        assert result.returncode == 0
        # Should show it's not composed (it's a regular dependency-based workflow)
        assert "Composed" in result.stdout
        assert "step2" in result.stdout

    def test_compose_info_specific_workflow(self, simple_workflow_file: Path) -> None:
        """Test compose info for a specific workflow by name."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "info",
                str(simple_workflow_file),
                "--workflow",
                "simple",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "simple" in result.stdout

    def test_compose_info_workflow_not_found(self, simple_workflow_file: Path) -> None:
        """Test compose info when workflow is not found."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "info",
                str(simple_workflow_file),
                "--workflow",
                "nonexistent",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert "not found" in result.stderr.lower()


class TestComposeMergeCommand:
    """Tests for the `smithers compose merge` command."""

    def test_compose_merge_single_file(self, simple_workflow_file: Path) -> None:
        """Test compose merge with a single file."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "compose", "merge", str(simple_workflow_file)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # Should output mermaid by default
        assert "graph" in result.stdout.lower() or "simple" in result.stdout

    def test_compose_merge_multiple_files(
        self, multi_workflow_file_1: Path, multi_workflow_file_2: Path
    ) -> None:
        """Test compose merge with multiple files."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "merge",
                str(multi_workflow_file_1),
                str(multi_workflow_file_2),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # Output should mention both workflows or be valid mermaid
        assert "graph" in result.stdout.lower() or "process" in result.stdout

    def test_compose_merge_json_format(self, simple_workflow_file: Path) -> None:
        """Test compose merge with JSON output."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "merge",
                str(simple_workflow_file),
                "--format",
                "json",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "root" in data
        assert "nodes" in data
        assert "edges" in data
        assert "levels" in data

    def test_compose_merge_ascii_format(self, simple_workflow_file: Path) -> None:
        """Test compose merge with ASCII output."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "merge",
                str(simple_workflow_file),
                "--format",
                "ascii",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # ASCII output should have some structure
        assert len(result.stdout) > 0

    def test_compose_merge_with_output_file(
        self, simple_workflow_file: Path, tmp_path: Path
    ) -> None:
        """Test compose merge with output file."""
        output_file = tmp_path / "merged_graph.md"
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "merge",
                str(simple_workflow_file),
                "--output",
                str(output_file),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert output_file.exists()
        content = output_file.read_text()
        assert "graph" in content.lower() or "simple" in content

    def test_compose_merge_with_target(
        self, multi_workflow_file_1: Path, multi_workflow_file_2: Path
    ) -> None:
        """Test compose merge with specific target."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "merge",
                str(multi_workflow_file_1),
                str(multi_workflow_file_2),
                "--target",
                "analyze",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

    def test_compose_merge_file_not_found(self, tmp_path: Path) -> None:
        """Test compose merge when file is not found."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "smithers.cli",
                "compose",
                "merge",
                str(tmp_path / "nonexistent.py"),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0


class TestComposeCommandHelp:
    """Tests for compose command help output."""

    def test_compose_help(self) -> None:
        """Test compose command shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "compose", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "compose" in result.stdout.lower()

    def test_compose_info_help(self) -> None:
        """Test compose info shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "compose", "info", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "workflow" in result.stdout.lower()

    def test_compose_merge_help(self) -> None:
        """Test compose merge shows help."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "compose", "merge", "--help"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "merge" in result.stdout.lower()
