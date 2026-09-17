// Package inputops defines bounded, replay-safe staging for literal text.
// It does not inject input or expose a network endpoint. A transport must bind
// Registry to one authenticated, opaque session and preserve its receipts.
package inputops

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"unicode/utf8"
)

const (
	Version       = 1
	MaxTextBytes  = 128 * 1024
	MaxChunkBytes = 16 * 1024
	MaxChunks     = 128
	MaxOperations = 64
)

var (
	ErrInvalid    = errors.New("invalid text operation")
	ErrConflict   = errors.New("operation or chunk conflicts with existing content")
	ErrIncomplete = errors.New("text transfer is incomplete")
	ErrCapacity   = errors.New("session operation capacity reached")
	ErrState      = errors.New("operation is not in the required state")
)

type State string

const (
	Receiving   State = "receiving"
	Ready       State = "ready"
	Dispatching State = "dispatching"
	Dispatched  State = "dispatched" // Adapter returned; not proof of text in the target app.
	Uncertain   State = "uncertain"
	Rejected    State = "rejected"
	Cancelled   State = "cancelled"
)

type Manifest struct {
	Version     int    `json:"version"`
	OperationID string `json:"operationId"`
	Session     string `json:"session"`
	Context     string `json:"context"`
	Sequence    uint64 `json:"sequence"`
	Bytes       int    `json:"bytes"`
	SHA256      string `json:"sha256"`
}

type Receipt struct {
	Manifest
	State         State `json:"state"`
	ReceivedBytes int   `json:"receivedBytes"`
	NextChunk     int   `json:"nextChunk"`
}

type chunk struct {
	size   int
	digest [32]byte
}

type TextTransfer struct {
	mu       sync.Mutex
	manifest Manifest
	state    State
	payload  []byte
	chunks   []chunk
	received int
}

func validID(s string) bool {
	if len(s) == 0 || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func validManifest(m Manifest) bool {
	hash, err := hex.DecodeString(m.SHA256)
	return m.Version == Version && validID(m.OperationID) && validID(m.Session) && validID(m.Context) &&
		m.Sequence > 0 && m.Sequence <= 9007199254740991 && m.Bytes > 0 && m.Bytes <= MaxTextBytes &&
		err == nil && len(hash) == sha256.Size && hex.EncodeToString(hash) == m.SHA256
}

// Registry never evicts a known operation to make room: eviction would allow a
// late retry to inject it again. The transport must negotiate a new session at
// capacity, keeping the previous session queryable during its retention lease.
// At most 8 MiB of text can be staged per registry; no user text enters logs.
type Registry struct {
	mu         sync.Mutex
	session    string
	operations map[string]*TextTransfer
	highest    uint64
}

func NewRegistry(session string) (*Registry, error) {
	if !validID(session) {
		return nil, ErrInvalid
	}
	return &Registry{session: session, operations: make(map[string]*TextTransfer)}, nil
}

func (r *Registry) Begin(m Manifest) (*TextTransfer, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !validManifest(m) || m.Session != r.session {
		return nil, ErrInvalid
	}
	if old, ok := r.operations[m.OperationID]; ok {
		if old.manifest != m {
			return nil, ErrConflict
		}
		return old, nil
	}
	if m.Sequence <= r.highest {
		return nil, ErrConflict
	}
	if len(r.operations) >= MaxOperations {
		return nil, ErrCapacity
	}
	transfer := &TextTransfer{manifest: m, state: Receiving}
	r.operations[m.OperationID] = transfer
	r.highest = m.Sequence
	return transfer, nil
}

// Missing receipts mean unknown, never permission to replay an old operation.
func (r *Registry) Lookup(id string) (Receipt, bool) {
	r.mu.Lock()
	t, ok := r.operations[id]
	r.mu.Unlock()
	if !ok {
		return Receipt{}, false
	}
	return t.Receipt(), true
}

func (t *TextTransfer) receipt() Receipt {
	return Receipt{Manifest: t.manifest, State: t.state, ReceivedBytes: t.received, NextChunk: len(t.chunks)}
}
func (t *TextTransfer) Receipt() Receipt { t.mu.Lock(); defer t.mu.Unlock(); return t.receipt() }

// Append is ordered. Identical retries return the same receipt; conflicting
// retries do not replace bytes. UTF-8 may straddle chunks and is checked at commit.
func (t *TextTransfer) Append(index int, data []byte) (Receipt, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if index < 0 || index >= MaxChunks || len(data) == 0 || len(data) > MaxChunkBytes {
		return t.receipt(), ErrInvalid
	}
	digest := sha256.Sum256(data)
	if index < len(t.chunks) {
		old := t.chunks[index]
		if old.size != len(data) || old.digest != digest {
			return t.receipt(), ErrConflict
		}
		return t.receipt(), nil
	}
	if t.state != Receiving {
		return t.receipt(), ErrState
	}
	if index != len(t.chunks) {
		return t.receipt(), ErrIncomplete
	}
	if t.received+len(data) > t.manifest.Bytes {
		return t.receipt(), ErrInvalid
	}
	t.payload = append(t.payload, data...)
	t.received += len(data)
	t.chunks = append(t.chunks, chunk{len(data), digest})
	return t.receipt(), nil
}

func (t *TextTransfer) Commit() (Receipt, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != Receiving {
		return t.receipt(), nil
	}
	if t.received != t.manifest.Bytes {
		return t.receipt(), ErrIncomplete
	}
	digest := sha256.Sum256(t.payload)
	if hex.EncodeToString(digest[:]) != t.manifest.SHA256 || !utf8.Valid(t.payload) || bytes.IndexByte(t.payload, 0) >= 0 {
		t.state = Rejected
		t.payload = nil
		return t.receipt(), ErrInvalid
	}
	t.state = Ready
	return t.receipt(), nil
}

// Claim is the sole transition that releases text to an adapter, once only.
// A crash after this point has an uncertain outcome: do not call a new adapter
// with the same text merely because the original receipt was lost.
func (t *TextTransfer) Claim() (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != Ready {
		return "", ErrState
	}
	text := string(t.payload)
	t.payload = nil
	t.state = Dispatching
	return text, nil
}

func (t *TextTransfer) Finish(state State) (Receipt, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != Dispatching || state != Dispatched && state != Uncertain && state != Rejected {
		return t.receipt(), ErrState
	}
	t.state = state
	return t.receipt(), nil
}

func (t *TextTransfer) Cancel() (Receipt, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state != Receiving && t.state != Ready {
		return t.receipt(), ErrState
	}
	t.state = Cancelled
	t.payload = nil
	return t.receipt(), nil
}

// Retire stops a replaced/closed control lease. Keep tombstones queryable;
// dropping them would make lost receipts indistinguishable from new work.
func (r *Registry) Retire() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.operations {
		t.mu.Lock()
		if t.state == Receiving || t.state == Ready {
			t.state = Cancelled
			t.payload = nil
		}
		if t.state == Dispatching {
			t.state = Uncertain
		}
		t.mu.Unlock()
	}
}
