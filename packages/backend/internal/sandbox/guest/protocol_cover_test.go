package guest

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"testing"
)

// protocolCoverErrWrite is the sentinel returned by protocolCoverFailWriter.
var protocolCoverErrWrite = errors.New("protocol-cover: forced write failure")

// protocolCoverFailWriter allows okWrites successful Write calls, then fails
// every subsequent call. WriteMessage issues exactly two Write calls: one for
// the 4-byte length prefix and one for the JSON payload, so okWrites=0 forces
// the length write to fail and okWrites=1 forces the payload write to fail.
type protocolCoverFailWriter struct {
	okWrites int
	seen     int
}

func (w *protocolCoverFailWriter) Write(p []byte) (int, error) {
	if w.seen >= w.okWrites {
		return 0, protocolCoverErrWrite
	}
	w.seen++
	return len(p), nil
}

// WriteMessage: a value that cannot be JSON-marshaled surfaces a marshal error
// without touching the writer.
func TestProtocolCover_WriteMessage_MarshalError(t *testing.T) {
	err := WriteMessage(io.Discard, make(chan int))
	if err == nil {
		t.Fatal("expected marshal error, got nil")
	}
	if !strings.Contains(err.Error(), "marshal message") {
		t.Fatalf("error = %v, want marshal message", err)
	}
}

// WriteMessage: a writer that fails on the length prefix surfaces a
// write-length error.
func TestProtocolCover_WriteMessage_LengthWriteError(t *testing.T) {
	w := &protocolCoverFailWriter{okWrites: 0}
	err := WriteMessage(w, &Request{ID: "1", Method: MethodPing})
	if err == nil {
		t.Fatal("expected length write error, got nil")
	}
	if !strings.Contains(err.Error(), "write message length") {
		t.Fatalf("error = %v, want write message length", err)
	}
}

// WriteMessage: a writer that accepts the length prefix but fails on the
// payload surfaces a write-payload error.
func TestProtocolCover_WriteMessage_PayloadWriteError(t *testing.T) {
	w := &protocolCoverFailWriter{okWrites: 1}
	err := WriteMessage(w, &Request{ID: "1", Method: MethodPing})
	if err == nil {
		t.Fatal("expected payload write error, got nil")
	}
	if !strings.Contains(err.Error(), "write message payload") {
		t.Fatalf("error = %v, want write message payload", err)
	}
}

// ReadMessage: an empty reader fails while reading the length prefix.
func TestProtocolCover_ReadMessage_LengthReadError(t *testing.T) {
	var msg Request
	err := ReadMessage(bytes.NewReader(nil), &msg)
	if err == nil {
		t.Fatal("expected length read error, got nil")
	}
	if !strings.Contains(err.Error(), "read message length") {
		t.Fatalf("error = %v, want read message length", err)
	}
}

// ReadMessage: a length prefix larger than the hard cap is rejected before any
// payload is read.
func TestProtocolCover_ReadMessage_SizeExceedsMax(t *testing.T) {
	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.BigEndian, uint32(maxMessageSize+1)); err != nil {
		t.Fatalf("seed length: %v", err)
	}
	var msg Request
	err := ReadMessage(&buf, &msg)
	if err == nil {
		t.Fatal("expected size-exceeds-max error, got nil")
	}
	if !strings.Contains(err.Error(), "exceeds maximum") {
		t.Fatalf("error = %v, want exceeds maximum", err)
	}
}

// ReadMessage: a length prefix that promises more bytes than the reader holds
// surfaces a payload read error.
func TestProtocolCover_ReadMessage_PayloadReadError(t *testing.T) {
	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.BigEndian, uint32(16)); err != nil {
		t.Fatalf("seed length: %v", err)
	}
	buf.Write([]byte("only-3")) // fewer than the advertised 16 bytes
	var msg Request
	err := ReadMessage(&buf, &msg)
	if err == nil {
		t.Fatal("expected payload read error, got nil")
	}
	if !strings.Contains(err.Error(), "read message payload") {
		t.Fatalf("error = %v, want read message payload", err)
	}
}

// ReadMessage: a well-framed message whose payload is not valid JSON surfaces
// an unmarshal error.
func TestProtocolCover_ReadMessage_UnmarshalError(t *testing.T) {
	payload := []byte("{not-json")
	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.BigEndian, uint32(len(payload))); err != nil {
		t.Fatalf("seed length: %v", err)
	}
	buf.Write(payload)
	var msg Request
	err := ReadMessage(&buf, &msg)
	if err == nil {
		t.Fatal("expected unmarshal error, got nil")
	}
	if !strings.Contains(err.Error(), "unmarshal message") {
		t.Fatalf("error = %v, want unmarshal message", err)
	}
}

// ReadMessage/WriteMessage round-trip on a plain buffer returns the same value.
func TestProtocolCover_WriteRead_RoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := &Response{ID: "abc", Result: MarshalResult(PingResponse{Pong: true})}
	if err := WriteMessage(&buf, in); err != nil {
		t.Fatalf("WriteMessage: %v", err)
	}
	var out Response
	if err := ReadMessage(&buf, &out); err != nil {
		t.Fatalf("ReadMessage: %v", err)
	}
	if out.ID != "abc" {
		t.Fatalf("ID = %q, want abc", out.ID)
	}
}

// MarshalResult panics on a value that cannot be JSON-marshaled (a programming
// error the caller is expected to never hit).
func TestProtocolCover_MarshalResult_Panics(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("expected panic from MarshalResult on unmarshalable value")
		}
		if !strings.Contains(strings.ToLower(toStr(r)), "cannot marshal result") {
			t.Fatalf("panic value = %v, want cannot marshal result", r)
		}
	}()
	_ = MarshalResult(make(chan int))
}

func toStr(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
