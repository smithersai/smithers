package services

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// TestPairSession_Z_AcceptInviteGenericError covers acceptInvite's non-ErrNoRows
// error branch: when AcceptPairSessionInvite fails with a generic DB error (not a
// CAS-lost pgx.ErrNoRows), acceptInvite returns Internal without deferring to the
// race resolver.
func TestPairSession_Z_AcceptInviteGenericError(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
	_, err := s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
	require.NoError(t, err)

	svc, fake := s.errSvc()
	// Generic (non-ErrNoRows) accept failure -> line 593 Internal, not the racer.
	fake.acceptInviteFn = func() (db.PairSessionMember, error) {
		return db.PairSessionMember{}, errPairBoom
	}
	_, err = svc.ResolveSession(ctx, s.session.ID, s.stranger)
	assert.Equal(t, 500, httpStatus(err))
}

// TestPairSession_Z_AcceptedInviteRaceShareError covers resolveAcceptedInviteRace's
// ensureWorkspaceShare failure branch: the invite was already accepted by this
// visitor and the matching live member row is found, but re-granting the workspace
// share fails, so the resolver surfaces that error instead of resolving.
func TestPairSession_Z_AcceptedInviteRaceShareError(t *testing.T) {
	ctx := context.Background()
	s := newPairFSetup(t)

	strangerEmail := pairUserEmail(t, s.fx.pool, s.stranger)
	invRes, err := s.svc.CreateInvite(ctx, s.session.ID, s.owner, strangerEmail, PairRoleEditor)
	require.NoError(t, err)

	// Real accept: creates the member row (invited_via_invite_id set) and consumes
	// the invite so it is no longer live.
	_, err = s.svc.ResolveSession(ctx, s.session.ID, s.stranger)
	require.NoError(t, err)

	// Simulate the double-accept race with a share failure inside the resolver:
	// the accept CAS returns no rows, the JOIN membership probe misses (forcing the
	// invite path), and the consumed invite is re-surfaced so acceptInvite -> race
	// resolver runs; the matching member is then found but the share upsert fails.
	svc, fake := s.errSvc("UpsertWorkspaceShare")
	fake.acceptInviteFn = func() (db.PairSessionMember, error) {
		return db.PairSessionMember{}, pgx.ErrNoRows
	}
	fake.getMemberFn = func(call int, real db.PairSessionMember, realErr error) (db.PairSessionMember, error) {
		if call == 1 {
			return db.PairSessionMember{}, pgx.ErrNoRows // ResolveSession JOIN path miss
		}
		return real, realErr // inside race: real member with matching invite id
	}
	fake.getLiveInviteForEmailFn = func(_ db.PairSessionInvite, _ error) (db.PairSessionInvite, error) {
		return invRes.Invite, nil
	}
	_, err = svc.ResolveSession(ctx, s.session.ID, s.stranger)
	assert.Equal(t, 500, httpStatus(err))
}
