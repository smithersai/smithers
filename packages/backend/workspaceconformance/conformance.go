// Package workspaceconformance contains provider-neutral behavior checks used
// by trusted-process and isolated workspace adapters.
package workspaceconformance

import (
	"context"
	"io/fs"
	"testing"

	"github.com/smithersai/smithers/packages/backend/workspace"
)

// CoreHarness supplies provider identity and harmless fixture commands while
// retaining one lifecycle, execution, and file assertion suite.
type CoreHarness struct {
	Runtime          workspace.WorkspaceRuntime
	Context          func(operationID string) context.Context
	Spec             workspace.WorkspaceSpec
	CreateStates     []workspace.WorkspaceState
	Command          workspace.Command
	WantStdout       string
	FilePath         string
	FileContent      []byte
	FileMode         fs.FileMode
	WantIsolation    workspace.IsolationLevel
	WantCapabilities workspace.WorkspaceCapabilities
}

// RunCore verifies real lifecycle state, execution evidence, durable file
// behavior across stop/start, and deletion. Process exit is not treated as a
// product or Flow completion receipt.
func RunCore(t *testing.T, harness CoreHarness) {
	t.Helper()
	if harness.Runtime == nil || harness.Context == nil {
		t.Fatal("workspace conformance requires a runtime and context factory")
	}
	if got := harness.Runtime.Isolation(); got != harness.WantIsolation {
		t.Fatalf("Isolation() = %q; want %q", got, harness.WantIsolation)
	}
	if got := harness.Runtime.Capabilities(); got != harness.WantCapabilities {
		t.Fatalf("Capabilities() = %#v; want %#v", got, harness.WantCapabilities)
	}

	createdWorkspace, err := harness.Runtime.CreateWorkspace(harness.Context("create"), harness.Spec)
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	created := true
	defer func() {
		if created {
			_ = harness.Runtime.DeleteWorkspace(harness.Context("cleanup"), harness.Spec.ID)
		}
	}()
	if createdWorkspace.ID != harness.Spec.ID {
		t.Fatalf("created workspace id = %q; want %q", createdWorkspace.ID, harness.Spec.ID)
	}
	if !containsState(harness.CreateStates, createdWorkspace.State) {
		t.Fatalf("created workspace state = %q; want one of %v", createdWorkspace.State, harness.CreateStates)
	}
	if createdWorkspace.State == workspace.WorkspaceStopped {
		createdWorkspace, err = harness.Runtime.StartWorkspace(harness.Context("start-created"), harness.Spec.ID)
		if err != nil {
			t.Fatalf("StartWorkspace(created): %v", err)
		}
	}
	if createdWorkspace.State != workspace.WorkspaceRunning {
		t.Fatalf("workspace state before execution = %q; want %q", createdWorkspace.State, workspace.WorkspaceRunning)
	}

	result, err := harness.Runtime.ExecuteCommand(harness.Context("execute"), harness.Spec.ID, harness.Command)
	if err != nil {
		t.Fatalf("ExecuteCommand: %v", err)
	}
	if result.ExitCode != 0 || result.Stdout != harness.WantStdout {
		t.Fatalf("command result = %#v; want exit 0 stdout %q", result, harness.WantStdout)
	}

	if harness.WantCapabilities.FileOperations {
		if err := harness.Runtime.WriteFile(harness.Context("write-file"), harness.Spec.ID, harness.FilePath, harness.FileContent, harness.FileMode); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		content, err := harness.Runtime.ReadFile(harness.Context("read-file"), harness.Spec.ID, harness.FilePath)
		if err != nil {
			t.Fatalf("ReadFile: %v", err)
		}
		if string(content) != string(harness.FileContent) {
			t.Fatalf("ReadFile content = %q; want %q", content, harness.FileContent)
		}
	}

	if err := harness.Runtime.StopWorkspace(harness.Context("stop"), harness.Spec.ID); err != nil {
		t.Fatalf("StopWorkspace: %v", err)
	}
	observed, err := harness.Runtime.InspectWorkspace(harness.Context("inspect-stopped"), harness.Spec.ID)
	if err != nil {
		t.Fatalf("InspectWorkspace(stopped): %v", err)
	}
	if observed.State != workspace.WorkspaceStopped {
		t.Fatalf("stopped workspace state = %q; want %q", observed.State, workspace.WorkspaceStopped)
	}
	observed, err = harness.Runtime.StartWorkspace(harness.Context("restart"), harness.Spec.ID)
	if err != nil {
		t.Fatalf("StartWorkspace(restart): %v", err)
	}
	if observed.State != workspace.WorkspaceRunning {
		t.Fatalf("restarted workspace state = %q; want %q", observed.State, workspace.WorkspaceRunning)
	}
	if harness.WantCapabilities.FileOperations && harness.WantCapabilities.PersistentFiles {
		content, err := harness.Runtime.ReadFile(harness.Context("read-after-restart"), harness.Spec.ID, harness.FilePath)
		if err != nil || string(content) != string(harness.FileContent) {
			t.Fatalf("persistent ReadFile = %q, %v; want %q", content, err, harness.FileContent)
		}
		if err := harness.Runtime.RemoveFile(harness.Context("remove-file"), harness.Spec.ID, harness.FilePath); err != nil {
			t.Fatalf("RemoveFile: %v", err)
		}
	}

	if err := harness.Runtime.DeleteWorkspace(harness.Context("delete"), harness.Spec.ID); err != nil {
		t.Fatalf("DeleteWorkspace: %v", err)
	}
	created = false
}

