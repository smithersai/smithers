package blob

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const (
	filesystemTransferPath = "/api/blob-transfer/"
	filesystemKeyFile      = ".smithers-transfer-key"
	filesystemTempDir      = ".tmp"
)

var (
	ErrStorageFull   = errors.New("blob storage has no available capacity")
	ErrInvalidUpload = errors.New("blob upload failed validation")
)

// FilesystemConfig configures the durable single-owner blob adapter. MaxBytes
// is a logical object quota; zero means no additional global limit. ReserveBytes
// is kept free for PostgreSQL, API logs, and atomic filesystem operations.
type FilesystemConfig struct {
	Root          string
	PublicBaseURL string
	SigningKey    []byte
	MaxBytes      int64
	ReserveBytes  int64
}

// FilesystemStore stores immutable product objects under one persistent data
// root. Uploads are spooled and fsynced before an atomic publication, so an
// interrupted request or process crash never exposes a partial object.
type FilesystemStore struct {
	root          string
	publicBaseURL string
	signingKey    []byte
	maxBytes      int64
	reserveBytes  int64
	now           func() time.Time

	quotaMu  sync.Mutex
	used     int64
	reserved int64
	// mutationMu serializes publication, promotion, and deletion inside the one
	// supported local app process. It complements the services' durable
	// ownership fences and keeps filesystem mutations in a definite order.
	mutationMu sync.Mutex
}

type transferClaims struct {
	Version     int    `json:"v"`
	Operation   string `json:"op"`
	Key         string `json:"key"`
	Owner       string `json:"owner"`
	ExpiresUnix int64  `json:"exp"`
	ContentType string `json:"content_type,omitempty"`
	SizeLimit   int64  `json:"size_limit"`
	ExactSize   bool   `json:"exact_size,omitempty"`
	CreateOnly  bool   `json:"create_only,omitempty"`
}

// NewFilesystemStore opens a durable store, removes abandoned upload spools,
// and reconstructs quota accounting from committed objects. When SigningKey is
// omitted, a 256-bit key is created once inside Root and reused after restart.
func NewFilesystemStore(cfg FilesystemConfig) (*FilesystemStore, error) {
	if strings.TrimSpace(cfg.Root) == "" {
		return nil, errors.New("filesystem blob root is required")
	}
	if cfg.MaxBytes < 0 || cfg.ReserveBytes < 0 {
		return nil, errors.New("filesystem blob quota and reserve must be non-negative")
	}
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(cfg.PublicBaseURL), "/"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return nil, errors.New("filesystem blob public base URL must be an absolute http(s) URL")
	}
	root, err := filepath.Abs(cfg.Root)
	if err != nil {
		return nil, fmt.Errorf("resolve filesystem blob root: %w", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create filesystem blob root: %w", err)
	}
	if info, err := os.Lstat(root); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("filesystem blob root must be a real directory")
	}
	tempDir := filepath.Join(root, filesystemTempDir)
	if err := os.RemoveAll(tempDir); err != nil {
		return nil, fmt.Errorf("remove incomplete blob uploads: %w", err)
	}
	if err := os.Mkdir(tempDir, 0o700); err != nil {
		return nil, fmt.Errorf("create blob upload directory: %w", err)
	}

	key, err := loadOrCreateSigningKey(root, cfg.SigningKey)
	if err != nil {
		return nil, err
	}
	used, err := committedBytes(root)
	if err != nil {
		return nil, err
	}
	if cfg.MaxBytes > 0 && used > cfg.MaxBytes {
		return nil, fmt.Errorf("committed blobs use %d bytes, exceeding configured quota %d", used, cfg.MaxBytes)
	}
	s := &FilesystemStore{
		root: root, publicBaseURL: strings.TrimRight(base.String(), "/"),
		signingKey: key, maxBytes: cfg.MaxBytes, reserveBytes: cfg.ReserveBytes,
		now: time.Now, used: used,
	}
	if err := s.checkDiskHeadroom(0); err != nil {
		return nil, err
	}
	return s, nil
}

