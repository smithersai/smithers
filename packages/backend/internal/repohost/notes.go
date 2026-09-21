package repohost

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const maxNotesAdvertisementBytes = 16 << 20

// MaxNotesRefs bounds the notes appended to the public mirror ref listing.
const MaxNotesRefs = 10000

// NotesRef is an actual Git ref, independent of jj bookmarks.
type NotesRef struct {
	Ref string
	SHA string
}

type boundedRefBuffer struct{ buffer bytes.Buffer }

func (b *boundedRefBuffer) Write(p []byte) (int, error) {
	if len(p) > maxNotesAdvertisementBytes-b.buffer.Len() {
		return 0, fmt.Errorf("ref advertisement exceeds %d bytes", maxNotesAdvertisementBytes)
	}
	return b.buffer.Write(p)
}

// ListNotesRefs reads the existing upload-pack advertisement. It fails on
// overflow instead of presenting a truncated advertisement as a complete list.
func (c *Client) ListNotesRefs(ctx context.Context, owner, repo string) ([]NotesRef, error) {
	var buf boundedRefBuffer
	if _, err := c.InfoRefs(ctx, owner, repo, "git-upload-pack", &buf); err != nil {
		return nil, err
	}
	return parseNotesAdvertisement(buf.buffer.Bytes())
}

func parseNotesAdvertisement(data []byte) ([]NotesRef, error) {
	refs := make([]NotesRef, 0)
	seen := make(map[string]bool)
	reader := bytes.NewReader(data)
	readPacket := func() (string, error) {
		var header [4]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return "", err
		}
		size, err := strconv.ParseUint(string(header[:]), 16, 16)
		if err != nil || (size != 0 && size <= 4) {
			return "", fmt.Errorf("invalid ref packet length")
		}
		if size == 0 {
			return "", nil
		}
		payload := make([]byte, int(size)-4)
		_, err = io.ReadFull(reader, payload)
		return string(payload), err
	}
	header, err := readPacket()
	if err != nil || header != "# service=git-upload-pack\n" {
		return nil, fmt.Errorf("invalid ref advertisement header")
	}
	flush, err := readPacket()
	if err != nil || flush != "" {
		return nil, fmt.Errorf("missing ref advertisement header flush")
	}
	for {
		packet, err := readPacket()
		if err != nil {
			return nil, fmt.Errorf("read ref advertisement: %w", err)
		}
		if packet == "" {
			if reader.Len() != 0 {
				return nil, fmt.Errorf("trailing ref advertisement data")
			}
			return refs, nil
		}
		line, _, _ := strings.Cut(strings.TrimSuffix(packet, "\n"), "\x00")
		sha, name, ok := strings.Cut(line, " ")
		if !ok || !fullSourceCommitID.MatchString(sha) {
			return nil, fmt.Errorf("invalid advertised ref")
		}
		if !strings.HasPrefix(name, "refs/notes/") || strings.HasSuffix(name, "^{}") {
			continue
		}
		if name == "refs/notes/" || strings.ContainsAny(name, " \t\r\n") || seen[name] {
			return nil, fmt.Errorf("invalid or duplicate notes ref")
		}
		if len(refs) == MaxNotesRefs {
			return nil, fmt.Errorf("notes refs exceed %d", MaxNotesRefs)
		}
		seen[name] = true
		refs = append(refs, NotesRef{Ref: name, SHA: sha})
	}
}
