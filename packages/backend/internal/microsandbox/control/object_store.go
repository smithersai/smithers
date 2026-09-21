package control

import (
	"context"
	"io"
)

// SnapshotObjectStore is the durable, worker-independent snapshot archive.
// Implementations stream data and never buffer a guest disk in controller RAM.
type SnapshotObjectStore interface {
	Put(context.Context, string, io.Reader) (uri, digest string, size int64, err error)
	Open(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}
