package services

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
	"github.com/smithersai/smithers/packages/backend/internal/services/workspace_scripts"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type workspaceCodingRuntimeReceipt struct {
	Status       string `json:"status"`
	WorkspaceID  string `json:"workspaceId"`
	RepositoryID int64  `json:"repositoryId"`
	ActorID      int64  `json:"actorId"`
	Before       string `json:"before"`
	After        string `json:"after"`
}

func workspaceCodingRuntimeDigest() string {
	digest := sha256.Sum256([]byte(workspace_scripts.CodingScript + "\n"))
	return hex.EncodeToString(digest[:])
}

// Reconcile only the root-provisioned adapter used by future native subprocesses.
// The gateway, reporter, credential cache, config and native exporter stay live.
// The guest records old/new bytes before replacement, and an acknowledgement is
// accepted only after rechecking the same owner, repository and VM in the DB.
func (s *WorkspaceService) ensureWorkspaceCodingRuntime(ctx context.Context, workspace db.Workspace) error {
	check := func() error {
		current, err := s.loadOwnedWorkspace(ctx, workspace.ID, workspace.RepositoryID, workspace.UserID)
		if err != nil {
			return err
		}
		if current.ID != workspace.ID || current.RepositoryID != workspace.RepositoryID || current.UserID != workspace.UserID ||
			current.VmID != workspace.VmID || current.VmID == "" || current.Status != "running" || current.DeletedAt.Valid {
			return pkgerrors.Conflict("workspace changed before native runtime verification; retry")
		}
		return nil
	}
	if err := check(); err != nil {
		return err
	}
	client, ok := s.sandbox.(sandboxExecClient)
	if !ok {
		return codingHostUnavailable("workspace native runtime cannot be verified; retry")
	}
	user := strings.TrimSpace(s.workspaceUsername)
	if user == "" {
		user = defaultWorkspaceUser
	}
	timeout := int64(15000)
	result, err := client.Execute(ctx, workspace.VmID, sandbox.ExecRequest{
		Command: buildWorkspaceCodingRuntimeCommand(workspace, user), TimeoutMS: &timeout,
	})
	if err != nil || result.StatusCode == nil || *result.StatusCode != 0 || len(result.Stdout) > 4096 {
		return codingHostUnavailable("workspace native runtime could not be verified; retry")
	}
	var receipt workspaceCodingRuntimeReceipt
	if json.Unmarshal([]byte(result.Stdout), &receipt) != nil || receipt.WorkspaceID != workspace.ID ||
		receipt.RepositoryID != workspace.RepositoryID || receipt.ActorID != workspace.UserID ||
		receipt.After != workspaceCodingRuntimeDigest() || len(receipt.Before) != 64 ||
		(receipt.Status != "updated" && receipt.Status != "unchanged") {
		return codingHostUnavailable("workspace native runtime returned an invalid verification receipt; retry")
	}
	if _, err := hex.DecodeString(receipt.Before); err != nil ||
		(receipt.Status == "unchanged") != (receipt.Before == receipt.After) {
		return codingHostUnavailable("workspace native runtime returned an invalid verification receipt; retry")
	}
	if err := check(); err != nil {
		return err
	}
	if receipt.Status == "updated" {
		slog.Info("workspace native adapter refreshed", "workspace_id", workspace.ID, "vm_id", workspace.VmID,
			"previous_sha256", receipt.Before, "sha256", receipt.After)
	}
	return nil
}

func buildWorkspaceCodingRuntimeCommand(workspace db.Workspace, user string) string {
	input, _ := json.Marshal(map[string]any{
		"workspaceId": workspace.ID, "repositoryId": workspace.RepositoryID, "actorId": workspace.UserID,
		"repositoryPath": defaultWorkspaceClonePath, "username": user,
		"script": base64.StdEncoding.EncodeToString([]byte(workspace_scripts.CodingScript + "\n")),
		"digest": workspaceCodingRuntimeDigest(),
	})
	// No repository cwd, Python modules, invocation PATH or Python environment
	// can participate in this root-only maintenance command.
	// The provider passes this whole command as one Bash argument. Keep the
	// JSON payload quoted once: a second base64 layer exceeds Linux's per-arg
	// limit with the current embedded adapter before Python can even start.
	return "/usr/bin/env -i PATH=/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin python3 -I - <<'SMITHERS_CODING_RUNTIME'\n" +
		workspaceCodingRuntimeProgram + fmt.Sprintf("\nrun(%q)\nSMITHERS_CODING_RUNTIME", string(input))
}

