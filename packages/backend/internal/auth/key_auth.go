package auth

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"encoding/hex"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"golang.org/x/crypto/sha3"
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

	sig, err := decodeKeyAuthHex(signature)
	if err != nil {
		return "", "", fmt.Errorf("decode key auth signature: %w", err)
	}
	if len(sig) != keyAuthSignatureLength {
		return "", "", fmt.Errorf("invalid key auth signature length")
	}
	if sig[keyAuthRecoveryIDOffset] >= 27 {
		sig[keyAuthRecoveryIDOffset] -= 27
	}
	if sig[keyAuthRecoveryIDOffset] > 1 {
		return "", "", fmt.Errorf("invalid key auth recovery id")
	}

	// Ethereum signs [R || S || V]; the compact form is [27+V || R || S].
	compact := make([]byte, keyAuthSignatureLength)
	compact[0] = 27 + sig[keyAuthRecoveryIDOffset]
	copy(compact[1:], sig[:keyAuthRecoveryIDOffset])
	pubKey, _, err := ecdsa.RecoverCompact(compact, keyAuthTextHash([]byte(message)))
	if err != nil {
		return "", "", fmt.Errorf("recover key auth signer: %w", err)
	}

	recoveredAddress := keyAuthAddress(pubKey)
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
	if !isKeyAuthHexAddress(walletAddress) {
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

const (
	keyAuthSignatureLength  = 65
	keyAuthRecoveryIDOffset = 64
)

func keccak256(data ...[]byte) []byte {
	hash := sha3.NewLegacyKeccak256()
	for _, chunk := range data {
		hash.Write(chunk)
	}
	return hash.Sum(nil)
}

// keyAuthTextHash is the EIP-191 personal_sign digest.
func keyAuthTextHash(message []byte) []byte {
	return keccak256([]byte(fmt.Sprintf("\x19Ethereum Signed Message:\n%d", len(message))), message)
}

// keyAuthAddress returns the EIP-55 checksummed address of a public key.
func keyAuthAddress(pubKey *secp256k1.PublicKey) string {
	address := hex.EncodeToString(keccak256(pubKey.SerializeUncompressed()[1:])[12:])
	checksum := hex.EncodeToString(keccak256([]byte(address)))
	out := []byte(address)
	for i, c := range out {
		if c >= 'a' && c <= 'f' && checksum[i] >= '8' {
			out[i] = c - 'a' + 'A'
		}
	}
	return "0x" + string(out)
}

// isKeyAuthHexAddress accepts 20 hex bytes with an optional 0x prefix.
func isKeyAuthHexAddress(value string) bool {
	if len(value) >= 2 && value[0] == '0' && (value[1] == 'x' || value[1] == 'X') {
		value = value[2:]
	}
	if len(value) != 40 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// decodeKeyAuthHex decodes a 0x-prefixed hex string.
func decodeKeyAuthHex(value string) ([]byte, error) {
	if value == "" {
		return nil, fmt.Errorf("empty hex string")
	}
	if len(value) < 2 || value[0] != '0' || (value[1] != 'x' && value[1] != 'X') {
		return nil, fmt.Errorf("hex string without 0x prefix")
	}
	return hex.DecodeString(value[2:])
}
