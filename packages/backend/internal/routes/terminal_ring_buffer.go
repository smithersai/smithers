package routes

type terminalRingBuffer struct {
	buf       []byte
	start     int
	size      int
	offset    uint64
	truncated bool
}

func newTerminalRingBuffer(capacity int) *terminalRingBuffer {
	if capacity <= 0 {
		capacity = 512 * 1024
	}
	return &terminalRingBuffer{buf: make([]byte, capacity)}
}

func (r *terminalRingBuffer) Append(p []byte) {
	if len(p) == 0 || len(r.buf) == 0 {
		return
	}
	if len(p) >= len(r.buf) {
		r.offset += uint64(r.size + len(p) - len(r.buf))
		copy(r.buf, p[len(p)-len(r.buf):])
		r.start = 0
		r.size = len(r.buf)
		r.truncated = true
		return
	}
	for r.size+len(p) > len(r.buf) {
		r.start = (r.start + 1) % len(r.buf)
		r.size--
		r.offset++
		r.truncated = true
	}
	end := (r.start + r.size) % len(r.buf)
	n := copy(r.buf[end:], p)
	if n < len(p) {
		copy(r.buf, p[n:])
	}
	r.size += len(p)
}

func (r *terminalRingBuffer) Snapshot() ([]byte, uint64, bool) {
	out := make([]byte, r.size)
	if r.size == 0 {
		return out, r.offset, r.truncated
	}
	n := copy(out, r.buf[r.start:])
	if n < r.size {
		copy(out[n:], r.buf[:r.size-n])
	}
	return out, r.offset, r.truncated
}
