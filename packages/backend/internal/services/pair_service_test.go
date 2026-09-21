package services

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestPairLandingDiffGate(t *testing.T) {
	tests := []struct {
		name          string
		workspaceDiff string
		roomDiff      string
		wantBlocked   bool
		wantMessage   string
	}{
		{
			name:          "blocks room overlay even with workspace changes",
			workspaceDiff: "diff --git a/app.go b/app.go\n",
			roomDiff:      "diff --git a/shared.md b/shared.md\n",
			wantBlocked:   true,
			wantMessage:   pairRoomEditsNotAppliedMessage,
		},
		{
			name:        "blocks room overlay without workspace changes",
			roomDiff:    "diff --git a/shared.md b/shared.md\n",
			wantBlocked: true,
			wantMessage: pairRoomEditsNotAppliedMessage,
		},
		{
			name:        "blocks empty workspace",
			wantBlocked: true,
			wantMessage: "No working-tree changes are available to land.",
		},
		{
			name:          "allows workspace-only changes",
			workspaceDiff: "diff --git a/app.go b/app.go\n",
			wantBlocked:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, blocked := pairLandingDiffGate(tt.workspaceDiff, tt.roomDiff)
			if blocked != tt.wantBlocked {
				t.Fatalf("blocked = %v, want %v", blocked, tt.wantBlocked)
			}
			if result.Message != tt.wantMessage {
				t.Fatalf("message = %q, want %q", result.Message, tt.wantMessage)
			}
		})
	}
}

func TestNewPairService_NilLandingStaysNil(t *testing.T) {
	svc := NewPairService(nil, nil, nil)
	if svc.landing != nil {
		t.Fatalf("landing interface = %#v, want nil", svc.landing)
	}
}

type mockPairQuerier struct {
	user      db.User
	stateJSON json.RawMessage
}

func (m mockPairQuerier) GetPairState(ctx context.Context, roomID string) (db.GetPairStateRow, error) {
	if len(m.stateJSON) == 0 {
		return db.GetPairStateRow{}, pgx.ErrNoRows
	}
	return db.GetPairStateRow{State: m.stateJSON, Version: 1}, nil
}

func (m mockPairQuerier) GetUserByID(ctx context.Context, id int64) (db.User, error) {
	if m.user.ID != 0 {
		return m.user, nil
	}
	return db.User{ID: id, Username: "pair-actor", LowerUsername: "pair-actor"}, nil
}

type mockPairLandingCreator struct {
	called bool
}

func (m *mockPairLandingCreator) CreateLandingRequest(ctx context.Context, actor *db.User, owner, repo string, req CreateLandingRequestInput) (LandingRequestResponse, error) {
	m.called = true
	return LandingRequestResponse{Number: 1}, nil
}

func TestPairServiceCreateLandingRequest_BlocksMixedRoomOverlayBeforeLandingBackend(t *testing.T) {
	root := t.TempDir()
	requireGitRepo(t, root)

	if err := os.WriteFile(filepath.Join(root, "app.go"), []byte("package main\n\nfunc main() {}\n"), 0o644); err != nil {
		t.Fatalf("write tracked file: %v", err)
	}
	runGit(t, root, "add", "app.go")
	runGit(t, root, "-c", "user.email=pair@example.com", "-c", "user.name=Pair Test", "commit", "-m", "initial")
	if err := os.WriteFile(filepath.Join(root, "app.go"), []byte("package main\n\nfunc main() { println(\"changed\") }\n"), 0o644); err != nil {
		t.Fatalf("modify tracked file: %v", err)
	}

	roomState := newPairRoomState()
	roomState.Files["room-only.md"] = pairFile{Content: "visible room edit\n", Version: 1, UpdatedBy: "test"}
	raw, err := json.Marshal(roomState)
	if err != nil {
		t.Fatalf("marshal room state: %v", err)
	}

	landing := &mockPairLandingCreator{}
	svc := &PairService{
		q:       mockPairQuerier{stateJSON: raw},
		landing: landing,
		repoDir: root,
	}
	t.Setenv("SMITHERS_PAIR_LANDING_ACTOR_ID", "42")

	result, err := svc.CreateLandingRequest(context.Background(), "room-a")
	if err != nil {
		t.Fatalf("CreateLandingRequest returned error: %v", err)
	}
	if result.Message != pairRoomEditsNotAppliedMessage {
		t.Fatalf("message = %q, want %q", result.Message, pairRoomEditsNotAppliedMessage)
	}
	if landing.called {
		t.Fatalf("landing backend was called even though Pair room-state edits were not materialized")
	}
}

func requireGitRepo(t *testing.T, root string) {
	t.Helper()
	runGit(t, root, "init", "-b", "main")
}

func runGit(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}