func loadOrCreateSigningKey(root string, configured []byte) ([]byte, error) {
	if len(configured) > 0 {
		if len(configured) < 32 {
			return nil, errors.New("filesystem blob signing key must be at least 32 bytes")
		}
		return append([]byte(nil), configured...), nil
	}
	keyPath := filepath.Join(root, filesystemKeyFile)
	if info, statErr := os.Lstat(keyPath); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
			return nil, errors.New("filesystem blob signing key file must be a private regular file")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect filesystem blob signing key: %w", statErr)
	}
	key, err := os.ReadFile(keyPath)
	if err == nil {
		if len(key) != 32 {
			return nil, errors.New("filesystem blob signing key file is invalid")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read filesystem blob signing key: %w", err)
	}
	key = make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate filesystem blob signing key: %w", err)
	}
	f, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return loadOrCreateSigningKey(root, nil)
	}
	if err != nil {
		return nil, fmt.Errorf("create filesystem blob signing key: %w", err)
	}
	_, writeErr := f.Write(key)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		_ = os.Remove(keyPath)
		return nil, fmt.Errorf("persist filesystem blob signing key: %w", err)
	}
	if err := syncDirectory(root); err != nil {
		return nil, err
	}
	return key, nil
}

func committedBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(name string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if name == root {
			return nil
		}
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		first := strings.Split(rel, string(filepath.Separator))[0]
		if entry.IsDir() && first == filesystemTempDir {
			return filepath.SkipDir
		}
		if first == filesystemKeyFile {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("scan filesystem blobs: %w", err)
	}
	return total, nil
}

func cleanObjectKey(key string) (string, error) {
	if key == "" || strings.TrimSpace(key) != key || strings.HasPrefix(key, "/") || strings.Contains(key, "\\") || strings.ContainsRune(key, 0) || path.Clean(key) != key {
		return "", errors.New("invalid blob object key")
	}
	for i, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." || (i == 0 && (part == filesystemTempDir || part == filesystemKeyFile)) {
			return "", errors.New("invalid blob object key")
		}
	}
	return key, nil
}

func (s *FilesystemStore) objectPath(key string) (string, error) {
	key, err := cleanObjectKey(key)
	if err != nil {
		return "", err
	}
	return filepath.Join(s.root, filepath.FromSlash(key)), nil
}

func (s *FilesystemStore) ensureParent(key string) (string, error) {
	key, err := cleanObjectKey(key)
	if err != nil {
		return "", err
	}
	parts := strings.Split(key, "/")
	dir := s.root
	for _, part := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, part)
		info, statErr := os.Lstat(dir)
		switch {
		case errors.Is(statErr, os.ErrNotExist):
			if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
				return "", err
			}
			if err := syncDirectory(filepath.Dir(dir)); err != nil {
				return "", err
			}
			info, statErr = os.Lstat(dir)
			fallthrough
		case statErr == nil:
			if info == nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("blob object path crosses a non-directory")
			}
		default:
			return "", statErr
		}
	}
	return filepath.Join(dir, parts[len(parts)-1]), nil
}

func ownerScope(key string) (string, error) {
	parts := strings.Split(key, "/")
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "repos" {
			if id, err := strconv.ParseInt(parts[i+1], 10, 64); err == nil && id > 0 {
				return "repository:" + parts[i+1], nil
			}
		}
	}
	if len(parts) > 1 {
		switch parts[0] {
		case "lfs-pending", "agent-logs", "build-cache":
			if id, err := strconv.ParseInt(parts[1], 10, 64); err == nil && id > 0 {
				return "repository:" + parts[1], nil
			}
		case "snapshots":
			return "system:snapshots", nil
		}
	}
	return "", errors.New("blob transfer key has no owner scope")
}

func (s *FilesystemStore) signTransfer(claims transferClaims) (string, error) {
	key, err := cleanObjectKey(claims.Key)
	if err != nil {
		return "", err
	}
	owner, err := ownerScope(key)
	if err != nil {
		return "", err
	}
	claims.Key = key
	claims.Owner = owner
	claims.Version = 1
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, s.signingKey)
	_, _ = mac.Write(payload)
	token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return s.publicBaseURL + filesystemTransferPath + token, nil
}

func (s *FilesystemStore) verifyTransfer(token string) (transferClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	mac := hmac.New(sha256.New, s.signingKey)
	_, _ = mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	var claims transferClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Version != 1 {
		return transferClaims{}, errors.New("invalid transfer credential")
	}
	key, err := cleanObjectKey(claims.Key)
	owner, ownerErr := ownerScope(key)
	if err != nil || ownerErr != nil || claims.Owner != owner || claims.ExpiresUnix <= s.now().Unix() {
		return transferClaims{}, errors.New("expired or invalid transfer credential")
	}
	if claims.Operation != http.MethodGet && claims.Operation != http.MethodPut {
		return transferClaims{}, errors.New("invalid transfer operation")
	}
	claims.Key = key
	return claims, nil
}

