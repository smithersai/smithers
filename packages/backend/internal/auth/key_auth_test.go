package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestKeyAuthVerifier_Verify(t *testing.T) {
	t.Parallel()

	privateKey, err := crypto.HexToECDSA("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f9f6e2b7fbc1f8f9af")
	require.NoError(t, err)

	expectedAddress := crypto.PubkeyToAddress(privateKey.PublicKey).Hex()
	nonce := "a1b2c3d4"
	issuedAt := time.Date(2026, time.February, 19, 12, 0, 0, 0, time.UTC).Format(time.RFC3339)
	message := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 1",
		"Chain ID: 1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")

	hash := accounts.TextHash([]byte(message))
	sig, err := crypto.Sign(hash, privateKey)
	require.NoError(t, err)
	signature := hexutil.Encode(sig)
	legacySig := append([]byte(nil), sig...)
	legacySig[crypto.RecoveryIDOffset] += 27
	legacySignature := hexutil.Encode(legacySig)
	invalidRecoverySig := append([]byte(nil), sig...)
	invalidRecoverySig[crypto.RecoveryIDOffset] = 2
	invalidRecoverySignature := hexutil.Encode(invalidRecoverySig)
	messageMissingNonce := strings.Replace(message, "Nonce: "+nonce+"\n", "", 1)
	messageInvalidAddress := strings.Replace(message, expectedAddress, "0x123", 1)

	// Build message with a different key so signature recovery gives wrong address
	otherKey, err := crypto.HexToECDSA("6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1")
	require.NoError(t, err)
	otherHash := accounts.TextHash([]byte(message))
	otherSig, err := crypto.Sign(otherHash, otherKey)
	require.NoError(t, err)
	signerMismatchSignature := hexutil.Encode(otherSig)

	// Message where first line doesn't have the EIP-4361 suffix
	messageWrongDomainLine := strings.Join([]string{
		"some random first line",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"Nonce: " + nonce,
	}, "\n")

	// Message where domain is empty but suffix is present
	messageEmptyDomain := strings.Join([]string{
		" wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"Nonce: " + nonce,
	}, "\n")

	testCases := []struct {
		name           string
		message        string
		signature      string
		expectedDomain string
		wantAddress    string
		wantNonce      string
		wantErr        bool
	}{
		{
			name:           "valid message and signature",
			message:        message,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantAddress:    expectedAddress,
			wantNonce:      nonce,
		},
		{
			name:           "malformed key auth message",
			message:        "not a key auth message",
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "invalid signature",
			message:        message,
			signature:      "0x00" + signature[4:],
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "invalid recovery id variant",
			message:        message,
			signature:      invalidRecoverySignature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "legacy recovery id variant",
			message:        message,
			signature:      legacySignature,
			expectedDomain: "localhost:4000",
			wantAddress:    expectedAddress,
			wantNonce:      nonce,
		},
		{
			name:           "expected domain mismatch",
			message:        message,
			signature:      signature,
			expectedDomain: "smithers.sh",
			wantErr:        true,
		},
		{
			name:           "empty expected domain rejected",
			message:        message,
			signature:      signature,
			expectedDomain: "",
			wantErr:        true,
		},
		{
			name:           "missing nonce",
			message:        messageMissingNonce,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "invalid wallet address",
			message:        messageInvalidAddress,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "non-hex signature rejected",
			message:        message,
			signature:      "0xZZZZZZZZZZ",
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "wrong length signature rejected",
			message:        message,
			signature:      "0xdeadbeef",
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "signer does not match message address",
			message:        message,
			signature:      signerMismatchSignature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "domain line without EIP-4361 suffix",
			message:        messageWrongDomainLine,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		{
			name:           "empty domain in message",
			message:        messageEmptyDomain,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
	}

	// Messages missing EIP-4361 required fields
	messageMissingURI := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"Version: 1",
		"Chain ID: 1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")
	messageMissingVersion := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Chain ID: 1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")
	messageMissingChainID := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")
	messageInvalidVersion := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 2",
		"Chain ID: 1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")
	messageInvalidChainID := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 1",
		"Chain ID: abc",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")
	messageNegativeChainID := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 1",
		"Chain ID: -1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")
	messageEmptyURI := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		expectedAddress,
		"",
		"Sign in to Smithers",
		"",
		"URI: ",
		"Version: 1",
		"Chain ID: 1",
		"Nonce: " + nonce,
		"Issued At: " + issuedAt,
	}, "\n")

	testCases = append(testCases,
		struct {
			name           string
			message        string
			signature      string
			expectedDomain string
			wantAddress    string
			wantNonce      string
			wantErr        bool
		}{
			name:           "missing URI rejected",
			message:        messageMissingURI,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		struct {
			name           string
			message        string
			signature      string
			expectedDomain string
			wantAddress    string
			wantNonce      string
			wantErr        bool
		}{
			name:           "missing version rejected",
			message:        messageMissingVersion,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		struct {
			name           string
			message        string
			signature      string
			expectedDomain string
			wantAddress    string
			wantNonce      string
			wantErr        bool
		}{
			name:           "missing chain ID rejected",
			message:        messageMissingChainID,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		struct {
			name           string
			message        string
			signature      string
			expectedDomain string
			wantAddress    string
			wantNonce      string
			wantErr        bool
		}{
			name:           "invalid version rejected",
			message:        messageInvalidVersion,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		struct {
			name           string
			message        string
			signature      string
			expectedDomain string
			wantAddress    string
			wantNonce      string
			wantErr        bool
		}{
			name:           "non-numeric chain ID rejected",
			message:        messageInvalidChainID,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		struct {
			name           string
			message        string
			signature      string
			expectedDomain string
			wantAddress    string
			wantNonce      string
			wantErr        bool
		}{
			name:           "negative chain ID rejected",
			message:        messageNegativeChainID,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
		struct {
			name           string
			message        string
			signature      string
			expectedDomain string
			wantAddress    string
			wantNonce      string
			wantErr        bool
		}{
			name:           "empty URI rejected",
			message:        messageEmptyURI,
			signature:      signature,
			expectedDomain: "localhost:4000",
			wantErr:        true,
		},
	)

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			verifier := NewKeyAuthVerifier()
			walletAddress, gotNonce, err := verifier.Verify(tc.message, tc.signature, tc.expectedDomain)
			if tc.wantErr {
				require.Error(t, err)
				return
			}

			require.NoError(t, err)
			assert.Equal(t, tc.wantAddress, walletAddress)
			assert.Equal(t, tc.wantNonce, gotNonce)
		})
	}
}

func TestKeyAuthVerifier_Verify_URIAndChainBinding(t *testing.T) {
	t.Parallel()

	privateKey, err := crypto.HexToECDSA("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f9f6e2b7fbc1f8f9af")
	require.NoError(t, err)
	address := crypto.PubkeyToAddress(privateKey.PublicKey).Hex()

	buildAndSign := func(t *testing.T, uri, chainID string) (string, string) {
		t.Helper()
		msg := strings.Join([]string{
			"smithers.sh wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: " + uri,
			"Version: 1",
			"Chain ID: " + chainID,
			"Nonce: a1b2c3d4",
			"Issued At: 2026-02-19T12:00:00Z",
		}, "\n")
		sig, err := crypto.Sign(accounts.TextHash([]byte(msg)), privateKey)
		require.NoError(t, err)
		return msg, hexutil.Encode(sig)
	}

	testCases := []struct {
		name    string
		uri     string
		chainID string
		wantErr string
	}{
		{
			name:    "matching https URI and chain 1 accepted",
			uri:     "https://smithers.sh",
			chainID: "1",
		},
		{
			name:    "URI with path on the login origin accepted",
			uri:     "https://smithers.sh/login",
			chainID: "1",
		},
		{
			name:    "URI host case-insensitive match accepted",
			uri:     "https://SMITHERS.SH",
			chainID: "1",
		},
		{
			name:    "URI for another origin rejected",
			uri:     "https://evil.example.com",
			chainID: "1",
			wantErr: "key auth uri host mismatch",
		},
		{
			name:    "URI with unexpected port rejected",
			uri:     "https://smithers.sh:8443",
			chainID: "1",
			wantErr: "key auth uri host mismatch",
		},
		{
			name:    "non-web URI scheme rejected",
			uri:     "javascript://smithers.sh",
			chainID: "1",
			wantErr: "invalid key auth uri scheme",
		},
		{
			name:    "relative URI without host rejected",
			uri:     "smithers.sh",
			chainID: "1",
			wantErr: "invalid key auth uri scheme",
		},
		{
			name:    "unsupported chain id rejected",
			uri:     "https://smithers.sh",
			chainID: "137",
			wantErr: "unsupported key auth chain id",
		},
	}

	for _, tc := range testCases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			message, signature := buildAndSign(t, tc.uri, tc.chainID)
			verifier := NewKeyAuthVerifier()
			walletAddress, nonce, err := verifier.Verify(message, signature, "smithers.sh")
			if tc.wantErr != "" {
				require.Error(t, err)
				assert.Contains(t, err.Error(), tc.wantErr)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, address, walletAddress)
			assert.Equal(t, "a1b2c3d4", nonce)
		})
	}
}

