package lfsauth

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// BridgeConfig is shared by the SSH issuer and HTTP verifier. PublicBaseURL
// must be the trusted external HTTP(S) server base; it is never inferred from
// an SSH client or HTTP Host header.
type BridgeConfig struct {
	Secret        string
	PublicBaseURL string
	TokenTTL      time.Duration
}

// Bridge couples token issuance with the exact HTTP LFS endpoint the SSH
// response advertises, preventing the issuer and verifier from drifting onto
// different secrets or URL contracts.
type Bridge struct {
	manager       *Manager
	publicBaseURL string
	tokenTTL      time.Duration
}

type AuthenticateResponse struct {
	Href      string            `json:"href"`
	Header    map[string]string `json:"header"`
	ExpiresIn int64             `json:"expires_in"`
}

func NewBridge(cfg BridgeConfig) (*Bridge, error) {
	manager, err := NewManager(cfg.Secret)
	if err != nil {
		return nil, err
	}
	base, err := validatePublicBaseURL(cfg.PublicBaseURL)
	if err != nil {
		return nil, err
	}
	ttl := cfg.TokenTTL
	if ttl == 0 {
		ttl = DefaultTokenTTL
	}
	if ttl < time.Second || ttl > MaximumTokenTTL || ttl%time.Second != 0 {
		return nil, fmt.Errorf("lfs auth token ttl must be whole seconds between 1s and %s", MaximumTokenTTL)
	}
	return &Bridge{manager: manager, publicBaseURL: base, tokenTTL: ttl}, nil
}

func (b *Bridge) Manager() *Manager {
	if b == nil {
		return nil
	}
	return b.manager
}

func (b *Bridge) Issue(grant Grant) (AuthenticateResponse, Claims, error) {
	if b == nil || b.manager == nil {
		return AuthenticateResponse{}, Claims{}, errors.New("lfs auth bridge is not configured")
	}
	token, claims, err := b.manager.Issue(grant, b.tokenTTL)
	if err != nil {
		return AuthenticateResponse{}, Claims{}, err
	}
	return AuthenticateResponse{
		Href: b.publicBaseURL + "/api/repos/" + url.PathEscape(claims.Owner) + "/" + url.PathEscape(claims.Repository) + "/lfs",
		Header: map[string]string{
			"Authorization": AuthorizationValue(token),
		},
		ExpiresIn: int64(b.tokenTTL / time.Second),
	}, claims, nil
}

func validatePublicBaseURL(raw string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(raw), "/")
	if base == "" {
		return "", errors.New("lfs public base url is required")
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("lfs public base url must be a trusted http(s) URL without credentials, query, or fragment")
	}
	return base, nil
}