func (s *FilesystemStore) SignedUploadURL(_ context.Context, key, contentType string, maxSizeBytes int64, expiry time.Duration) (string, error) {
	if maxSizeBytes < 0 {
		return "", errors.New("upload size limit must be non-negative")
	}
	expiry = normalizeSignedURLExpiry(expiry)
	return s.signTransfer(transferClaims{Operation: http.MethodPut, Key: key, ContentType: contentType, SizeLimit: maxSizeBytes, ExpiresUnix: s.now().Add(expiry).Unix()})
}

func (s *FilesystemStore) SignedCreateOnlyUploadURL(_ context.Context, key, contentType string, exactSizeBytes int64, expiry time.Duration) (SignedUpload, error) {
	if exactSizeBytes < UnknownObjectSize {
		return SignedUpload{}, errors.New("upload size must be exact or unknown")
	}
	expiry = normalizeSignedURLExpiry(expiry)
	u, err := s.signTransfer(transferClaims{
		Operation: http.MethodPut, Key: key, ContentType: contentType,
		SizeLimit: exactSizeBytes, ExactSize: exactSizeBytes >= 0, CreateOnly: true,
		ExpiresUnix: s.now().Add(expiry).Unix(),
	})
	if err != nil {
		return SignedUpload{}, err
	}
	headers := map[string]string{}
	if contentType != "" {
		headers["Content-Type"] = contentType
	}
	return SignedUpload{URL: u, Header: headers}, nil
}

func (s *FilesystemStore) SignedDownloadURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	if _, err := s.Stat(ctx, key); err != nil {
		return "", err
	}
	expiry = normalizeSignedURLExpiry(expiry)
	return s.signTransfer(transferClaims{Operation: http.MethodGet, Key: key, SizeLimit: UnknownObjectSize, ExpiresUnix: s.now().Add(expiry).Unix()})
}

func (s *FilesystemStore) reserve(bytes int64) error {
	if bytes < 0 {
		return errors.New("negative blob reservation")
	}
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	if s.maxBytes > 0 && bytes > s.maxBytes-s.used-s.reserved {
		return ErrStorageFull
	}
	if err := s.checkDiskHeadroom(s.reserved + bytes); err != nil {
		return err
	}
	s.reserved += bytes
	return nil
}

func (s *FilesystemStore) releaseReservation(bytes int64) {
	s.quotaMu.Lock()
	s.reserved -= bytes
	if s.reserved < 0 {
		s.reserved = 0
	}
	s.quotaMu.Unlock()
}

func (s *FilesystemStore) checkDiskHeadroom(pending int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(s.root, &stat); err != nil {
		return fmt.Errorf("inspect blob filesystem capacity: %w", err)
	}
	available := int64(stat.Bavail) * int64(stat.Bsize)
	if pending > available || available-pending < s.reserveBytes {
		return ErrStorageFull
	}
	return nil
}

func (s *FilesystemStore) writeObject(ctx context.Context, key string, body io.Reader, createOnly bool, exactSize, maxSize int64, expectedDigest string) (ObjectAttrs, error) {
	if _, err := cleanObjectKey(key); err != nil {
		return ObjectAttrs{}, err
	}
	reservation := exactSize
	if reservation < 0 {
		reservation = maxSize
	}
	if reservation < 0 {
		reservation = 0
	}
	if err := s.reserve(reservation); err != nil {
		return ObjectAttrs{}, err
	}
	defer func() { s.releaseReservation(reservation) }()

	temp, err := os.CreateTemp(filepath.Join(s.root, filesystemTempDir), "upload-*")
	if err != nil {
		return ObjectAttrs{}, err
	}
	tempName := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}()
	if err := temp.Chmod(0o600); err != nil {
		return ObjectAttrs{}, err
	}
	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: body}
	var source io.Reader = reader
	limit := maxSize
	if exactSize >= 0 {
		limit = exactSize
	}
	if limit >= 0 {
		source = io.LimitReader(source, limit+1)
	}
	destinationWriter := io.Writer(io.MultiWriter(temp, hash))
	if reservation == 0 {
		destinationWriter = &quotaWriter{store: s, writer: destinationWriter, reserved: &reservation}
	}
	size, copyErr := io.Copy(destinationWriter, source)
	if copyErr != nil {
		return ObjectAttrs{}, copyErr
	}
	if err := ctx.Err(); err != nil {
		return ObjectAttrs{}, err
	}
	if (exactSize >= 0 && size != exactSize) || (maxSize >= 0 && size > maxSize) {
		return ObjectAttrs{}, fmt.Errorf("%w: received %d bytes", ErrInvalidUpload, size)
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if expectedDigest != "" && !strings.EqualFold(expectedDigest, digest) {
		return ObjectAttrs{}, fmt.Errorf("%w: sha256 mismatch", ErrInvalidUpload)
	}
	if err := temp.Sync(); err != nil {
		return ObjectAttrs{}, err
	}
	if err := temp.Close(); err != nil {
		return ObjectAttrs{}, err
	}
	destination, err := s.ensureParent(key)
	if err != nil {
		return ObjectAttrs{}, err
	}
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	var previousSize int64
	if info, statErr := os.Lstat(destination); statErr == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return ObjectAttrs{}, errors.New("blob destination is not a regular file")
		}
		previousSize = info.Size()
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return ObjectAttrs{}, statErr
	}
	if createOnly {
		if err := os.Link(tempName, destination); err != nil {
			if errors.Is(err, os.ErrExist) {
				return ObjectAttrs{}, ErrObjectAlreadyExists
			}
			return ObjectAttrs{}, err
		}
	} else if err := os.Rename(tempName, destination); err != nil {
		return ObjectAttrs{}, err
	}
	s.quotaMu.Lock()
	s.used += size - previousSize
	s.quotaMu.Unlock()
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		if createOnly {
			_ = os.Remove(destination)
			s.quotaMu.Lock()
			s.used -= size
			s.quotaMu.Unlock()
		}
		return ObjectAttrs{}, err
	}
	return ObjectAttrs{Size: size, SHA256: digest}, nil
}

