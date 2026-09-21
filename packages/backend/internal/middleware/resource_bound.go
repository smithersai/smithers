package middleware

// IsResourceBound reports whether this token carries any resource binding:
// a repository restriction (repo:), an agent-session restriction
// (agent-session:), a path allowlist (path:), or a workspace restriction
// (workspace:). Per-run sandbox tokens and workspace head tokens carry these
// so a leaked credential cannot act outside its task.
//
// The bindings are inert scope entries (ParseTokenScopes drops them), so any
// surface that forwards only the parsed permission scopes silently unbinds
// the token. Surfaces that mint a new credential from the caller's scopes
// (OAuth2 authorization codes) must refuse bound callers instead. Session
// callers are never bound. The predicate reuses the same parsers the
// enforcing routes use, so it is true exactly when some route treats the
// token as restricted.
func (a *AuthInfo) IsResourceBound() bool {
	if a == nil || !a.IsTokenAuth {
		return false
	}
	if a.RepositoryRestriction() != 0 {
		return true
	}
	if ParseTokenAgentSessionRestriction(a.RawScopes) != "" {
		return true
	}
	if len(ParseTokenPathRestrictions(a.RawScopes)) > 0 {
		return true
	}
	return a.WorkspaceRestriction() != ""
}
