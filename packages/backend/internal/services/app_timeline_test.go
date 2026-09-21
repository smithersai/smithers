package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const testTimelineID = "5f0c2a3e-9d61-4a7b-8f28-3f4a1c9be0d7"

// fakeAppTimelineStore is an in-memory AppTimelineStore. No txBeginner is
// wired in tests, so writes run unserialized against these maps — the exact
// fallback path the service documents for store-only doubles.
type fakeAppTimelineStore struct {
	timelines map[string]db.AppTimeline
	members   map[[2]any]db.AppTimelineMember
	events    map[[2]any]db.AppTimelineEvent
	branches  map[[2]any]db.AppTimelineBranch
	snapshots map[[2]any]db.AppTimelineSnapshot
	users     map[string]db.User

	// createLoses simulates losing the find-or-create race: CreateAppTimeline
	// returns ErrNoRows (partial-unique conflict swallowed the insert) while
	// the "winner" row is already in timelines.
	createLoses bool
}

func newFakeAppTimelineStore() *fakeAppTimelineStore {
	return &fakeAppTimelineStore{
		timelines: map[string]db.AppTimeline{},
		members:   map[[2]any]db.AppTimelineMember{},
		events:    map[[2]any]db.AppTimelineEvent{},
		branches:  map[[2]any]db.AppTimelineBranch{},
		snapshots: map[[2]any]db.AppTimelineSnapshot{},
		users:     map[string]db.User{},
	}
}

func (f *fakeAppTimelineStore) CreateAppTimeline(_ context.Context, arg db.CreateAppTimelineParams) (db.AppTimeline, error) {
	if f.createLoses {
		return db.AppTimeline{}, pgx.ErrNoRows
	}
	for _, t := range f.timelines {
		if t.OwnerUserID == arg.OwnerUserID && t.ClientKey == arg.ClientKey {
			return db.AppTimeline{}, pgx.ErrNoRows
		}
	}
	t := db.AppTimeline{ID: testTimelineID, OwnerUserID: arg.OwnerUserID, ClientKey: arg.ClientKey, Version: 1}
	f.timelines[t.ID] = t
	return t, nil
}

func (f *fakeAppTimelineStore) GetAppTimeline(_ context.Context, id string) (db.AppTimeline, error) {
	if t, ok := f.timelines[id]; ok {
		return t, nil
	}
	return db.AppTimeline{}, pgx.ErrNoRows
}

func (f *fakeAppTimelineStore) GetAppTimelineByOwnerClientKey(_ context.Context, arg db.GetAppTimelineByOwnerClientKeyParams) (db.AppTimeline, error) {
	for _, t := range f.timelines {
		if t.OwnerUserID == arg.OwnerUserID && t.ClientKey == arg.ClientKey {
			return t, nil
		}
	}
	return db.AppTimeline{}, pgx.ErrNoRows
}

func (f *fakeAppTimelineStore) CountAppTimelinesForOwner(_ context.Context, ownerUserID int64) (int64, error) {
	var n int64
	for _, t := range f.timelines {
		if t.OwnerUserID == ownerUserID {
			n++
		}
	}
	return n, nil
}

func (f *fakeAppTimelineStore) TouchAppTimeline(_ context.Context, arg db.TouchAppTimelineParams) (db.AppTimeline, error) {
	t, ok := f.timelines[arg.ID]
	if !ok {
		return db.AppTimeline{}, pgx.ErrNoRows
	}
	t.HeadSeq = arg.HeadSeq
	f.timelines[arg.ID] = t
	return t, nil
}

func (f *fakeAppTimelineStore) UpsertAppTimelineMember(_ context.Context, arg db.UpsertAppTimelineMemberParams) (db.AppTimelineMember, error) {
	key := [2]any{arg.TimelineID, arg.UserID}
	if existing, ok := f.members[key]; ok && existing.RemovedAt.Valid {
		return db.AppTimelineMember{}, pgx.ErrNoRows // never resurrect
	}
	m := db.AppTimelineMember{TimelineID: arg.TimelineID, UserID: arg.UserID, Role: arg.Role}
	f.members[key] = m
	return m, nil
}

func (f *fakeAppTimelineStore) ReAddAppTimelineMember(_ context.Context, arg db.ReAddAppTimelineMemberParams) (db.AppTimelineMember, error) {
	m := db.AppTimelineMember{TimelineID: arg.TimelineID, UserID: arg.UserID, Role: arg.Role}
	f.members[[2]any{arg.TimelineID, arg.UserID}] = m
	return m, nil
}

