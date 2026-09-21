package repohostserver

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteDurableJournalReportsInstalledAfterDirectorySyncFailure(t *testing.T) {
	stageDir := t.TempDir()
	wantErr := errors.New("injected directory sync failure")
	installed, err := writeDurableJournalWithSync(
		stageDir,
		moveStageMetadataFile,
		[]byte(`{"src_owner":"alice"}`),
		0o600,
		func(path string) error {
			if path == stageDir {
				return wantErr
			}
			return syncDirectory(path)
		},
	)
	if !installed {
		t.Fatal("journal installation was not reported after the atomic rename")
	}
	if !errors.Is(err, wantErr) {
		t.Fatalf("write journal error = %v, want injected sync failure", err)
	}

	journalPath := filepath.Join(stageDir, moveStageMetadataFile)
	data, readErr := os.ReadFile(journalPath)
	if readErr != nil {
		t.Fatalf("read installed journal: %v", readErr)
	}
	if string(data) != `{"src_owner":"alice"}` {
		t.Fatalf("journal data = %q", data)
	}
	matches, globErr := filepath.Glob(filepath.Join(stageDir, "."+moveStageMetadataFile+".tmp-*"))
	if globErr != nil {
		t.Fatalf("glob journal temporary files: %v", globErr)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary journals remain after install: %v", matches)
	}
}

func TestDurableRenameReportsSyncFailureWithoutHidingAppliedRename(t *testing.T) {
	root := t.TempDir()
	fromParent := filepath.Join(root, "from")
	toParent := filepath.Join(root, "to")
	if err := os.MkdirAll(fromParent, 0o755); err != nil {
		t.Fatalf("mkdir source parent: %v", err)
	}
	if err := os.MkdirAll(toParent, 0o755); err != nil {
		t.Fatalf("mkdir destination parent: %v", err)
	}
	from := filepath.Join(fromParent, "repository")
	to := filepath.Join(toParent, "repository")
	if err := os.WriteFile(from, []byte("repository"), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	wantErr := errors.New("injected source-parent sync failure")
	var synced []string
	err := durableRenamePathWithSync(from, to, func(path string) error {
		synced = append(synced, path)
		if path == fromParent {
			return wantErr
		}
		return nil
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("durable rename error = %v, want injected sync failure", err)
	}
	wantSynced := []string{toParent, fromParent}
	if strings.Join(synced, "\n") != strings.Join(wantSynced, "\n") {
		t.Fatalf("synced parents = %#v, want destination then source %#v", synced, wantSynced)
	}
	if _, statErr := os.Stat(from); !os.IsNotExist(statErr) {
		t.Fatalf("source stat error = %v, want not-exist after applied rename", statErr)
	}
	data, readErr := os.ReadFile(to)
	if readErr != nil {
		t.Fatalf("read renamed destination: %v", readErr)
	}
	if string(data) != "repository" {
		t.Fatalf("destination data = %q", data)
	}
}

func TestSyncRenameParentsStopsWhenDestinationCannotBeMadeDurable(t *testing.T) {
	root := t.TempDir()
	from := filepath.Join(root, "from", "repository")
	to := filepath.Join(root, "to", "repository")
	toParent := filepath.Dir(to)
	wantErr := errors.New("injected destination-parent sync failure")
	var synced []string

	err := syncRenameParentsWithSync(from, to, func(path string) error {
		synced = append(synced, path)
		if path == toParent {
			return wantErr
		}
		return nil
	})

	if !errors.Is(err, wantErr) {
		t.Fatalf("sync rename parents error = %v, want injected destination failure", err)
	}
	wantSynced := []string{toParent}
	if strings.Join(synced, "\n") != strings.Join(wantSynced, "\n") {
		t.Fatalf("synced parents = %#v, want destination only %#v", synced, wantSynced)
	}
}

func TestDurableRemoveReportsSyncFailureAfterAppliedUnlink(t *testing.T) {
	stageDir := t.TempDir()
	metadataPath := filepath.Join(stageDir, deleteStageMetadataFile)
	if err := os.WriteFile(metadataPath, []byte("metadata"), 0o600); err != nil {
		t.Fatalf("write metadata: %v", err)
	}

	wantErr := errors.New("injected unlink sync failure")
	err := durableRemovePathWithSync(metadataPath, func(path string) error {
		if path != stageDir {
			t.Fatalf("sync path = %q, want %q", path, stageDir)
		}
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("durable remove error = %v, want injected sync failure", err)
	}
	if _, statErr := os.Stat(metadataPath); !os.IsNotExist(statErr) {
		t.Fatalf("metadata stat error = %v, want not-exist after applied unlink", statErr)
	}
}

func TestEnsureDurableDirectorySyncsEachCreatedParent(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "staging", "token")
	var synced []string
	err := ensureDurableDirectoryWithSync(target, 0o700, func(path string) error {
		synced = append(synced, path)
		return nil
	})
	if err != nil {
		t.Fatalf("ensure durable directory: %v", err)
	}
	want := []string{root, filepath.Join(root, "staging")}
	if strings.Join(synced, "\n") != strings.Join(want, "\n") {
		t.Fatalf("synced parents = %v, want %v", synced, want)
	}
	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat target directory: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("target mode = %v, want directory", info.Mode())
	}
}

func TestSettleMissingProvisionJournalRetriesStageParentSync(t *testing.T) {
	root := t.TempDir()
	stagingRoot := filepath.Join(root, provisionStagingDirName)
	if err := os.Mkdir(stagingRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	stageDir := filepath.Join(stagingRoot, strings.Repeat("a1", deleteStageTokenBytes))
	wantErr := errors.New("injected staging-parent sync failure")
	var synced []string

	err := settleMissingProvisionJournalWithSync(stageDir, func(path string) error {
		synced = append(synced, path)
		return wantErr
	})

	if !errors.Is(err, wantErr) {
		t.Fatalf("settle missing journal error = %v, want injected sync failure", err)
	}
	if len(synced) != 1 || synced[0] != stagingRoot {
		t.Fatalf("synced paths = %v, want [%s]", synced, stagingRoot)
	}
}