// SnapshotHarness supplies durable public identifiers while the adapter keeps
// provider snapshot handles private and tenant scoped.
type SnapshotHarness struct {
	Runtime     workspace.WorkspaceRuntime
	Snapshots   workspace.WorkspaceSnapshots
	Context     func(operationID string) context.Context
	Source      workspace.WorkspaceSpec
	Fork        workspace.WorkspaceSpec
	Snapshot    workspace.ColdSnapshotSpec
	FilePath    string
	FileContent []byte
	FileMode    fs.FileMode
}

// RunColdSnapshots verifies that advertised snapshots are stopped disk state,
// survive through a real fork, and can be deleted.
func RunColdSnapshots(t *testing.T, harness SnapshotHarness) {
	t.Helper()
	if harness.Runtime == nil || harness.Snapshots == nil || harness.Context == nil {
		t.Fatal("snapshot conformance requires runtime, snapshots, and context factory")
	}
	if !harness.Runtime.Capabilities().ColdSnapshots {
		t.Fatal("snapshot facet is present while ColdSnapshots is false")
	}

	source, err := harness.Runtime.CreateWorkspace(harness.Context("snapshot-source-create"), harness.Source)
	if err != nil {
		t.Fatalf("create snapshot source: %v", err)
	}
	sourceCreated := true
	defer func() {
		if sourceCreated {
			_ = harness.Runtime.DeleteWorkspace(harness.Context("snapshot-source-cleanup"), harness.Source.ID)
		}
	}()
	if source.State == workspace.WorkspaceStopped {
		if _, err := harness.Runtime.StartWorkspace(harness.Context("snapshot-source-start"), harness.Source.ID); err != nil {
			t.Fatalf("start snapshot source: %v", err)
		}
	}
	if err := harness.Runtime.WriteFile(harness.Context("snapshot-write"), harness.Source.ID, harness.FilePath, harness.FileContent, harness.FileMode); err != nil {
		t.Fatalf("write snapshot fixture: %v", err)
	}
	if err := harness.Runtime.StopWorkspace(harness.Context("snapshot-source-stop"), harness.Source.ID); err != nil {
		t.Fatalf("stop snapshot source: %v", err)
	}

	snapshot, err := harness.Snapshots.CreateColdSnapshot(harness.Context("snapshot-create"), harness.Source.ID, harness.Snapshot)
	if err != nil {
		t.Fatalf("CreateColdSnapshot: %v", err)
	}
	snapshotCreated := true
	defer func() {
		if snapshotCreated {
			_ = harness.Snapshots.DeleteColdSnapshot(harness.Context("snapshot-cleanup"), harness.Snapshot.ID)
		}
	}()
	if snapshot.ID != harness.Snapshot.ID || snapshot.SourceWorkspaceID != harness.Source.ID {
		t.Fatalf("cold snapshot = %#v", snapshot)
	}

	fork, err := harness.Snapshots.ForkColdSnapshot(harness.Context("snapshot-fork"), harness.Snapshot.ID, harness.Fork)
	if err != nil {
		t.Fatalf("ForkColdSnapshot: %v", err)
	}
	forkCreated := true
	defer func() {
		if forkCreated {
			_ = harness.Runtime.DeleteWorkspace(harness.Context("snapshot-fork-cleanup"), harness.Fork.ID)
		}
	}()
	if fork.ID != harness.Fork.ID {
		t.Fatalf("fork workspace id = %q; want %q", fork.ID, harness.Fork.ID)
	}
	if fork.State == workspace.WorkspaceStopped {
		if _, err := harness.Runtime.StartWorkspace(harness.Context("snapshot-fork-start"), harness.Fork.ID); err != nil {
			t.Fatalf("start snapshot fork: %v", err)
		}
	}
	content, err := harness.Runtime.ReadFile(harness.Context("snapshot-fork-read"), harness.Fork.ID, harness.FilePath)
	if err != nil || string(content) != string(harness.FileContent) {
		t.Fatalf("fork fixture = %q, %v; want %q", content, err, harness.FileContent)
	}

	if err := harness.Runtime.DeleteWorkspace(harness.Context("snapshot-fork-delete"), harness.Fork.ID); err != nil {
		t.Fatalf("delete snapshot fork: %v", err)
	}
	forkCreated = false
	if err := harness.Snapshots.DeleteColdSnapshot(harness.Context("snapshot-delete"), harness.Snapshot.ID); err != nil {
		t.Fatalf("DeleteColdSnapshot: %v", err)
	}
	snapshotCreated = false
	if err := harness.Runtime.DeleteWorkspace(harness.Context("snapshot-source-delete"), harness.Source.ID); err != nil {
		t.Fatalf("delete snapshot source: %v", err)
	}
	sourceCreated = false
}

func containsState(states []workspace.WorkspaceState, state workspace.WorkspaceState) bool {
	for _, candidate := range states {
		if candidate == state {
			return true
		}
	}
	return false
}
