package services

import (
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MythicalBookmark is the repository's mythical stack. Only the stack service
// moves it: landings, the bookmark routes and every push refuse it (the
// receive-pack side is repohost.ControlPlaneRefViolation).
const MythicalBookmark = "mythical"

var errMythicalBookmarkOwned = pkgerrors.Forbidden("the mythical bookmark is written only by the stack service")
