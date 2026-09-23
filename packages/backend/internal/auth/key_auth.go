package auth

import "errors"

// KeyAuthVerifier is kept as a typed seam for deployments that provide wallet
// authentication. The self-hosted product does not advertise that capability;
// Plue owns the implementation in its private module.
type KeyAuthVerifier struct{}

func NewKeyAuthVerifier() *KeyAuthVerifier { return &KeyAuthVerifier{} }

func (*KeyAuthVerifier) Verify(string, string, string) (string, string, error) {
	return "", "", errors.New("key authentication is unavailable in this deployment")
}
