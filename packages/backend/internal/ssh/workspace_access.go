package ssh

import (
	"context"
	"errors"
	gliderssh "github.com/gliderlabs/ssh"
	"strings"
	"unicode"
)

const workspaceAccessKey contextKey = "workspace-access"

var ErrWorkspaceAccessDenied = errors.New("workspace access denied")

// ErrWorkspaceUnavailable means the controller could not answer: the VM is
// missing or moving, or the controller failed. It is never a credential failure.
var ErrWorkspaceUnavailable = errors.New("workspace unavailable")

// WorkspaceAccess is the non-persisted credential material for one public SSH
// connection. Token must never be logged or included in an error.
type WorkspaceAccess struct {
	SandboxID string
	User      string
	Token     string
}

// WorkspaceBridge validates an access grant and proxies an authenticated
// public session into the workspace's private SSH server.
type WorkspaceBridge interface {
	Validate(context.Context, WorkspaceAccess) error
	Serve(gliderssh.Session, WorkspaceAccess) (int, error)
}

func parseWorkspacePublicKeyLogin(login string) (WorkspaceAccess, bool) {
	separator := strings.LastIndexByte(login, ':')
	if separator < 0 {
		return WorkspaceAccess{}, false
	}
	return parseWorkspaceLogin(login[:separator], login[separator+1:])
}

func parseWorkspacePasswordLogin(login, password string) (WorkspaceAccess, bool) {
	if strings.Contains(login, ":") {
		return WorkspaceAccess{}, false
	}
	return parseWorkspaceLogin(login, password)
}

func parseWorkspaceLogin(login, token string) (WorkspaceAccess, bool) {
	separator := strings.IndexByte(login, '+')
	if separator <= 0 || separator == len(login)-1 {
		return WorkspaceAccess{}, false
	}
	sandboxID, user := login[:separator], login[separator+1:]
	if len(sandboxID) > 128 || !safeSSHIdentifier(sandboxID) || !safeSSHIdentifier(user) {
		return WorkspaceAccess{}, false
	}
	token = strings.TrimSpace(token)
	if len(token) < 20 || len(token) > 1024 || strings.IndexFunc(token, unicode.IsSpace) >= 0 {
		return WorkspaceAccess{}, false
	}
	return WorkspaceAccess{SandboxID: sandboxID, User: user, Token: token}, true
}

func safeSSHIdentifier(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !(unicode.IsLetter(character) || unicode.IsDigit(character) || character == '_' || character == '-') {
			return false
		}
	}
	return true
}
