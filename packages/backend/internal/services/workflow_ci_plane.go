package services

import (
	"context"
	"log/slog"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// RepositoryEnvironmentNixPath is the file a repository uses to declare that it
// owns its own machine: a NixOS module imported after nix/modules/base.nix and
// built into the closure image every kind=vm guest boots.
const RepositoryEnvironmentNixPath = ".smithers/environment.nix"

// nixCIEnvironmentImageKind is the guest kind a CI task boots. CI tasks are
// headless, so they use the same kind=vm closure a workspace boots, never the
// heavier kind=desktop one.
const nixCIEnvironmentImageKind = "vm"

// WorkflowRunRepoFileProbe reads one path out of one immutable repository
// revision. repohost.Client implements it; the workflow-sync service uses the
// same call to discover workflow definitions.
type WorkflowRunRepoFileProbe interface {
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

// WorkflowRunEnvironmentImageResolver resolves the NixOS closure image a guest
// boots for a repository. SandboxEnvironmentImageService implements it; it is
// the exact lookup a kind=vm workspace already performs.
type WorkflowRunEnvironmentImageResolver interface {
	Resolve(ctx context.Context, repositoryID int64, kind string) (db.SandboxEnvironmentImage, error)
}

// CIExecutionPlaneInput identifies the repository revision a CI run was
// dispatched for.
type CIExecutionPlaneInput struct {
	RepositoryID int64
	Owner        string
	Repo         string
	CommitSHA    string
}

// ResolveCIExecutionPlane decides which execution plane a newly dispatched CI
// run lands on. It returns WorkflowRunPlaneSandbox for a repository that
// declares and has built its own NixOS environment, and WorkflowRunPlaneRunner
// for everything else.
//
// Owner decision (2026-09-15): Smithers Cloud machines are NixOS, built from
// nix/ plus each repository's .smithers/environment.nix — not Docker images.
// Workspaces and agent runs already boot that closure as kind=vm guests
// (WorkspaceService.buildWorkspaceVMRequestWithImage). Cloud CI was the last
// consumer still pinned to the Debian smithers-runner image on the gVisor
// runner pool, and paid for it in toolchain patching (Node 18, missing
// ps/xz/bwrap, cargo OOM) that the NixOS workspaces never needed, because the
// runner image is a second, hand-maintained definition of the same machine.
//
// The rule, in order:
//
//  1. The trigger commit must contain .smithers/environment.nix. That file is
//     the repository's declaration that it owns its toolchain. Routing a
//     repository that has not declared one onto a NixOS guest would boot the
//     platform base closure, which contains no repository toolchain at all —
//     strictly worse than the Debian runner it replaced.
//
//  2. A ready kind=vm closure image must be registered FOR THAT REPOSITORY.
//     The registry resolver deliberately falls back to the platform base image
//     (repository_id NULL) so a workspace can still boot; accepting that
//     fallback here would reintroduce failure mode 1 in Nix clothing. So the
//     resolved image's repository must match. The consequence is intentional:
//     the first push after adding environment.nix runs on the Debian runner
//     until `bun scripts/build-nix-environment.ts --kind vm --repo <owner/repo>
//     --register` has built and registered the closure.
//
// Anything else — no probe or resolver wired, a lookup error, a run with no
// trigger commit — is the runner plane. The Debian runner pool is the
// fallback, to be retired once every active repository has a registered
// closure image.
func ResolveCIExecutionPlane(
	ctx context.Context,
	probe WorkflowRunRepoFileProbe,
	images WorkflowRunEnvironmentImageResolver,
	input CIExecutionPlaneInput,
) string {
	if probe == nil || images == nil {
		return WorkflowRunPlaneRunner
	}
	owner := strings.TrimSpace(input.Owner)
	repo := strings.TrimSpace(input.Repo)
	commit := strings.TrimSpace(input.CommitSHA)
	if owner == "" || repo == "" || commit == "" || input.RepositoryID <= 0 {
		return WorkflowRunPlaneRunner
	}

	if _, err := probe.GetFileAtChange(ctx, owner, repo, commit, RepositoryEnvironmentNixPath); err != nil {
		// Absent is the common case and not an error worth logging loudly: a
		// repository that has not adopted the NixOS environment simply stays
		// on the runner plane.
		slog.Debug("workflow run stays on the runner plane: no environment.nix at the trigger commit",
			"repository_id", input.RepositoryID, "commit", commit)
		return WorkflowRunPlaneRunner
	}

	image, err := images.Resolve(ctx, input.RepositoryID, nixCIEnvironmentImageKind)
	if err != nil {
		slog.Warn("workflow run stays on the runner plane: no NixOS environment image resolved",
			"repository_id", input.RepositoryID, "error", err)
		return WorkflowRunPlaneRunner
	}
	if !image.RepositoryID.Valid || image.RepositoryID.Int64 != input.RepositoryID {
		slog.Info("workflow run stays on the runner plane: repository declares environment.nix but has no registered closure image",
			"repository_id", input.RepositoryID, "resolved_image", image.Image)
		return WorkflowRunPlaneRunner
	}

	slog.Info("workflow run routed to the NixOS sandbox plane",
		"repository_id", input.RepositoryID, "closure_hash", image.ClosureHash, "image", image.Image)
	return WorkflowRunPlaneSandbox
}

// normalizeCIExecutionPlane is the last gate before the insert: a CI run may
// only be created on the runner or sandbox plane. 'agent' is reachable solely
// through agent dispatch, and an empty or unknown value falls back to the
// runner pool, which is always safe — the sandbox scheduler never claims a
// 'runner' run.
func normalizeCIExecutionPlane(plane string) string {
	if strings.TrimSpace(plane) == WorkflowRunPlaneSandbox {
		return WorkflowRunPlaneSandbox
	}
	return WorkflowRunPlaneRunner
}

// BindWorkflowRunEnvironmentRouting wires NixOS CI routing into an
// already-constructed run service. The closure image registry is built after
// the run service (it depends on the workspace service, which depends on the
// sandbox client), so routing is bound late rather than reordering startup.
// A service that is not the concrete implementation is left on the runner
// plane, which is always safe.
func BindWorkflowRunEnvironmentRouting(svc WorkflowRunService, probe WorkflowRunRepoFileProbe, images WorkflowRunEnvironmentImageResolver) {
	concrete, ok := svc.(*workflowRunService)
	if !ok {
		return
	}
	WithWorkflowRunEnvironmentRouting(probe, images)(concrete)
}