func (f *fakeAppTimelineStore) GetLiveAppTimelineMember(_ context.Context, arg db.GetLiveAppTimelineMemberParams) (db.AppTimelineMember, error) {
	if m, ok := f.members[[2]any{arg.TimelineID, arg.UserID}]; ok && !m.RemovedAt.Valid {
		return m, nil
	}
	return db.AppTimelineMember{}, pgx.ErrNoRows
}

func (f *fakeAppTimelineStore) ListLiveAppTimelineMemberProfiles(_ context.Context, timelineID string) ([]db.ListLiveAppTimelineMemberProfilesRow, error) {
	var rows []db.ListLiveAppTimelineMemberProfilesRow
	for _, m := range f.members {
		if m.TimelineID == timelineID && !m.RemovedAt.Valid {
			rows = append(rows, db.ListLiveAppTimelineMemberProfilesRow{
				TimelineID: m.TimelineID, UserID: m.UserID, Role: m.Role,
			})
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].UserID < rows[j].UserID })
	return rows, nil
}

func (f *fakeAppTimelineStore) RevokeAppTimelineMember(_ context.Context, arg db.RevokeAppTimelineMemberParams) (db.AppTimelineMember, error) {
	key := [2]any{arg.TimelineID, arg.UserID}
	m, ok := f.members[key]
	if !ok || m.RemovedAt.Valid || m.Role == "owner" {
		return db.AppTimelineMember{}, pgx.ErrNoRows
	}
	m.RemovedAt.Valid = true
	f.members[key] = m
	return m, nil
}

func (f *fakeAppTimelineStore) InsertAppTimelineEvent(_ context.Context, arg db.InsertAppTimelineEventParams) (db.AppTimelineEvent, error) {
	ev := db.AppTimelineEvent{TimelineID: arg.TimelineID, Seq: arg.Seq, Payload: arg.Payload}
	f.events[[2]any{arg.TimelineID, arg.Seq}] = ev
	return ev, nil
}

func (f *fakeAppTimelineStore) DeleteAppTimelineEventsFrom(_ context.Context, arg db.DeleteAppTimelineEventsFromParams) error {
	for key, ev := range f.events {
		if ev.TimelineID == arg.TimelineID && ev.Seq >= arg.Seq {
			delete(f.events, key)
		}
	}
	return nil
}

func (f *fakeAppTimelineStore) DeleteAllAppTimelineEvents(_ context.Context, timelineID string) error {
	for key, ev := range f.events {
		if ev.TimelineID == timelineID {
			delete(f.events, key)
		}
	}
	return nil
}

func (f *fakeAppTimelineStore) InsertAppTimelineBranch(_ context.Context, arg db.InsertAppTimelineBranchParams) (db.AppTimelineBranch, error) {
	b := db.AppTimelineBranch{TimelineID: arg.TimelineID, Ordinal: arg.Ordinal, FromSeq: arg.FromSeq, Events: arg.Events}
	f.branches[[2]any{arg.TimelineID, arg.Ordinal}] = b
	return b, nil
}

func (f *fakeAppTimelineStore) DeleteAllAppTimelineBranches(_ context.Context, timelineID string) error {
	for key, b := range f.branches {
		if b.TimelineID == timelineID {
			delete(f.branches, key)
		}
	}
	return nil
}

func (f *fakeAppTimelineStore) UpsertAppTimelineSnapshot(_ context.Context, arg db.UpsertAppTimelineSnapshotParams) (db.AppTimelineSnapshot, error) {
	s := db.AppTimelineSnapshot{TimelineID: arg.TimelineID, Seq: arg.Seq, State: arg.State}
	f.snapshots[[2]any{arg.TimelineID, arg.Seq}] = s
	return s, nil
}

func (f *fakeAppTimelineStore) DeleteAppTimelineSnapshotsFrom(_ context.Context, arg db.DeleteAppTimelineSnapshotsFromParams) error {
	for key, s := range f.snapshots {
		if s.TimelineID == arg.TimelineID && s.Seq > arg.Seq {
			delete(f.snapshots, key)
		}
	}
	return nil
}

func (f *fakeAppTimelineStore) DeleteAllAppTimelineSnapshots(_ context.Context, timelineID string) error {
	for key, s := range f.snapshots {
		if s.TimelineID == timelineID {
			delete(f.snapshots, key)
		}
	}
	return nil
}

func (f *fakeAppTimelineStore) PruneAppTimelineSnapshots(_ context.Context, arg db.PruneAppTimelineSnapshotsParams) error {
	var seqs []int64
	for _, s := range f.snapshots {
		if s.TimelineID == arg.TimelineID {
			seqs = append(seqs, s.Seq)
		}
	}
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] > seqs[j] })
	if len(seqs) <= int(arg.KeepCount) {
		return nil
	}
	for _, seq := range seqs[arg.KeepCount:] {
		delete(f.snapshots, [2]any{arg.TimelineID, seq})
	}
	return nil
}

