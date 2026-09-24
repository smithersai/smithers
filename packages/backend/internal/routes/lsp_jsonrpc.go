package routes

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"
)

// LSP relay wire format (#505, RFD-005).
//
// Guest side: the language server speaks JSON-RPC 2.0 over stdio with
// `Content-Length: N\r\n\r\n<body>` framing (the LSP base protocol).
//
// Client side: one WebSocket text frame carries exactly one JSON-RPC message
// as its body, no header. A message larger than lspMaxMessageBytes travels as
// `{"seq":n,"last":bool,"data":"<partial UTF-8>"}` fragments, seq starting
// at 1, that the receiver concatenates in order. Either side may fragment;
// the relay reassembles client fragments and fragments large server messages.
const (
	// lspMaxMessageBytes caps one WebSocket frame in either direction and is
	// the threshold above which the relay fragments a server message. Hover
	// and publishDiagnostics on a large file exceed the terminal's 64 KiB.
	lspMaxMessageBytes = 1 << 20
	// lspMaxAssembledBytes caps one reassembled message (all fragments).
	lspMaxAssembledBytes = 16 << 20
	// lspFragmentDataBytes is the raw byte budget per fragment. JSON string
	// escaping expands one byte to at most six (`<` becomes `\u003c`, a
	// control byte `\u0000`); 64 bytes cover the fragment envelope. Every
	// encoded frame therefore stays under lspMaxMessageBytes.
	lspFragmentDataBytes = (lspMaxMessageBytes - 64) / 6
	// lspMaxHeaderLineBytes bounds one header line and the launch script's
	// ready line; lspMaxHeaderBytes bounds one message's whole header block.
	// The server binary comes from the workspace, so its stdout is hostile
	// input: a line that never ends must not grow in the API's heap.
	lspMaxHeaderLineBytes = 8 << 10
	lspMaxHeaderBytes     = 16 << 10
)

var (
	errLSPHeaderTooLarge       = errors.New("lsp: header exceeds the size cap")
	errLSPMissingContentLength = errors.New("lsp: message without a Content-Length header")
	errLSPMessageTooLarge      = errors.New("lsp: message exceeds the size cap")
	errLSPNotAnObject          = errors.New("lsp: frame is not a JSON object")
	errLSPFragmentOrder        = errors.New("lsp: fragment out of order")
)

// lspFrameReader decodes Content-Length framed messages from a server's
// stdout. The bufio.Reader is shared with the ready-line handshake so bytes
// the handshake over-read are not lost.
type lspFrameReader struct {
	br  *bufio.Reader
	max int
}

func newLSPFrameReader(br *bufio.Reader, max int) *lspFrameReader {
	return &lspFrameReader{br: br, max: max}
}

// Next returns the next message body. io.EOF means the stream ended cleanly
// between messages.
func (r *lspFrameReader) Next() ([]byte, error) {
	length := -1
	sawHeader := false
	headerBytes := 0
	for {
		line, err := readLSPLine(r.br, min(lspMaxHeaderLineBytes, lspMaxHeaderBytes-headerBytes))
		headerBytes += len(line)
		if err != nil {
			if err == io.EOF && !sawHeader && line == "" {
				return nil, io.EOF
			}
			return nil, fmt.Errorf("lsp: read header: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if !sawHeader {
				// Tolerate stray blank lines between messages.
				continue
			}
			break
		}
		sawHeader = true
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("lsp: malformed header %q", line)
		}
		if strings.EqualFold(strings.TrimSpace(name), "Content-Length") {
			n, convErr := strconv.Atoi(strings.TrimSpace(value))
			if convErr != nil || n < 0 {
				return nil, fmt.Errorf("lsp: malformed Content-Length %q", value)
			}
			length = n
		}
	}
	if length < 0 {
		return nil, errLSPMissingContentLength
	}
	if length > r.max {
		return nil, fmt.Errorf("%w: %d bytes", errLSPMessageTooLarge, length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r.br, body); err != nil {
		return nil, fmt.Errorf("lsp: read body: %w", err)
	}
	return body, nil
}

