package services

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type sourceReaderFunc func(context.Context, string, string, repohost.WorkspaceSourceRequest) (repohost.WorkspaceSourceReceipt, error)

func (f sourceReaderFunc) ReadWorkspaceSource(ctx context.Context, owner, repo string, req repohost.WorkspaceSourceRequest) (repohost.WorkspaceSourceReceipt, error) {
	return f(ctx, owner, repo, req)
}

func TestWorkspaceSourceAuthorizationExactACKAndNoHeadRegression(t *testing.T) {
	const workspaceID = "0f8fad5b-d9cb-469f-a165-70867728950e"
	source := repohost.WorkspaceSource{ChangeID: strings.Repeat("k", 32), CommitID: strings.Repeat("a", 40), TreeID: strings.Repeat("b", 40), ParentCommitIDs: []string{strings.Repeat("0", 40)}}
	for _, mode := range []string{"retained", "replay-after-head-moved", "wrong-token", "wrong-repo", "wrong-owner", "mixed-head", "missing", "old-route", "upstream-failure", "wrong-ack-source", "wrong-ack-workspace", "incomplete-ack", "no-capability"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			row := db.Workspace{ID: workspaceID, RepositoryID: 200, UserID: 7, Status: "running", HeadCommitID: strings.Repeat("c", 40), HeadChangeID: strings.Repeat("m", 32)}
			q := &workspaceHeadTestQuerier{mockWorkspaceQuerier: &mockWorkspaceQuerier{getWorkspaceFn: func(context.Context, string) (db.Workspace, error) { return row, nil }, updateWorkspaceHeadFn: func(context.Context, db.UpdateWorkspaceHeadParams) (db.Workspace, error) {
				t.Fatal("retention ACK must not regress live head")
				return row, nil
			}, notifyWorkspaceStatusFn: func(context.Context, db.NotifyWorkspaceStatusParams) error {
				t.Fatal("retention does not emit live head change")
				return nil
			}}}
			svc := newWorkspaceServiceForTests(q)
			svc.sourceReader = sourceReaderFunc(func(_ context.Context, owner, repo string, req repohost.WorkspaceSourceRequest) (repohost.WorkspaceSourceReceipt, error) {
				calls++
				require.Equal(t, "acme", owner)
				require.Equal(t, "widgets", repo)
				require.Equal(t, workspaceID, req.WorkspaceID)
				require.Equal(t, source, req.Source)
				receipt := repohost.WorkspaceSourceReceipt{Status: "retained", WorkspaceID: workspaceID, Ref: repohost.WorkspaceSourceRef(workspaceID, source.CommitID), Source: source}
				switch mode {
				case "missing":
					return receipt, &repohost.StatusError{StatusCode: 404, Code: "workspace_source_missing"}
				case "old-route":
					return receipt, &repohost.StatusError{StatusCode: 404}
				case "upstream-failure":
					return receipt, &repohost.StatusError{StatusCode: 500}
				case "wrong-ack-source":
					receipt.Source.TreeID = strings.Repeat("d", 40)
				case "wrong-ack-workspace":
					receipt.WorkspaceID = "other"
				case "incomplete-ack":
					receipt.Status = ""
				}
				return receipt, nil
			})
			input := ReportWorkspaceHeadInput{WorkspaceID: workspaceID, RepositoryID: 200, UserID: 7, TokenWorkspaceID: workspaceID, RetainSource: &source}
			status := 503
			switch mode {
			case "retained", "replay-after-head-moved":
				status = 200
			case "wrong-token":
				input.TokenWorkspaceID = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
				status = 403
			case "wrong-owner":
				input.TokenWorkspaceID = ""
				input.UserID = 8
				status = 403
			case "wrong-repo":
				input.RepositoryID = 300
				status = 404
			case "mixed-head":
				input.CommitID = source.CommitID
				status = 400
			case "missing":
				status = 404
			case "no-capability":
				svc.sourceReader = nil
			}
			result, err := svc.ReportWorkspaceHead(context.Background(), input)
			if status == 200 {
				require.NoError(t, err)
				require.NotNil(t, result.RetainedSource)
				require.Equal(t, row.HeadCommitID, result.Head.CommitID)
				require.Equal(t, int64(200), result.RetainedSource.RepositoryID)
				require.Equal(t, source, result.RetainedSource.Source)
			} else {
				var api *pkgerrors.APIError
				require.ErrorAs(t, err, &api)
				require.Equal(t, status, api.Status)
				if mode == "missing" {
					require.Equal(t, pkgerrors.CodeWorkspaceSourceMissing, api.Code)
				} else {
					require.NotEqual(t, pkgerrors.CodeWorkspaceSourceMissing, api.Code)
				}
			}
			if mode == "wrong-token" || mode == "wrong-owner" || mode == "wrong-repo" || mode == "mixed-head" || mode == "no-capability" {
				require.Zero(t, calls)
			} else {
				require.Equal(t, 1, calls)
			}
		})
	}
}
