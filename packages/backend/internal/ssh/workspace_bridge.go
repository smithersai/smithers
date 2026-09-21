package ssh

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/coder/websocket"
	gliderssh "github.com/gliderlabs/ssh"
	gossh "golang.org/x/crypto/ssh"

	msb "github.com/smithersai/smithers/packages/backend/internal/microsandbox"
	"github.com/smithersai/smithers/packages/backend/internal/observability"
)

const workspaceAccessKey contextKey = "workspace-access"

var ErrWorkspaceAccessDenied = errors.New("workspace access denied")

// WorkspaceAccess is the non-persisted credential material for one public SSH
// connection. Token must never be logged or included in an error.
type WorkspaceAccess struct {
	SandboxID string
	User      string
	Token     string
}

// WorkspaceBridge validates a Plue access grant and proxies an authenticated
// public session into the guest's private Microsandbox SSH server.
type WorkspaceBridge interface {
	Validate(context.Context, WorkspaceAccess) error
	Serve(gliderssh.Session, WorkspaceAccess) (int, error)
}

type ControllerWorkspaceBridgeConfig struct {
	ControllerURL  string
	HTTPClient     *http.Client
	PrivateKeyFile string
}

type ControllerWorkspaceBridge struct {
	controllerURL string
	httpClient    *http.Client
	signer        gossh.Signer
}

func NewControllerWorkspaceBridge(config ControllerWorkspaceBridgeConfig) (*ControllerWorkspaceBridge, error) {
	controllerURL := strings.TrimRight(strings.TrimSpace(config.ControllerURL), "/")
	parsed, err := url.Parse(controllerURL)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return nil, fmt.Errorf("invalid Microsandbox controller URL")
	}
	privateKey, err := os.ReadFile(strings.TrimSpace(config.PrivateKeyFile))
	if err != nil {
		return nil, fmt.Errorf("read workspace SSH bridge key: %w", err)
	}
	signer, err := gossh.ParsePrivateKey(privateKey)
	if err != nil {
		return nil, fmt.Errorf("parse workspace SSH bridge key: %w", err)
	}
	client := config.HTTPClient
	if client == nil {
		client = observability.NewHTTPClient(0)
	}
	return &ControllerWorkspaceBridge{controllerURL: controllerURL, httpClient: client, signer: signer}, nil
}

func (b *ControllerWorkspaceBridge) Validate(ctx context.Context, access WorkspaceAccess) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	payload, err := json.Marshal(msb.AccessValidationRequest{
		SandboxID: access.SandboxID,
		Token:     access.Token,
		User:      access.User,
		Protocol:  "ssh",
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, b.controllerURL+"/internal/v1/access/validate", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := b.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("validate workspace access: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
		return ErrWorkspaceAccessDenied
	}
	var validation msb.AccessValidationResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&validation); err != nil {
		return fmt.Errorf("decode workspace access validation: %w", err)
	}
	if !validation.Allowed || validation.SandboxID != access.SandboxID {
		return ErrWorkspaceAccessDenied
	}
	return nil
}

