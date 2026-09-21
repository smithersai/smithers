package auth

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

// eip4361DomainSuffix is the EIP-4361 protocol wire format suffix.
// This is part of the signing protocol, not user-facing branding.
const eip4361DomainSuffix = " wants you to sign in with your Ethereum account:"

// keyAuthChainID is the only chain ID accepted in the signed EIP-4361 message.
// Sign in with Key never performs on-chain actions, and every Smithers client
// signs "Chain ID: 1"; binding verification to it prevents signatures minted
// for another chain's context from authenticating here.
const keyAuthChainID = 1

type KeyAuthVerifier struct{}

func NewKeyAuthVerifier() *KeyAuthVerifier {
	return &KeyAuthVerifier{}
}

func (v *KeyAuthVerifier) Verify(message, signature, expectedDomain string) (walletAddress string, nonce string, err error) {
	parsed, err := parseKeyAuthMessage(message)
	if err != nil {
		return "", "", err
	}

	expectedDomain = strings.TrimSpace(expectedDomain)
	if expectedDomain == "" {
		return "", "", fmt.Errorf("key auth expected domain is required")
	}
	if !strings.EqualFold(parsed.domain, expectedDomain) {
		return "", "", fmt.Errorf("key auth domain mismatch: expected %q, got %q", expectedDomain, parsed.domain)
	}

	// The signed URI and chain ID must be bound to the Smithers login context:
	// a message whose URI points at another origin (or a non-web scheme) or
	// whose chain ID is not the fixed sign-in chain was minted for a different
	// context and must not authenticate here, even with a valid signature.
	uriURL, err := url.Parse(parsed.uri)
	if err != nil {
		return "", "", fmt.Errorf("invalid key auth uri: %w", err)
	}
	if uriURL.Scheme != "http" && uriURL.Scheme != "https" {
		return "", "", fmt.Errorf("invalid key auth uri scheme: %q", uriURL.Scheme)
	}
	if !strings.EqualFold(uriURL.Host, expectedDomain) {
		return "", "", fmt.Errorf("key auth uri host mismatch: expected %q, got %q", expectedDomain, uriURL.Host)
	}
	if parsed.chainID != keyAuthChainID {
		return "", "", fmt.Errorf("unsupported key auth chain id: %d", parsed.chainID)
	}

	sig, err := hexutil.Decode(signature)
	if err != nil {
		return "", "", fmt.Errorf("decode key auth signature: %w", err)
	}
	if len(sig) != crypto.SignatureLength {
		return "", "", fmt.Errorf("invalid key auth signature length")
	}
	if sig[crypto.RecoveryIDOffset] >= 27 {
		sig[crypto.RecoveryIDOffset] -= 27
	}
	if sig[crypto.RecoveryIDOffset] > 1 {
		return "", "", fmt.Errorf("invalid key auth recovery id")
	}

	hash := accounts.TextHash([]byte(message))
	pubKey, err := crypto.SigToPub(hash, sig)
	if err != nil {
		return "", "", fmt.Errorf("recover key auth signer: %w", err)
	}

	recoveredAddress := crypto.PubkeyToAddress(*pubKey).Hex()
	if !strings.EqualFold(recoveredAddress, parsed.walletAddress) {
		return "", "", fmt.Errorf("key auth signer does not match message address")
	}

	return recoveredAddress, parsed.nonce, nil
}

type keyAuthParsedMessage struct {
	domain        string
	walletAddress string
	nonce         string
	uri           string
	version       string
	chainID       uint64
}

func parseKeyAuthMessage(message string) (keyAuthParsedMessage, error) {
	lines := strings.Split(message, "\n")
	if len(lines) < 2 {
		return keyAuthParsedMessage{}, fmt.Errorf("invalid key auth message")
	}

	domainLine := strings.TrimSpace(lines[0])
	if !strings.HasSuffix(domainLine, eip4361DomainSuffix) {
		return keyAuthParsedMessage{}, fmt.Errorf("invalid key auth domain line")
	}

	domain := keyAuthMustNonEmptyDomain(strings.TrimSpace(strings.TrimSuffix(domainLine, eip4361DomainSuffix)))

	walletAddress := strings.TrimSpace(lines[1])
	if !common.IsHexAddress(walletAddress) {
		return keyAuthParsedMessage{}, fmt.Errorf("invalid key auth wallet address")
	}

	var nonce, uri, version, chainIDStr string
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "Nonce: "):
			nonce = strings.TrimSpace(strings.TrimPrefix(line, "Nonce: "))
		case strings.HasPrefix(line, "URI: "):
			uri = strings.TrimSpace(strings.TrimPrefix(line, "URI: "))
		case strings.HasPrefix(line, "Version: "):
			version = strings.TrimSpace(strings.TrimPrefix(line, "Version: "))
		case strings.HasPrefix(line, "Chain ID: "):
			chainIDStr = strings.TrimSpace(strings.TrimPrefix(line, "Chain ID: "))
		}
	}

	if uri == "" {
		return keyAuthParsedMessage{}, fmt.Errorf("missing key auth uri")
	}

	if version == "" {
		return keyAuthParsedMessage{}, fmt.Errorf("missing key auth version")
	}
	if version != "1" {
		return keyAuthParsedMessage{}, fmt.Errorf("invalid key auth version: must be 1, got %q", version)
	}

	if chainIDStr == "" {
		return keyAuthParsedMessage{}, fmt.Errorf("missing key auth chain id")
	}
	chainID, err := strconv.ParseUint(chainIDStr, 10, 64)
	if err != nil || chainID == 0 {
		return keyAuthParsedMessage{}, fmt.Errorf("invalid key auth chain id: %q", chainIDStr)
	}

	if nonce == "" {
		return keyAuthParsedMessage{}, fmt.Errorf("missing key auth nonce")
	}

	return keyAuthParsedMessage{
		domain:        domain,
		walletAddress: walletAddress,
		nonce:         nonce,
		uri:           uri,
		version:       version,
		chainID:       chainID,
	}, nil
}

func keyAuthMustNonEmptyDomain(domain string) string {
	if strings.TrimSpace(domain) == "" {
		panic("missing key auth domain after valid EIP-4361 suffix")
	}
	return domain
}