func (f *fakeAppTimelineStore) GetUserByLowerUsername(_ context.Context, lowerUsername string) (db.User, error) {
	if u, ok := f.users[lowerUsername]; ok {
		return u, nil
	}
	return db.User{}, pgx.ErrNoRows
}

// seededTimelineStore returns a store with a live timeline owned by user 1
// (head at headSeq) and user 2 as an editor member.
func seededTimelineStore(headSeq int64) *fakeAppTimelineStore {
	f := newFakeAppTimelineStore()
	f.timelines[testTimelineID] = db.AppTimeline{ID: testTimelineID, OwnerUserID: 1, ClientKey: "default", Version: 1, HeadSeq: headSeq}
	f.members[[2]any{testTimelineID, int64(1)}] = db.AppTimelineMember{TimelineID: testTimelineID, UserID: 1, Role: "owner"}
	f.members[[2]any{testTimelineID, int64(2)}] = db.AppTimelineMember{TimelineID: testTimelineID, UserID: 2, Role: "editor"}
	return f
}

func wantStatus(t *testing.T, err error, status int) {
	t.Helper()
	var apiErr *pkgerrors.APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError with status %d, got %v", status, err)
	}
	if apiErr.Status != status {
		t.Fatalf("expected status %d, got %d (%s)", status, apiErr.Status, apiErr.Message)
	}
}

func rawEvents(payloads ...string) []AppTimelineEventWrite {
	out := make([]AppTimelineEventWrite, len(payloads))
	for i, p := range payloads {
		out[i] = AppTimelineEventWrite{Seq: int64(i), Payload: json.RawMessage(p)}
	}
	return out
}

func TestAppTimeline_FindOrCreate_MintsTimelineAndOwnerMember(t *testing.T) {
	f := newFakeAppTimelineStore()
	s := NewAppTimelineService(f)

	res, err := s.FindOrCreate(context.Background(), 1, "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !res.Created || res.Role != AppTimelineRoleOwner || res.Timeline.ClientKey != "default" {
		t.Fatalf("unexpected resolution: %+v", res)
	}
	if _, ok := f.members[[2]any{res.Timeline.ID, int64(1)}]; !ok {
		t.Fatalf("owner member row not recorded")
	}

	// Second call finds the same timeline.
	again, err := s.FindOrCreate(context.Background(), 1, "default")
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if again.Created || again.Timeline.ID != res.Timeline.ID {
		t.Fatalf("expected find of existing timeline, got %+v", again)
	}
}

func TestAppTimeline_FindOrCreate_LostRaceRereads(t *testing.T) {
	f := newFakeAppTimelineStore()
	s := NewAppTimelineService(f)

	// The winner's row exists, but this process's insert is swallowed by the
	// partial-unique conflict target.
	f.timelines[testTimelineID] = db.AppTimeline{ID: testTimelineID, OwnerUserID: 1, ClientKey: "fresh", Version: 1}
	f.createLoses = true
	// Force the create path by asking for a key the pre-seeded Get misses on
	// first read: delete then re-add inside the fake is overkill — instead ask
	// for the seeded key from a store whose Get works; simulate the race by
	// having Create lose while Get succeeds on the re-read.
	res, err := s.FindOrCreate(context.Background(), 1, "fresh")
	if err != nil {
		t.Fatalf("lost race should re-read the winner: %v", err)
	}
	if res.Created || res.Timeline.ID != testTimelineID {
		t.Fatalf("expected the winner's row, got %+v", res)
	}
}

func TestAppTimeline_FindOrCreate_QuotaEnforced(t *testing.T) {
	f := newFakeAppTimelineStore()
	s := NewAppTimelineService(f)
	for i := 0; i < MaxAppTimelinesPerOwner; i++ {
		f.timelines[strings.Repeat("x", 3)+string(rune('a'+i))] = db.AppTimeline{
			ID: "t" + string(rune('a'+i)), OwnerUserID: 1, ClientKey: "k" + string(rune('a'+i)),
		}
	}
	_, err := s.FindOrCreate(context.Background(), 1, "one-too-many")
	if err == nil {
		t.Fatalf("expected quota error")
	}
	wantStatus(t, err, http.StatusTooManyRequests)
}

