package blob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const DefaultSignedURLExpiry = 5 * time.Minute

// MaxSignedURLExpiry matches GCS V4's provider-enforced seven-day ceiling.
// Keep this bound conservative during rollout: older Plue versions accepted
// unbounded configuration, so a capability minted immediately before upgrade
// can remain valid for the full provider maximum.
const MaxSignedURLExpiry = 7 * 24 * time.Hour
const UnknownObjectSize int64 = -1

var ErrObjectNotFound = errors.New("blob object not found")
var ErrObjectAlreadyExists = errors.New("blob object already exists")

const PendingUploadPrefix = "pending/"

// PendingUploadKey derives a deterministic staging key from an immutable
// final object key. Production upload services put unverified bytes under this
// lifecycle-bounded namespace, then promote them create-only after validation.
// A stale signed capability can therefore recreate only a pending object that
// bucket lifecycle cleanup will reclaim, never overwrite authoritative data.
func PendingUploadKey(namespace, finalKey string) string {
	namespace = strings.Trim(strings.TrimSpace(namespace), "/")
	finalKey = strings.TrimLeft(strings.TrimSpace(finalKey), "/")
	if namespace == "" {
		return PendingUploadPrefix + finalKey
	}
	return PendingUploadPrefix + namespace + "/" + finalKey
}

// ObjectAttrs holds metadata about a stored object.
// SHA256 is the hex-encoded SHA-256 digest of the object content.
// It is empty when the store does not compute or expose a hash.
type ObjectAttrs struct {
	Size   int64
	SHA256 string
}

// SignedUpload describes a signed upload action: the URL to PUT to plus any
// headers that are part of the signature. The uploader must send every header
// verbatim or the storage layer rejects the request, so callers building
// client-facing actions (e.g. Git LFS batch responses) must forward Header.
type SignedUpload struct {
	URL    string
	Header map[string]string
}

// CreateOnlyUploadSigner is implemented by stores whose signed upload URLs can
// enforce create-only semantics: the storage layer rejects the PUT when a live
// object already exists at the key, so a stale signed URL can never overwrite
// data that was uploaded and verified later. A non-negative exactSizeBytes is
// the only accepted upload length (including zero-byte objects); pass
// UnknownObjectSize only when the caller genuinely cannot declare a size.
type CreateOnlyUploadSigner interface {
	SignedCreateOnlyUploadURL(ctx context.Context, key string, contentType string, exactSizeBytes int64, expiry time.Duration) (SignedUpload, error)
}

// CreateOnlyPromoter is implemented by stores that can atomically copy a
// staged object into a destination only when the destination does not yet
// exist. It lets callers keep unverified uploads out of permanent object
// namespaces until integrity, authorization, and quota checks succeed.
type CreateOnlyPromoter interface {
	PromoteCreateOnly(ctx context.Context, sourceKey, destinationKey string) error
}

// SignedCreateOnlyUpload returns a create-only signed upload for key when the
// store supports it. Stores without create-only support (MemoryStore and test
// doubles) fall back to a plain signed URL with no required headers, keeping
// their existing semantics.
func SignedCreateOnlyUpload(ctx context.Context, store Store, key string, contentType string, exactSizeBytes int64, expiry time.Duration) (SignedUpload, error) {
	expiry = normalizeSignedURLExpiry(expiry)
	if s, ok := store.(CreateOnlyUploadSigner); ok {
		return s.SignedCreateOnlyUploadURL(ctx, key, contentType, exactSizeBytes, expiry)
	}
	u, err := store.SignedUploadURL(ctx, key, contentType, exactSizeBytes, expiry)
	if err != nil {
		return SignedUpload{}, err
	}
	return SignedUpload{URL: u}, nil
}

// Putter is implemented by stores that can write an object server-side from
// a reader. The build cache needs it: artifact bytes arrive through the API,
// which verifies their digest before anything touches the bucket, so a signed
// client upload would only reintroduce the unverified window.
type Putter interface {
	Put(ctx context.Context, key, contentType string, r io.Reader) error
}

// TransferHandlerProvider is implemented by local stores that proxy signed
// transfers through the application. Cluster stores can continue returning
// provider-hosted signed URLs without exposing an application handler.
type TransferHandlerProvider interface {
	TransferHandler() http.Handler
}

// Put writes key through store when it supports server-side writes.
func Put(ctx context.Context, store Store, key, contentType string, r io.Reader) error {
	p, ok := store.(Putter)
	if !ok {
		return errors.New("blob store does not support server-side writes")
	}
	return p.Put(ctx, key, contentType, r)
}

type Store interface {
	// SignedUploadURL returns a time-limited PUT URL for key. When
	// maxSizeBytes is positive, the returned URL enforces that upper bound at
	// the storage layer (e.g. GCS's x-goog-content-length-range header) so an
	// uploader cannot write more bytes than the caller declared; pass 0 for no
	// enforced limit.
	SignedUploadURL(ctx context.Context, key string, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error)
	SignedDownloadURL(ctx context.Context, key string, expiry time.Duration) (string, error)
	Delete(ctx context.Context, key string) error
	Exists(ctx context.Context, key string) (bool, error)
	Stat(ctx context.Context, key string) (ObjectAttrs, error)
	NewReader(ctx context.Context, key string) (io.ReadCloser, error)
}

func ParseSignedURLExpiry(raw string) (time.Duration, error) {
	if raw == "" {
		return DefaultSignedURLExpiry, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, err
	}
	if d <= 0 {
		return 0, errors.New("signed URL expiry must be greater than zero")
	}
	if d > MaxSignedURLExpiry {
		return 0, errors.New("signed URL expiry must not exceed 168h")
	}
	return d, nil
}

func normalizeSignedURLExpiry(expiry time.Duration) time.Duration {
	if expiry <= 0 {
		return DefaultSignedURLExpiry
	}
	// Public constructors accept a duration directly in addition to the parsed
	// configuration path. Clamp those callers too, so no Plue-issued capability
	// can outlive the deletion queue's safety fence.
	if expiry > MaxSignedURLExpiry {
		return MaxSignedURLExpiry
	}
	return expiry
}

// GenerationPurger permanently removes every live and archived generation of
// one exact key. GCS implements this with generation-specific deletes so
// bucket versioning cannot turn cleanup into a hidden noncurrent object.
type GenerationPurger interface {
	PurgeAllGenerations(ctx context.Context, key string) error
}

// PurgeAllGenerations uses a store's generation-aware implementation when
// available. Non-versioned/local stores safely fall back to ordinary Delete.
func PurgeAllGenerations(ctx context.Context, store Store, key string) error {
	if purger, ok := store.(GenerationPurger); ok {
		return purger.PurgeAllGenerations(ctx, key)
	}
	return store.Delete(ctx, key)
}

// ComputeSHA256 reads the object at key from store and returns its hex-encoded
// SHA-256 digest.  The caller is responsible for ensuring key exists; if the
// object is not found ErrObjectNotFound is returned.
func ComputeSHA256(ctx context.Context, store Store, key string) (string, error) {
	r, err := store.NewReader(ctx, key)
	if err != nil {
		return "", err
	}
	defer func() { _ = r.Close() }()

	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
