package jobs

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCanonicalJSONPreservesExactNumbers(t *testing.T) {
	for _, value := range []string{
		`9007199254740993`,
		`9223372036854775807`,
		`0.12345678901234567890123456789`,
		`1e400`,
		`1e-400`,
	} {
		t.Run(value, func(t *testing.T) {
			encoded, err := canonicalJSON(json.RawMessage(`{"value":`+value+`}`), true)
			require.NoError(t, err)
			require.Equal(t, `{"value":`+value+`}`, string(encoded))
		})
	}
	for _, value := range []string{`{} {}`, `true false`, `{} invalid`} {
		_, err := canonicalJSON(json.RawMessage(value), false)
		require.Error(t, err, "trailing JSON must still be rejected")
	}
}

func TestAdmissionRejectsDistinctLargeIntegers(t *testing.T) {
	store := newTestStore(t)
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	_, err := store.Admit(t.Context(), testAdmission(scope, "large-id", EffectIdempotent, `{"id":9007199254740992}`))
	require.NoError(t, err)
	_, err = store.Admit(t.Context(), testAdmission(scope, "large-id", EffectIdempotent, `{"id":9007199254740993}`))
	require.ErrorIs(t, err, ErrPayloadConflict, "distinct exact integers must not join one request")
}

func TestAdmissionJoinsEquivalentNumberSpellings(t *testing.T) {
	for name, retry := range map[string]string{
		"ordinary":    `{"input":[1e3,0.0,1.50]}`,
		"signed-zero": `{"input":[1e3,-0,1.50]}`,
	} {
		t.Run(name, func(t *testing.T) {
			store := newTestStore(t)
			scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
			// This initial payload has the same fingerprint under the former
			// float decoder, so ordinary retries exercise existing receipts.
			first, err := store.Admit(t.Context(), testAdmission(scope, "equivalent", EffectIdempotent, `{"input":[1000,0,1.5]}`))
			require.NoError(t, err)
			joined, err := store.Admit(t.Context(), testAdmission(scope, "equivalent", EffectIdempotent, retry))
			require.NoError(t, err)
			require.True(t, joined.Joined)
			require.Equal(t, first.OperationID, joined.OperationID)
		})
	}
}

func TestExactNumbersSurviveJobStorageAndReplay(t *testing.T) {
	store := newTestStore(t)
	ctx := t.Context()
	scope := Scope{TenantID: "tenant", PrincipalID: "owner"}
	input := testAdmission(scope, "exact", EffectReconcile, `{"id":9007199254740993}`)
	input.AuthorizationContext = json.RawMessage(`{"userId":9223372036854775807}`)
	receipt, err := store.Admit(ctx, input)
	require.NoError(t, err)
	claim, err := store.Claim(ctx, "worker", time.Minute)
	require.NoError(t, err)
	require.Contains(t, string(claim.Payload), `9007199254740993`)
	require.Contains(t, string(claim.AuthorizationContext), `9223372036854775807`)
	observation := json.RawMessage(`{"providerId":9007199254740993}`)
	_, err = store.BeginExternal(ctx, claim, observation)
	require.NoError(t, err)
	checkpoint := json.RawMessage(`{"amount":0.12345678901234567890123456789}`)
	_, err = store.Checkpoint(ctx, claim, checkpoint)
	require.NoError(t, err)
	require.NoError(t, store.Complete(ctx, claim, observation))
	operation, err := store.Get(ctx, scope, receipt.OperationID)
	require.NoError(t, err)
	require.Contains(t, string(operation.ExternalReceipt), `0.12345678901234567890123456789`)
	require.Contains(t, string(operation.TerminalReceipt), `9007199254740993`)
	page, err := store.Replay(ctx, scope, 0, 100)
	require.NoError(t, err)
	require.Len(t, page.Events, 5)
	require.Contains(t, string(page.Events[2].Data), `9007199254740993`)
	require.Contains(t, string(page.Events[3].Data), `0.12345678901234567890123456789`)
	require.Contains(t, string(page.Events[4].Data), `9007199254740993`)
}