func TestAppTimeline_Get_RolesAndUniformNotFound(t *testing.T) {
	f := seededTimelineStore(0)
	s := NewAppTimelineService(f)

	owner, err := s.Get(context.Background(), 1, testTimelineID)
	if err != nil || owner.Role != AppTimelineRoleOwner {
		t.Fatalf("owner resolve: %+v err=%v", owner, err)
	}
	member, err := s.Get(context.Background(), 2, testTimelineID)
	if err != nil || member.Role != AppTimelineRoleEditor {
		t.Fatalf("member resolve: %+v err=%v", member, err)
	}
	// Non-member and unknown timeline are the SAME 404 (no existence oracle).
	_, err = s.Get(context.Background(), 3, testTimelineID)
	wantStatus(t, err, http.StatusNotFound)
	_, err = s.Get(context.Background(), 1, "11111111-2222-4333-8444-555555555555")
	wantStatus(t, err, http.StatusNotFound)
}

func TestAppTimeline_AppendEvents_HappyPathTruncatesAndAdvancesHead(t *testing.T) {
	f := seededTimelineStore(5)
	// Seed the tail that the fork-overwrite must truncate, plus snapshots on
	// both sides of the boundary.
	for seq := int64(0); seq < 5; seq++ {
		f.events[[2]any{testTimelineID, seq}] = db.AppTimelineEvent{TimelineID: testTimelineID, Seq: seq, Payload: json.RawMessage(`{"old":true}`)}
	}
	f.snapshots[[2]any{testTimelineID, int64(3)}] = db.AppTimelineSnapshot{TimelineID: testTimelineID, Seq: 3}
	f.snapshots[[2]any{testTimelineID, int64(5)}] = db.AppTimelineSnapshot{TimelineID: testTimelineID, Seq: 5}
	s := NewAppTimelineService(f)

	events := []AppTimelineEventWrite{
		{Seq: 3, Payload: json.RawMessage(`{"type":"chat.user"}`)},
		{Seq: 4, Payload: json.RawMessage(`{"type":"chat.agent"}`)},
	}
	if err := s.AppendEvents(context.Background(), 2, testTimelineID, events); err != nil {
		t.Fatalf("append: %v", err)
	}
	if got := f.timelines[testTimelineID].HeadSeq; got != 5 {
		t.Fatalf("head_seq: got %d want 5", got)
	}
	// Events 0..2 survive, 3..4 rewritten, nothing beyond.
	if _, ok := f.events[[2]any{testTimelineID, int64(2)}]; !ok {
		t.Fatalf("prefix event dropped")
	}
	if string(f.events[[2]any{testTimelineID, int64(3)}].Payload) != `{"type":"chat.user"}` {
		t.Fatalf("boundary event not rewritten")
	}
	// Snapshot at the boundary (3) survives; the one past it (5) is gone.
	if _, ok := f.snapshots[[2]any{testTimelineID, int64(3)}]; !ok {
		t.Fatalf("boundary snapshot must survive")
	}
	if _, ok := f.snapshots[[2]any{testTimelineID, int64(5)}]; ok {
		t.Fatalf("stale snapshot past the boundary must be invalidated")
	}
}

func TestAppTimeline_AppendEvents_Validation(t *testing.T) {
	s := NewAppTimelineService(seededTimelineStore(2))
	ctx := context.Background()

	// Empty batch.
	err := s.AppendEvents(ctx, 1, testTimelineID, nil)
	wantStatus(t, err, http.StatusBadRequest)

	// Non-contiguous seqs.
	err = s.AppendEvents(ctx, 1, testTimelineID, []AppTimelineEventWrite{
		{Seq: 0, Payload: json.RawMessage(`{}`)},
		{Seq: 2, Payload: json.RawMessage(`{}`)},
	})
	wantStatus(t, err, http.StatusBadRequest)

	// Invalid JSON payload.
	err = s.AppendEvents(ctx, 1, testTimelineID, []AppTimelineEventWrite{{Seq: 0, Payload: json.RawMessage(`{nope`)}})
	wantStatus(t, err, http.StatusBadRequest)

	// Oversized payload.
	big := `{"pad":"` + strings.Repeat("x", MaxAppTimelineEventBytes) + `"}`
	err = s.AppendEvents(ctx, 1, testTimelineID, []AppTimelineEventWrite{{Seq: 0, Payload: json.RawMessage(big)}})
	wantStatus(t, err, http.StatusBadRequest)

	// Gap beyond head → 409.
	err = s.AppendEvents(ctx, 1, testTimelineID, []AppTimelineEventWrite{{Seq: 7, Payload: json.RawMessage(`{}`)}})
	wantStatus(t, err, http.StatusConflict)
}

