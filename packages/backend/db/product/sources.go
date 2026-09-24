package product

import "io/fs"

// MigrationSources returns the embedded, read-only canonical migration files.
// Deployment query generators and schema guards can consume the exact product
// schema in their pinned module without copying or maintaining its DDL.
func MigrationSources() fs.FS { return migrations }