type quotaWriter struct {
	store    *FilesystemStore
	writer   io.Writer
	reserved *int64
}

func (w *quotaWriter) Write(p []byte) (int, error) {
	amount := int64(len(p))
	if err := w.store.reserve(amount); err != nil {
		return 0, err
	}
	*w.reserved += amount
	n, err := w.writer.Write(p)
	if unwritten := amount - int64(n); unwritten > 0 {
		w.store.releaseReservation(unwritten)
		*w.reserved -= unwritten
	}
	return n, err
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func syncDirectory(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	return f.Sync()
}

func (s *FilesystemStore) Put(ctx context.Context, key, _ string, body io.Reader) error {
	_, err := s.writeObject(ctx, key, body, false, UnknownObjectSize, UnknownObjectSize, expectedKeyDigest(key))
	return err
}

func (s *FilesystemStore) PromoteCreateOnly(ctx context.Context, sourceKey, destinationKey string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	source, err := s.objectPath(sourceKey)
	if err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return ErrObjectNotFound
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		if err != nil {
			return err
		}
		return errors.New("blob source is not a regular file")
	}
	destination, err := s.ensureParent(destinationKey)
	if err != nil {
		return err
	}
	if err := os.Link(source, destination); err != nil {
		if errors.Is(err, os.ErrExist) {
			return ErrObjectAlreadyExists
		}
		return err
	}
	if err := syncDirectory(filepath.Dir(destination)); err != nil {
		_ = os.Remove(destination)
		return err
	}
	if err := os.Remove(source); err != nil {
		// Both names refer to the same immutable inode. Leaving the staging name
		// is safe and lets the existing cleanup worker retry removal.
		return err
	}
	_ = syncDirectory(filepath.Dir(source))
	return nil
}

func (s *FilesystemStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mutationMu.Lock()
	defer s.mutationMu.Unlock()
	name, err := s.objectPath(key)
	if err != nil {
		return err
	}
	info, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("blob object is not a regular file")
	}
	if err := os.Remove(name); err != nil {
		return err
	}
	s.quotaMu.Lock()
	s.used -= info.Size()
	if s.used < 0 {
		s.used = 0
	}
	s.quotaMu.Unlock()
	return syncDirectory(filepath.Dir(name))
}

func (s *FilesystemStore) PurgeAllGenerations(ctx context.Context, key string) error {
	return s.Delete(ctx, key)
}

func (s *FilesystemStore) Exists(ctx context.Context, key string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	name, err := s.objectPath(key)
	if err != nil {
		return false, err
	}
	info, err := os.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0, nil
}