func TestAppTimeline_AppendEvents_ViewerForbidden(t *testing.T) {
	f := seededTimelineStore(0)
	f.members[[2]any{testTimelineID, int64(2)}] = db.AppTimelineMember{TimelineID: testTimelineID, UserID: 2, Role: "viewer"}
	s := NewAppTimelineService(f)

	err := s.AppendEvents(context.Background(), 2, testTimelineID, rawEvents(`{}`))
	wantStatus(t, err, http.StatusForbidden)
}

func TestAppTimeline_Rewrite_ReplacesLogPositionally(t *testing.T) {
	f := seededTimelineStore(3)
	for seq := int64(0); seq < 3; seq++ {
		f.events[[2]any{testTimelineID, seq}] = db.AppTimelineEvent{TimelineID: testTimelineID, Seq: seq, Payload: json.RawMessage(`{"old":true}`)}
	}
	f.snapshots[[2]any{testTimelineID, int64(2)}] = db.AppTimelineSnapshot{TimelineID: testTimelineID, Seq: 2}
	s := NewAppTimelineService(f)

	dump := AppTimelineDump{
		Version: 1,
		Events:  []json.RawMessage{json.RawMessage(`{"a":1}`), json.RawMessage(`{"b":2}`)},
		Branches: []AppTimelineBranchWrite{
			{FromSeq: 1, Events: []json.RawMessage{json.RawMessage(`{"sealed":true}`)}},
		},
	}
	if err := s.Rewrite(context.Background(), 1, testTimelineID, dump); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if got := f.timelines[testTimelineID].HeadSeq; got != 2 {
		t.Fatalf("head_seq: got %d want 2", got)
	}
	if len(f.events) != 2 || len(f.branches) != 1 || len(f.snapshots) != 0 {
		t.Fatalf("tables not rewritten: events=%d branches=%d snapshots=%d", len(f.events), len(f.branches), len(f.snapshots))
	}
}

func TestAppTimeline_Rewrite_VersionGate(t *testing.T) {
	s := NewAppTimelineService(seededTimelineStore(0))
	err := s.Rewrite(context.Background(), 1, testTimelineID, AppTimelineDump{Version: 2})
	wantStatus(t, err, http.StatusBadRequest)
}

func TestAppTimeline_PutSnapshot_UpsertsAndPrunes(t *testing.T) {
	f := seededTimelineStore(100)
	s := NewAppTimelineService(f)
	ctx := context.Background()

	for seq := int64(0); seq <= 20; seq += 2 {
		if err := s.PutSnapshot(ctx, 1, testTimelineID, seq, json.RawMessage(`{"value":"chat"}`)); err != nil {
			t.Fatalf("snapshot at %d: %v", seq, err)
		}
	}
	if len(f.snapshots) != AppTimelineSnapshotKeep {
		t.Fatalf("snapshots not pruned: %d", len(f.snapshots))
	}
	// Ahead of head → 409.
	err := s.PutSnapshot(ctx, 1, testTimelineID, 101, json.RawMessage(`{}`))
	wantStatus(t, err, http.StatusConflict)
}

func TestAppTimeline_MemberManagement(t *testing.T) {
	f := seededTimelineStore(0)
	f.users["bob"] = db.User{ID: 3, Username: "bob", LowerUsername: "bob"}
	s := NewAppTimelineService(f)
	ctx := context.Background()

	// Non-owner cannot manage members.
	_, err := s.AddMember(ctx, 2, testTimelineID, "bob", "editor")
	wantStatus(t, err, http.StatusForbidden)

	// Bad role.
	_, err = s.AddMember(ctx, 1, testTimelineID, "bob", "owner")
	wantStatus(t, err, http.StatusBadRequest)

	// Unknown user.
	_, err = s.AddMember(ctx, 1, testTimelineID, "ghost", "editor")
	wantStatus(t, err, http.StatusNotFound)

	// Happy path.
	member, err := s.AddMember(ctx, 1, testTimelineID, "Bob", "viewer")
	if err != nil || member.UserID != 3 || member.Role != "viewer" {
		t.Fatalf("add member: %+v err=%v", member, err)
	}

	// Members listing visible to any member.
	members, err := s.Members(ctx, 3, testTimelineID)
	if err != nil || len(members) != 3 {
		t.Fatalf("members: %d err=%v", len(members), err)
	}

	// Remove (owner only; owner row irrevocable).
	if err := s.RemoveMember(ctx, 1, testTimelineID, 3); err != nil {
		t.Fatalf("remove member: %v", err)
	}
	err = s.RemoveMember(ctx, 1, testTimelineID, 1)
	wantStatus(t, err, http.StatusNotFound)
}
