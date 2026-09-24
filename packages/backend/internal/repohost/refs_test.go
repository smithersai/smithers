package repohost

import (
	"strings"
	"testing"
)

func TestReservedWorkspaceSourcesAreImmutableAndOwned(t *testing.T) {
	mine := "0f8fad5b-d9cb-469f-a165-70867728950e"
	other := "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	id, different, zero := strings.Repeat("a", 40), strings.Repeat("b", 40), strings.Repeat("0", 40)
	for _, tc := range []struct {
		name, owner, ref, old, next string
		denied                      bool
	}{
		{"create", mine, WorkspaceSourceRef(mine, id), zero, id, false},
		{"replay", mine, WorkspaceSourceRef(mine, id), id, id, false},
		{"wrong owner", other, WorkspaceSourceRef(mine, id), zero, id, true},
		{"user", "", WorkspaceSourceRef(mine, id), zero, id, true},
		{"delete", mine, WorkspaceSourceRef(mine, id), id, zero, true},
		{"repoint", mine, WorkspaceSourceRef(mine, id), id, different, true},
		{"mismatched initial target", mine, WorkspaceSourceRef(mine, id), zero, different, true},
		{"already corrupted target", mine, WorkspaceSourceRef(mine, id), different, id, true},
		{"noncanonical workspace", mine, WorkspaceSourceRef(strings.ToUpper(mine), id), zero, id, true},
		{"malformed commit", mine, WorkspaceSourceRef(mine, "abc"), zero, id, true},
		{"root", mine, WorkspaceSourceRef(mine, zero), zero, zero, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			message := ReservedRefViolation([]ReceivePackCommand{{RefName: tc.ref, OldOID: tc.old, NewOID: tc.next}}, tc.owner)
			if (message != "") != tc.denied {
				t.Fatalf("violation=%q denied=%v", message, tc.denied)
			}
		})
	}
}

func TestWorkspaceIDFromHeadRef(t *testing.T) {
	id := "0f8fad5b-d9cb-469f-a165-70867728950e"
	got, ok := WorkspaceIDFromHeadRef(WorkspaceHeadRef(id))
	if !ok || got != id {
		t.Fatalf("round trip = %q, %v", got, ok)
	}
	for _, ref := range []string{
		"refs/heads/main",
		"refs/smithers/workspaces/" + id,
		"refs/smithers/workspaces/" + id + "/head/extra",
		"refs/smithers/workspaces/not-a-uuid/head",
		"refs/smithers/workspaces//head",
		"refs/smithers/other/" + id + "/head",
	} {
		if _, ok := WorkspaceIDFromHeadRef(ref); ok {
			t.Fatalf("%q parsed as a workspace head ref", ref)
		}
	}
}

func TestReservedRefViolation(t *testing.T) {
	mine := "0f8fad5b-d9cb-469f-a165-70867728950e"
	other := "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	cases := []struct {
		name      string
		refs      []string
		workspace string
		denied    bool
	}{
		{"user pushes bookmark", []string{"refs/heads/main"}, "", false},
		{"user pushes tag", []string{"refs/tags/v1"}, "", false},
		{"user pushes reserved head", []string{WorkspaceHeadRef(mine)}, "", true},
		{"user pushes arbitrary reserved ref", []string{"refs/smithers/anything"}, "", true},
		{"workspace pushes own head", []string{WorkspaceHeadRef(mine)}, mine, false},
		{"workspace pushes own head upper-case token id", []string{WorkspaceHeadRef(mine)}, "0F8FAD5B-D9CB-469F-A165-70867728950E", false},
		{"workspace pushes other head", []string{WorkspaceHeadRef(other)}, mine, true},
		{"workspace pushes bookmark", []string{"refs/heads/main"}, mine, true},
		{"workspace pushes head and bookmark", []string{WorkspaceHeadRef(mine), "refs/heads/main"}, mine, true},
		{"workspace pushes malformed reserved ref", []string{"refs/smithers/workspaces/" + mine}, mine, true},
		{"user deletes jj retention pin", []string{"refs/jj/keep/0123456789abcdef0123456789abcdef01234567"}, "", true},
		{"user plants jj ref", []string{"refs/jj/anything"}, "", true},
		{"workspace pushes jj retention pin", []string{"refs/jj/keep/0123456789abcdef0123456789abcdef01234567"}, mine, true},
		{"empty command list", nil, mine, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			commands := make([]ReceivePackCommand, 0, len(tc.refs))
			for _, ref := range tc.refs {
				commands = append(commands, ReceivePackCommand{RefName: ref, OldOID: "0", NewOID: "1"})
			}
			msg := ReservedRefViolation(commands, tc.workspace)
			if (msg != "") != tc.denied {
				t.Fatalf("violation=%q denied=%v", msg, tc.denied)
			}
		})
	}
}