func (b *ControllerWorkspaceBridge) Serve(session gliderssh.Session, access WorkspaceAccess) (int, error) {
	endpoint, err := url.Parse(b.controllerURL + "/v1/sandboxes/" + url.PathEscape(access.SandboxID) + "/ssh")
	if err != nil {
		return 1, err
	}
	switch endpoint.Scheme {
	case "http":
		endpoint.Scheme = "ws"
	case "https":
		endpoint.Scheme = "wss"
	default:
		return 1, errors.New("unsupported Microsandbox controller scheme")
	}
	query := endpoint.Query()
	query.Set("user", access.User)
	endpoint.RawQuery = query.Encode()
	headers := http.Header{}
	headers.Set("X-Plue-Access-Token", access.Token)
	socket, response, err := websocket.Dial(session.Context(), endpoint.String(), &websocket.DialOptions{
		HTTPClient: b.httpClient,
		HTTPHeader: headers,
	})
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return 1, fmt.Errorf("open private workspace stream: %w", err)
	}
	defer func() { _ = socket.CloseNow() }()
	stream := websocket.NetConn(session.Context(), socket, websocket.MessageBinary)
	defer func() { _ = stream.Close() }()

	// The outer WebSocket is mutually authenticated and placement-fenced. The
	// guest host key is intentionally not used as a second trust root because it
	// is ephemeral and never leaves the private worker; accepting it here does
	// not weaken the mTLS worker identity that selected the stream.
	clientConfig := &gossh.ClientConfig{
		User:            access.User,
		Auth:            []gossh.AuthMethod{gossh.PublicKeys(b.signer)},
		HostKeyCallback: func(string, net.Addr, gossh.PublicKey) error { return nil },
		Timeout:         15 * time.Second,
	}
	connection, channels, requests, err := gossh.NewClientConn(stream, "microsandbox-private", clientConfig)
	if err != nil {
		return 1, fmt.Errorf("authenticate private workspace SSH: %w", err)
	}
	client := gossh.NewClient(connection, channels, requests)
	defer func() { _ = client.Close() }()
	inner, err := client.NewSession()
	if err != nil {
		return 1, fmt.Errorf("open private workspace session: %w", err)
	}
	defer func() { _ = inner.Close() }()
	inner.Stdin = session
	inner.Stdout = session
	inner.Stderr = session.Stderr()

	if pty, windows, ok := session.Pty(); ok {
		if err := inner.RequestPty(pty.Term, pty.Window.Height, pty.Window.Width, gossh.TerminalModes{}); err != nil {
			return 1, fmt.Errorf("request private workspace pty: %w", err)
		}
		go forwardWindowChanges(session.Context(), inner, windows)
	}
	signals := make(chan gliderssh.Signal, 8)
	session.Signals(signals)
	defer session.Signals(nil)
	go forwardSignals(session.Context(), inner, signals)

	if session.RawCommand() == "" {
		err = inner.Shell()
	} else {
		err = inner.Start(session.RawCommand())
	}
	if err != nil {
		return 1, fmt.Errorf("start private workspace session: %w", err)
	}
	err = inner.Wait()
	var exitError *gossh.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitStatus(), nil
	}
	if err != nil {
		return 1, err
	}
	return 0, nil
}

func forwardWindowChanges(ctx context.Context, session *gossh.Session, windows <-chan gliderssh.Window) {
	for {
		select {
		case <-ctx.Done():
			return
		case window, ok := <-windows:
			if !ok {
				return
			}
			_ = session.WindowChange(window.Height, window.Width)
		}
	}
}

func forwardSignals(ctx context.Context, session *gossh.Session, signals <-chan gliderssh.Signal) {
	for {
		select {
		case <-ctx.Done():
			return
		case signal, ok := <-signals:
			if !ok {
				return
			}
			_ = session.Signal(gossh.Signal(signal))
		}
	}
}

func parseWorkspacePublicKeyLogin(login string) (WorkspaceAccess, bool) {
	separator := strings.LastIndexByte(login, ':')
	if separator < 0 {
		return WorkspaceAccess{}, false
	}
	return parseWorkspaceLogin(login[:separator], login[separator+1:])
}

func parseWorkspacePasswordLogin(login, password string) (WorkspaceAccess, bool) {
	if strings.Contains(login, ":") {
		return WorkspaceAccess{}, false
	}
	return parseWorkspaceLogin(login, password)
}

func parseWorkspaceLogin(login, token string) (WorkspaceAccess, bool) {
	separator := strings.IndexByte(login, '+')
	if separator <= 0 || separator == len(login)-1 {
		return WorkspaceAccess{}, false
	}
	sandboxID, user := login[:separator], login[separator+1:]
	if !strings.HasPrefix(sandboxID, "msb_") || len(sandboxID) > 128 || !safeSSHIdentifier(sandboxID) || !safeSSHIdentifier(user) {
		return WorkspaceAccess{}, false
	}
	token = strings.TrimSpace(token)
	if len(token) < 20 || len(token) > 1024 || strings.IndexFunc(token, unicode.IsSpace) >= 0 {
		return WorkspaceAccess{}, false
	}
	return WorkspaceAccess{SandboxID: sandboxID, User: user, Token: token}, true
}

func safeSSHIdentifier(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !(unicode.IsLetter(character) || unicode.IsDigit(character) || character == '_' || character == '-') {
			return false
		}
	}
	return true
}
