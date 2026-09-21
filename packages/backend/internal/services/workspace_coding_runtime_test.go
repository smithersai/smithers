package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/sandbox"
	"github.com/smithersai/smithers/packages/backend/internal/services/workspace_scripts"
)

func runtimeTestReceipt(t *testing.T, workspace db.Workspace, status string) string {
	t.Helper()
	digest := workspaceCodingRuntimeDigest()
	before := digest
	if status == "updated" {
		before = strings.Repeat("a", 64)
	}
	encoded, err := json.Marshal(workspaceCodingRuntimeReceipt{Status: status, WorkspaceID: workspace.ID,
		RepositoryID: workspace.RepositoryID, ActorID: workspace.UserID, Before: before, After: digest})
	require.NoError(t, err)
	return string(encoded)
}

type codingRuntimeFixture struct {
	root      string
	workspace db.Workspace
	config    []byte
	previous  []byte
	input     string
}

func newCodingRuntimeFixture(t *testing.T) codingRuntimeFixture {
	t.Helper()
	f := codingRuntimeFixture{root: t.TempDir(), workspace: db.Workspace{ID: "89de37b2-558e-47e8-9f1c-71d9ca46c970", RepositoryID: 101, UserID: 7, VmID: "owned-vm", Status: "running"}, previous: []byte("print('old native adapter')\n")}
	var err error
	f.config, err = json.Marshal(map[string]any{"version": 1, "workspaceId": f.workspace.ID, "repositoryId": f.workspace.RepositoryID,
		"actorId": f.workspace.UserID, "repositoryPath": defaultWorkspaceClonePath, "username": defaultWorkspaceUser, "gitUrl": "https://fixed.invalid/acme/repo.git"})
	require.NoError(t, err)
	for _, path := range []string{"etc/smithers", "usr/local/lib/smithers", "usr/local/bin", "home/developer/workspace"} {
		require.NoError(t, os.MkdirAll(filepath.Join(f.root, path), 0755))
	}
	for path, body := range map[string][]byte{"etc/smithers/workspace-coding.json": f.config, "usr/local/lib/smithers/workspace-coding.py": f.previous,
		"usr/local/bin/smithers-jj-export": []byte("exporter retained"), "usr/local/bin/smithers-workspace-head": []byte("reporter retained"),
		"home/developer/workspace/user.txt": []byte("unsaved user content")} {
		require.NoError(t, os.WriteFile(filepath.Join(f.root, path), body, 0644))
	}
	command := buildWorkspaceCodingRuntimeCommand(f.workspace, defaultWorkspaceUser)
	require.Contains(t, command, "/usr/bin/env -i PATH=/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin python3 -I -")
	f.input = strings.TrimSuffix(strings.SplitN(command, "\n", 2)[1], "\nSMITHERS_CODING_RUNTIME")
	// Give the unchanged production dirfd traversal an isolated filesystem and
	// owner. No test path, UID, or fault injector exists in production inputs.
	f.input = strings.Replace(f.input, "ROOT = \"/\"", "ROOT = "+fmt.Sprintf("%q", f.root), 1)
	f.input = strings.Replace(f.input, "OWNER = 0", fmt.Sprintf("OWNER = %d", os.Getuid()), 1)
	return f
}

