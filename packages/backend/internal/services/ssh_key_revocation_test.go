package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/revocation"
)

// failingPublisher simulates a revocation store that is down.
type failingPublisher struct{ calls int }

func (p *failingPublisher) Publish(context.Context, revocation.Event) error {
	p.calls++
	return errors.New("revocation store unavailable")
}

func sshKeyDeleteQuerier(owner int64, deleteErr error) mockSSHKeyQuerier {
	return mockSSHKeyQuerier{
		getSSHKeyByIDFn: func(_ context.Context, id int64) (db.SshKey, error) {
			return db.SshKey{ID: id, UserID: owner, Fingerprint: "SHA256:user-key"}, nil
		},
		deleteSSHKeyFn: func(context.Context, db.DeleteSSHKeyParams) error { return deleteErr },
	}
}

func TestSSHKeyService_DeleteKeyPublishesKeyRevocation(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	svc := NewSSHKeyService(sshKeyDeleteQuerier(42, nil))
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.DeleteKey(context.Background(), 42, 7))
	events := publisher.all()
	require.Len(t, events, 1)
	require.Equal(t, revocation.KindSSHKeyRevoked, events[0].Kind)
	require.Equal(t, int64(42), events[0].UserID)
	require.Equal(t, int64(42), events[0].ActorID)
	require.Equal(t, "SHA256:user-key", events[0].KeyFingerprint)
	require.True(t, events[0].Affects(revocation.Principal{UserID: 42, KeyFingerprint: "SHA256:user-key"}))
	require.False(t, events[0].Affects(revocation.Principal{UserID: 42, KeyFingerprint: "SHA256:other-key"}))
}

func TestSSHKeyService_DeleteKeyDoesNotPublishOnFailure(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	svc := NewSSHKeyService(sshKeyDeleteQuerier(42, errors.New("db down")))
	svc.SetRevocationPublisher(publisher)
	require.Error(t, svc.DeleteKey(context.Background(), 42, 7))
	require.Empty(t, publisher.all())

	other := NewSSHKeyService(sshKeyDeleteQuerier(99, nil))
	other.SetRevocationPublisher(publisher)
	require.Error(t, other.DeleteKey(context.Background(), 42, 7))
	require.Empty(t, publisher.all())
}

func TestSSHKeyService_DeleteKeySucceedsWhenPublishFails(t *testing.T) {
	t.Parallel()
	publisher := &failingPublisher{}
	svc := NewSSHKeyService(sshKeyDeleteQuerier(42, nil))
	svc.SetRevocationPublisher(publisher)
	require.NoError(t, svc.DeleteKey(context.Background(), 42, 7))
	require.Equal(t, 1, publisher.calls)

	require.NoError(t, NewSSHKeyService(sshKeyDeleteQuerier(42, nil)).DeleteKey(context.Background(), 42, 7))
}

func deployKeyDeleteQuerier(keyRepo int64, deleteErr error) *mockDeployKeyQuerier {
	return &mockDeployKeyQuerier{
		getRepoFn: func(context.Context, db.GetRepoByOwnerAndLowerNameParams) (db.Repository, error) {
			return db.Repository{ID: 5}, nil
		},
		getDeployKeyByIDFn: func(_ context.Context, id int64) (db.DeployKey, error) {
			return db.DeployKey{ID: id, RepositoryID: keyRepo, KeyFingerprint: "SHA256:deploy-key"}, nil
		},
		deleteDeployKeyFn: func(context.Context, int64) error { return deleteErr },
	}
}

func TestDeployKeyService_DeleteDeployKeyPublishesKeyRevocation(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	svc := NewDeployKeyService(deployKeyDeleteQuerier(5, nil))
	svc.SetRevocationPublisher(publisher)

	require.NoError(t, svc.DeleteDeployKey(context.Background(), "alice", "repo", 3))
	events := publisher.all()
	require.Len(t, events, 1)
	require.Equal(t, revocation.KindSSHKeyRevoked, events[0].Kind)
	require.Equal(t, int64(5), events[0].RepositoryID)
	require.Equal(t, "SHA256:deploy-key", events[0].KeyFingerprint)
	require.True(t, events[0].Affects(revocation.Principal{RepositoryID: 5, KeyFingerprint: "SHA256:deploy-key"}))
}

func TestDeployKeyService_DeleteDeployKeyDoesNotPublishOnFailure(t *testing.T) {
	t.Parallel()
	publisher := &recordingPublisher{}
	svc := NewDeployKeyService(deployKeyDeleteQuerier(5, errors.New("db down")))
	svc.SetRevocationPublisher(publisher)
	require.Error(t, svc.DeleteDeployKey(context.Background(), "alice", "repo", 3))
	require.Empty(t, publisher.all())

	other := NewDeployKeyService(deployKeyDeleteQuerier(6, nil))
	other.SetRevocationPublisher(publisher)
	require.Error(t, other.DeleteDeployKey(context.Background(), "alice", "repo", 3))
	require.Empty(t, publisher.all())
}

func TestDeployKeyService_DeleteDeployKeySucceedsWhenPublishFails(t *testing.T) {
	t.Parallel()
	publisher := &failingPublisher{}
	svc := NewDeployKeyService(deployKeyDeleteQuerier(5, nil))
	svc.SetRevocationPublisher(publisher)
	require.NoError(t, svc.DeleteDeployKey(context.Background(), "alice", "repo", 3))
	require.Equal(t, 1, publisher.calls)

	require.NoError(t, NewDeployKeyService(deployKeyDeleteQuerier(5, nil)).DeleteDeployKey(context.Background(), "alice", "repo", 3))
}