func (s *FilesystemStore) Stat(ctx context.Context, key string) (ObjectAttrs, error) {
	r, err := s.NewReader(ctx, key)
	if err != nil {
		return ObjectAttrs{}, err
	}
	defer func() { _ = r.Close() }()
	hash := sha256.New()
	size, err := io.Copy(hash, &contextReader{ctx: ctx, reader: r})
	if err != nil {
		return ObjectAttrs{}, err
	}
	return ObjectAttrs{Size: size, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (s *FilesystemStore) NewReader(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	name, err := s.objectPath(key)
	if err != nil {
		return nil, err
	}
	fd, err := unix.Open(name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, ErrObjectNotFound
	}
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("blob object is not a regular file")
	}
	return f, nil
}

func expectedKeyDigest(key string) string {
	parts := strings.Split(key, "/")
	if len(parts) < 2 {
		return ""
	}
	allowed := strings.Contains(key, "/lfs/") || strings.HasPrefix(key, "lfs-pending/") || strings.HasPrefix(key, "build-cache/")
	candidate := parts[len(parts)-1]
	if !allowed || len(candidate) != sha256.Size*2 {
		return ""
	}
	if _, err := hex.DecodeString(candidate); err != nil {
		return ""
	}
	return strings.ToLower(candidate)
}

// TransferHandler serves the application-owned URLs returned by the signing
// methods. The HMAC credential is the authorization: it is bound to one exact
// owner scope, object key, operation, size policy, and expiry.
func (s *FilesystemStore) TransferHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, filesystemTransferPath) {
			http.NotFound(w, r)
			return
		}
		token := strings.TrimPrefix(r.URL.Path, filesystemTransferPath)
		if len(token) > 8192 {
			http.Error(w, "invalid or expired blob transfer", http.StatusForbidden)
			return
		}
		claims, err := s.verifyTransfer(token)
		if err != nil {
			http.Error(w, "invalid or expired blob transfer", http.StatusForbidden)
			return
		}
		if r.Method != claims.Operation {
			w.Header().Set("Allow", claims.Operation)
			http.Error(w, "blob transfer operation not allowed", http.StatusMethodNotAllowed)
			return
		}
		if claims.Operation == http.MethodGet {
			s.serveDownload(w, r, claims)
			return
		}
		s.serveUpload(w, r, claims)
	})
}

func (s *FilesystemStore) serveUpload(w http.ResponseWriter, r *http.Request, claims transferClaims) {
	if claims.ContentType != "" && r.Header.Get("Content-Type") != claims.ContentType {
		http.Error(w, "content type does not match transfer credential", http.StatusBadRequest)
		return
	}
	if r.ContentLength >= 0 {
		if claims.ExactSize && r.ContentLength != claims.SizeLimit {
			http.Error(w, "content length does not match transfer credential", http.StatusBadRequest)
			return
		}
		if !claims.ExactSize && claims.SizeLimit > 0 && r.ContentLength > claims.SizeLimit {
			http.Error(w, "content length exceeds transfer credential", http.StatusRequestEntityTooLarge)
			return
		}
	}
	exact, maximum := int64(UnknownObjectSize), int64(UnknownObjectSize)
	if claims.ExactSize {
		exact = claims.SizeLimit
	} else if claims.SizeLimit > 0 {
		maximum = claims.SizeLimit
	}
	attrs, err := s.writeObject(r.Context(), claims.Key, r.Body, claims.CreateOnly, exact, maximum, expectedKeyDigest(claims.Key))
	switch {
	case err == nil:
		w.Header().Set("ETag", `"sha256:`+attrs.SHA256+`"`)
		w.WriteHeader(http.StatusCreated)
	case errors.Is(err, ErrObjectAlreadyExists):
		http.Error(w, "blob object already exists", http.StatusPreconditionFailed)
	case errors.Is(err, ErrStorageFull):
		http.Error(w, "blob storage capacity exceeded", http.StatusInsufficientStorage)
	case errors.Is(err, ErrInvalidUpload):
		http.Error(w, "blob upload failed validation", http.StatusUnprocessableEntity)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		http.Error(w, "blob upload interrupted", http.StatusRequestTimeout)
	default:
		http.Error(w, "blob upload failed", http.StatusInternalServerError)
	}
}

func (s *FilesystemStore) serveDownload(w http.ResponseWriter, r *http.Request, claims transferClaims) {
	reader, err := s.NewReader(r.Context(), claims.Key)
	if errors.Is(err, ErrObjectNotFound) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "blob download failed", http.StatusInternalServerError)
		return
	}
	defer func() { _ = reader.Close() }()
	attrs, err := s.Stat(r.Context(), claims.Key)
	if err != nil {
		http.Error(w, "blob download failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(attrs.Size, 10))
	w.Header().Set("ETag", `"sha256:`+attrs.SHA256+`"`)
	w.Header().Set("Cache-Control", "private, no-store")
	_, _ = io.Copy(w, &contextReader{ctx: r.Context(), reader: reader})
}

var _ Store = (*FilesystemStore)(nil)
var _ CreateOnlyUploadSigner = (*FilesystemStore)(nil)
var _ CreateOnlyPromoter = (*FilesystemStore)(nil)
var _ GenerationPurger = (*FilesystemStore)(nil)
var _ Putter = (*FilesystemStore)(nil)
var _ TransferHandlerProvider = (*FilesystemStore)(nil)
