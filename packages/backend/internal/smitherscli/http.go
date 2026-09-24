package smitherscli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// maxAPIResponseBytes bounds every buffered API response body.
const maxAPIResponseBytes = 4 << 20

// Timeouts for every CLI HTTP request. They are variables so tests can shrink
// them. apiRequestTimeout bounds a whole buffered request; a streaming request
// (SSE logs, workspace events) is bounded only by the dial, TLS and response
// header timeouts because its body may legitimately stay open.
var (
	apiDialTimeout           = 10 * time.Second
	apiTLSHandshakeTimeout   = 10 * time.Second
	apiResponseHeaderTimeout = 60 * time.Second
	apiRequestTimeout        = 2 * time.Minute
)

// apiHTTPClient is the one client every CLI API call uses. Tests swap it.
var apiHTTPClient = newAPIHTTPClient()

func newAPIHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: apiDialTimeout, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = apiTLSHandshakeTimeout
	transport.ResponseHeaderTimeout = apiResponseHeaderTimeout
	return &http.Client{Transport: transport}
}

// cliUserAgent names the CLI and its version on every request so the server
// can attribute failures to a release.
func cliUserAgent() string {
	return "smithers-cli/" + resolvedCLIVersion()
}

// apiCall describes one HTTP request. Only Method and URL are required.
type apiCall struct {
	Method string
	URL    string
	// Path is the request path reported in errors. It defaults to URL.
	Path    string
	Body    any
	RawBody []byte
	// Token, when set, is sent as `Authorization: token <Token>`.
	Token   string
	Accept  string
	Headers map[string]string
	// Stream skips the whole-request deadline. The caller must close the
	// response body.
	Stream bool
	// Client overrides apiHTTPClient, for callers that must not follow
	// redirects.
	Client *http.Client
}

// doAPI sends call and returns the response on a 2xx status. On any other
// status it reads the body and returns a typed *APIError. The caller must
// close the returned body; cancel releases the request deadline and is safe
// to call after the body is closed.
func doAPI(call apiCall) (*http.Response, context.CancelFunc, error) {
	var reader io.Reader
	contentType := ""
	switch {
	case call.RawBody != nil:
		reader = bytes.NewReader(call.RawBody)
		contentType = "application/json"
	case call.Body != nil:
		data, err := json.Marshal(call.Body)
		if err != nil {
			return nil, nil, err
		}
		reader = bytes.NewReader(data)
		contentType = "application/json"
	}
	ctx, cancel := context.Background(), context.CancelFunc(func() {})
	if !call.Stream {
		ctx, cancel = context.WithTimeout(context.Background(), apiRequestTimeout)
	}
	req, err := http.NewRequestWithContext(ctx, call.Method, call.URL, reader)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	req.Header.Set("User-Agent", cliUserAgent())
	accept := call.Accept
	if accept == "" {
		accept = "application/json"
	}
	req.Header.Set("Accept", accept)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if call.Token != "" {
		req.Header.Set("Authorization", "token "+call.Token)
	}
	for key, value := range call.Headers {
		req.Header.Set(key, value)
	}
	client := call.Client
	if client == nil {
		client = apiHTTPClient
	}
	response, err := client.Do(req)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer cancel()
		defer func() { _ = response.Body.Close() }()
		path := call.Path
		if path == "" {
			path = call.URL
		}
		return nil, nil, readAPIError(call.Method, path, response)
	}
	return response, cancel, nil
}

// doAPIJSON sends call and decodes a JSON body. An empty or 204 response
// decodes to nil.
func doAPIJSON(call apiCall) (any, http.Header, error) {
	resp, cancel, err := doAPI(call)
	if err != nil {
		return nil, nil, err
	}
	defer cancel()
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNoContent {
		return nil, resp.Header, nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIResponseBytes))
	if err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(string(raw)) == "" {
		return nil, resp.Header, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, nil, err
	}
	return decoded, resp.Header, nil
}

// readAPIError turns a non-2xx response into an *APIError carrying the
// server's typed verdict (code, fault, retry_after) and its request id.
func readAPIError(method, path string, resp *http.Response) *APIError {
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxAPIResponseBytes))
	apiErr := &APIError{
		Method:    method,
		Path:      path,
		Status:    resp.StatusCode,
		Detail:    resp.Status,
		RequestID: strings.TrimSpace(resp.Header.Get("X-Request-Id")),
	}
	var parsed struct {
		Code       string `json:"code"`
		Fault      string `json:"fault"`
		RetryAfter int    `json:"retry_after"`
		Message    string `json:"message"`
	}
	if json.Unmarshal(raw, &parsed) == nil {
		apiErr.Code = parsed.Code
		apiErr.Fault = parsed.Fault
		apiErr.RetryAfter = parsed.RetryAfter
		if strings.TrimSpace(parsed.Message) != "" {
			apiErr.Detail = strings.TrimSpace(parsed.Message)
		}
	} else if text := strings.TrimSpace(string(raw)); text != "" {
		apiErr.Detail = text
	}
	if apiErr.RetryAfter == 0 {
		if seconds, err := strconv.Atoi(strings.TrimSpace(resp.Header.Get("Retry-After"))); err == nil && seconds > 0 {
			apiErr.RetryAfter = seconds
		}
	}
	return apiErr
}

// APIError is a non-2xx API response.
type APIError struct {
	Method string
	Path   string
	Status int
	Detail string
	// Code, Fault and RetryAfter mirror the server's typed error body. Fault
	// says whose problem the failure is (for example "user" or "infra").
	Code       string
	Fault      string
	RetryAfter int
	// RequestID is the server's X-Request-Id, for support reports.
	RequestID string
}

func (e *APIError) Error() string {
	message := fmt.Sprintf("%s %s -> %d: %s", e.Method, e.Path, e.Status, e.Detail)
	if e.RetryAfter > 0 {
		message += fmt.Sprintf(" (retry after %ds)", e.RetryAfter)
	}
	if e.RequestID != "" {
		message += " [request " + e.RequestID + "]"
	}
	return message
}
