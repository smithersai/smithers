package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

func TestErasureRouteIsMountedAndRejectsMalformedProof(t *testing.T) {
	router := chi.NewRouter()
	(&Handler{Store: &Store{}}).MountPublic(router)
	if !router.Match(chi.NewRouteContext(), http.MethodPost, ErasePath) {
		t.Fatal("delete-only erasure route is missing")
	}
	for _, body := range []string{
		`{}`,
		`{"runId":"run","legId":"leg","retirementProof":"short"}`,
		`{"runId":"run","legId":"leg","retirementProof":"` + strings.Repeat("a", 64) + `","journal":{}}`,
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, ErasePath, strings.NewReader(body)))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("malformed proof: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestEraseDeletesAcceptedOutputAndRetainsOnlyTombstones(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	scope, runID, journal := testScope(), "erase-"+uuid.NewString(), testJournal()
	accepted := admit(t, store, scope, runID, journal)
	grant, err := store.Claim(ctx, scope, accepted.TurnID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Commit(ctx, CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token,
		Expected: grant.Cursor, Frames: []json.RawMessage{frame(runID, "private output"), done(runID, "stop")}})
	if err != nil {
		t.Fatal(err)
	}
	// The wire proof uses the journal domain separator, not raw SHA256.
	_, proof, err := authHashes(scope, journal.Token)
	if err != nil {
		t.Fatal(err)
	}
	readWithProof := journal
	readWithProof.Token = proof
	if _, err = store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: readWithProof}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete proof could read output: %v", err)
	}
	if err = store.Erase(ctx, runID, journal.LegID, strings.Repeat("0", 64)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("wrong proof = %v", err)
	}
	// A refused proof must leave the accepted request and output intact.
	page, err := store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal})
	if err != nil || len(page.Batches) != 1 {
		t.Fatalf("wrong proof changed turn: batches=%d err=%v", len(page.Batches), err)
	}
	router := chi.NewRouter()
	(&Handler{Store: store}).MountErasure(router)
	body, _ := json.Marshal(eraseRequest{RunID: runID, LegID: journal.LegID, RetirementProof: proof})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, ErasePath, strings.NewReader(string(body))))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"status":"retired"`) {
		t.Fatalf("signed-out erasure: %d %s", response.Code, response.Body.String())
	}
	if err = store.Erase(ctx, runID, journal.LegID, proof); err != nil {
		t.Fatalf("idempotent erase: %v", err)
	}
	var payload, acceptance, retirement []byte
	var state string
	var batchCount int
	err = store.pool.QueryRow(ctx, `SELECT request_payload,acceptance,retirement,state FROM chat_turns WHERE id=$1`, accepted.TurnID).Scan(&payload, &acceptance, &retirement, &state)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) != 0 || len(acceptance) != 0 || len(retirement) == 0 || state != "retired" {
		t.Fatalf("private bytes retained: payload=%d acceptance=%d retirement=%d state=%s", len(payload), len(acceptance), len(retirement), state)
	}
	if err = store.pool.QueryRow(ctx, `SELECT count(*) FROM chat_turn_batches WHERE turn_id=$1`, accepted.TurnID).Scan(&batchCount); err != nil {
		t.Fatal(err)
	}
	if batchCount != 0 {
		t.Fatalf("%d output batches retained", batchCount)
	}
	if _, err = store.Replay(ctx, ReplayInput{Scope: scope, RunID: runID, Journal: journal}); !errors.Is(err, ErrRetired) {
		t.Fatalf("replay after erasure = %v", err)
	}
	if _, err = store.Admit(ctx, AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: requestFor(runID)}); !errors.Is(err, ErrRetired) {
		t.Fatalf("acceptance after erasure = %v", err)
	}
}

func TestEraseBeforeAndDuringAcceptanceFencesRecreation(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	for attempt := 0; attempt < 12; attempt++ {
		scope, runID, journal := testScope(), "erase-race-"+uuid.NewString(), testJournal()
		_, proof, err := authHashes(scope, journal.Token)
		if err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			if err = store.Erase(ctx, runID, journal.LegID, proof); err != nil {
				t.Fatal(err)
			}
			if err = store.Erase(ctx, runID, journal.LegID, proof); err != nil {
				t.Fatalf("repeated preacceptance proof = %v", err)
			}
			if _, err = store.Admit(ctx, AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: requestFor(runID)}); !errors.Is(err, ErrRetired) {
				t.Fatalf("preacceptance erasure = %v", err)
			}
			other := journal
			other.Token = strings.Repeat("z", 64)
			if _, err = store.Admit(ctx, AdmitInput{Scope: scope, RunID: runID, Journal: other, Request: requestFor(runID)}); !errors.Is(err, ErrForbidden) {
				t.Fatalf("different proof accepted over tombstone: %v", err)
			}
			continue
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		var admitErr, eraseErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, admitErr = store.Admit(ctx, AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: requestFor(runID)})
		}()
		go func() { defer wg.Done(); <-start; eraseErr = store.Erase(ctx, runID, journal.LegID, proof) }()
		close(start)
		wg.Wait()
		if eraseErr != nil || (admitErr != nil && !errors.Is(admitErr, ErrRetired)) {
			t.Fatalf("race admit=%v erase=%v", admitErr, eraseErr)
		}
		if _, err = store.Admit(ctx, AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: requestFor(runID)}); !errors.Is(err, ErrRetired) {
			t.Fatalf("turn recreated after race: %v", err)
		}
		var live int
		if err = store.pool.QueryRow(ctx, `SELECT count(*) FROM chat_turns WHERE run_id=$1 AND leg_id=$2 AND state<>'retired'`, runID, journal.LegID).Scan(&live); err != nil {
			t.Fatal(err)
		}
		if live != 0 {
			t.Fatalf("%d live turns after erasure", live)
		}
	}
}

func TestUnknownIdentityFirstProofReservesIt(t *testing.T) {
	store := needStore(t)
	ctx := context.Background()
	scope, runID, journal := testScope(), "erase-first-proof-"+uuid.NewString(), testJournal()
	if err := store.Erase(ctx, runID, journal.LegID, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	if err := store.Erase(ctx, runID, journal.LegID, strings.Repeat("1", 64)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("second proof = %v", err)
	}
	if _, err := store.Admit(ctx, AdmitInput{Scope: scope, RunID: runID, Journal: journal, Request: requestFor(runID)}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("admission over another proof's preacceptance tombstone = %v", err)
	}
}
