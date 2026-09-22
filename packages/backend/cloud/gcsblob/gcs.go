package gcsblob

import (
	"context"
	stdErrors "errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"cloud.google.com/go/storage"
	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/iterator"
)

type gcsSignerFn func(bucket, object string, opts *storage.SignedURLOptions) (string, error)
type gcsExistsFn func(ctx context.Context, bucket, object string) (bool, error)
type gcsDeleteFn func(ctx context.Context, bucket, object string) error
type gcsStatFn func(ctx context.Context, bucket, object string) (blob.ObjectAttrs, error)
type gcsNewReaderFn func(ctx context.Context, bucket, object string) (io.ReadCloser, error)
type gcsPromoteFn func(ctx context.Context, bucket, sourceObject, destinationObject string) error
type gcsPutFn func(ctx context.Context, bucket, object, contentType string, r io.Reader) error

type GCSStore struct {
	bucket      string
	signerFn    gcsSignerFn
	existsFn    gcsExistsFn
	deleteFn    gcsDeleteFn
	purgeFn     gcsDeleteFn
	statFn      gcsStatFn
	newReaderFn gcsNewReaderFn
	promoteFn   gcsPromoteFn
	putFn       gcsPutFn
}

func NewGCSStore(client *storage.Client, bucket string) *GCSStore {
	s := &GCSStore{bucket: bucket}
	if client != nil {
		// Use ObjectHandle.GenerateSignedURL so that signing works with
		// Application Default Credentials (Workload Identity on GKE) without
		// needing an explicit service-account key.  The package-level
		// storage.SignedURL requires GoogleAccessID + PrivateKey or SignBytes,
		// which are unavailable in ADC environments.
		s.signerFn = func(bucket, object string, opts *storage.SignedURLOptions) (string, error) {
			return client.Bucket(bucket).SignedURL(object, opts)
		}
		s.existsFn = func(ctx context.Context, bucket, object string) (bool, error) {
			_, err := client.Bucket(bucket).Object(object).Attrs(ctx)
			if err != nil {
				if stdErrors.Is(err, storage.ErrObjectNotExist) {
					return false, nil
				}
				return false, err
			}
			return true, nil
		}
		s.deleteFn = func(ctx context.Context, bucket, object string) error {
			err := client.Bucket(bucket).Object(object).Delete(ctx)
			if stdErrors.Is(err, storage.ErrObjectNotExist) {
				return nil
			}
			return err
		}
		s.purgeFn = func(ctx context.Context, bucket, object string) error {
			return hardDeleteGCSObjectGenerations(ctx, client.Bucket(bucket), object)
		}
		s.statFn = func(ctx context.Context, bucket, object string) (blob.ObjectAttrs, error) {
			attrs, err := client.Bucket(bucket).Object(object).Attrs(ctx)
			if err != nil {
				if stdErrors.Is(err, storage.ErrObjectNotExist) {
					return blob.ObjectAttrs{}, blob.ErrObjectNotFound
				}
				return blob.ObjectAttrs{}, err
			}
			return blob.ObjectAttrs{Size: attrs.Size}, nil
		}
		s.newReaderFn = func(ctx context.Context, bucket, object string) (io.ReadCloser, error) {
			r, err := client.Bucket(bucket).Object(object).NewReader(ctx)
			if err != nil {
				if stdErrors.Is(err, storage.ErrObjectNotExist) {
					return nil, blob.ErrObjectNotFound
				}
				return nil, err
			}
			return r, nil
		}
		s.putFn = func(ctx context.Context, bucket, object, contentType string, r io.Reader) error {
			w := client.Bucket(bucket).Object(object).NewWriter(ctx)
			w.ContentType = contentType
			if _, err := io.Copy(w, r); err != nil {
				_ = w.Close()
				return err
			}
			return w.Close()
		}
		s.promoteFn = func(ctx context.Context, bucket, sourceObject, destinationObject string) error {
			bucketHandle := client.Bucket(bucket)
			destination := bucketHandle.Object(destinationObject).If(storage.Conditions{DoesNotExist: true})
			if _, err := destination.CopierFrom(bucketHandle.Object(sourceObject)).Run(ctx); err != nil {
				return translateGCSPromoteError(err)
			}
			// Bucket versioning would archive a normal source delete. Purge every
			// pending generation instead; the service repeats this cleanup before
			// consuming quota, retaining the reservation if the purge still fails.
			_ = s.purgeFn(ctx, bucket, sourceObject)
			return nil
		}
	}
	return s
}

func translateGCSPromoteError(err error) error {
	var apiErr *googleapi.Error
	if stdErrors.As(err, &apiErr) {
		switch apiErr.Code {
		case http.StatusPreconditionFailed:
			return blob.ErrObjectAlreadyExists
		case http.StatusNotFound:
			return blob.ErrObjectNotFound
		}
	}
	if stdErrors.Is(err, storage.ErrObjectNotExist) {
		return blob.ErrObjectNotFound
	}
	return err
}

