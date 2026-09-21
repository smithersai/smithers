package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
)

// Anonymous sandboxes back ../multi SPEC.md §3: a signed-out visitor opening
// an allowlisted public repository (today exactly smithersai/smithers) gets a
// short-lived sandbox on the requested branch. The security envelope is
// deliberate and narrow:
//
//   - the allowlist lives server-side (config), never client-side;
//   - rows carry NO user linkage — anonymous work never joins user data;
//   - access is a bearer capability returned once at creation;
//   - creation is capped globally, per IP, and per-IP rate limited;
//   - lifetime is a hard TTL after which the reaper DELETES the VM. Anonymous
//     sandboxes are never suspended-with-disk-retained: the recurring cost of
//     sandboxes is retained disks, not compute, so nothing anonymous may
//     outlive its TTL.
const (
	anonSandboxProvisionTimeout = 10 * time.Minute
	anonSandboxReaperInterval   = time.Minute
	anonSandboxReapBatchLimit   = 50
	anonSandboxCloneTimeout     = 210 * time.Second

	anonStageCreatingVM   = "creating_vm"
	anonStageCloningRepo  = "cloning_repository"
	anonStageReady        = "ready"
	anonStageCreateFailed = "vm_create_failed"
	anonStageCloneFailed  = "clone_failed"
)