const workspaceCodingRuntimeProgram = `import base64, fcntl, hashlib, json, os, stat, sys, uuid
ROOT = "/"
OWNER = 0

def protected(info, directory=False):
    if info.st_uid != OWNER or stat.S_IMODE(info.st_mode) & 0o022:
        raise ValueError("unprotected runtime")
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError("invalid runtime type")

def directory(path):
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        protected(os.fstat(fd), True)
        for part in path.strip("/").split("/"):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            protected(os.fstat(fd), True)
        return fd
    except BaseException:
        os.close(fd)
        raise

def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def read(parent, name, limit=1048576):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd)
        protected(before)
        if before.st_size > limit:
            raise ValueError("runtime too large")
        data = bytearray()
        while len(data) <= limit:
            block = os.read(fd, min(65536, limit + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        if len(data) > limit or identity(before) != identity(os.fstat(fd)):
            raise ValueError("runtime changed during read")
        return bytes(data), identity(before)
    finally:
        os.close(fd)

def write(parent, name, content, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(fd, mode)
            os.fsync(fd)
    finally:
        os.close(fd)
    os.fsync(parent)

def retain(parent, name, content):
    try:
        existing = read(parent, name)[0]
    except FileNotFoundError:
        staged = ".evidence-" + uuid.uuid4().hex
        try:
            write(parent, staged, content, 0o600)
            try:
                os.link(staged, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
                os.fsync(parent)
            except FileExistsError:
                if read(parent, name)[0] != content:
                    raise ValueError("retained runtime evidence differs")
        finally:
            try:
                os.unlink(staged, dir_fd=parent)
            except FileNotFoundError:
                pass
    else:
        if existing != content:
            raise ValueError("retained runtime evidence differs")

def visible(config_dir, runtime_dir, config, script):
    # A pinned FD can outlive a root provisioning directory swap. Verify the
    # canonical paths future subprocesses will open, not an unlinked directory.
    current_config, current_runtime = directory("/etc/smithers"), None
    try:
        current_runtime = directory("/usr/local/lib/smithers")
        for pinned, current in ((config_dir, current_config), (runtime_dir, current_runtime)):
            a, b = os.fstat(pinned), os.fstat(current)
            if (a.st_dev, a.st_ino) != (b.st_dev, b.st_ino):
                raise ValueError("native runtime directory changed")
        if read(current_config, "workspace-coding.json", 16384)[0] != config or read(current_runtime, "workspace-coding.py")[0] != script:
            raise ValueError("native runtime verification changed")
    finally:
        os.close(current_config)
        if current_runtime is not None:
            os.close(current_runtime)

def refresh(data):
    expected = {key: data[key] for key in ("workspaceId", "repositoryId", "actorId", "repositoryPath", "username")}
    content = base64.b64decode(data["script"], validate=True)
    after = hashlib.sha256(content).hexdigest()
    if after != data["digest"] or not content or len(content) > 1048576:
        raise ValueError("invalid embedded runtime")
    compile(content, "<managed-native-runtime>", "exec", dont_inherit=True)
    config_dir, runtime_dir = directory("/etc/smithers"), None
    try:
        config, _ = read(config_dir, "workspace-coding.json", 16384)
        configured = json.loads(config)
        if configured.get("version") != 1 or any(configured.get(key) != value for key, value in expected.items()):
            raise ValueError("native runtime binding changed")
        runtime_dir = directory("/usr/local/lib/smithers")
        try:
            os.mkdir("coding-runtime", 0o700, dir_fd=runtime_dir)
        except FileExistsError:
            pass
        evidence = os.open("coding-runtime", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=runtime_dir)
        try:
            protected(os.fstat(evidence), True)
            lock = os.open("refresh.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=evidence)
            try:
                protected(os.fstat(lock))
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                previous, previous_id = read(runtime_dir, "workspace-coding.py")
                before = hashlib.sha256(previous).hexdigest()
                receipt = {key: data[key] for key in ("workspaceId", "repositoryId", "actorId")}
                receipt.update(before=before, after=after, status="unchanged" if before == after else "updated")
                if before != after:
                    retain(evidence, before + ".py", previous)
                    retain(evidence, after + ".py", content)
                    recorded = dict(receipt, configDigest=hashlib.sha256(config).hexdigest())
                    record = before + "-" + after
                    retain(evidence, record + ".prepared.json", json.dumps(dict(recorded, status="prepared"), sort_keys=True).encode())
                    staged = ".workspace-coding-" + uuid.uuid4().hex
                    try:
                        write(runtime_dir, staged, content, 0o644)
                        # Both root provisioning and another API generation must
                        # leave the inspected binding and installed inode intact.
                        if read(config_dir, "workspace-coding.json", 16384)[0] != config or read(runtime_dir, "workspace-coding.py") != (previous, previous_id):
                            raise ValueError("native runtime changed before install")
                        visible(config_dir, runtime_dir, config, previous)
                        os.replace(staged, "workspace-coding.py", src_dir_fd=runtime_dir, dst_dir_fd=runtime_dir)
                        os.fsync(runtime_dir)
                        if read(runtime_dir, "workspace-coding.py")[0] != content:
                            raise ValueError("native runtime changed after install")
                        visible(config_dir, runtime_dir, config, content)
                        retain(evidence, record + ".installed.json", json.dumps(dict(recorded, status="installed"), sort_keys=True).encode())
                    finally:
                        try:
                            os.unlink(staged, dir_fd=runtime_dir)
                        except FileNotFoundError:
                            pass
                # An interrupted post-rename acknowledgement can leave only a
                # prepared marker. Retry proves current bytes; it does not infer
                # the earlier attempt's outcome or manufacture its receipt.
                visible(config_dir, runtime_dir, config, content)
                return receipt
            finally:
                os.close(lock)
        finally:
            os.close(evidence)
    finally:
        os.close(config_dir)
        if runtime_dir is not None:
            os.close(runtime_dir)

def run(payload):
    try:
        print(json.dumps(refresh(json.loads(payload))))
    except Exception:
        # Configuration, subprocess paths, and raw failures never leave the VM.
        print('{"error":"native_runtime_refresh_unavailable"}')
        raise SystemExit(75)
`
