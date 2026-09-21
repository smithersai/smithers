package ironproxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestParseCAAcceptsAGeneratedCA(t *testing.T) {
	generated, err := GenerateCA("test-egress", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseCA(generated.CertPEM, generated.KeyPEM)
	if err != nil {
		t.Fatalf("ParseCA: %v", err)
	}
	if string(parsed.CertPEM) != string(generated.CertPEM) || string(parsed.KeyPEM) != string(generated.KeyPEM) {
		t.Fatal("ParseCA must return the material it validated, unchanged")
	}
}

func TestParseCAFailsClosed(t *testing.T) {
	a, err := GenerateCA("a", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	b, err := GenerateCA("b", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	expired, err := generateCAAt("expired", time.Now().Add(-48*time.Hour), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		cert []byte
		key  []byte
		want string
	}{
		{"empty cert", nil, a.KeyPEM, "certificate"},
		{"empty key", a.CertPEM, nil, "key"},
		{"not pem", []byte("garbage"), a.KeyPEM, "certificate"},
		{"key mismatch", a.CertPEM, b.KeyPEM, "does not match"},
		{"expired", expired.CertPEM, expired.KeyPEM, "expired"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseCA(tc.cert, tc.key); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
}

func TestParseCARejectsALeafCertificate(t *testing.T) {
	ca, err := GenerateCA("root", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	leafCert, leafKey, err := issueLeafForTest(ca)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseCA(leafCert, leafKey); err == nil || !strings.Contains(err.Error(), "not a CA") {
		t.Fatalf("a leaf certificate must be refused, got %v", err)
	}
}

// issueLeafForTest signs a non-CA certificate with ca so ParseCA can be shown
// to refuse it.
func issueLeafForTest(ca CA) (certPEM, keyPEM []byte, err error) {
	caBlock, _ := pem.Decode(ca.CertPEM)
	caCert, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	caKeyBlock, _ := pem.Decode(ca.KeyPEM)
	caKey, err := x509.ParseECPrivateKey(caKeyBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "leaf"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), nil
}