// anonSandboxBranchPattern bounds the branch names an anonymous caller can
// request: plain ref characters only, no leading dash (argv-flag injection).
var anonSandboxBranchPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,128}$`)

// AnonSandboxVMClient is the slice of sandbox.Provider anonymous provisioning
// needs (interface so tests drive the lifecycle without a provider).
type AnonSandboxVMClient interface {
	CreateSandbox(ctx context.Context, req sandbox.CreateRequest) (sandbox.CreateResult, error)
	DeleteSandbox(ctx context.Context, id string) error
	Execute(ctx context.Context, id string, req sandbox.ExecRequest) (sandbox.ExecResult, error)
}

// anonGoldenSnapshots is the golden-snapshot fast path (GoldenSnapshotService).
type anonGoldenSnapshots interface {
	Current(ctx context.Context) string
	MarkBad(ctx context.Context, snapshotID string)
}

type anonSandboxStore interface {
	CreateAnonSandbox(ctx context.Context, arg db.CreateAnonSandboxParams) (db.AnonSandbox, error)
	GetAnonSandbox(ctx context.Context, id string) (db.AnonSandbox, error)
	UpdateAnonSandboxStatusCAS(ctx context.Context, arg db.UpdateAnonSandboxStatusCASParams) (db.AnonSandbox, error)
	CountActiveAnonSandboxes(ctx context.Context) (int64, error)
	CountActiveAnonSandboxesForIP(ctx context.Context, clientIP string) (int64, error)
	ListReapableAnonSandboxes(ctx context.Context, limit int32) ([]db.AnonSandbox, error)
	SoftDeleteAnonSandbox(ctx context.Context, id string) (db.AnonSandbox, error)
}

// AnonSandboxConfig is the service's bound of the sandbox.anon_* config knobs
// plus the VM sizing caps (the agent sizing knobs double as the platform's
// "bounded VM" numbers; anonymous VMs must never be larger than agent VMs).
type AnonSandboxConfig struct {
	Enabled       bool
	RepoAllowlist []string
	TTL           time.Duration
	MaxConcurrent int32
	MaxPerIP      int32
	MemSizeMB     int32
	VCPUCount     int32
	RootfsSizeMB  int64
}

// AnonSandboxService provisions, serves, and reaps anonymous sandboxes.
type AnonSandboxService struct {
	q       anonSandboxStore
	sandbox AnonSandboxVMClient
	golden  anonGoldenSnapshots
	// baseVMRequest supplies the repo-agnostic, secret-free workspace VM
	// request (WorkspaceService.GoldenBakeVMRequest) so anonymous VMs boot the
	// exact environment the golden snapshot was baked from.
	baseVMRequest func() sandbox.CreateRequest
	cfg           AnonSandboxConfig
	now           func() time.Time
}

// NewAnonSandboxService constructs the service. golden may be nil (no fast
// path); sandbox may be nil (creation degrades honestly with a 409-style
// unavailable error, mirroring the repo-gateway degrade).
func NewAnonSandboxService(q anonSandboxStore, vmClient AnonSandboxVMClient, golden anonGoldenSnapshots, baseVMRequest func() sandbox.CreateRequest, cfg AnonSandboxConfig) *AnonSandboxService {
	if cfg.TTL <= 0 {
		cfg.TTL = 30 * time.Minute
	}
	return &AnonSandboxService{
		q:             q,
		sandbox:       vmClient,
		golden:        golden,
		baseVMRequest: baseVMRequest,
		cfg:           cfg,
		now:           time.Now,
	}
}

// AnonSandboxCreation is a created sandbox plus its once-only access token.
type AnonSandboxCreation struct {
	Sandbox db.AnonSandbox
	Token   string
}

func (s *AnonSandboxService) repoAllowed(fullName string) bool {
	for _, allowed := range s.cfg.RepoAllowlist {
		if strings.EqualFold(strings.TrimSpace(allowed), fullName) {
			return true
		}
	}
	return false
}

// Create validates the request against the anonymous security envelope,
// inserts the row, and provisions the VM asynchronously (the caller polls
// Get until status running/failed, like the async workspace path).
func (s *AnonSandboxService) Create(ctx context.Context, repoFullName, branch, clientIP string) (AnonSandboxCreation, error) {
	if s == nil || s.q == nil {
		return AnonSandboxCreation{}, pkgerrors.Internal("anonymous sandbox service unavailable")
	}
	if !s.cfg.Enabled {
		return AnonSandboxCreation{}, pkgerrors.NotFound("anonymous sandboxes are not enabled")
	}
	if s.sandbox == nil || s.baseVMRequest == nil {
		return AnonSandboxCreation{}, pkgerrors.Conflict("sandbox provisioning is not configured on this deployment")
	}

	repoFullName = strings.TrimSpace(repoFullName)
	owner, name, ok := strings.Cut(repoFullName, "/")
	if !ok || strings.TrimSpace(owner) == "" || strings.TrimSpace(name) == "" || strings.Contains(name, "/") {
		return AnonSandboxCreation{}, pkgerrors.BadRequest("repo_full_name must be owner/name")
	}
	if !s.repoAllowed(repoFullName) {
		return AnonSandboxCreation{}, pkgerrors.Forbidden("repository is not on the anonymous sandbox allowlist")
	}

	branch = strings.TrimSpace(branch)
	if branch == "" {
		branch = "main"
	}
	if !anonSandboxBranchPattern.MatchString(branch) || strings.HasPrefix(branch, "-") {
		return AnonSandboxCreation{}, pkgerrors.BadRequest("invalid branch name")
	}

	// Both caps FAIL CLOSED: a count error refuses creation rather than
	// letting an outage disable the spend guard.
	if s.cfg.MaxConcurrent > 0 {
		active, err := s.q.CountActiveAnonSandboxes(ctx)
		if err != nil {
			return AnonSandboxCreation{}, err
		}
		if active >= int64(s.cfg.MaxConcurrent) {
			return AnonSandboxCreation{}, pkgerrors.QuotaExceeded("anonymous sandbox capacity reached, try again shortly")
		}
	}
	clientIP = strings.TrimSpace(clientIP)
	if s.cfg.MaxPerIP > 0 && clientIP != "" {
		perIP, err := s.q.CountActiveAnonSandboxesForIP(ctx, clientIP)
		if err != nil {
			return AnonSandboxCreation{}, err
		}
		if perIP >= int64(s.cfg.MaxPerIP) {
			return AnonSandboxCreation{}, pkgerrors.QuotaExceeded("too many active anonymous sandboxes for this address")
		}
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return AnonSandboxCreation{}, pkgerrors.Internal("mint sandbox token: " + err.Error())
	}
	token := hex.EncodeToString(tokenBytes)
	tokenHash := sha256.Sum256([]byte(token))

	row, err := s.q.CreateAnonSandbox(ctx, db.CreateAnonSandboxParams{
		RepoFullName: repoFullName,
		Branch:       branch,
		TokenHash:    hex.EncodeToString(tokenHash[:]),
		ClientIp:     clientIP,
		ExpiresAt:    s.now().UTC().Add(s.cfg.TTL),
	})
	if err != nil {
		return AnonSandboxCreation{}, err
	}

	s.provisionAsync(ctx, row)
	return AnonSandboxCreation{Sandbox: row, Token: token}, nil
}

// verifyToken resolves a live sandbox by id and constant-time-checks the
// caller's capability token. Unknown id and bad token are indistinguishable.
func (s *AnonSandboxService) verifyToken(ctx context.Context, id, token string) (db.AnonSandbox, error) {
	notFound := pkgerrors.NotFound("sandbox not found")
	if s == nil || s.q == nil {
		return db.AnonSandbox{}, pkgerrors.Internal("anonymous sandbox service unavailable")
	}
	row, err := s.q.GetAnonSandbox(ctx, id)
	if err != nil {
		if pgxNoRows(err) {
			return db.AnonSandbox{}, notFound
		}
		return db.AnonSandbox{}, err
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	if subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(row.TokenHash)) != 1 {
		return db.AnonSandbox{}, notFound
	}
	return row, nil
}

// Get returns the sandbox for status polling.
func (s *AnonSandboxService) Get(ctx context.Context, id, token string) (db.AnonSandbox, error) {
	return s.verifyToken(ctx, id, token)
}

// Delete tears the sandbox down early (VM first, then the row). A failed
// (non-404) VM delete keeps the row LIVE and returns an error — tombstoning
// a row whose VM still exists would orphan the disk, because the reaper only
// sweeps live rows. The live row stays reapable at TTL expiry, so the disk is
// deleted eventually even if the caller never retries.
func (s *AnonSandboxService) Delete(ctx context.Context, id, token string) error {
	row, err := s.verifyToken(ctx, id, token)
	if err != nil {
		return err
	}
	if err := s.deleteVM(ctx, row.VmID); err != nil {
		slog.Warn("anon sandbox vm delete failed; keeping row live for the reaper", "vm_id", row.VmID, "error", err)
		return pkgerrors.Internal("sandbox teardown failed; it will be reaped automatically")
	}
	if _, err := s.q.SoftDeleteAnonSandbox(ctx, row.ID); err != nil && !pgxNoRows(err) {
		return err
	}
	return nil
}

// deleteVM deletes the provider VM (and its disk). A missing VM counts as
// success; any other provider failure is returned so callers can decide
// whether the row may be tombstoned.
func (s *AnonSandboxService) deleteVM(ctx context.Context, vmID string) error {
	vmID = strings.TrimSpace(vmID)
	if vmID == "" || s.sandbox == nil {
		return nil
	}
	deleteCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := s.sandbox.DeleteSandbox(deleteCtx, vmID); err != nil && !isSandboxNotFound(err) {
		return err
	}
	return nil
}

// deleteVMBestEffort is deleteVM for paths where the VM is already
// unattributable (provision races) — the error is logged, not returned.
func (s *AnonSandboxService) deleteVMBestEffort(ctx context.Context, vmID string) {
	if err := s.deleteVM(ctx, vmID); err != nil {
		slog.Warn("anon sandbox vm delete failed", "vm_id", vmID, "error", err)
	}
}

// anonVMRequest assembles the provider-neutral create request: the exact
// secret-free workspace environment (so the golden snapshot applies), bounded
// by the agent-class sizing caps, ephemeral persistence, and an idle timeout
// no longer than the TTL.
func (s *AnonSandboxService) anonVMRequest(ctx context.Context, snapshotID string) sandbox.CreateRequest {
	req := s.baseVMRequest()
	req.SnapshotID = snapshotID
	if strings.TrimSpace(snapshotID) != "" {
		req.Packages = nil
	}
	if s.cfg.MemSizeMB > 0 {
		mem := s.cfg.MemSizeMB
		req.MemSizeMB = &mem
	}
	if s.cfg.VCPUCount > 0 {
		vcpu := s.cfg.VCPUCount
		req.VCPUCount = &vcpu
	}
	if s.cfg.RootfsSizeMB > 0 {
		rootfs := s.cfg.RootfsSizeMB
		req.RootfsSizeMB = &rootfs
	}
	idle := int64(s.cfg.TTL / time.Second)
	req.IdleTimeoutSeconds = &idle
	req.Persistence = &sandbox.PersistencePolicy{Type: sandbox.PersistenceEphemeral}
	return req
}

func (s *AnonSandboxService) provisionAsync(ctx context.Context, row db.AnonSandbox) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("panic in anon sandbox provisioning", "anon_sandbox_id", row.ID, "panic", r)
				s.markFailedStage(context.Background(), row.ID, "starting", anonStageCreateFailed)
			}
		}()
		provisionCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), anonSandboxProvisionTimeout)
		defer cancel()
		s.provision(provisionCtx, row)
	}()
}

func (s *AnonSandboxService) provision(ctx context.Context, row db.AnonSandbox) {
	current, err := s.q.UpdateAnonSandboxStatusCAS(ctx, db.UpdateAnonSandboxStatusCASParams{
		ID:                row.ID,
		NewStatus:         "starting",
		ProvisioningStage: anonStageCreatingVM,
		VmID:              "",
		ExpectedStatus:    "pending",
	})
	if err != nil {
		if !pgxNoRows(err) {
			slog.Error("anon sandbox starting transition failed", "anon_sandbox_id", row.ID, "error", err)
		}
		return // lost the CAS (reaped or deleted) — nothing to do
	}

	vm, err := s.createAnonVM(ctx, current)
	if err != nil {
		slog.Error("anon sandbox vm create failed", "anon_sandbox_id", row.ID, "error", err)
		s.markFailedStage(ctx, row.ID, "starting", anonStageCreateFailed)
		return
	}

	// Persist the VM id before the clone so a crash mid-clone leaves an
	// attributable allocation for the reaper.
	if _, err := s.q.UpdateAnonSandboxStatusCAS(ctx, db.UpdateAnonSandboxStatusCASParams{
		ID:                row.ID,
		NewStatus:         "starting",
		ProvisioningStage: anonStageCloningRepo,
		VmID:              vm.ID,
		ExpectedStatus:    "starting",
	}); err != nil {
		// Row vanished under us (reaper/delete won): the row can no longer
		// attribute the VM, so reap the VM here or it leaks.
		s.deleteVMBestEffort(ctx, vm.ID)
		return
	}

	if err := s.cloneAnonRepository(ctx, vm.ID, current.RepoFullName, current.Branch); err != nil {
		slog.Error("anon sandbox clone failed", "anon_sandbox_id", row.ID, "repo", current.RepoFullName, "error", err)
		s.deleteVMBestEffort(ctx, vm.ID)
		s.markFailedStage(ctx, row.ID, "starting", anonStageCloneFailed)
		return
	}

	if _, err := s.q.UpdateAnonSandboxStatusCAS(ctx, db.UpdateAnonSandboxStatusCASParams{
		ID:                row.ID,
		NewStatus:         "running",
		ProvisioningStage: anonStageReady,
		VmID:              vm.ID,
		ExpectedStatus:    "starting",
	}); err != nil {
		s.deleteVMBestEffort(ctx, vm.ID)
		return
	}
	slog.Info("anon sandbox provisioned", "anon_sandbox_id", row.ID, "repo", current.RepoFullName, "vm_id", vm.ID)
}

// createAnonVM boots from the golden snapshot with a bare-image fallback,
// mirroring createFreshWorkspaceVM (snapshots are an accelerator, never a
// dependency).
func (s *AnonSandboxService) createAnonVM(ctx context.Context, row db.AnonSandbox) (sandbox.CreateResult, error) {
	snapshotID := ""
	if s.golden != nil {
		snapshotID = s.golden.Current(ctx)
	}
	req := s.anonVMRequest(ctx, snapshotID)
	attempt := "bare"
	if strings.TrimSpace(snapshotID) != "" {
		attempt = "golden-" + snapshotID
	}
	vm, err := s.sandbox.CreateSandbox(sandboxProvisionContext(ctx, "create", "anon-sandbox", row.ID, attempt), req)
	if err == nil || strings.TrimSpace(snapshotID) == "" {
		return vm, err
	}
	slog.Warn("anon sandbox golden snapshot boot failed; retrying from bare image", "snapshot_id", snapshotID, "error", err)
	s.deleteVMBestEffort(ctx, vm.ID)
	bareVM, bareErr := s.sandbox.CreateSandbox(
		sandboxProvisionContext(ctx, "create", "anon-sandbox", row.ID, "bare"),
		s.anonVMRequest(ctx, ""),
	)
	if bareErr != nil {
		return bareVM, bareErr
	}
	if goldenSnapshotCreateErrorIsSnapshotSpecific(err, snapshotID) && s.golden != nil {
		s.golden.MarkBad(ctx, snapshotID)
	}
	return bareVM, nil
}

// cloneAnonRepository clones the PUBLIC repository inside the VM. No
// credential of any kind is involved: the allowlist admits only public
// repositories, and the clone URL is the public GitHub HTTPS endpoint.
func (s *AnonSandboxService) cloneAnonRepository(ctx context.Context, vmID, repoFullName, branch string) error {
	timeoutMS := int64(anonSandboxCloneTimeout / time.Millisecond)
	execCtx, cancel := context.WithTimeout(ctx, anonSandboxCloneTimeout)
	defer cancel()
	resp, err := s.sandbox.Execute(execCtx, vmID, sandbox.ExecRequest{
		Command:   buildAnonSandboxCloneCommand(repoFullName, branch),
		TimeoutMS: &timeoutMS,
	})
	if err != nil {
		return fmt.Errorf("clone anon repository: %w", err)
	}
	if resp.StatusCode != nil && *resp.StatusCode != 0 {
		detail := strings.TrimSpace(resp.Stderr)
		if out := strings.TrimSpace(resp.Stdout); out != "" {
			if detail != "" {
				detail += "\n"
			}
			detail += out
		}
		if len(detail) > 1000 {
			detail = detail[len(detail)-1000:]
		}
		return fmt.Errorf("clone anon repository failed with status %d: %s", *resp.StatusCode, detail)
	}
	return nil
}

// buildAnonSandboxCloneCommand mirrors buildWorkspaceCloneCommand minus every
// credential path: plain public HTTPS clone plus the jj colocation the baked
// toolchain expects.
func buildAnonSandboxCloneCommand(repoFullName, branch string) string {
	cloneURL := "https://github.com/" + repoFullName
	lines := []string{
		"set -euo pipefail",
		"install -d -o " + shellQuote(defaultWorkspaceUser) + " -g " + shellQuote(defaultWorkspaceUser) + " " + shellQuote(defaultWorkspaceHome),
		"rm -rf " + shellQuote(defaultWorkspaceClonePath),
		"runuser -u " + shellQuote(defaultWorkspaceUser) + " -- git clone -- " + shellQuote(cloneURL) + " " + shellQuote(defaultWorkspaceClonePath),
	}
	if branch = strings.TrimSpace(branch); branch != "" {
		lines = append(lines,
			"runuser -u "+shellQuote(defaultWorkspaceUser)+" -- git -C "+shellQuote(defaultWorkspaceClonePath)+" checkout -- .",
			"runuser -u "+shellQuote(defaultWorkspaceUser)+" -- git -C "+shellQuote(defaultWorkspaceClonePath)+" switch "+shellQuote(branch),
			"if command -v jj >/dev/null 2>&1; then runuser -u "+shellQuote(defaultWorkspaceUser)+" -- jj git init --colocate "+shellQuote(defaultWorkspaceClonePath)+"; fi",
		)
	}
	return strings.Join(lines, "\n")
}

func (s *AnonSandboxService) markFailedStage(ctx context.Context, id, expected, stage string) {
	updateCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if _, err := s.q.UpdateAnonSandboxStatusCAS(updateCtx, db.UpdateAnonSandboxStatusCASParams{
		ID:                id,
		NewStatus:         "failed",
		ProvisioningStage: stage,
		VmID:              "",
		ExpectedStatus:    expected,
	}); err != nil && !pgxNoRows(err) {
		slog.Warn("anon sandbox failed transition error", "anon_sandbox_id", id, "error", err)
	}
}

var anonSandboxReaperNewTicker = time.NewTicker

// StartReaper deletes expired, failed, and stranded anonymous sandboxes —
// VM (and disk) first, row second. Modeled on AgentService.StartSessionReaper.
func (s *AnonSandboxService) StartReaper(ctx context.Context) {
	if s == nil || s.q == nil {
		return
	}
	newTicker := anonSandboxReaperNewTicker
	go func() {
		if err := s.reap(ctx); err != nil {
			slog.Warn("anon sandbox reaper iteration failed", "error", err)
		}
		ticker := newTicker(anonSandboxReaperInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := s.reap(ctx); err != nil {
					slog.Warn("anon sandbox reaper iteration failed", "error", err)
				}
			}
		}
	}()
}

func (s *AnonSandboxService) reap(ctx context.Context) error {
	rows, err := s.q.ListReapableAnonSandboxes(ctx, anonSandboxReapBatchLimit)
	if err != nil {
		return err
	}
	for _, row := range rows {
		// VM first: if the provider delete fails the row stays live and the
		// next sweep retries, so a disk can never be silently orphaned by a
		// row tombstone racing a failed delete.
		vmID := strings.TrimSpace(row.VmID)
		if vmID != "" && s.sandbox != nil {
			deleteCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := s.sandbox.DeleteSandbox(deleteCtx, vmID)
			cancel()
			if err != nil && !isSandboxNotFound(err) {
				slog.Warn("anon sandbox reap: vm delete failed, will retry", "anon_sandbox_id", row.ID, "vm_id", vmID, "error", err)
				continue
			}
		}
		if _, err := s.q.SoftDeleteAnonSandbox(ctx, row.ID); err != nil && !pgxNoRows(err) {
			slog.Warn("anon sandbox reap: row delete failed", "anon_sandbox_id", row.ID, "error", err)
		}
	}
	return nil
}

func pgxNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}
