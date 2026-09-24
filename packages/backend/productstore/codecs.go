package productstore

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/database"
)

// ConfigureTypes installs the codecs required by canonical product query
// values. Hosts call this in AfterConnect for pools used by product adapters.
func ConfigureTypes(types *pgtype.Map) { database.ConfigureSQLCTypes(types) }