// readLSPLine reads through the next '\n', like bufio.Reader.ReadString,
// but gives up with errLSPHeaderTooLarge once the line passes max bytes: the
// bytes read so far are the only allocation, never the rest of the stream.
func readLSPLine(br *bufio.Reader, max int) (string, error) {
	var line []byte
	for {
		part, err := br.ReadSlice('\n')
		if len(line)+len(part) > max {
			return string(line), errLSPHeaderTooLarge
		}
		line = append(line, part...)
		if err != bufio.ErrBufferFull {
			return string(line), err
		}
	}
}

// lspEncodeMessage frames body for a server's stdin.
func lspEncodeMessage(body []byte) []byte {
	header := "Content-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n"
	out := make([]byte, 0, len(header)+len(body))
	out = append(out, header...)
	return append(out, body...)
}

// lspFragment is one piece of a message too large for a single frame.
type lspFragment struct {
	Seq  int    `json:"seq"`
	Last bool   `json:"last"`
	Data string `json:"data"`
}

// lspSplitFragments encodes msg as ordered fragment frames of at most
// dataBytes raw bytes each, cut on UTF-8 rune boundaries so every fragment
// is a valid JSON string. dataBytes is clamped to lspFragmentDataBytes so no
// escaping can push a frame over lspMaxMessageBytes.
func lspSplitFragments(msg []byte, dataBytes int) [][]byte {
	if dataBytes <= 0 || dataBytes > lspFragmentDataBytes {
		dataBytes = lspFragmentDataBytes
	}
	var frames [][]byte
	seq := 0
	for len(msg) > 0 {
		cut := len(msg)
		if cut > dataBytes {
			cut = dataBytes
			for cut > 0 && !utf8.RuneStart(msg[cut]) {
				cut--
			}
			if cut == 0 {
				cut = dataBytes
			}
		}
		seq++
		frame, _ := json.Marshal(lspFragment{Seq: seq, Last: cut == len(msg), Data: string(msg[:cut])})
		frames = append(frames, frame)
		msg = msg[cut:]
	}
	return frames
}

// lspFrameKind classifies one client text frame.
type lspFrameKind int

const (
	lspFrameMessage lspFrameKind = iota
	lspFrameFragment
)

// lspClassifyFrame tells a whole JSON-RPC message from a fragment: a
// fragment is an object with a numeric `seq` and a string `data` and no
// `jsonrpc` member. Anything that is not a JSON object is a protocol error.
func lspClassifyFrame(data []byte) (lspFrameKind, lspFragment, error) {
	trimmed := bytes.TrimLeft(data, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return lspFrameMessage, lspFragment{}, errLSPNotAnObject
	}
	var probe struct {
		JSONRPC *json.RawMessage `json:"jsonrpc"`
		Seq     *int             `json:"seq"`
		Last    *bool            `json:"last"`
		Data    *string          `json:"data"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return lspFrameMessage, lspFragment{}, fmt.Errorf("lsp: %w", err)
	}
	if probe.JSONRPC == nil && probe.Seq != nil && probe.Data != nil {
		frag := lspFragment{Seq: *probe.Seq, Data: *probe.Data}
		if probe.Last != nil {
			frag.Last = *probe.Last
		}
		return lspFrameFragment, frag, nil
	}
	return lspFrameMessage, lspFragment{}, nil
}

// lspFragmentAssembler reassembles client fragments in order.
type lspFragmentAssembler struct {
	next int
	buf  []byte
	max  int
}

func newLSPFragmentAssembler(max int) *lspFragmentAssembler {
	return &lspFragmentAssembler{next: 1, max: max}
}

// open reports whether a fragment sequence is in progress.
func (a *lspFragmentAssembler) open() bool { return a.next > 1 }

// Push adds one fragment. It returns the complete message when frag is the
// last one, and resets for the next sequence.
func (a *lspFragmentAssembler) Push(frag lspFragment) ([]byte, bool, error) {
	if frag.Seq != a.next {
		a.reset()
		return nil, false, fmt.Errorf("%w: got seq %d, want %d", errLSPFragmentOrder, frag.Seq, a.next)
	}
	if len(a.buf)+len(frag.Data) > a.max {
		a.reset()
		return nil, false, fmt.Errorf("%w: reassembled message over %d bytes", errLSPMessageTooLarge, a.max)
	}
	a.buf = append(a.buf, frag.Data...)
	a.next++
	if !frag.Last {
		return nil, false, nil
	}
	msg := a.buf
	a.reset()
	return msg, true, nil
}

func (a *lspFragmentAssembler) reset() {
	a.next = 1
	a.buf = nil
}
