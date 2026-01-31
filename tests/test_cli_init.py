"""Tests for the CLI init command."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


class TestInitCommand:
    """Tests for the `smithers init` command."""

    def test_init_creates_project_directory(self, tmp_path: Path) -> None:
        """Test that init creates the project directory."""
        project_dir = tmp_path / "my_project"

        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0
        assert project_dir.exists()
        assert "Initialized Smithers project" in result.stdout

    def test_init_creates_workflows_directory(self, tmp_path: Path) -> None:
        """Test that init creates a workflows subdirectory."""
        project_dir = tmp_path / "my_project"

        subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        workflows_dir = project_dir / "workflows"
        assert workflows_dir.exists()
        assert workflows_dir.is_dir()

    def test_init_creates_example_workflow(self, tmp_path: Path) -> None:
        """Test that init creates an example workflow file."""
        project_dir = tmp_path / "my_project"

        subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        example_file = project_dir / "workflows" / "example.py"
        assert example_file.exists()

        # Check the example file contains expected content
        content = example_file.read_text()
        assert "from smithers import workflow" in content
        assert "@workflow" in content
        assert "ExampleOutput" in content
        assert "async def" in content

    def test_init_creates_readme(self, tmp_path: Path) -> None:
        """Test that init creates a README.md file."""
        project_dir = tmp_path / "my_project"

        subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        readme_file = project_dir / "README.md"
        assert readme_file.exists()
        content = readme_file.read_text()
        assert "Smithers" in content

    def test_init_preserves_existing_readme(self, tmp_path: Path) -> None:
        """Test that init does not overwrite existing README."""
        project_dir = tmp_path / "my_project"
        project_dir.mkdir()
        readme_file = project_dir / "README.md"
        readme_file.write_text("# My Custom README\n")

        subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        content = readme_file.read_text()
        assert "My Custom README" in content

    def test_init_preserves_existing_example(self, tmp_path: Path) -> None:
        """Test that init does not overwrite existing example.py."""
        project_dir = tmp_path / "my_project"
        workflows_dir = project_dir / "workflows"
        workflows_dir.mkdir(parents=True)
        example_file = workflows_dir / "example.py"
        example_file.write_text("# My custom workflow\n")

        subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        content = example_file.read_text()
        assert "My custom workflow" in content

    def test_init_with_nested_path(self, tmp_path: Path) -> None:
        """Test that init creates nested directories if needed."""
        project_dir = tmp_path / "deep" / "nested" / "project"

        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0
        assert project_dir.exists()
        assert (project_dir / "workflows").exists()

    def test_init_idempotent(self, tmp_path: Path) -> None:
        """Test that running init twice works without errors."""
        project_dir = tmp_path / "my_project"

        # Run init twice
        result1 = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )
        result2 = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        assert result1.returncode == 0
        assert result2.returncode == 0

    def test_init_generated_example_is_valid_python(self, tmp_path: Path) -> None:
        """Test that the generated example.py is valid Python syntax."""
        project_dir = tmp_path / "my_project"

        subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        example_file = project_dir / "workflows" / "example.py"

        # Check syntax is valid by compiling
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", str(example_file)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

    def test_init_example_can_be_imported(self, tmp_path: Path) -> None:
        """Test that the generated example.py can be imported."""
        project_dir = tmp_path / "my_project"

        subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", str(project_dir)],
            capture_output=True,
            text=True,
        )

        workflows_dir = project_dir / "workflows"

        # Check the module can be imported without errors
        # by running it through Python with limited execution
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                f"import sys; sys.path.insert(0, '{workflows_dir}'); import example",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"Import failed: {result.stderr}"


class TestInitHelp:
    """Tests for init command help."""

    def test_init_help(self) -> None:
        """Test that init --help shows usage."""
        result = subprocess.run(
            [sys.executable, "-m", "smithers.cli", "init", "--help"],
            capture_output=True,
            text=True,
        )

        assert result.returncode == 0
        assert "init" in result.stdout.lower()
        assert "path" in result.stdout.lower()
