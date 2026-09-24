package repohost

import (
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// ReservedRefPrefix is the git ref namespace the control plane owns. Nothing
// under it is a bookmark or a tag: push hooks ignore it, jj import ignores it,
// and only the control plane's own credentials may write to it.
const ReservedRefPrefix = "refs/smithers/"

// JJRefPrefix is the git ref namespace jj itself writes (refs/jj/keep/*
// retention pins among them). Pushes may not create, move, or delete refs
// there.
const JJRefPrefix = "refs/jj/"

// WorkspaceHeadRefPrefix holds one ref per workspace,
// refs/smithers/workspaces/<workspace id>/head, force-updated by the
// workspace's guest head reporter on every jj snapshot (RFD-004).
const WorkspaceHeadRefPrefix = ReservedRefPrefix + "workspaces/"

var fullSourceCommitID = regexp.MustCompile(`^[0-9a-f]{40}$`)

// WorkspaceSourceRef is an immutable object-retention root, never a bookmark.
func WorkspaceSourceRef(workspaceID, commitID string) string {
	return WorkspaceHeadRefPrefix + workspaceID + "/sources/" + commitID
}

func WorkspaceSourceFromRef(ref string) (workspaceID, commitID string, ok bool) {
	rest, ok := strings.CutPrefix(ref, WorkspaceHeadRefPrefix)
	if !ok {
		return "", "", false
	}
	id, commit, ok := strings.Cut(rest, "/sources/")
	parsed, err := uuid.Parse(id)
	if !ok || err != nil || parsed.String() != id || parsed == uuid.Nil || !fullSourceCommitID.MatchString(commit) || commit == strings.Repeat("0", 40) {
		return "", "", false
	}
	return id, commit, true
}

// WorkspaceHeadRef returns the head ref of a workspace.
func WorkspaceHeadRef(workspaceID string) string {
	return WorkspaceHeadRefPrefix + strings.TrimSpace(workspaceID) + "/head"
}

// WorkspaceIDFromHeadRef parses refs/smithers/workspaces/<uuid>/head. The id
// is returned in canonical lower-case form.
func WorkspaceIDFromHeadRef(ref string) (string, bool) {
	rest, ok := strings.CutPrefix(ref, WorkspaceHeadRefPrefix)
	if !ok {
		return "", false
	}
	id, ok := strings.CutSuffix(rest, "/head")
	if !ok || id == "" || strings.Contains(id, "/") {
		return "", false
	}
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", false
	}
	return parsed.String(), true
}

// ReservedRefViolation applies the reserved-namespace push policy to a
// receive-pack command list and returns an empty string when the push is
// allowed, or the reason it must be refused.
//
// workspaceID is the workspace a workspace-restricted credential is bound to
// ("" for every other credential). Rules:
//   - nothing may write under refs/jj/: jj owns that namespace, and its
//     refs/jj/keep/* pins are what keep jj-only commits safe from git gc;
//   - a ref under refs/smithers/ must be a workspace head ref, and only the
//     owning workspace's credential may update it;
//   - a workspace credential may update nothing but its own head ref.
func ReservedRefViolation(commands []ReceivePackCommand, workspaceID string) string {
	workspaceID = strings.ToLower(strings.TrimSpace(workspaceID))
	for _, command := range commands {
		ref := strings.TrimSpace(command.RefName)
		if strings.HasPrefix(ref, JJRefPrefix) {
			return "refs/jj/ is managed by jj and cannot be pushed"
		}
		if !strings.HasPrefix(ref, ReservedRefPrefix) {
			if workspaceID != "" {
				return "workspace credentials may only update the workspace head ref"
			}
			continue
		}
		if owner, commit, ok := WorkspaceSourceFromRef(ref); ok {
			if workspaceID == "" || owner != workspaceID {
				return "workspace sources are written only by the owning workspace"
			}
			if command.NewOID != commit || (command.OldOID != strings.Repeat("0", 40) && command.OldOID != commit) {
				return "workspace source refs permit only creation or identical replay of their named commit"
			}
			continue
		}
		owner, ok := WorkspaceIDFromHeadRef(ref)
		if !ok {
			return "refs/smithers/ is reserved for the control plane"
		}
		if workspaceID == "" || owner != workspaceID {
			return "workspace head refs are written only by the owning workspace"
		}
	}
	return ""
}
