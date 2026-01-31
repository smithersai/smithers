"""JJ integration for checkpoint management.

This module provides the RepoStateService for managing JJ (Jujutsu) repositories
and creating/restoring checkpoints during agent runs.

Key features:
- Initialize JJ repository if needed
- Create checkpoints with metadata
- Restore to previous checkpoints
- Query repository status

See prd/smithers-v2-task-guide.md Category 8 for requirements.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class RepoStatus:
    """Repository status information."""

    is_jj_repo: bool
    current_commit: str | None
    has_changes: bool
    change_summary: str | None


@dataclass
class Checkpoint:
    """A checkpoint created by the agent."""

    checkpoint_id: str
    jj_commit_id: str
    bookmark_name: str
    message: str
    created_at: str


class JJNotFoundError(Exception):
    """Raised when JJ is not installed or not found in PATH."""

    pass


class RepoStateService:
    """
    Service for managing JJ repository state and checkpoints.

    This service wraps JJ commands to provide checkpoint functionality
    for agent sessions. It handles:
    - Ensuring the workspace is a JJ repository
    - Creating named checkpoints (bookmarks) at specific commits
    - Restoring to previous checkpoints
    - Querying repository status

    Usage:
        service = RepoStateService(Path("/path/to/workspace"))

        # Ensure JJ repo exists
        await service.ensure_jj_repo()

        # Create a checkpoint
        checkpoint = await service.create_checkpoint(
            checkpoint_id="cp-123",
            message="Before refactoring auth"
        )

        # Restore checkpoint
        await service.restore_checkpoint(checkpoint.checkpoint_id)

        # Get status
        status = await service.get_status()
    """

    def __init__(self, workspace_root: Path) -> None:
        """
        Initialize the RepoStateService.

        Args:
            workspace_root: Path to the workspace directory
        """
        self.workspace_root = workspace_root

    async def ensure_jj_repo(self) -> None:
        """
        Ensure the workspace is a JJ repository.

        If the workspace is not already a JJ repo, initialize it.
        If JJ is not installed, raise JJNotFoundError.

        Raises:
            JJNotFoundError: If JJ is not installed or not found in PATH
            subprocess.CalledProcessError: If JJ command fails
        """
        # Check if JJ is installed
        try:
            subprocess.run(
                ["jj", "--version"],
                capture_output=True,
                text=True,
                check=True,
            )
        except FileNotFoundError as e:
            raise JJNotFoundError(
                "JJ (Jujutsu) is not installed or not found in PATH. "
                "Install from https://github.com/martinvonz/jj"
            ) from e

        # Check if already a JJ repo
        status = await self.get_status()
        if status.is_jj_repo:
            return

        # Initialize JJ repo
        subprocess.run(
            ["jj", "git", "init"],
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=True,
        )

    async def create_checkpoint(
        self, checkpoint_id: str, message: str
    ) -> Checkpoint:
        """
        Create a checkpoint at the current commit.

        This creates a JJ bookmark with the given checkpoint_id as the name,
        pointing to the current commit. If there are working copy changes,
        they are committed first.

        Args:
            checkpoint_id: Unique identifier for this checkpoint (used as bookmark name)
            message: Human-readable description of the checkpoint

        Returns:
            Checkpoint with metadata

        Raises:
            JJNotFoundError: If JJ is not installed
            subprocess.CalledProcessError: If JJ command fails
        """
        # Ensure JJ repo exists
        await self.ensure_jj_repo()

        # Get current commit before any changes
        result = subprocess.run(
            ["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"],
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=True,
        )
        current_commit = result.stdout.strip()

        # Check if there are uncommitted changes
        status = await self.get_status()
        if status.has_changes:
            # Commit changes with the checkpoint message
            subprocess.run(
                ["jj", "commit", "-m", message],
                cwd=self.workspace_root,
                capture_output=True,
                text=True,
                check=True,
            )
            # Get the new commit ID
            result = subprocess.run(
                ["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"],
                cwd=self.workspace_root,
                capture_output=True,
                text=True,
                check=True,
            )
            jj_commit_id = result.stdout.strip()
        else:
            jj_commit_id = current_commit

        # Create bookmark at the commit
        bookmark_name = f"checkpoint-{checkpoint_id}"
        subprocess.run(
            ["jj", "bookmark", "create", bookmark_name, "-r", jj_commit_id],
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=True,
        )

        # Get timestamp
        result = subprocess.run(
            ["jj", "log", "-r", jj_commit_id, "--no-graph", "-T", "committer.timestamp()"],
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=True,
        )
        created_at = result.stdout.strip()

        return Checkpoint(
            checkpoint_id=checkpoint_id,
            jj_commit_id=jj_commit_id,
            bookmark_name=bookmark_name,
            message=message,
            created_at=created_at,
        )

    async def restore_checkpoint(self, checkpoint_id: str) -> None:
        """
        Restore the repository to a previous checkpoint.

        This checks out the commit associated with the checkpoint bookmark.
        Any uncommitted changes will be preserved in a new commit.

        Args:
            checkpoint_id: The checkpoint ID to restore

        Raises:
            JJNotFoundError: If JJ is not installed
            subprocess.CalledProcessError: If JJ command fails or checkpoint not found
        """
        bookmark_name = f"checkpoint-{checkpoint_id}"

        # Edit to the checkpoint commit
        subprocess.run(
            ["jj", "edit", bookmark_name],
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=True,
        )

    async def get_status(self) -> RepoStatus:
        """
        Get the current repository status.

        Returns:
            RepoStatus with repository information

        Raises:
            JJNotFoundError: If JJ is not installed (only for non-repo checks)
        """
        # Check if JJ is installed
        try:
            subprocess.run(
                ["jj", "--version"],
                capture_output=True,
                text=True,
                check=True,
            )
        except FileNotFoundError:
            # JJ not installed, but we can still return status
            return RepoStatus(
                is_jj_repo=False,
                current_commit=None,
                has_changes=False,
                change_summary=None,
            )

        # Check if this is a JJ repo by trying to get status
        try:
            result = subprocess.run(
                ["jj", "status"],
                cwd=self.workspace_root,
                capture_output=True,
                text=True,
                check=True,
            )
            is_jj_repo = True
            status_output = result.stdout
        except subprocess.CalledProcessError:
            # Not a JJ repo
            return RepoStatus(
                is_jj_repo=False,
                current_commit=None,
                has_changes=False,
                change_summary=None,
            )

        # Get current commit
        result = subprocess.run(
            ["jj", "log", "-r", "@", "--no-graph", "-T", "commit_id"],
            cwd=self.workspace_root,
            capture_output=True,
            text=True,
            check=True,
        )
        current_commit = result.stdout.strip()

        # Check for changes
        has_changes = "Working copy changes:" in status_output or "Working copy :" in status_output
        change_summary = status_output if has_changes else None

        return RepoStatus(
            is_jj_repo=is_jj_repo,
            current_commit=current_commit,
            has_changes=has_changes,
            change_summary=change_summary,
        )
