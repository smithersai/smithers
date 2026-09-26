package services

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// UserRefHost is repo-host's per-user ref API (#1964, #1968).
type UserRefHost interface {
	ListUserRefs(context.Context, string, string, int64) (repohost.UserRefList, error)
	RetainUserRef(context.Context, string, string, int64, repohost.RetainUserRefRequest) (repohost.RetainedUserRef, error)
	RenewUserRef(context.Context, string, string, int64, string) (repohost.UserRefInfo, error)
}

type userRefStore interface {
	GetWorkspaceByRepo(context.Context, db.GetWorkspaceByRepoParams) (db.Workspace, error)
	GetMythicalStack(context.Context, int64) (db.MythicalStack, error)
}

// UserRefService serves a user's own pushed refs,
// refs/smithers/users/<id>/<name>. Every operation names the caller's
// namespace, so no one can read another user's ref through it.
type UserRefService struct {
	host UserRefHost
	q    userRefStore
}

func NewUserRefService(host UserRefHost, q userRefStore) *UserRefService {
	return &UserRefService{host: host, q: q}
}

// DefaultUserRefName is the ref `smithers repo push` writes without --name,
// and the one a change starts from when it names none.
const DefaultUserRefName = "head"

// UserRefSource answers where a change in a workspace starts: Base is the
// coding/request base (the commit pinned under the workspace's own source
// ref), nil when the caller asked for no ref and has no head.
type UserRefSource struct {
	Name     string                    `json:"name"`
	Base     *UserRefBase              `json:"base"`
	Retained *repohost.RetainedUserRef `json:"retained,omitempty"`
}

// UserRefBase matches flows/coding's StackBase.
type UserRefBase struct {
	CommitID string `json:"commitId"`
	Ref      string `json:"ref"`
}

func userRefHostMissing(err error) bool {
	var upstream *repohost.StatusError
	return errors.As(err, &upstream) && upstream.StatusCode == http.StatusNotFound && upstream.Code == "user_ref_missing"
}

func userRefHostError(err error) error {
	var upstream *repohost.StatusError
	if errors.As(err, &upstream) {
		switch {
		case upstream.Code == "user_ref_missing":
			return pkgerrors.New(pkgerrors.CodeUserRefMissing, upstream.Message)
		case upstream.StatusCode == http.StatusNotFound:
			return pkgerrors.NotFound(upstream.Message)
		case upstream.StatusCode == http.StatusBadRequest:
			return pkgerrors.BadRequest(upstream.Message)
		case upstream.StatusCode == http.StatusConflict:
			return pkgerrors.Conflict(upstream.Message)
		}
	}
	return pkgerrors.Internal("repository host: " + err.Error())
}

// List answers the caller's refs in a repository with their expiry.
func (s *UserRefService) List(ctx context.Context, owner, repo string, userID int64) (repohost.UserRefList, error) {
	list, err := s.host.ListUserRefs(ctx, owner, repo, userID)
	if err != nil {
		return repohost.UserRefList{}, userRefHostError(err)
	}
	return list, nil
}

// Renew restarts the expiry of one of the caller's refs.
func (s *UserRefService) Renew(ctx context.Context, owner, repo string, userID int64, name string) (repohost.UserRefInfo, error) {
	if !repohost.ValidUserRefName(name) {
		return repohost.UserRefInfo{}, pkgerrors.BadRequest("invalid ref name")
	}
	info, err := s.host.RenewUserRef(ctx, owner, repo, userID, name)
	if err != nil {
		return repohost.UserRefInfo{}, userRefHostError(err)
	}
	return info, nil
}

// StartFrom pins one of the caller's refs for a coding run in the caller's
// own workspace. With no name it looks for the caller's head ref and answers
// a nil Base when there is none; a named ref must exist. A repository that
// lands through its mythical stack refuses a named ref and ignores head: a
// lane starts from the stack tip.
func (s *UserRefService) StartFrom(ctx context.Context, owner, repo string, repositoryID, userID int64, workspaceID, name string) (UserRefSource, error) {
	explicit := name != ""
	if !explicit {
		name = DefaultUserRefName
	}
	if !repohost.ValidUserRefName(name) {
		return UserRefSource{}, pkgerrors.BadRequest("invalid ref name")
	}
	source := UserRefSource{Name: name}
	workspace, err := s.q.GetWorkspaceByRepo(ctx, db.GetWorkspaceByRepoParams{ID: workspaceID, RepositoryID: repositoryID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) || isInvalidTextRepresentation(err) {
			return UserRefSource{}, pkgerrors.NotFound("workspace not found")
		}
		return UserRefSource{}, pkgerrors.Internal("load workspace: " + err.Error())
	}
	// A pushed ref is its owner's local work: it goes only into their own box.
	if workspace.UserID != userID {
		return UserRefSource{}, pkgerrors.NotFound("workspace not found")
	}
	if _, err := s.q.GetMythicalStack(ctx, repositoryID); err == nil {
		if explicit {
			return UserRefSource{}, pkgerrors.New(pkgerrors.CodeUserRefStack, "this repository lands through its mythical stack")
		}
		return source, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return UserRefSource{}, pkgerrors.Internal("load mythical stack: " + err.Error())
	}
	retained, err := s.host.RetainUserRef(ctx, owner, repo, userID, repohost.RetainUserRefRequest{Name: name, WorkspaceID: workspace.ID})
	if err != nil {
		if !explicit && userRefHostMissing(err) {
			return source, nil
		}
		return UserRefSource{}, userRefHostError(err)
	}
	source.Base = &UserRefBase{CommitID: retained.CommitID, Ref: retained.SourceRef}
	source.Retained = &retained
	return source, nil
}