func (f codingRuntimeFixture) run(t *testing.T, injection string) ([]byte, error) {
	t.Helper()
	input := f.input
	if injection != "" {
		at := strings.LastIndex(input, "\nrun(")
		require.Positive(t, at)
		input = input[:at] + "\n" + injection + input[at:]
	}
	ctx, cancel := context.WithTimeout(context.Background(), workspaceHeadInstallTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python3", "-I", "-")
	cmd.Stdin = strings.NewReader(input)
	return cmd.CombinedOutput()
}

func (f codingRuntimeFixture) script() string {
	return filepath.Join(f.root, "usr/local/lib/smithers/workspace-coding.py")
}
func (f codingRuntimeFixture) evidence(name string) string {
	return filepath.Join(f.root, "usr/local/lib/smithers/coding-runtime", name)
}

func TestWorkspaceCodingRuntime_FullProviderCommandFitsAndExecutes(t *testing.T) {
	f := newCodingRuntimeFixture(t)
	// Model SDKRuntime.Exec -> Shell -> exec /bin/bash -lc with the complete
	// rendered command. Extracting Python and piping it to stdin misses the
	// Linux 32-page single-argument limit that refused the deployed command.
	command := buildWorkspaceCodingRuntimeCommand(f.workspace, defaultWorkspaceUser)
	command = strings.Replace(command, "ROOT = \"/\"", "ROOT = "+fmt.Sprintf("%q", f.root), 1)
	command = strings.Replace(command, "OWNER = 0", fmt.Sprintf("OWNER = %d", os.Getuid()), 1)
	wrapped := "exec /bin/bash -lc " + shellQuote(command)
	require.Less(t, len(wrapped)+1, 120*1024, "keep margin below Linux's 128-KiB minimum single-argument limit")
	for _, status := range []string{"updated", "unchanged"} {
		ctx, cancel := context.WithTimeout(context.Background(), workspaceHeadInstallTimeout)
		cmd := exec.CommandContext(ctx, "/bin/sh", "-c", wrapped)
		output, err := cmd.CombinedOutput()
		cancel()
		require.NoError(t, err, string(output))
		var receipt workspaceCodingRuntimeReceipt
		require.NoError(t, json.Unmarshal(output, &receipt))
		require.Equal(t, status, receipt.Status)
		require.Equal(t, f.workspace.ID, receipt.WorkspaceID)
		require.Equal(t, f.workspace.RepositoryID, receipt.RepositoryID)
		require.Equal(t, f.workspace.UserID, receipt.ActorID)
		require.Equal(t, workspaceCodingRuntimeDigest(), receipt.After)
	}
	installed, err := os.ReadFile(f.script())
	require.NoError(t, err)
	require.Equal(t, workspace_scripts.CodingScript+"\n", string(installed))
	config, err := os.ReadFile(filepath.Join(f.root, "etc/smithers/workspace-coding.json"))
	require.NoError(t, err)
	require.Equal(t, f.config, config)
}

func TestWorkspaceCodingRuntime_AtomicRefreshRetainsOldInodeAndEvidence(t *testing.T) {
	f := newCodingRuntimeFixture(t)
	old, err := os.Open(f.script())
	require.NoError(t, err)
	defer old.Close()
	oldInfo, err := old.Stat()
	require.NoError(t, err)
	output, err := f.run(t, "")
	require.NoError(t, err, string(output))
	var receipt workspaceCodingRuntimeReceipt
	require.NoError(t, json.Unmarshal(output, &receipt))
	require.Equal(t, "updated", receipt.Status)
	require.Equal(t, f.workspace.ID, receipt.WorkspaceID)
	require.Equal(t, workspaceCodingRuntimeDigest(), receipt.After)
	previous, err := io.ReadAll(old)
	require.NoError(t, err)
	require.Equal(t, f.previous, previous, "an already open interpreter inode remains intact")
	current, err := os.ReadFile(f.script())
	require.NoError(t, err)
	require.Equal(t, workspace_scripts.CodingScript+"\n", string(current))
	currentInfo, err := os.Stat(f.script())
	require.NoError(t, err)
	require.False(t, os.SameFile(oldInfo, currentInfo))
	require.EqualValues(t, 0644, currentInfo.Mode().Perm())
	for name, want := range map[string][]byte{receipt.Before + ".py": f.previous, receipt.After + ".py": current} {
		body, err := os.ReadFile(f.evidence(name))
		require.NoError(t, err)
		require.Equal(t, want, body)
		info, err := os.Stat(f.evidence(name))
		require.NoError(t, err)
		require.EqualValues(t, 0600, info.Mode().Perm())
	}
	for _, phase := range []string{"prepared", "installed"} {
		body, err := os.ReadFile(f.evidence(receipt.Before + "-" + receipt.After + "." + phase + ".json"))
		require.NoError(t, err)
		require.Contains(t, string(body), receipt.Before)
		require.Contains(t, string(body), receipt.After)
		require.NotContains(t, string(body), "fixed.invalid")
	}
	for path, want := range map[string][]byte{"etc/smithers/workspace-coding.json": f.config, "usr/local/bin/smithers-jj-export": []byte("exporter retained"),
		"usr/local/bin/smithers-workspace-head": []byte("reporter retained"), "home/developer/workspace/user.txt": []byte("unsaved user content")} {
		body, err := os.ReadFile(filepath.Join(f.root, path))
		require.NoError(t, err)
		require.Equal(t, want, body)
	}
	output, err = f.run(t, "")
	require.NoError(t, err, string(output))
	require.NoError(t, json.Unmarshal(output, &receipt))
	require.Equal(t, "unchanged", receipt.Status)
	require.Equal(t, receipt.Before, receipt.After)
	unchangedInfo, err := os.Stat(f.script())
	require.NoError(t, err)
	require.True(t, os.SameFile(currentInfo, unchangedInfo))
	require.Equal(t, currentInfo.ModTime(), unchangedInfo.ModTime())
}

func TestWorkspaceCodingRuntime_PartialUpdatesAreRetryableWithoutTruncatingActiveAdapter(t *testing.T) {
	for _, phase := range []string{"evidence-write", "stage-write", "before-replace", "after-replace"} {
		t.Run(phase, func(t *testing.T) {
			f := newCodingRuntimeFixture(t)
			injection := map[string]string{
				"evidence-write": "original_write = write\ndef write(parent, name, content, mode):\n    if name.startswith('.evidence-'):\n        original_write(parent, name, content[:4], mode)\n        raise OSError('injected partial evidence write')\n    return original_write(parent, name, content, mode)\n",
				"stage-write":    "original_write = write\ndef write(parent, name, content, mode):\n    if name.startswith('.workspace-coding-'):\n        original_write(parent, name, content[:4], mode)\n        raise OSError('injected partial staging write')\n    return original_write(parent, name, content, mode)\n",
				"before-replace": "def refuse(*args, **kwargs):\n    raise OSError('injected replacement refusal')\nos.replace = refuse\n",
				"after-replace":  "original_replace = os.replace\ndef refuse(*args, **kwargs):\n    original_replace(*args, **kwargs)\n    raise OSError('injected lost acknowledgement')\nos.replace = refuse\n",
			}[phase]
			output, err := f.run(t, injection)
			require.Error(t, err)
			require.NotContains(t, string(output), "injected")
			body, err := os.ReadFile(f.script())
			require.NoError(t, err)
			if phase == "after-replace" {
				require.Equal(t, workspace_scripts.CodingScript+"\n", string(body))
			} else {
				require.Equal(t, f.previous, body)
			}
			output, err = f.run(t, "")
			require.NoError(t, err, string(output))
			if phase == "after-replace" {
				var receipt workspaceCodingRuntimeReceipt
				require.NoError(t, json.Unmarshal(output, &receipt))
				require.Equal(t, "unchanged", receipt.Status)
				before := sha256.Sum256(f.previous)
				record := hex.EncodeToString(before[:]) + "-" + workspaceCodingRuntimeDigest()
				_, err := os.Stat(f.evidence(record + ".installed.json"))
				require.True(t, os.IsNotExist(err), "retry verifies bytes without manufacturing the interrupted attempt's acknowledgement")
				body, err := os.ReadFile(f.evidence(record + ".prepared.json"))
				require.NoError(t, err)
				require.Contains(t, string(body), `"status": "prepared"`)
			}
			body, err = os.ReadFile(f.script())
			require.NoError(t, err)
			require.Equal(t, workspace_scripts.CodingScript+"\n", string(body))
			if phase != "evidence-write" {
				before := sha256.Sum256(f.previous)
				retained, err := os.ReadFile(f.evidence(hex.EncodeToString(before[:]) + ".py"))
				require.NoError(t, err)
				require.Equal(t, f.previous, retained)
			}
		})
	}
}

func TestWorkspaceCodingRuntime_RefusesCanonicalDirectorySwap(t *testing.T) {
	for _, path := range []string{"/etc/smithers", "/usr/local/lib/smithers"} {
		for _, phase := range []string{"before", "after"} {
			t.Run(path+"/"+phase, func(t *testing.T) {
				f := newCodingRuntimeFixture(t)
				// Root provisioning retires a directory while a maintenance request
				// still holds it open. A byte-identical replacement is still a new
				// binding and cannot be acknowledged through those stale FDs.
				swap := fmt.Sprintf("import shutil\ndef swap():\n    path = ROOT + %q\n    os.rename(path, path + '.retired')\n    shutil.copytree(path + '.retired', path)\n", path)
				injection := swap
				if phase == "before" {
					injection += "original_write = write\ndef write(parent, name, content, mode):\n    original_write(parent, name, content, mode)\n    if name.startswith('.workspace-coding-'):\n        swap()\n"
				} else {
					injection += "original_replace = os.replace\ndef replace(*args, **kwargs):\n    original_replace(*args, **kwargs)\n    swap()\nos.replace = replace\n"
				}
				output, err := f.run(t, injection)
				require.Error(t, err)
				require.JSONEq(t, `{"error":"native_runtime_refresh_unavailable"}`, strings.TrimSpace(string(output)))
			})
		}
	}
}

func TestWorkspaceCodingRuntime_BusyMaintenanceLeavesAdapterAndRetries(t *testing.T) {
	f := newCodingRuntimeFixture(t)
	injection := "directory_fd = directory('/usr/local/lib/smithers')\nos.mkdir('coding-runtime', 0o700, dir_fd=directory_fd)\nevidence_fd = os.open('coding-runtime', os.O_RDONLY | os.O_DIRECTORY, dir_fd=directory_fd)\nheld = os.open('refresh.lock', os.O_RDWR | os.O_CREAT, 0o600, dir_fd=evidence_fd)\nfcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)\n"
	output, err := f.run(t, injection)
	require.Error(t, err)
	require.JSONEq(t, `{"error":"native_runtime_refresh_unavailable"}`, strings.TrimSpace(string(output)))
	body, err := os.ReadFile(f.script())
	require.NoError(t, err)
	require.Equal(t, f.previous, body)
	output, err = f.run(t, "")
	require.NoError(t, err, string(output))
}

func TestWorkspaceCodingRuntime_RejectsChangedGuestBindingAndUnprotectedFiles(t *testing.T) {
	for _, mode := range []string{"owner", "repository", "workspace", "config-symlink", "script-symlink", "writable-directory", "binding-race"} {
		t.Run(mode, func(t *testing.T) {
			f := newCodingRuntimeFixture(t)
			configPath := filepath.Join(f.root, "etc/smithers/workspace-coding.json")
			injection := ""
			switch mode {
			case "owner", "repository", "workspace":
				var config map[string]any
				require.NoError(t, json.Unmarshal(f.config, &config))
				key := map[string]string{"owner": "actorId", "repository": "repositoryId", "workspace": "workspaceId"}[mode]
				config[key] = "different"
				body, err := json.Marshal(config)
				require.NoError(t, err)
				require.NoError(t, os.WriteFile(configPath, body, 0644))
			case "config-symlink", "script-symlink":
				path := configPath
				if mode == "script-symlink" {
					path = f.script()
				}
				require.NoError(t, os.Rename(path, path+".retained"))
				require.NoError(t, os.Symlink(path+".retained", path))
			case "writable-directory":
				require.NoError(t, os.Chmod(filepath.Join(f.root, "usr/local/lib/smithers"), 0777))
			case "binding-race":
				injection = "original_write = write\ndef write(parent, name, content, mode):\n    original_write(parent, name, content, mode)\n    if name.startswith('.workspace-coding-'):\n        with open(ROOT + '/etc/smithers/workspace-coding.json', 'wb') as changed:\n            changed.write(b'{}')\n"
			}
			output, err := f.run(t, injection)
			require.Error(t, err)
			require.NotContains(t, string(output), "fixed.invalid")
			body, err := os.ReadFile(f.script())
			require.NoError(t, err)
			require.Equal(t, f.previous, body)
		})
	}
}

func TestWorkspaceCodingRuntime_ServiceFencesBindingAndAcknowledgement(t *testing.T) {
	for _, mode := range []string{"updated", "unchanged", "owner-before", "repository-before", "vm-before", "vm-after", "owner-after", "repository-after", "deleted-after", "transport", "partial", "forged"} {
		t.Run(mode, func(t *testing.T) {
			workspace := db.Workspace{ID: "owned-workspace", RepositoryID: 101, UserID: 7, VmID: "owned-vm", Status: "running"}
			current := workspace
			if mode == "owner-before" {
				current.UserID++
			}
			if mode == "vm-before" {
				current.VmID = "different-vm"
			}
			if mode == "repository-before" {
				current.RepositoryID++
			}
			q := &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return current, nil }}
			calls := 0
			vm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
				calls++
				require.Equal(t, workspace.VmID, vmID)
				require.Contains(t, req.Command, "SMITHERS_CODING_RUNTIME")
				if mode == "transport" {
					return sandbox.ExecResult{}, errors.New("private diagnostic")
				}
				status := int32(0)
				if mode == "partial" {
					status = 75
				}
				if mode == "vm-after" {
					current.VmID = "different-vm"
				}
				if mode == "owner-after" {
					current.UserID++
				}
				if mode == "repository-after" {
					current.RepositoryID++
				}
				if mode == "deleted-after" {
					current.DeletedAt.Valid = true
				}
				receipt := runtimeTestReceipt(t, workspace, "updated")
				if mode == "unchanged" {
					receipt = runtimeTestReceipt(t, workspace, "unchanged")
				}
				if mode == "forged" {
					receipt = strings.ReplaceAll(receipt, workspace.ID, "foreign-workspace")
				}
				return sandbox.ExecResult{StatusCode: &status, Stdout: receipt}, nil
			}}
			svc := newWorkspaceServiceForTests(q, WithWorkspaceSandboxClient(vm))
			err := svc.ensureWorkspaceCodingRuntime(context.Background(), workspace)
			if mode == "updated" || mode == "unchanged" {
				require.NoError(t, err)
			} else {
				require.Error(t, err)
				require.NotContains(t, err.Error(), "private diagnostic")
			}
			if strings.HasSuffix(mode, "-before") {
				require.Zero(t, calls)
			} else {
				require.Equal(t, 1, calls)
			}
		})
	}
}

