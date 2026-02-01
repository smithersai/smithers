"""Tests for JJ (Jujutsu) integration and checkpoint management.

This module tests the RepoStateService class and its checkpoint functionality.
Tests verify:
- JJ repository initialization
- Checkpoint creation and restoration
- Status querying
- Error handling when JJ is not installed
- Edge cases with uncommitted changes
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agentd.jj import (
    Checkpoint,
    JJNotFoundError,
    RepoStateService,
    RepoStatus,
)


class TestRepoStateService:
    """Tests for RepoStateService basic functionality."""

    @pytest.mark.asyncio
    async def test_init_creates_service(self, tmp_path: Path) -> None:
        """Test that RepoStateService initializes correctly."""
        service = RepoStateService(tmp_path)
        assert service.workspace_root == tmp_path

    @pytest.mark.asyncio
    async def test_get_status_without_jj_installed(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test get_status when JJ is not installed."""

        def mock_run(*args, **kwargs):
            raise FileNotFoundError("jj not found")

        monkeypatch.setattr(subprocess, "run", mock_run)

        service = RepoStateService(tmp_path)
        status = await service.get_status()

        assert status.is_jj_repo is False
        assert status.current_commit is None
        assert status.has_changes is False
        assert status.change_summary is None

    @pytest.mark.asyncio
    async def test_get_status_not_jj_repo(self, tmp_path: Path) -> None:
        """Test get_status when directory is not a JJ repo."""
        # Skip if JJ not installed
        try:
            subprocess.run(
                ["jj", "--version"], capture_output=True, check=True
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

        service = RepoStateService(tmp_path)
        status = await service.get_status()

        assert status.is_jj_repo is False
        assert status.current_commit is None
        assert status.has_changes is False
        assert status.change_summary is None

    @pytest.mark.asyncio
    async def test_ensure_jj_repo_raises_without_jj(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test ensure_jj_repo raises JJNotFoundError when JJ not installed."""

        def mock_run(*args, **kwargs):
            if args[0][0] == "jj" and args[0][1] == "--version":
                raise FileNotFoundError("jj not found")
            # Should not reach here
            raise RuntimeError("Unexpected call")

        monkeypatch.setattr(subprocess, "run", mock_run)

        service = RepoStateService(tmp_path)
        with pytest.raises(JJNotFoundError, match="not installed or not found"):
            await service.ensure_jj_repo()


@pytest.mark.integration
class TestJJIntegration:
    """Integration tests for JJ functionality.

    These tests require JJ to be installed and will be skipped if not available.
    """

    @pytest.fixture(autouse=True)
    def check_jj_installed(self) -> None:
        """Skip tests if JJ is not installed."""
        try:
            subprocess.run(
                ["jj", "--version"], capture_output=True, check=True
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

    @pytest.mark.asyncio
    async def test_ensure_jj_repo_initializes_repo(
        self, tmp_path: Path
    ) -> None:
        """Test that ensure_jj_repo creates a new JJ repository."""
        service = RepoStateService(tmp_path)

        # Initially not a JJ repo
        status = await service.get_status()
        assert status.is_jj_repo is False

        # Initialize JJ repo
        await service.ensure_jj_repo()

        # Now it is a JJ repo
        status = await service.get_status()
        assert status.is_jj_repo is True
        assert status.current_commit is not None

    @pytest.mark.asyncio
    async def test_ensure_jj_repo_idempotent(self, tmp_path: Path) -> None:
        """Test that ensure_jj_repo is idempotent."""
        service = RepoStateService(tmp_path)

        # Initialize once
        await service.ensure_jj_repo()
        status1 = await service.get_status()

        # Initialize again (should be no-op)
        await service.ensure_jj_repo()
        status2 = await service.get_status()

        assert status1.current_commit == status2.current_commit
        assert status1.is_jj_repo is True
        assert status2.is_jj_repo is True

    @pytest.mark.asyncio
    async def test_get_status_clean_repo(self, tmp_path: Path) -> None:
        """Test get_status on a clean JJ repository."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        status = await service.get_status()

        assert status.is_jj_repo is True
        assert status.current_commit is not None
        assert len(status.current_commit) > 0
        assert status.has_changes is False
        assert status.change_summary is None

    @pytest.mark.asyncio
    async def test_get_status_with_changes(self, tmp_path: Path) -> None:
        """Test get_status when there are uncommitted changes."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Create a file (uncommitted change)
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        status = await service.get_status()

        assert status.is_jj_repo is True
        assert status.has_changes is True
        assert status.change_summary is not None
        assert "test.txt" in status.change_summary or "Working copy" in status.change_summary

    @pytest.mark.asyncio
    async def test_create_checkpoint_clean_repo(self, tmp_path: Path) -> None:
        """Test creating a checkpoint on a clean repo."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        checkpoint = await service.create_checkpoint(
            checkpoint_id="test-cp-001",
            message="Test checkpoint on clean repo",
        )

        assert checkpoint.checkpoint_id == "test-cp-001"
        assert checkpoint.jj_commit_id is not None
        assert len(checkpoint.jj_commit_id) > 0
        assert checkpoint.bookmark_name == "checkpoint-test-cp-001"
        assert checkpoint.message == "Test checkpoint on clean repo"
        assert checkpoint.created_at is not None

        # Verify bookmark was created
        result = subprocess.run(
            ["jj", "bookmark", "list"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=True,
        )
        assert "checkpoint-test-cp-001" in result.stdout

    @pytest.mark.asyncio
    async def test_create_checkpoint_with_changes(
        self, tmp_path: Path
    ) -> None:
        """Test creating a checkpoint when there are uncommitted changes."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Create a file
        test_file = tmp_path / "test.txt"
        test_file.write_text("Initial content")

        # Create checkpoint (should commit changes first)
        checkpoint = await service.create_checkpoint(
            checkpoint_id="test-cp-002",
            message="Checkpoint with changes",
        )

        assert checkpoint.checkpoint_id == "test-cp-002"
        assert checkpoint.bookmark_name == "checkpoint-test-cp-002"
        assert checkpoint.message == "Checkpoint with changes"

        # Verify changes were committed
        status = await service.get_status()
        # After committing, working copy should be clean (on a new empty commit)
        assert status.is_jj_repo is True

        # Verify the file exists and is tracked
        assert test_file.exists()
        assert test_file.read_text() == "Initial content"

    @pytest.mark.asyncio
    async def test_create_multiple_checkpoints(self, tmp_path: Path) -> None:
        """Test creating multiple checkpoints."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Create first checkpoint
        cp1 = await service.create_checkpoint(
            checkpoint_id="cp-1", message="First checkpoint"
        )

        # Make a change
        (tmp_path / "file1.txt").write_text("Content 1")

        # Create second checkpoint
        cp2 = await service.create_checkpoint(
            checkpoint_id="cp-2", message="Second checkpoint"
        )

        # Make another change
        (tmp_path / "file2.txt").write_text("Content 2")

        # Create third checkpoint
        cp3 = await service.create_checkpoint(
            checkpoint_id="cp-3", message="Third checkpoint"
        )

        # All checkpoints should have different commits (since changes were made)
        assert cp1.jj_commit_id != cp2.jj_commit_id
        assert cp2.jj_commit_id != cp3.jj_commit_id
        assert cp1.jj_commit_id != cp3.jj_commit_id

        # Verify all bookmarks exist
        result = subprocess.run(
            ["jj", "bookmark", "list"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=True,
        )
        assert "checkpoint-cp-1" in result.stdout
        assert "checkpoint-cp-2" in result.stdout
        assert "checkpoint-cp-3" in result.stdout

    @pytest.mark.asyncio
    async def test_restore_checkpoint(self, tmp_path: Path) -> None:
        """Test restoring to a previous checkpoint."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Create a file and checkpoint
        file1 = tmp_path / "file1.txt"
        file1.write_text("Original content")

        checkpoint1 = await service.create_checkpoint(
            checkpoint_id="restore-test-1", message="First state"
        )

        # Modify the file
        file1.write_text("Modified content")

        # Create another file and checkpoint
        file2 = tmp_path / "file2.txt"
        file2.write_text("New file")

        await service.create_checkpoint(
            checkpoint_id="restore-test-2", message="Second state"
        )

        # Restore to first checkpoint
        await service.restore_checkpoint("restore-test-1")

        # Verify we're at the first checkpoint
        status = await service.get_status()
        assert status.is_jj_repo is True

        # The working copy should have the state from checkpoint 1
        # Note: file1 should have "Original content" in the commit
        result = subprocess.run(
            ["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=True,
        )
        current_commit = result.stdout.strip()
        assert current_commit == checkpoint1.jj_commit_id

    @pytest.mark.asyncio
    async def test_restore_nonexistent_checkpoint_fails(
        self, tmp_path: Path
    ) -> None:
        """Test that restoring a nonexistent checkpoint raises an error."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Try to restore a checkpoint that doesn't exist
        with pytest.raises(subprocess.CalledProcessError):
            await service.restore_checkpoint("nonexistent-checkpoint")

    @pytest.mark.asyncio
    async def test_checkpoint_workflow_integration(
        self, tmp_path: Path
    ) -> None:
        """Test a realistic workflow: create, modify, checkpoint, restore."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Initial state
        file_a = tmp_path / "a.txt"
        file_a.write_text("Version A")
        checkpoint_a = await service.create_checkpoint(
            checkpoint_id="workflow-a", message="State A"
        )

        # Second state
        file_a.write_text("Version B")
        file_b = tmp_path / "b.txt"
        file_b.write_text("File B added")
        checkpoint_b = await service.create_checkpoint(
            checkpoint_id="workflow-b", message="State B"
        )

        # Third state
        file_a.write_text("Version C")
        file_b.write_text("File B modified")
        file_c = tmp_path / "c.txt"
        file_c.write_text("File C added")
        await service.create_checkpoint(
            checkpoint_id="workflow-c", message="State C"
        )

        # Restore to state B
        await service.restore_checkpoint("workflow-b")

        # Verify we're at checkpoint B
        result = subprocess.run(
            ["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=True,
        )
        current_commit = result.stdout.strip()
        assert current_commit == checkpoint_b.jj_commit_id

        # Restore to state A
        await service.restore_checkpoint("workflow-a")

        # Verify we're at checkpoint A
        result = subprocess.run(
            ["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            check=True,
        )
        current_commit = result.stdout.strip()
        assert current_commit == checkpoint_a.jj_commit_id


@pytest.mark.integration
class TestCheckpointDataclasses:
    """Tests for checkpoint-related dataclasses."""

    def test_repo_status_creation(self) -> None:
        """Test RepoStatus dataclass creation."""
        status = RepoStatus(
            is_jj_repo=True,
            current_commit="abc123",
            has_changes=True,
            change_summary="Modified: test.txt",
        )

        assert status.is_jj_repo is True
        assert status.current_commit == "abc123"
        assert status.has_changes is True
        assert status.change_summary == "Modified: test.txt"

    def test_checkpoint_creation(self) -> None:
        """Test Checkpoint dataclass creation."""
        checkpoint = Checkpoint(
            checkpoint_id="cp-123",
            jj_commit_id="abc123def456",
            bookmark_name="checkpoint-cp-123",
            message="Test checkpoint",
            created_at="2024-01-01T00:00:00Z",
        )

        assert checkpoint.checkpoint_id == "cp-123"
        assert checkpoint.jj_commit_id == "abc123def456"
        assert checkpoint.bookmark_name == "checkpoint-cp-123"
        assert checkpoint.message == "Test checkpoint"
        assert checkpoint.created_at == "2024-01-01T00:00:00Z"


@pytest.mark.integration
class TestJJErrorCases:
    """Tests for JJ error handling and edge cases."""

    @pytest.fixture(autouse=True)
    def check_jj_installed(self) -> None:
        """Skip tests if JJ is not installed."""
        try:
            subprocess.run(
                ["jj", "--version"], capture_output=True, check=True
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            pytest.skip("JJ not installed")

    @pytest.mark.asyncio
    async def test_create_checkpoint_with_special_characters(
        self, tmp_path: Path
    ) -> None:
        """Test checkpoint creation with special characters in ID and message."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Create file with special characters
        special_file = tmp_path / "file with spaces.txt"
        special_file.write_text("Content with\nMultiple\nLines")

        checkpoint = await service.create_checkpoint(
            checkpoint_id="cp-with-dashes-123",
            message="Checkpoint with 'quotes' and special: chars!",
        )

        assert checkpoint.checkpoint_id == "cp-with-dashes-123"
        assert checkpoint.bookmark_name == "checkpoint-cp-with-dashes-123"

    @pytest.mark.asyncio
    async def test_empty_directory_checkpoint(self, tmp_path: Path) -> None:
        """Test checkpoint on completely empty directory."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Create checkpoint without any files
        checkpoint = await service.create_checkpoint(
            checkpoint_id="empty-cp", message="Empty checkpoint"
        )

        assert checkpoint.checkpoint_id == "empty-cp"
        assert checkpoint.jj_commit_id is not None

    @pytest.mark.asyncio
    async def test_large_file_checkpoint(self, tmp_path: Path) -> None:
        """Test checkpoint with a larger file."""
        service = RepoStateService(tmp_path)
        await service.ensure_jj_repo()

        # Create a larger file (1MB)
        large_file = tmp_path / "large.txt"
        large_file.write_text("x" * (1024 * 1024))

        checkpoint = await service.create_checkpoint(
            checkpoint_id="large-file-cp", message="Large file checkpoint"
        )

        assert checkpoint.checkpoint_id == "large-file-cp"

        # Verify file is in the commit
        assert large_file.exists()
        assert len(large_file.read_text()) == 1024 * 1024
