package services

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/ownership"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type OwnershipSatisfiedBy struct {
	Login string `json:"login"`
	Seq   int64  `json:"seq"`
}

type OwnershipTouchedPath struct {
	ownership.PathResolution
	SatisfiedBy *OwnershipSatisfiedBy `json:"satisfied_by"`
}

type MissingOwnershipApproval struct {
	Path       string   `json:"path"`
	Candidates []string `json:"candidates"`
}

type ChangeOwnership struct {
	TouchedPaths       []OwnershipTouchedPath     `json:"touched_paths"`
	RequiredApprovers  []string                   `json:"required_approvers"`
	SuggestedReviewers []string                   `json:"suggested_reviewers"`
	MissingApprovals   []MissingOwnershipApproval `json:"missing_approvals"`
}

type OwnershipTouchedFile struct {
	Path        string
	ChangeID    string
	CommitID    string
	RevisionSeq int64
}

type ownershipRepoHost interface {
	GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error)
}

type ownershipQueries interface {
	ListSubmittedLandingApprovals(ctx context.Context, landingRequestID int64) ([]db.LandingRequestReview, error)
	GetUserByID(ctx context.Context, id int64) (db.User, error)
	ListTeamNamesForUserByRepository(ctx context.Context, arg db.ListTeamNamesForUserByRepositoryParams) ([]string, error)
}

type ownershipFileLoader struct {
	ctxOwner string
	ctxRepo  string
	repoHost ownershipRepoHost
}

func (l ownershipFileLoader) LoadFile(ctx context.Context, revision, filePath string) (string, bool, error) {
	file, err := l.repoHost.GetFileAtChange(ctx, l.ctxOwner, l.ctxRepo, revision, filePath)
	if err != nil {
		if status, ok := repohost.IsStatusError(err); ok && status.StatusCode == 404 {
			return "", false, nil
		}
		return "", false, err
	}
	if file.TooLarge || file.Encoding == "base64" {
		return "", false, stdErrors.New("ownership file is not readable UTF-8 text")
	}
	return file.Content, true, nil
}

type approvalRevision struct {
	CommitID string `json:"commit_id"`
	Seq      int64  `json:"seq"`
}

type ownershipApproval struct {
	login     string
	userType  string
	teams     map[string]struct{}
	revisions map[string]approvalRevision
}

func resolveChangeOwnership(
	ctx context.Context,
	q ownershipQueries,
	rh ownershipRepoHost,
	repositoryID int64,
	owner, repo, ownershipRevision string,
	touched []OwnershipTouchedFile,
	landingRequestID int64,
	immutableOnly ...bool,
) (ChangeOwnership, error) {
	paths := make([]string, len(touched))
	for i := range touched {
		paths[i] = touched[i].Path
	}
	tree, err := ownership.LoadTree(ctx, ownershipFileLoader{ctxOwner: owner, ctxRepo: repo, repoHost: rh}, ownershipRevision, paths)
	if err != nil {
		return ChangeOwnership{}, err
	}

	approvals, err := loadOwnershipApprovals(ctx, q, repositoryID, landingRequestID)
	if err != nil {
		return ChangeOwnership{}, err
	}
	result := ChangeOwnership{TouchedPaths: make([]OwnershipTouchedPath, 0, len(touched))}
	result.MissingApprovals = make([]MissingOwnershipApproval, 0)
	pathResolutions := make([]ownership.PathResolution, 0, len(touched))
	for _, file := range touched {
		resolved := tree.Resolve(file.Path)
		pathResolutions = append(pathResolutions, resolved)
		item := OwnershipTouchedPath{PathResolution: resolved}
		candidates := approvingCandidates(resolved.Owners)
		for _, approval := range approvals {
			revision, ok := approval.revisions[file.ChangeID]
			if !ok || revision.CommitID != file.CommitID || (revision.Seq != file.RevisionSeq && !(len(immutableOnly) > 0 && immutableOnly[0])) {
				continue
			}
			if principalApproves(approval, resolved.Owners) {
				item.SatisfiedBy = &OwnershipSatisfiedBy{Login: approval.login, Seq: revision.Seq}
				break
			}
		}
		if len(candidates) > 0 && item.SatisfiedBy == nil {
			result.MissingApprovals = append(result.MissingApprovals, MissingOwnershipApproval{Path: resolved.Path, Candidates: candidates})
		}
		result.TouchedPaths = append(result.TouchedPaths, item)
	}
	result.RequiredApprovers = ownership.RequiredApprovers(pathResolutions)
	result.SuggestedReviewers = ownership.SuggestedReviewers(pathResolutions)
	return result, nil
}

func loadOwnershipApprovals(ctx context.Context, q ownershipQueries, repositoryID, landingRequestID int64) ([]ownershipApproval, error) {
	if q == nil || landingRequestID == 0 {
		return nil, nil
	}
	reviews, err := q.ListSubmittedLandingApprovals(ctx, landingRequestID)
	if err != nil {
		return nil, err
	}
	result := make([]ownershipApproval, 0, len(reviews))
	for _, review := range reviews {
		if !review.ReviewerID.Valid {
			continue
		}
		user, err := q.GetUserByID(ctx, review.ReviewerID.Int64)
		if err != nil {
			return nil, err
		}
		teams, err := q.ListTeamNamesForUserByRepository(ctx, db.ListTeamNamesForUserByRepositoryParams{RepositoryID: repositoryID, UserID: user.ID})
		if err != nil {
			return nil, err
		}
		teamSet := make(map[string]struct{}, len(teams))
		for _, team := range teams {
			teamSet[strings.ToLower(team)] = struct{}{}
		}
		revisions := map[string]approvalRevision{}
		if len(review.ChangeRevisions) > 0 {
			if err := json.Unmarshal(review.ChangeRevisions, &revisions); err != nil {
				return nil, err
			}
		}
		result = append(result, ownershipApproval{login: user.Username, userType: user.UserType, teams: teamSet, revisions: revisions})
	}
	return result, nil
}

func approvingCandidates(owners []ownership.Principal) []string {
	seen := map[string]struct{}{}
	for _, candidate := range owners {
		if candidate.Role == ownership.RoleApprove {
			seen[candidate.ID()] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for candidate := range seen {
		out = append(out, candidate)
	}
	sort.Strings(out)
	return out
}

func principalApproves(approval ownershipApproval, owners []ownership.Principal) bool {
	for _, candidate := range owners {
		if candidate.Role != ownership.RoleApprove {
			continue
		}
		if candidate.Login != "" && strings.EqualFold(candidate.Login, approval.login) {
			return true
		}
		if candidate.Team != "" {
			if _, ok := approval.teams[strings.ToLower(candidate.Team)]; ok {
				return true
			}
		}
	}
	return false
}

func appendUniqueReviewers(base []string, extra ...string) []string {
	seen := make(map[string]struct{}, len(base)+len(extra))
	for _, item := range base {
		if item != "" {
			seen[item] = struct{}{}
		}
	}
	for _, item := range extra {
		if item != "" {
			seen[item] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for item := range seen {
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func latestLandingID(ctx context.Context, q interface {
	GetLatestLandingRequestForChange(context.Context, db.GetLatestLandingRequestForChangeParams) (db.LandingRequest, error)
}, repositoryID int64, changeID string) (int64, error) {
	row, err := q.GetLatestLandingRequestForChange(ctx, db.GetLatestLandingRequestForChangeParams{RepositoryID: repositoryID, ChangeID: changeID})
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return row.ID, nil
}
