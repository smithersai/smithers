package process

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// ResolveWorkspaceSourceRevision returns the repository snapshot used to
// launch a Flow host. Jujutsu's working-copy commit captures the current
// snapshot. A plain Git checkout is accepted only when its worktree is clean.
func (r *Runtime) ResolveWorkspaceSourceRevision(ctx context.Context, workspaceID string) (string, error) {
	current, err := r.InspectWorkspace(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	if current.State != workspaceapi.WorkspaceRunning {
		return "", workspaceapi.ErrWorkspaceStopped
	}
	jj, err := repositoryMarker(current.Root, ".jj")
	if err != nil {
		return "", err
	}
	if jj {
		result, err := r.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{
			Args: []string{"jj", "--color=never", "log", "-r", "@", "--no-graph", "-T", "commit_id ++ \"\\n\""},
		})
		if err != nil {
			return "", fmt.Errorf("resolve Jujutsu workspace revision: %w", err)
		}
		if result.ExitCode != 0 || result.OutputTruncated {
			return "", fmt.Errorf("%w: Jujutsu snapshot failed", workspaceapi.ErrWorkspaceSourceUnavailable)
		}
		return validatedSourceRevision(result.Stdout)
	}

	git, err := repositoryMarker(current.Root, ".git")
	if err != nil {
		return "", err
	}
	if !git {
		return "", workspaceapi.ErrWorkspaceSourceUnavailable
	}
	first, err := r.gitHead(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	status, err := r.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{
		Args: []string{"git", "status", "--porcelain=v1", "--untracked-files=normal"},
	})
	if err != nil {
		return "", fmt.Errorf("inspect Git workspace: %w", err)
	}
	if status.ExitCode != 0 || status.OutputTruncated {
		return "", fmt.Errorf("%w: Git status failed", workspaceapi.ErrWorkspaceSourceUnavailable)
	}
	if strings.TrimSpace(status.Stdout) != "" {
		return "", fmt.Errorf("%w: Git worktree is not clean", workspaceapi.ErrWorkspaceSourceUnavailable)
	}
	second, err := r.gitHead(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	if first != second {
		return "", fmt.Errorf("%w: Git HEAD changed while resolving", workspaceapi.ErrWorkspaceSourceUnavailable)
	}
	return first, nil
}

func (r *Runtime) gitHead(ctx context.Context, workspaceID string) (string, error) {
	result, err := r.ExecuteCommand(ctx, workspaceID, workspaceapi.Command{
		Args: []string{"git", "rev-parse", "--verify", "HEAD"},
	})
	if err != nil {
		return "", fmt.Errorf("resolve Git workspace revision: %w", err)
	}
	if result.ExitCode != 0 || result.OutputTruncated {
		return "", fmt.Errorf("%w: Git HEAD resolution failed", workspaceapi.ErrWorkspaceSourceUnavailable)
	}
	return validatedSourceRevision(result.Stdout)
}

func repositoryMarker(root, name string) (bool, error) {
	info, err := os.Lstat(filepath.Join(root, name))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("inspect repository metadata: %w", err)
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		return false, errors.New("repository metadata must not be a symbolic link")
	}
	return true, nil
}

func validatedSourceRevision(output string) (string, error) {
	revision := strings.TrimSpace(output)
	if !lowerHex(revision, 40) {
		return "", fmt.Errorf("%w: revision must be 40 lowercase hexadecimal characters", workspaceapi.ErrWorkspaceSourceUnavailable)
	}
	return revision, nil
}

var _ workspaceapi.WorkspaceSourceRevisionResolver = (*Runtime)(nil)
