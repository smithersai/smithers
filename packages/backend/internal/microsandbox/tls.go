package microsandbox

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"strings"
)

// TLSFiles identifies a workload's leaf certificate and private CA bundle.
// Production mounts these from Secret Manager-backed Kubernetes secrets.
type TLSFiles struct {
	CertFile   string
	KeyFile    string
	CAFile     string
	ServerName string
}

func (f TLSFiles) configured() bool {
	return strings.TrimSpace(f.CertFile) != "" || strings.TrimSpace(f.KeyFile) != "" || strings.TrimSpace(f.CAFile) != ""
}

func LoadClientTLSConfig(files TLSFiles) (*tls.Config, error) {
	if !files.configured() {
		return nil, nil
	}
	certificate, roots, err := loadTLSMaterial(files)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		RootCAs:      roots,
		ServerName:   strings.TrimSpace(files.ServerName),
	}, nil
}

func LoadServerTLSConfig(files TLSFiles) (*tls.Config, error) {
	if !files.configured() {
		return nil, nil
	}
	certificate, clientRoots, err := loadTLSMaterial(files)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		ClientCAs:    clientRoots,
		ClientAuth:   tls.RequireAndVerifyClientCert,
	}, nil
}

func loadTLSMaterial(files TLSFiles) (tls.Certificate, *x509.CertPool, error) {
	if strings.TrimSpace(files.CertFile) == "" || strings.TrimSpace(files.KeyFile) == "" || strings.TrimSpace(files.CAFile) == "" {
		return tls.Certificate{}, nil, fmt.Errorf("mTLS requires cert, key, and CA files")
	}
	certificate, err := tls.LoadX509KeyPair(files.CertFile, files.KeyFile)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("load mTLS key pair: %w", err)
	}
	caPEM, err := os.ReadFile(files.CAFile)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("read mTLS CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return tls.Certificate{}, nil, fmt.Errorf("mTLS CA file contains no certificates")
	}
	return certificate, roots, nil
}
