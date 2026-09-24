// Package githubrepo validates GitHub repository references shared by the
// mirror runtime and repository config sync, so both accept the same inputs.
package githubrepo

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var (
	ownerSegment   = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
	repositoryName = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
)

// NormalizeRef lowercases and validates an owner/repository pair.
func NormalizeRef(owner, repo string) (string, string, error) {
	normalizedOwner := strings.ToLower(strings.TrimSpace(owner))
	normalizedRepo := strings.ToLower(strings.TrimSpace(repo))
	if normalizedOwner == "" {
		return "", "", errors.New("owner is required")
	}
	if normalizedRepo == "" {
		return "", "", errors.New("repository name is required")
	}
	if !ownerSegment.MatchString(normalizedOwner) || len(normalizedOwner) > 255 {
		return "", "", errors.New("invalid owner")
	}
	// GitHub repository names use a slightly broader namespace than local
	// Smithers repositories. In particular, leading-dot repositories such as
	// the well-known .github repository are valid source references.
	if normalizedRepo == "." || normalizedRepo == ".." ||
		!repositoryName.MatchString(normalizedRepo) || len(normalizedRepo) > 100 {
		return "", "", errors.New("invalid repository name")
	}
	return normalizedOwner, normalizedRepo, nil
}

// ParseMirrorDestination accepts owner/repo or an HTTPS github.com URL and
// returns the normalized owner and repository.
func ParseMirrorDestination(value string) (string, string, error) {
	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", "", errors.New("Mirror destination must name an HTTPS GitHub repository")
		}
		value = strings.TrimPrefix(parsed.Path, "/")
	}
	parts := strings.Split(strings.TrimSuffix(strings.TrimSuffix(value, "/"), ".git"), "/")
	if len(parts) != 2 {
		return "", "", errors.New("Mirror destination must name owner/repository")
	}
	return NormalizeRef(parts[0], parts[1])
}
