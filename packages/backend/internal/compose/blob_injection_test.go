package compose

import (
	"context"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/config"
)

func TestInjectedBlobStoreBypassesDeploymentConstructor(t *testing.T) {
	provided := blob.NewMemoryStore()
	store, client, expiry, err := selectBlobStore(context.Background(), config.BlobConfig{
		GCSBucket:       "must-not-open-cloud-client",
		SignedURLExpiry: "9m",
	}, provided)
	if err != nil {
		t.Fatal(err)
	}
	if store != provided || client != nil || expiry != 9*time.Minute {
		t.Fatalf("injected store was not used: store=%T client=%v expiry=%s", store, client, expiry)
	}
}
