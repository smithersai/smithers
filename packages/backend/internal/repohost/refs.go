package repohost

import (
	"regexp"
	"strconv"
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

// The mythical stack's refs are written only by the stack service (RFD-004
// control plane): its bookmark, its provenance notes, and its retention pins.
const (
	MythicalBookmarkRef   = "refs/heads/mythical"
	MythicalNotesRef      = "refs/notes/mythical"
	MythicalReservedRefNS = ReservedRefPrefix + "mythical/"
)

// UserRefPrefix holds work a user pushes from a local checkout (#1964):
// refs/smithers/users/<user id>/<name>, written only by that user. Under
// refs/smithers/ it is inert like every control-plane ref: no bookmark, no
// push hook, no jj import, no GitHub mirror. The numeric id, never the login,
// names the owner: a login can be renamed and reused, and internal pushers
// carry fixed logins.
const UserRefPrefix = ReservedRefPrefix + "users/"

var userRefName = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)

// UserRef returns a user's ref for one pushed name.
func UserRef(userID int64, name string) string {
	return UserRefPrefix + strconv.FormatInt(userID, 10) + "/" + name
}

// UserIDFromRef parses refs/smithers/users/<id>/<name>. The id is canonical
// decimal and positive; the name is one or more [A-Za-z0-9._-] segments that
// git accepts: no "..", no segment starting or ending with ".", none ending
// in ".lock".
func UserIDFromRef(ref string) (int64, bool) {
	rest, ok := strings.CutPrefix(ref, UserRefPrefix)
	if !ok {
		return 0, false
	}
	idText, name, ok := strings.Cut(rest, "/")
	id, err := strconv.ParseInt(idText, 10, 64)
	if !ok || err != nil || id <= 0 || strconv.FormatInt(id, 10) != idText || !userRefName.MatchString(name) {
		return 0, false
	}
	if strings.Contains(name, "..") {
		return 0, false
	}
	for _, segment := range strings.Split(name, "/") {
		if strings.HasPrefix(segment, ".") || strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, ".lock") {
			return 0, false
		}
	}
	return id, true
}

// IsMythicalRef reports whether ref belongs to the mythical stack service.
func IsMythicalRef(ref string) bool {
	return ref == MythicalBookmarkRef || ref == MythicalNotesRef || strings.HasPrefix(ref, MythicalReservedRefNS)
}

// ReservedRefViolation applies the reserved-namespace push policy to a
// receive-pack command list and returns an empty string when the push is
// allowed, or the reason it must be refused.
//
// workspaceID is the workspace a workspace-restricted credential is bound to
// ("" for every other credential); pusherID is the authenticated user (0 when
// none, as for internal pushers). Rules:
//   - nothing may write under refs/jj/: jj owns that namespace, and its
//     refs/jj/keep/* pins are what keep jj-only commits safe from git gc;
//   - a ref under refs/smithers/ must be a workspace head ref, and only the
//     owning workspace's credential may update it;
//   - a workspace credential may update nothing but its own head ref;
//   - refs/smithers/users/<id>/<name> may be written only by user <id>
//     through a user credential.
func ReservedRefViolation(commands []ReceivePackCommand, workspaceID string, pusherID int64) string {
	return ControlPlaneRefViolation(commands, workspaceID, pusherID, false)
}

// ControlPlaneRefViolation is ReservedRefViolation for a push the API made
// on its own behalf. Only such a push (controlPlane, never set from a
// client) may write the mythical stack's refs, and it may write nothing else.
func ControlPlaneRefViolation(commands []ReceivePackCommand, workspaceID string, pusherID int64, controlPlane bool) string {
	workspaceID = strings.ToLower(strings.TrimSpace(workspaceID))
	for _, command := range commands {
		ref := strings.TrimSpace(command.RefName)
		if strings.HasPrefix(ref, JJRefPrefix) {
			return "refs/jj/ is managed by jj and cannot be pushed"
		}
		if IsMythicalRef(ref) {
			if !controlPlane || workspaceID != "" {
				return "the mythical stack is written only by the stack service"
			}
			continue
		}
		if controlPlane {
			return "a control-plane push may write only the mythical stack"
		}
		if !strings.HasPrefix(ref, ReservedRefPrefix) {
			if workspaceID != "" {
				return "workspace credentials may only update the workspace head ref"
			}
			continue
		}
		if strings.HasPrefix(ref, UserRefPrefix) {
			owner, ok := UserIDFromRef(ref)
			if !ok || workspaceID != "" || pusherID <= 0 || owner != pusherID {
				return "refs/smithers/users/<id>/<name> is written only by user <id>"
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