func TestWorkspaceCodingRuntime_HealthyGatewayRefreshesWithoutRestart(t *testing.T) {
	s, q, vm, workspace := boundGatewayFixture(t)
	q.active = &db.RepoGateway{ID: q.nextGatewayID, RepositoryID: workspace.RepositoryID, UserID: workspace.UserID, VmID: workspace.VmID,
		WorkspaceID: pgtype.UUID{Bytes: uuid.MustParse(workspace.ID), Valid: true}, Status: "running", AuthTokenCiphertext: "enc:retained"}
	// Same real gateway flow, with the production head-store capability present.
	wq := &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceByRepoFn: func(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error) { return *workspace, nil }}}
	calls := 0
	wvm := &mockWorkspaceSandboxVMClient{execAwaitFn: func(_ context.Context, vmID string, req sandbox.ExecRequest) (sandbox.ExecResult, error) {
		calls++
		require.Equal(t, workspace.VmID, vmID)
		zero := int32(0)
		if strings.Contains(req.Command, "SMITHERS_CODING_RUNTIME") {
			return sandbox.ExecResult{StatusCode: &zero, Stdout: runtimeTestReceipt(t, *workspace, "updated")}, nil
		}
		require.Contains(t, req.Command, "socket.is_socket()")
		return sandbox.ExecResult{StatusCode: &zero}, nil
	}}
	s.workspaces = newWorkspaceServiceForTests(wq, WithWorkspaceSandboxClient(wvm))
	info, err := s.GetRepoGatewayConnectionInfo(context.Background(), RepoGatewayConnectionInput{RepositoryID: workspace.RepositoryID, UserID: workspace.UserID, WorkspaceID: workspace.ID})
	require.NoError(t, err)
	require.Equal(t, workspace.ID, info.WorkspaceID)
	require.Equal(t, workspace.VmID, info.VMID)
	assert.Equal(t, 2, calls)
	assert.Empty(t, vm.systemdSpecs)
	assert.Empty(t, vm.execAwaitReqs)
	assert.Empty(t, vm.deletedVMIDs)
	assert.Empty(t, vm.createVMReqs)
	assert.Zero(t, wq.headTokenID)
}