func NewGCSStoreWithHooks(bucket string, signerFn gcsSignerFn, existsFn gcsExistsFn, deleteFn gcsDeleteFn, statFn gcsStatFn, newReaderFn ...gcsNewReaderFn) *GCSStore {
	s := &GCSStore{
		bucket:   bucket,
		signerFn: signerFn,
		existsFn: existsFn,
		deleteFn: deleteFn,
		purgeFn:  deleteFn,
		statFn:   statFn,
	}
	if len(newReaderFn) > 0 {
		s.newReaderFn = newReaderFn[0]
	}
	return s
}

// GCSIfGenerationMatchHeader is the GCS precondition header that, with value
// "0", makes a PUT create-only: GCS rejects the write with 412 Precondition
// Failed unless no live object exists at the key.
const GCSIfGenerationMatchHeader = "x-goog-if-generation-match"

var _ blob.CreateOnlyUploadSigner = (*GCSStore)(nil)
var _ blob.CreateOnlyPromoter = (*GCSStore)(nil)
var _ blob.GenerationPurger = (*GCSStore)(nil)

// SignedCreateOnlyUploadURL returns a V4 signed PUT URL whose signature covers
// x-goog-if-generation-match: 0, so the upload only succeeds while no live
// object exists at key. Once a first upload lands (generation 1), any later
// PUT through this or another signed URL for the same key fails with 412
// instead of silently overwriting verified content. The returned Header map
// carries every signed header the uploader must send. Unlike the legacy plain
// upload signer, a declared size is exact: N,N permits only N bytes, including
// 0,0 for an empty object. blob.UnknownObjectSize disables the length constraint.
func (g *GCSStore) SignedCreateOnlyUploadURL(_ context.Context, key string, contentType string, exactSizeBytes int64, expiry time.Duration) (blob.SignedUpload, error) {
	if g.signerFn == nil {
		return blob.SignedUpload{}, fmt.Errorf("gcs signer is not configured")
	}
	opts := &storage.SignedURLOptions{
		// V4 signing is required: it includes extension headers in the
		// canonical request, which is what forces the client to actually send
		// the precondition header for GCS to enforce it.
		Scheme:      storage.SigningSchemeV4,
		Method:      "PUT",
		ContentType: contentType,
		Expires:     time.Now().Add(blob.NormalizeSignedURLExpiry(expiry)),
		Headers:     []string{GCSIfGenerationMatchHeader + ":0"},
	}
	header := map[string]string{GCSIfGenerationMatchHeader: "0"}
	if contentType != "" {
		header["Content-Type"] = contentType
	}
	if exactSizeBytes >= 0 {
		exactRange := fmt.Sprintf("%d,%d", exactSizeBytes, exactSizeBytes)
		opts.Headers = append(opts.Headers, "x-goog-content-length-range:"+exactRange)
		header["x-goog-content-length-range"] = exactRange
	}
	u, err := g.signerFn(g.bucket, key, opts)
	if err != nil {
		return blob.SignedUpload{}, err
	}
	return blob.SignedUpload{URL: u, Header: header}, nil
}

// PromoteCreateOnly copies a staged object to its permanent key with a GCS
// generation-match precondition. Concurrent confirmations therefore converge
// without overwriting an already-verified object.
func (g *GCSStore) PromoteCreateOnly(ctx context.Context, sourceKey, destinationKey string) error {
	if g.promoteFn == nil {
		return fmt.Errorf("GCS promote operation not configured")
	}
	return g.promoteFn(ctx, g.bucket, sourceKey, destinationKey)
}

func (g *GCSStore) SignedUploadURL(_ context.Context, key string, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error) {
	if g.signerFn == nil {
		return "", fmt.Errorf("gcs signer is not configured")
	}
	opts := &storage.SignedURLOptions{
		Scheme:      storage.SigningSchemeV4,
		Method:      "PUT",
		ContentType: contentType,
		Expires:     time.Now().Add(blob.NormalizeSignedURLExpiry(expiry)),
	}
	if maxSizeBytes > 0 {
		opts.Headers = []string{fmt.Sprintf("x-goog-content-length-range:0,%d", maxSizeBytes)}
	}
	return g.signerFn(g.bucket, key, opts)
}

func (g *GCSStore) SignedDownloadURL(_ context.Context, key string, expiry time.Duration) (string, error) {
	if g.signerFn == nil {
		return "", fmt.Errorf("gcs signer is not configured")
	}
	return g.signerFn(g.bucket, key, &storage.SignedURLOptions{
		Scheme:  storage.SigningSchemeV4,
		Method:  "GET",
		Expires: time.Now().Add(blob.NormalizeSignedURLExpiry(expiry)),
	})
}

func (g *GCSStore) Delete(ctx context.Context, key string) error {
	if isGenerationPurgeKey(key) {
		if g.purgeFn == nil {
			return fmt.Errorf("gcs generation purge is not configured")
		}
		return g.purgeFn(ctx, g.bucket, key)
	}
	if g.deleteFn == nil {
		return fmt.Errorf("gcs delete is not configured")
	}
	return g.deleteFn(ctx, g.bucket, key)
}

