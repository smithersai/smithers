package testkit

import "github.com/smithersai/smithers/packages/backend/internal/blob"

func MemoryBlobs() *blob.MemoryStore { return blob.NewMemoryStore() }
