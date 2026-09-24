package services

import (
	"context"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/runtimeports"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type fakeRepoFileProbe struct {
	files map[string]string
	calls []string
	err   error
}

func (f *fakeRepoFileProbe) GetFileAtChange(_ context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	f.calls = append(f.calls, owner+"/"+repo+"@"+changeID+":"+path)
	if f.err != nil {
		return repohost.FileContent{}, f.err
	}
	content, ok := f.files[path]
	if !ok {
		return repohost.FileContent{}, errors.New("not found")
	}
	return repohost.FileContent{Path: path, Content: content}, nil
}

type fakeEnvironmentImageResolver struct {
	image runtimeports.SandboxEnvironmentImage
	err   error
	kinds []string
}

func (f *fakeEnvironmentImageResolver) Resolve(_ context.Context, _ int64, kind string) (runtimeports.SandboxEnvironmentImage, error) {
	f.kinds = append(f.kinds, kind)
	if f.err != nil {
		return runtimeports.SandboxEnvironmentImage{}, f.err
	}
	return f.image, nil
}

func repoScopedImage(repositoryID int64) runtimeports.SandboxEnvironmentImage {
	return runtimeports.SandboxEnvironmentImage{
		RepositoryID: pgtype.Int8{Int64: repositoryID, Valid: true},
		Kind:         "vm",
		ClosureHash:  "0123456789abcdef0123456789abcdef",
		Image:        "us-docker.pkg.dev/plue/nix/repo:0123456789abcdef0123456789abcdef",
		Status:       "ready",
	}
}

func declaredEnvironmentProbe() *fakeRepoFileProbe {
	return &fakeRepoFileProbe{files: map[string]string{RepositoryEnvironmentNixPath: "{ ... }: {}"}}
}

func ciPlaneInput() CIExecutionPlaneInput {
	return CIExecutionPlaneInput{RepositoryID: 42, Owner: "alice", Repo: "demo", CommitSHA: "cafebabe"}
}

func TestResolveCIExecutionPlane_DeclaredEnvironmentWithRegisteredImageIsSandbox(t *testing.T) {
	t.Parallel()
	probe := declaredEnvironmentProbe()
	images := &fakeEnvironmentImageResolver{image: repoScopedImage(42)}

	plane := ResolveCIExecutionPlane(context.Background(), probe, images, ciPlaneInput())

	assert.Equal(t, WorkflowRunPlaneSandbox, plane)
	assert.Equal(t, []string{"alice/demo@cafebabe:" + RepositoryEnvironmentNixPath}, probe.calls,
		"the probe must read the trigger commit, not a moving bookmark")
	assert.Equal(t, []string{"vm"}, images.kinds, "CI guests are headless kind=vm, never kind=desktop")
}

func TestResolveCIExecutionPlane_NoEnvironmentNixStaysOnRunner(t *testing.T) {
	t.Parallel()
	probe := &fakeRepoFileProbe{files: map[string]string{}}
	images := &fakeEnvironmentImageResolver{image: repoScopedImage(42)}

	plane := ResolveCIExecutionPlane(context.Background(), probe, images, ciPlaneInput())

	assert.Equal(t, WorkflowRunPlaneRunner, plane)
	assert.Empty(t, images.kinds, "a repository that declares no environment must not consult the registry")
}

func TestResolveCIExecutionPlane_PlatformBaseImageFallbackStaysOnRunner(t *testing.T) {
	t.Parallel()
	// The registry falls back to the platform base image (repository_id NULL)
	// so workspaces can still boot. CI must not accept that fallback: the base
	// closure carries no repository toolchain.
	base := repoScopedImage(42)
	base.RepositoryID = pgtype.Int8{}
	images := &fakeEnvironmentImageResolver{image: base}

	plane := ResolveCIExecutionPlane(context.Background(), declaredEnvironmentProbe(), images, ciPlaneInput())

	assert.Equal(t, WorkflowRunPlaneRunner, plane)
}

func TestResolveCIExecutionPlane_OtherRepositoryImageStaysOnRunner(t *testing.T) {
	t.Parallel()
	images := &fakeEnvironmentImageResolver{image: repoScopedImage(99)}

	plane := ResolveCIExecutionPlane(context.Background(), declaredEnvironmentProbe(), images, ciPlaneInput())

	assert.Equal(t, WorkflowRunPlaneRunner, plane)
}

func TestResolveCIExecutionPlane_RegistryErrorStaysOnRunner(t *testing.T) {
	t.Parallel()
	images := &fakeEnvironmentImageResolver{err: errors.New("registry unavailable")}

	plane := ResolveCIExecutionPlane(context.Background(), declaredEnvironmentProbe(), images, ciPlaneInput())

	assert.Equal(t, WorkflowRunPlaneRunner, plane)
}

func TestResolveCIExecutionPlane_ProbeErrorStaysOnRunner(t *testing.T) {
	t.Parallel()
	probe := &fakeRepoFileProbe{err: errors.New("repo-host down")}
	images := &fakeEnvironmentImageResolver{image: repoScopedImage(42)}

	plane := ResolveCIExecutionPlane(context.Background(), probe, images, ciPlaneInput())

	assert.Equal(t, WorkflowRunPlaneRunner, plane)
}

func TestResolveCIExecutionPlane_UnwiredDependenciesStayOnRunner(t *testing.T) {
	t.Parallel()
	assert.Equal(t, WorkflowRunPlaneRunner,
		ResolveCIExecutionPlane(context.Background(), nil, &fakeEnvironmentImageResolver{image: repoScopedImage(42)}, ciPlaneInput()))
	assert.Equal(t, WorkflowRunPlaneRunner,
		ResolveCIExecutionPlane(context.Background(), declaredEnvironmentProbe(), nil, ciPlaneInput()))
}

func TestResolveCIExecutionPlane_MissingTriggerCommitStaysOnRunner(t *testing.T) {
	t.Parallel()
	input := ciPlaneInput()
	input.CommitSHA = "  "
	probe := declaredEnvironmentProbe()

	plane := ResolveCIExecutionPlane(context.Background(), probe, &fakeEnvironmentImageResolver{image: repoScopedImage(42)}, input)

	assert.Equal(t, WorkflowRunPlaneRunner, plane)
	assert.Empty(t, probe.calls, "a run with no immutable commit has nothing to probe")
}

func TestNormalizeCIExecutionPlane_RejectsEverythingButSandbox(t *testing.T) {
	t.Parallel()
	assert.Equal(t, WorkflowRunPlaneSandbox, normalizeCIExecutionPlane(WorkflowRunPlaneSandbox))
	assert.Equal(t, WorkflowRunPlaneRunner, normalizeCIExecutionPlane(WorkflowRunPlaneRunner))
	assert.Equal(t, WorkflowRunPlaneRunner, normalizeCIExecutionPlane(WorkflowRunPlaneAgent),
		"agent is reachable only through agent dispatch")
	assert.Equal(t, WorkflowRunPlaneRunner, normalizeCIExecutionPlane(""))
	assert.Equal(t, WorkflowRunPlaneRunner, normalizeCIExecutionPlane("microsandbox"))
}