// PurgeAllGenerations permanently deletes every generation for any exact key,
// independent of namespace. Durable deletion-queue entries already identify
// authoritative exact keys, so prefix allowlists are neither needed nor safe.
func (g *GCSStore) PurgeAllGenerations(ctx context.Context, key string) error {
	if g.purgeFn == nil {
		return fmt.Errorf("gcs generation purge is not configured")
	}
	return g.purgeFn(ctx, g.bucket, key)
}

func isGenerationPurgeKey(key string) bool {
	if strings.HasPrefix(key, "lfs-pending/") || strings.HasPrefix(key, blob.PendingUploadPrefix) {
		return true
	}
	if !strings.HasPrefix(key, "repos/") {
		return false
	}
	rest := strings.TrimPrefix(key, "repos/")
	return strings.Contains(rest, "/lfs/") ||
		(strings.Contains(rest, "/releases/") && strings.Contains(rest, "/assets/"))
}

// hardDeleteGCSObjectGenerations permanently removes both live and archived
// generations for one exact object. Generation-specific deletes bypass bucket
// versioning, so invalid staging data and release/LFS objects cannot accumulate
// as hidden noncurrent storage after their authoritative quota reservation is
// released.
func hardDeleteGCSObjectGenerations(ctx context.Context, bucket *storage.BucketHandle, object string) error {
	visit := func(ctx context.Context, query *storage.Query, visitor func(*storage.ObjectAttrs) error) error {
		objects := bucket.Objects(ctx, query)
		for {
			attrs, err := objects.Next()
			if stdErrors.Is(err, iterator.Done) {
				return nil
			}
			if err != nil {
				return err
			}
			if err := visitor(attrs); err != nil {
				return err
			}
		}
	}
	deleteGeneration := func(ctx context.Context, generation int64) error {
		return bucket.Object(object).Generation(generation).Delete(ctx)
	}
	return hardDeleteGCSObjectGenerationsWithHooks(ctx, object, visit, deleteGeneration)
}

type gcsObjectVisitorFn func(context.Context, *storage.Query, func(*storage.ObjectAttrs) error) error
type gcsDeleteGenerationFn func(context.Context, int64) error

func hardDeleteGCSObjectGenerationsWithHooks(
	ctx context.Context,
	object string,
	visit gcsObjectVisitorFn,
	deleteGeneration gcsDeleteGenerationFn,
) error {
	const maxPurgePasses = 4
	for pass := 0; pass < maxPurgePasses; pass++ {
		found := false
		if err := visit(ctx, &storage.Query{Prefix: object, Versions: true}, func(attrs *storage.ObjectAttrs) error {
			if attrs.Name != object {
				return nil
			}
			found = true
			err := deleteGeneration(ctx, attrs.Generation)
			if err != nil && !stdErrors.Is(err, storage.ErrObjectNotExist) {
				return err
			}
			return nil
		}); err != nil {
			return err
		}
		if !found {
			softDeleted := false
			err := visit(ctx, &storage.Query{Prefix: object, SoftDeleted: true}, func(attrs *storage.ObjectAttrs) error {
				if attrs.Name == object {
					softDeleted = true
				}
				return nil
			})
			if isGCSSoftDeleteDisabledError(err) {
				return nil
			}
			if err != nil {
				return err
			}
			if softDeleted {
				return fmt.Errorf("gcs object %q still has soft-deleted generations retained by bucket policy", object)
			}
			return nil
		}
	}
	return fmt.Errorf("gcs object %q still has generations after cleanup", object)
}

func isGCSSoftDeleteDisabledError(err error) bool {
	var apiErr *googleapi.Error
	return stdErrors.As(err, &apiErr) &&
		apiErr.Code == http.StatusBadRequest &&
		strings.Contains(strings.ToLower(apiErr.Message), "soft delete policy is required")
}

func (g *GCSStore) Exists(ctx context.Context, key string) (bool, error) {
	if g.existsFn == nil {
		return false, fmt.Errorf("gcs exists is not configured")
	}
	return g.existsFn(ctx, g.bucket, key)
}

func (g *GCSStore) Stat(ctx context.Context, key string) (blob.ObjectAttrs, error) {
	if g.statFn == nil {
		return blob.ObjectAttrs{}, fmt.Errorf("gcs stat is not configured")
	}
	return g.statFn(ctx, g.bucket, key)
}

func (g *GCSStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	if g.newReaderFn == nil {
		return nil, fmt.Errorf("gcs reader is not configured")
	}
	return g.newReaderFn(ctx, g.bucket, key)
}

// Put writes an object server-side. The build cache uses it for
// content-addressed artifacts whose bytes the API has already hashed.
func (g *GCSStore) Put(ctx context.Context, key, contentType string, r io.Reader) error {
	if g.putFn == nil {
		return fmt.Errorf("gcs put is not configured")
	}
	return g.putFn(ctx, g.bucket, key, contentType, r)
}

var _ blob.Putter = (*GCSStore)(nil)
