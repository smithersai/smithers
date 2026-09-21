package ironproxy

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"time"
)

// CA is a PEM-encoded MITM certificate authority.
type CA struct {
	CertPEM []byte
	KeyPEM  []byte
}

// GenerateCA mints an ECDSA P-256 CA for the proxy's TLS interception.
// Production workers load the cluster-wide CA from the mounted secret
// (ParseCA); per-boot generation is the local-development path only, because
// a CA that lives in one worker's memory stops being trusted by every guest
// the moment that worker restarts.
func GenerateCA(commonName string, validity time.Duration) (CA, error) {
	return generateCAAt(commonName, time.Now(), validity)
}

func generateCAAt(commonName string, now time.Time, validity time.Duration) (CA, error) {
	if validity <= 0 {
		validity = 30 * 24 * time.Hour
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return CA{}, fmt.Errorf("generate CA key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return CA{}, fmt.Errorf("generate CA serial: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: commonName, Organization: []string{"Smithers sandbox egress"}},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(validity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign | x509.KeyUsageDigitalSignature,
		MaxPathLenZero:        true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return CA{}, fmt.Errorf("create CA certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return CA{}, fmt.Errorf("marshal CA key: %w", err)
	}
	return CA{
		CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		KeyPEM:  pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
	}, nil
}

// ParseCA validates cluster-wide CA material before a worker hands it to
// iron-proxy: both halves must be PEM, the certificate must be a CA that is
// currently valid, and the key must be the certificate's key. Anything else
// is refused so a worker never starts proxies guests cannot trust. The bytes
// are returned unchanged so the file iron-proxy reads is exactly the secret.
func ParseCA(certPEM, keyPEM []byte) (CA, error) {
	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil || certBlock.Type != "CERTIFICATE" {
		return CA{}, errors.New("egress CA certificate is not a PEM CERTIFICATE block")
	}
	cert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return CA{}, fmt.Errorf("parse egress CA certificate: %w", err)
	}
	if !cert.IsCA || !cert.BasicConstraintsValid {
		return CA{}, errors.New("egress CA certificate is not a CA (basicConstraints CA:TRUE required)")
	}
	if cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		return CA{}, errors.New("egress CA certificate lacks the keyCertSign usage")
	}
	now := time.Now()
	if now.After(cert.NotAfter) {
		return CA{}, fmt.Errorf("egress CA certificate expired at %s", cert.NotAfter.UTC().Format(time.RFC3339))
	}
	if now.Before(cert.NotBefore) {
		return CA{}, fmt.Errorf("egress CA certificate is not valid until %s", cert.NotBefore.UTC().Format(time.RFC3339))
	}
	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return CA{}, errors.New("egress CA key is not a PEM block")
	}
	key, err := parsePrivateKey(keyBlock)
	if err != nil {
		return CA{}, fmt.Errorf("parse egress CA key: %w", err)
	}
	if !key.PublicKey.Equal(cert.PublicKey) {
		return CA{}, errors.New("egress CA key does not match the certificate")
	}
	return CA{CertPEM: certPEM, KeyPEM: keyPEM}, nil
}

// parsePrivateKey accepts the two encodings openssl and Go produce for an
// EC key: SEC 1 ("EC PRIVATE KEY") and PKCS #8 ("PRIVATE KEY").
func parsePrivateKey(block *pem.Block) (*ecdsa.PrivateKey, error) {
	switch block.Type {
	case "EC PRIVATE KEY":
		return x509.ParseECPrivateKey(block.Bytes)
	case "PRIVATE KEY":
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		key, ok := parsed.(*ecdsa.PrivateKey)
		if !ok {
			return nil, errors.New("egress CA key must be an ECDSA key")
		}
		return key, nil
	default:
		return nil, fmt.Errorf("unsupported egress CA key PEM type %q", block.Type)
	}
}
