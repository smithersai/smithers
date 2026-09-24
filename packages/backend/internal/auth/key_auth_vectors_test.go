package auth

import (
	"encoding/hex"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

func testKeyFromHex(value string) (*secp256k1.PrivateKey, error) {
	raw, err := hex.DecodeString(value)
	if err != nil {
		return nil, err
	}
	return secp256k1.PrivKeyFromBytes(raw), nil
}

// testSign returns an Ethereum [R || S || V] signature with V in {0, 1}.
func testSign(hash []byte, key *secp256k1.PrivateKey) ([]byte, error) {
	compact := ecdsa.SignCompact(key, hash, false)
	sig := make([]byte, keyAuthSignatureLength)
	copy(sig, compact[1:])
	sig[keyAuthRecoveryIDOffset] = compact[0] - 27
	return sig, nil
}

func testHexEncode(data []byte) string { return "0x" + hex.EncodeToString(data) }

// This EIP-191 signature was produced by go-ethereum v1.17.5. Keep a fixed
// external vector so replacing the crypto library also verifies wire parity.
func TestKeyAuthVerifierAcceptsExistingSignature(t *testing.T) {
	const message = "smithers.test wants you to sign in with your Ethereum account:\n0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0\n\nURI: https://smithers.test\nVersion: 1\nChain ID: 1\nNonce: vectornonce01\nIssued At: 2026-01-01T00:00:00Z"
	const signature = "0x49529d38ee5985a5027076990129c3783dadc833d39f7a5a2864e1a792b0c37c436210cc44dae7f4faff6635bf71d83f0bb47ca92a5a988876a8f43abceb6f7000"
	address, nonce, err := NewKeyAuthVerifier().Verify(message, signature, "smithers.test")
	if err != nil {
		t.Fatal(err)
	}
	if address != "0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0" || nonce != "vectornonce01" {
		t.Fatalf("address=%s nonce=%s", address, nonce)
	}
}
