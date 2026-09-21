package smitherscli

import (
	"strings"
	"testing"

	incur "github.com/smithersai/incur"
)

func localFServe(t *testing.T, cmd *incur.Cli, argv ...string) error {
	t.Helper()
	var out strings.Builder
	return cmd.ServeWithOptions(argv, incur.ServeOptions{Stdout: &out, Stderr: &out})
}

func TestCommandsLocal_F_StatusBranches(t *testing.T) {
	jjFInstall(t)

	t.Setenv("JJF_FAIL", "log -r")
	if err := localFServe(t, statusCommand()); err == nil {
		t.Fatal("status error expected")
	}
	t.Setenv("JJF_FAIL", "")

	if err := localFServe(t, statusCommand(), "--format", "toon"); err != nil {
		t.Fatalf("status toon = %v", err)
	}
	if err := localFServe(t, statusCommand(), "--format", "json"); err != nil {
		t.Fatalf("status json = %v", err)
	}
}

func TestCommandsLocal_F_BookmarkList(t *testing.T) {
	jjFInstall(t)

	t.Setenv("JJF_FAIL", "bookmark list")
	if err := localFServe(t, bookmarkCommand(), "list"); err == nil {
		t.Fatal("bookmark list error expected")
	}
	t.Setenv("JJF_FAIL", "")

	if err := localFServe(t, bookmarkCommand(), "list", "--format", "toon"); err != nil {
		t.Fatalf("bookmark list toon = %v", err)
	}
	if err := localFServe(t, bookmarkCommand(), "list", "--format", "json"); err != nil {
		t.Fatalf("bookmark list json = %v", err)
	}

	t.Setenv("JJF_BM", "none")
	if err := localFServe(t, bookmarkCommand(), "list"); err != nil {
		t.Fatalf("bookmark list empty = %v", err)
	}
	t.Setenv("JJF_BM", "blank")
	if err := localFServe(t, bookmarkCommand(), "list"); err != nil {
		t.Fatalf("bookmark list human = %v", err)
	}
}

func TestCommandsLocal_F_BookmarkCreate(t *testing.T) {
	jjFInstall(t)

	t.Setenv("JJF_FAIL", "bookmark create")
	if err := localFServe(t, bookmarkCommand(), "create", "n", "--change", "chg1"); err == nil {
		t.Fatal("bookmark create error expected")
	}
	t.Setenv("JJF_FAIL", "")

	if err := localFServe(t, bookmarkCommand(), "create", "n", "--change", "chg1", "--format", "toon"); err != nil {
		t.Fatalf("bookmark create toon = %v", err)
	}
	if err := localFServe(t, bookmarkCommand(), "create", "n", "--change", "chg1", "--format", "json"); err != nil {
		t.Fatalf("bookmark create json = %v", err)
	}

	// no change + empty bookmark listing -> fallback bookmark with nil target
	t.Setenv("JJF_BM", "none")
	if err := localFServe(t, bookmarkCommand(), "create", "n"); err != nil {
		t.Fatalf("bookmark create no-target = %v", err)
	}
}

func TestCommandsLocal_F_BookmarkDelete(t *testing.T) {
	jjFInstall(t)

	t.Setenv("JJF_FAIL", "bookmark list")
	if err := localFServe(t, bookmarkCommand(), "delete", "feature"); err == nil {
		t.Fatal("bookmark delete Has error expected")
	}
	t.Setenv("JJF_FAIL", "")

	if err := localFServe(t, bookmarkCommand(), "delete", "nonexistent"); err == nil {
		t.Fatal("bookmark delete not-found expected")
	}

	t.Setenv("JJF_FAIL", "bookmark delete")
	if err := localFServe(t, bookmarkCommand(), "delete", "feature"); err == nil {
		t.Fatal("bookmark delete op error expected")
	}
	t.Setenv("JJF_FAIL", "")

	if err := localFServe(t, bookmarkCommand(), "delete", "feature", "--format", "json"); err != nil {
		t.Fatalf("bookmark delete explicit = %v", err)
	}
}

func TestCommandsLocal_F_ChangeCommands(t *testing.T) {
	jjFInstall(t)

	t.Setenv("JJF_FAIL", "log -n")
	if err := localFServe(t, changeCommand(), "list"); err == nil {
		t.Fatal("change list error expected")
	}
	t.Setenv("JJF_FAIL", "")

	if err := localFServe(t, changeCommand(), "list", "--format", "toon"); err != nil {
		t.Fatalf("change list toon = %v", err)
	}
	if err := localFServe(t, changeCommand(), "list", "--format", "json"); err != nil {
		t.Fatalf("change list json = %v", err)
	}

	if err := localFServe(t, changeCommand(), "show", "chg1", "--format", "json"); err != nil {
		t.Fatalf("change show explicit = %v", err)
	}

	// diff with no id -> defaults to @
	if err := localFServe(t, changeCommand(), "diff"); err != nil {
		t.Fatalf("change diff default = %v", err)
	}
	t.Setenv("JJF_FAIL", "diff -r")
	if err := localFServe(t, changeCommand(), "diff", "chg1"); err == nil {
		t.Fatal("change diff error expected")
	}
	t.Setenv("JJF_FAIL", "diff --summary")
	if err := localFServe(t, changeCommand(), "files", "chg1"); err == nil {
		t.Fatal("change files error expected")
	}
	if err := localFServe(t, changeCommand(), "conflicts", "chg1"); err == nil {
		t.Fatal("change conflicts error expected")
	}
}
