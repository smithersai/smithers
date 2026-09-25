package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The monitoring snapshot of GET /api/repos/{owner}/{repo}/mythical. Field
// names and shapes are @smthrs/rpc/Mythical's MythicalStackSchema exactly.

type MythicalStackView struct {
	Repository string               `json:"repository"`
	State      string               `json:"state"`
	Reason     string               `json:"reason,omitempty"`
	Generation int64                `json:"generation"`
	Tip        *MythicalTipView     `json:"tip,omitempty"`
	LandedMain string               `json:"landedMain,omitempty"`
	MainBehind bool                 `json:"mainBehind"`
	Changes    []MythicalChangeView `json:"changes"`
	Items      []MythicalItemView   `json:"items"`
	Lanes      []MythicalLaneView   `json:"lanes"`
	Limits     MythicalLimitsView   `json:"limits"`
	UpdatedAt  string               `json:"updatedAt,omitempty"`
}

type MythicalTipView struct {
	ChangeID string `json:"changeId"`
	CommitID string `json:"commitId"`
}

type MythicalChangeView struct {
	ChangeID    string `json:"changeId"`
	CommitID    string `json:"commitId"`
	Title       string `json:"title"`
	Kind        string `json:"kind"`
	State       string `json:"state"`
	ItemID      string `json:"itemId,omitempty"`
	Issue       int64  `json:"issue,omitempty"`
	Predecessor string `json:"predecessor,omitempty"`
}

type MythicalIssueView struct {
	Number int64  `json:"number"`
	Title  string `json:"title"`
	URL    string `json:"url"`
}

type MythicalRunsView struct {
	Request string `json:"request,omitempty"`
	Vibe    string `json:"vibe,omitempty"`
	Verify  string `json:"verify,omitempty"`
}

type MythicalPullRequestView struct {
	Number int64  `json:"number"`
	URL    string `json:"url"`
	State  string `json:"state"`
}

type MythicalItemView struct {
	ID          string                   `json:"id"`
	Issue       *MythicalIssueView       `json:"issue,omitempty"`
	State       string                   `json:"state"`
	Reason      string                   `json:"reason,omitempty"`
	Attempt     int32                    `json:"attempt"`
	Lane        *int32                   `json:"lane,omitempty"`
	Runs        MythicalRunsView         `json:"runs"`
	Plan        json.RawMessage          `json:"plan,omitempty"`
	Integration json.RawMessage          `json:"integration,omitempty"`
	Checks      json.RawMessage          `json:"checks,omitempty"`
	PullRequest *MythicalPullRequestView `json:"pullRequest,omitempty"`
	DependsOn   []string                 `json:"dependsOn"`
	UpdatedAt   string                   `json:"updatedAt"`
}

type MythicalLaneView struct {
	Index       int32  `json:"index"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	ItemID      string `json:"itemId,omitempty"`
	State       string `json:"state"`
}

type MythicalLimitsView struct {
	MaxParallel int32 `json:"maxParallel"`
}

// Snapshot reads the repository's stack for the monitoring UI. mainCommit is
// the repository's current main commit when the caller knows it ("" skips
// the behind check). A repository without a stack is `absent`, not an error.
func (s *MythicalService) Snapshot(ctx context.Context, repositoryID int64, slug, mainCommit string) (MythicalStackView, error) {
	view := MythicalStackView{Repository: slug, State: "absent", Changes: []MythicalChangeView{}, Items: []MythicalItemView{},
		Lanes: []MythicalLaneView{}, Limits: MythicalLimitsView{MaxParallel: 2}}
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if errors.Is(err, pgx.ErrNoRows) {
		return view, nil
	}
	if err != nil {
		return view, err
	}
	view.State, view.Reason, view.Generation, view.LandedMain = stack.State, stack.Reason, stack.Generation, stack.LandedMain
	view.Limits.MaxParallel = stack.MaxParallel
	if stack.TipCommit != "" {
		view.Tip = &MythicalTipView{ChangeID: stack.TipChange, CommitID: stack.TipCommit}
	}
	view.MainBehind = mainCommit != "" && stack.LandedMain != "" && mainCommit != stack.LandedMain
	if stack.UpdatedAt.Valid {
		view.UpdatedAt = stack.UpdatedAt.Time.UTC().Format(time.RFC3339)
	}
	changes, err := q.ListRecentMythicalChanges(ctx, repositoryID, mythicalRecentChanges)
	if err != nil {
		return view, err
	}
	for _, change := range changes {
		row := MythicalChangeView{ChangeID: change.ChangeID, CommitID: change.CommitID, Title: change.Title, Kind: change.Kind,
			State: "landed", Predecessor: change.Predecessor}
		if change.ItemID.Valid {
			row.ItemID = uuidString(change.ItemID)
		}
		if change.IssueNumber.Valid {
			row.Issue = change.IssueNumber.Int64
		}
		view.Changes = append(view.Changes, row)
	}
	items, err := q.ListMythicalItems(ctx, repositoryID, 500)
	if err != nil {
		return view, err
	}
	lanes := map[int32]MythicalLaneView{}
	for _, item := range items {
		row := mythicalItemView(item)
		view.Items = append(view.Items, row)
		if row.Lane != nil && !mythicalSettled(item.State) {
			lanes[*row.Lane] = MythicalLaneView{Index: *row.Lane, WorkspaceID: item.WorkspaceID, ItemID: row.ID, State: "busy"}
		}
	}
	for index := int32(0); index < stack.MaxParallel; index++ {
		lane, ok := lanes[index]
		if !ok {
			lane = MythicalLaneView{Index: index, State: "idle"}
		}
		view.Lanes = append(view.Lanes, lane)
	}
	return view, nil
}

func mythicalSettled(state string) bool {
	switch state {
	case "skipped", "cancelled", "landed", "rejected", "blocked":
		return true
	}
	return false
}

func mythicalItemView(item db.MythicalItem) MythicalItemView {
	row := MythicalItemView{ID: uuidString(item.ID), State: item.State, Reason: item.Reason, Attempt: item.Attempt,
		Runs: MythicalRunsView{Request: item.RequestRunID, Vibe: item.VibeRunID, Verify: item.VerifyRunID},
		Plan: item.Plan, Integration: item.Integration, Checks: item.Checks, DependsOn: []string{}}
	if item.IssueNumber.Valid {
		row.Issue = &MythicalIssueView{Number: item.IssueNumber.Int64, Title: item.IssueTitle, URL: item.IssueURL}
	}
	if item.Lane.Valid {
		lane := item.Lane.Int32
		row.Lane = &lane
	}
	if item.PRNumber.Valid && item.PRURL != "" {
		state := item.PRState
		if state != "open" && state != "closed" && state != "merged" {
			state = "open"
		}
		row.PullRequest = &MythicalPullRequestView{Number: item.PRNumber.Int64, URL: item.PRURL, State: state}
	}
	if item.UpdatedAt.Valid {
		row.UpdatedAt = item.UpdatedAt.Time.UTC().Format(time.RFC3339)
	}
	return row
}
