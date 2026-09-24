package ssh_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/testutil/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/repository"
	productssh "github.com/smithersai/smithers/packages/backend/ssh"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

func TestNewRejectsAbsentProductDependencies(t *testing.T) {
	_, err := productssh.New(context.Background(), productssh.Config{})
	require.ErrorContains(t, err, "database")
}

func TestProductSSHUsesCanonicalKeyAndRepositoryAuthorization(t *testing.T) {
	raw := os.Getenv("SMITHERS_PRODUCT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("SMITHERS_PRODUCT_TEST_DATABASE_URL is required for real SSH authorization")
	}
	pool, _ := postgresfixture.NewProductDatabase(t, raw)
	ctx := context.Background()
	queries := db.New(pool)
	user, err := queries.CreateUser(ctx, db.CreateUserParams{Username: "ssh-fixture", LowerUsername: "ssh-fixture"})
	require.NoError(t, err)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	signer, err := gossh.NewSignerFromKey(private)
	require.NoError(t, err)
	_, err = queries.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: user.ID, Name: "fixture", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
	require.NoError(t, err)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	address := listener.Addr().String()
	require.NoError(t, listener.Close())
	server, err := productssh.New(ctx, productssh.Config{Database: pool, Repository: repository.NewRemoteClient(nil, "test-token"), Addr: address, HostKeyDir: t.TempDir(), LFSSigningSecret: "test-lfs-secret", PublicAPIOrigin: "http://127.0.0.1:4000"})
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- server.ListenAndServe() }()
	t.Cleanup(func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, server.Shutdown(shutdown))
		<-done
	})
	var client *gossh.Client
	require.Eventually(t, func() bool {
		client, err = gossh.Dial("tcp", address, &gossh.ClientConfig{User: "git", Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
		return err == nil
	}, 5*time.Second, 20*time.Millisecond)
	defer client.Close()
	session, err := client.NewSession()
	require.NoError(t, err)
	defer session.Close()
	output, err := session.CombinedOutput("git-upload-pack 'other/private.git'")
	require.Error(t, err, "real product repository authorization must reject an inaccessible repository")
	require.True(t, strings.Contains(strings.ToLower(string(output)), "denied") || strings.Contains(strings.ToLower(string(output)), "not found"), string(output))
}
