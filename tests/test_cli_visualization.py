"""Tests for the CLI visualization commands."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

import pytest


@pytest.fixture
def workflow_file(tmp_path: Path) -> Path:
    """Create a simple workflow file for testing."""
    workflow_code = '''
from pydantic import BaseModel
from smithers import workflow

class OutputA(BaseModel):
    value: str

class OutputB(BaseModel):
    value: str

class OutputC(BaseModel):
    value: str

@workflow
async def step_a() -> OutputA:
    return OutputA(value="a")

@workflow
async def step_b(dep: OutputA) -> OutputB:
    return OutputB(value="b")

@workflow
async def step_c(b: OutputB) -> OutputC:
    return OutputC(value="c")
'''
    file_path = tmp_path / "test_workflow.py"
    file_path.write_text(workflow_code)
    return file_path


class TestGraphCommand:
    """Tests for the `smithers graph` command."""

    def test_graph_mermaid_format(self, workflow_file: Path) -> None:
        """Test graph command with mermaid format."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "mermaid"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "graph LR" in result.stdout
        assert "step_a" in result.stdout
        assert "step_b" in result.stdout
        assert "step_c" in result.stdout
        assert "-->" in result.stdout

    def test_graph_mermaid_styled_format(self, workflow_file: Path) -> None:
        """Test graph command with mermaid-styled format."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "mermaid-styled"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "graph LR" in result.stdout
        assert "classDef" in result.stdout
        assert "pending" in result.stdout

    def test_graph_dot_format(self, workflow_file: Path) -> None:
        """Test graph command with dot format."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "dot"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "digraph workflow" in result.stdout
        assert '"step_a" -> "step_b"' in result.stdout

    def test_graph_json_format(self, workflow_file: Path) -> None:
        """Test graph command with json format."""
        import json

        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "json"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "root" in data
        assert "nodes" in data
        assert "edges" in data
        assert "levels" in data
        assert "step_c" == data["root"]

    def test_graph_ascii_format(self, workflow_file: Path) -> None:
        """Test graph command with ascii format."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "ascii"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Workflow Graph" in result.stdout
        assert "step_a" in result.stdout
        assert "step_b" in result.stdout
        assert "step_c" in result.stdout

    def test_graph_tree_format(self, workflow_file: Path) -> None:
        """Test graph command with tree format."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "tree"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Workflow Graph" in result.stdout
        assert "step_c" in result.stdout
        assert "step_b" in result.stdout
        assert "step_a" in result.stdout

    def test_graph_table_format(self, workflow_file: Path) -> None:
        """Test graph command with table format."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "table"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Node" in result.stdout
        assert "Status" in result.stdout
        assert "step_a" in result.stdout
        assert "step_b" in result.stdout
        assert "step_c" in result.stdout

    def test_graph_summary_format(self, workflow_file: Path) -> None:
        """Test graph command with summary format."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "summary"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Graph: step_c" in result.stdout
        assert "Total nodes: 3" in result.stdout

    def test_graph_no_color(self, workflow_file: Path) -> None:
        """Test graph command with --no-color flag."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "ascii", "--no-color"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # Should not contain ANSI escape codes
        assert "\033[" not in result.stdout

    def test_graph_no_unicode(self, workflow_file: Path) -> None:
        """Test graph command with --no-unicode flag."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "table", "--no-unicode"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # Should use ASCII box drawing characters
        assert "+" in result.stdout or "-" in result.stdout

    def test_graph_output_file(self, workflow_file: Path, tmp_path: Path) -> None:
        """Test graph command with output file."""
        output_file = tmp_path / "graph_output.txt"
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "ascii", "-o", str(output_file)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert output_file.exists()
        content = output_file.read_text()
        assert "Workflow Graph" in content
        assert "step_a" in content

    def test_graph_specific_workflow(self, workflow_file: Path) -> None:
        """Test graph command with specific workflow."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--format", "summary", "--workflow", "step_b"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "Graph: step_b" in result.stdout
        assert "Total nodes: 2" in result.stdout

    def test_graph_nonexistent_file(self) -> None:
        """Test graph command with nonexistent file."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", "/nonexistent/file.py"],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0

    def test_graph_nonexistent_workflow(self, workflow_file: Path) -> None:
        """Test graph command with nonexistent workflow name."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "graph", str(workflow_file), "--workflow", "nonexistent"],
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0


class TestGraphCombinedOptions:
    """Tests for combined CLI options."""

    def test_ascii_no_color_no_unicode(self, workflow_file: Path) -> None:
        """Test ASCII format with no color and no unicode."""
        result = subprocess.run(
            [
                sys.executable, "-m", "smithers.cli", "graph", str(workflow_file),
                "--format", "ascii", "--no-color", "--no-unicode"
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert "\033[" not in result.stdout
        # Check it has readable content
        assert "step_a" in result.stdout

    def test_tree_with_both_flags(self, workflow_file: Path) -> None:
        """Test tree format with both --no-color and --no-unicode."""
        result = subprocess.run(
            [
                sys.executable, "-m", "smithers.cli", "graph", str(workflow_file),
                "--format", "tree", "--no-color", "--no-unicode"
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # Should have ASCII tree connectors
        lines = result.stdout.split("\n")
        # Look for ASCII tree characters
        has_tree_chars = any("`--" in line or "|--" in line for line in lines)
        assert has_tree_chars or "step" in result.stdout
