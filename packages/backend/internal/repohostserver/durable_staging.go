package repohostserver

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type syncDirectoryFunc func(string) error

// syncDirectory persists directory-entry changes. File.Sync alone only makes
// file contents durable; creating, renaming, or unlinking a path also requires
// syncing each directory whose entries changed.
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open directory %s: %w", path, err)
	}
	syncErr := directory.Sync()
	closeErr := directory.Close()
	if syncErr != nil {
		syncErr = fmt.Errorf("sync directory %s: %w", path, syncErr)
	}
	if closeErr != nil {
		closeErr = fmt.Errorf("close directory %s: %w", path, closeErr)
	}
	return errors.Join(syncErr, closeErr)
}

func ensureDurableDirectory(path string, mode os.FileMode) error {
	return ensureDurableDirectoryWithSync(path, mode, syncDirectory)
}

func ensureDurableDirectoryWithSync(path string, mode os.FileMode, syncDir syncDirectoryFunc) error {
	path = filepath.Clean(path)
	missing := make([]string, 0, 2)
	current := path
	for {
		info, err := os.Stat(current)
		if err == nil {
			if !info.IsDir() {
				return fmt.Errorf("path %s exists and is not a directory", current)
			}
			break
		}
		if !os.IsNotExist(err) {
			return fmt.Errorf("inspect directory %s: %w", current, err)
		}
		missing = append(missing, current)
		parent := filepath.Dir(current)
		if parent == current {
			return fmt.Errorf("find existing parent for directory %s", path)
		}
		current = parent
	}

	for index := len(missing) - 1; index >= 0; index-- {
		directory := missing[index]
		if err := os.Mkdir(directory, mode); err != nil {
			if !os.IsExist(err) {
				return fmt.Errorf("create directory %s: %w", directory, err)
			}
			info, statErr := os.Stat(directory)
			if statErr != nil {
				return fmt.Errorf("inspect concurrently created directory %s: %w", directory, statErr)
			}
			if !info.IsDir() {
				return fmt.Errorf("path %s exists and is not a directory", directory)
			}
		}
		if err := syncDir(filepath.Dir(directory)); err != nil {
			return fmt.Errorf("persist directory %s: %w", directory, err)
		}
	}
	// An existing directory may be the result of an earlier attempt whose
	// parent sync failed. Syncing its parent again settles that ambiguity.
	if len(missing) == 0 {
		if err := syncDir(filepath.Dir(path)); err != nil {
			return fmt.Errorf("persist existing directory %s: %w", path, err)
		}
	}
	return nil
}

// writeDurableJournal atomically installs a fully synced journal. The boolean
// reports whether the final metadata name was installed, including the case
// where the following directory sync failed. Callers must preserve the stage
// directory whenever it is true because the operation is then ambiguous
// across a crash.
func writeDurableJournal(stageDir, name string, data []byte, mode os.FileMode) (bool, error) {
	return writeDurableJournalWithSync(stageDir, name, data, mode, syncDirectory)
}

func writeDurableJournalWithSync(stageDir, name string, data []byte, mode os.FileMode, syncDir syncDirectoryFunc) (bool, error) {
	temporary, err := os.CreateTemp(stageDir, "."+name+".tmp-")
	if err != nil {
		return false, fmt.Errorf("create temporary journal: %w", err)
	}
	temporaryPath := temporary.Name()
	temporaryOpen := true
	cleanupTemporary := true
	defer func() {
		if temporaryOpen {
			_ = temporary.Close()
		}
		if cleanupTemporary {
			_ = durableRemovePathWithSync(temporaryPath, syncDir)
		}
	}()

	if err := temporary.Chmod(mode); err != nil {
		return false, fmt.Errorf("set temporary journal permissions: %w", err)
	}
	written, err := temporary.Write(data)
	if err != nil {
		return false, fmt.Errorf("write temporary journal: %w", err)
	}
	if written != len(data) {
		return false, fmt.Errorf("write temporary journal: %w", io.ErrShortWrite)
	}
	if err := temporary.Sync(); err != nil {
		return false, fmt.Errorf("sync temporary journal: %w", err)
	}
	if err := temporary.Close(); err != nil {
		temporaryOpen = false
		return false, fmt.Errorf("close temporary journal: %w", err)
	}
	temporaryOpen = false

	journalPath := filepath.Join(stageDir, name)
	if err := os.Rename(temporaryPath, journalPath); err != nil {
		return false, fmt.Errorf("install journal: %w", err)
	}
	cleanupTemporary = false
	if err := syncDir(stageDir); err != nil {
		return true, fmt.Errorf("journal installed but directory sync failed: %w", err)
	}
	return true, nil
}

// durableRenamePath returns an error if either changed parent directory could
// not be synced. In that case the rename may already have happened; callers
// must keep their durable journal and recover by inspecting both paths.
func durableRenamePath(from, to string) error {
	return durableRenamePathWithSync(from, to, syncDirectory)
}

func durableRenamePathWithSync(from, to string, syncDir syncDirectoryFunc) error {
	if err := os.Rename(from, to); err != nil {
		return err
	}
	return syncRenameParentsWithSync(from, to, syncDir)
}

// syncRenameParents settles an earlier rename that is already visible in the
// process but whose fsync result was lost or failed. Recovery paths call this
// before discarding the journal when no new os.Rename is necessary.
func syncRenameParents(from, to string) error {
	return syncRenameParentsWithSync(from, to, syncDirectory)
}

func syncRenameParentsWithSync(from, to string, syncDir syncDirectoryFunc) error {
	fromParent := filepath.Dir(from)
	toParent := filepath.Dir(to)
	// Persist the destination entry before the source removal. If the
	// destination cannot be made durable, stop: syncing the source first could
	// make its unlink survive a crash while the destination entry disappears.
	if err := syncDir(toParent); err != nil {
		return fmt.Errorf("rename state visible but destination parent directory %s was not synced: %w", toParent, err)
	}
	if fromParent == toParent {
		return nil
	}
	if err := syncDir(fromParent); err != nil {
		return fmt.Errorf("rename destination durable but source parent directory %s was not synced: %w", fromParent, err)
	}
	return nil
}

func durableRemovePathWithSync(path string, syncDir syncDirectoryFunc) error {
	removeErr := os.Remove(path)
	if os.IsNotExist(removeErr) {
		removeErr = nil
	}
	syncErr := syncDir(filepath.Dir(path))
	if removeErr != nil {
		removeErr = fmt.Errorf("remove %s: %w", path, removeErr)
	}
	if syncErr != nil {
		syncErr = fmt.Errorf("persist removal of %s: %w", path, syncErr)
	}
	return errors.Join(removeErr, syncErr)
}

func durableRemoveAll(path string) error {
	return durableRemoveAllWithSync(path, syncDirectory)
}

func durableRemoveAllWithSync(path string, syncDir syncDirectoryFunc) error {
	removeErr := os.RemoveAll(path)
	syncErr := syncDir(filepath.Dir(path))
	if removeErr != nil {
		removeErr = fmt.Errorf("remove tree %s: %w", path, removeErr)
	}
	if syncErr != nil {
		syncErr = fmt.Errorf("persist removal of tree %s: %w", path, syncErr)
	}
	return errors.Join(removeErr, syncErr)
}
