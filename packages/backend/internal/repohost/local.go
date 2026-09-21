package repohost

import (
	"errors"
	"io"
	"net/http"
	"sync"
)

// NewLocalClient uses the same repository client and server protocol in the
// process that owns the repository. It does not bind a port or resolve a
// storage set. Git's public HTTP handler can be mounted separately.
func NewLocalClient(handler http.Handler, authToken string, metrics ...RepoHostOperationDurationObserver) *Client {
	client := NewClient(&StaticStorageSetResolver{URL: "http://repository.local"}, authToken, metrics...)
	client.httpClient = &http.Client{Transport: &handlerTransport{handler: handler}}
	return client
}

// handlerTransport streams responses through a pipe. A recorder would buffer
// diffs and repository contents without a bound before returning to Client.
type handlerTransport struct{ handler http.Handler }

func (t *handlerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Scheme != "http" || req.URL.Host != "repository.local" {
		return nil, errors.New("local repository request escaped its handler")
	}
	reader, writer := io.Pipe()
	ready := make(chan *http.Response, 1)
	w := &handlerResponseWriter{header: make(http.Header), writer: writer, reader: reader, ready: ready, request: req}
	go func() {
		defer writer.Close()
		t.handler.ServeHTTP(w, req)
		w.WriteHeader(http.StatusOK)
	}()
	select {
	case response := <-ready:
		return response, nil
	case <-req.Context().Done():
		_ = reader.CloseWithError(req.Context().Err())
		return nil, req.Context().Err()
	}
}

type handlerResponseWriter struct {
	header  http.Header
	writer  *io.PipeWriter
	reader  *io.PipeReader
	ready   chan *http.Response
	request *http.Request
	once    sync.Once
}

func (w *handlerResponseWriter) Header() http.Header { return w.header }

func (w *handlerResponseWriter) WriteHeader(status int) {
	w.once.Do(func() {
		w.ready <- &http.Response{
			StatusCode:    status,
			Header:        w.header.Clone(),
			Body:          w.reader,
			Request:       w.request,
			ContentLength: -1,
		}
	})
}

func (w *handlerResponseWriter) Write(b []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	return w.writer.Write(b)
}

func (w *handlerResponseWriter) Flush() { w.WriteHeader(http.StatusOK) }

var _ http.RoundTripper = (*handlerTransport)(nil)
var _ http.ResponseWriter = (*handlerResponseWriter)(nil)
var _ http.Flusher = (*handlerResponseWriter)(nil)
