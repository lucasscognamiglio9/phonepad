package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
	"phonepad/daemon/internal/input"
	"phonepad/daemon/internal/inputops"
)

var httpCookie = http.Cookie{Name: sessionCookieName, Value: "tok"}

type literalProbe struct {
	fakeInjector
	target   string
	outcome  string
	literals []string
}

func (p *literalProbe) LiteralFocus(context.Context) input.LiteralResult {
	return input.LiteralResult{State: "ready", Target: p.target}
}
func (p *literalProbe) LiteralText(_ context.Context, text, target string) input.LiteralResult {
	if target != p.target {
		return input.LiteralResult{State: "rejected", Detail: "focus_changed"}
	}
	p.literals = append(p.literals, text)
	return input.LiteralResult{State: p.outcome}
}
func inputFixture() (*Server, *literalProbe) {
	p := &literalProbe{target: strings.Repeat("a", 64), outcome: "dispatched"}
	s := New(staticAuth("tok"), p, nil, "")
	s.current = &websocket.Conn{} // Presence only; no socket I/O in this handler fixture.
	s.newInputLease()
	return s, p
}
func inputCall(s *Server, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	r := httptest.NewRequest("POST", "https://phonepad/api/input", bytes.NewReader(b))
	r.AddCookie(&httpCookie)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://phonepad")
	w := httptest.NewRecorder()
	s.handleInput(w, r)
	return w
}
func manifestFor(s *Server, text string) inputops.Manifest {
	hash := sha256.Sum256([]byte(text))
	return inputops.Manifest{Version: 1, OperationID: "operation-1", Session: s.inputSession, Context: "composer", Sequence: 1, Bytes: len(text), SHA256: hex.EncodeToString(hash[:])}
}
func stageText(t *testing.T, s *Server, text string) inputops.Manifest {
	t.Helper()
	m := manifestFor(s, text)
	if w := inputCall(s, inputRequest{Op: "begin", Session: m.Session, Manifest: m}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	for offset, index := 0, 0; offset < len(text); index++ {
		end := min(offset+inputops.MaxChunkBytes, len(text))
		if w := inputCall(s, inputRequest{Op: "chunk", Session: m.Session, OperationID: m.OperationID, Index: index, Data: []byte(text[offset:end])}); w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		offset = end
	}
	return m
}
func operationReceipt(t *testing.T, w *httptest.ResponseRecorder) inputops.Receipt {
	t.Helper()
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var wrapped struct {
		Receipt *inputops.Receipt `json:"receipt"`
	}
	json.Unmarshal(w.Body.Bytes(), &wrapped)
	if wrapped.Receipt != nil {
		return *wrapped.Receipt
	}
	var receipt inputops.Receipt
	if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	return receipt
}
func TestLiteralHTTPCompleteOnceAndRecoverReceipt(t *testing.T) {
	s, p := inputFixture()
	text := strings.Repeat("¿_👨‍👩‍👧‍👦\r\n", 4000)
	m := stageText(t, s, text)
	if len(p.literals) != 0 {
		t.Fatal("injected before commit")
	}
	request := inputRequest{Op: "commit", Session: m.Session, OperationID: m.OperationID}
	for range 3 {
		if got := operationReceipt(t, inputCall(s, request)); got.State != inputops.Dispatched {
			t.Fatal(got)
		}
	}
	if len(p.literals) != 1 || p.literals[0] != text {
		t.Fatal("literal content or dedup failed")
	}
	s.newInputLease()
	request.Op = "status"
	if got := operationReceipt(t, inputCall(s, request)); got.State != inputops.Dispatched {
		t.Fatal(got)
	}
	request.Op = "commit"
	if w := inputCall(s, request); w.Code != 409 {
		t.Fatal("old session replay accepted")
	}
	if len(p.literals) != 1 {
		t.Fatal("replayed after reconnect")
	}
}
func TestLiteralHTTPFocusChangedAndUncertainNeverReplay(t *testing.T) {
	for _, outcome := range []string{"rejected", "uncertain"} {
		t.Run(outcome, func(t *testing.T) {
			s, p := inputFixture()
			m := stageText(t, s, "conservar borrador")
			p.outcome = outcome
			if outcome == "rejected" {
				p.target = strings.Repeat("b", 64)
			}
			req := inputRequest{Op: "commit", Session: m.Session, OperationID: m.OperationID}
			for range 2 {
				if got := operationReceipt(t, inputCall(s, req)); string(got.State) != outcome {
					t.Fatal(got)
				}
			}
			expected := 1
			if outcome == "rejected" {
				expected = 0
			}
			if len(p.literals) != expected {
				t.Fatal("unsafe replay", len(p.literals))
			}
		})
	}
}
func TestLiteralHTTPIncompleteCorruptAndRetired(t *testing.T) {
	s, p := inputFixture()
	m := manifestFor(s, "abc")
	inputCall(s, inputRequest{Op: "begin", Session: m.Session, Manifest: m})
	req := inputRequest{Op: "commit", Session: m.Session, OperationID: m.OperationID}
	if w := inputCall(s, req); w.Code != 409 {
		t.Fatal("incomplete commit accepted")
	}
	inputCall(s, inputRequest{Op: "chunk", Session: m.Session, OperationID: m.OperationID, Data: []byte("xyz")})
	if w := inputCall(s, req); w.Code != 409 {
		t.Fatal("corrupt text accepted")
	}
	if len(p.literals) != 0 {
		t.Fatal("corrupt text injected")
	}
	s, p = inputFixture()
	m = stageText(t, s, "pending")
	s.newInputLease()
	receipt, _ := s.inputLeases[m.Session].registry.Lookup(m.OperationID)
	if receipt.State != inputops.Cancelled || len(p.literals) != 0 {
		t.Fatal(receipt)
	}
}
func TestLiteralHTTPAuthorizationAndUnknown(t *testing.T) {
	s, p := inputFixture()
	r := httptest.NewRequest("POST", "https://phonepad/api/input", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	s.handleInput(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	r = httptest.NewRequest("POST", "https://phonepad/api/input", strings.NewReader(`{}`))
	r.AddCookie(&httpCookie)
	r.Header.Set("Origin", "https://evil.example")
	w = httptest.NewRecorder()
	s.handleInput(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w := inputCall(s, inputRequest{Op: "status", Session: s.inputSession, OperationID: "unknown"}); w.Code != 404 {
		t.Fatal(w.Code)
	}
	if len(p.literals) != 0 {
		t.Fatal("unauthorized input")
	}
}