func TestParseKeyAuthMessage_EIP4361Fields(t *testing.T) {
	t.Parallel()

	address := "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"

	validMessage := strings.Join([]string{
		"localhost:4000 wants you to sign in with your Ethereum account:",
		address,
		"",
		"Sign in to Smithers",
		"",
		"URI: http://localhost:4000",
		"Version: 1",
		"Chain ID: 1",
		"Nonce: abc123",
		"Issued At: 2026-02-19T12:00:00Z",
	}, "\n")

	t.Run("valid message returns all EIP-4361 fields", func(t *testing.T) {
		t.Parallel()
		parsed, err := parseKeyAuthMessage(validMessage)
		require.NoError(t, err)
		assert.Equal(t, "localhost:4000", parsed.domain)
		assert.Equal(t, address, parsed.walletAddress)
		assert.Equal(t, "abc123", parsed.nonce)
		assert.Equal(t, "http://localhost:4000", parsed.uri)
		assert.Equal(t, "1", parsed.version)
		assert.Equal(t, uint64(1), parsed.chainID)
	})

	t.Run("missing URI returns error", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"Version: 1",
			"Chain ID: 1",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "missing key auth uri")
	})

	t.Run("empty URI returns error", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: ",
			"Version: 1",
			"Chain ID: 1",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "missing key auth uri")
	})

	t.Run("missing version returns error", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: http://localhost:4000",
			"Chain ID: 1",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "missing key auth version")
	})

	t.Run("version must be exactly 1", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: http://localhost:4000",
			"Version: 2",
			"Chain ID: 1",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid key auth version")
	})

	t.Run("missing chain ID returns error", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: http://localhost:4000",
			"Version: 1",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "missing key auth chain id")
	})

	t.Run("non-numeric chain ID returns error", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: http://localhost:4000",
			"Version: 1",
			"Chain ID: abc",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid key auth chain id")
	})

	t.Run("negative chain ID returns error", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: http://localhost:4000",
			"Version: 1",
			"Chain ID: -1",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid key auth chain id")
	})

	t.Run("zero chain ID returns error", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: http://localhost:4000",
			"Version: 1",
			"Chain ID: 0",
			"Nonce: abc123",
		}, "\n")
		_, err := parseKeyAuthMessage(msg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid key auth chain id")
	})

	t.Run("chain ID 137 (polygon) is valid", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"localhost:4000 wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: http://localhost:4000",
			"Version: 1",
			"Chain ID: 137",
			"Nonce: abc123",
		}, "\n")
		parsed, err := parseKeyAuthMessage(msg)
		require.NoError(t, err)
		assert.Equal(t, uint64(137), parsed.chainID)
	})

	t.Run("URI with https scheme is valid", func(t *testing.T) {
		t.Parallel()
		msg := strings.Join([]string{
			"smithers.sh wants you to sign in with your Ethereum account:",
			address,
			"",
			"Sign in to Smithers",
			"",
			"URI: https://smithers.sh",
			"Version: 1",
			"Chain ID: 1",
			"Nonce: abc123",
		}, "\n")
		parsed, err := parseKeyAuthMessage(msg)
		require.NoError(t, err)
		assert.Equal(t, "https://smithers.sh", parsed.uri)
	})
}
