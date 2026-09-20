package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"phonepad/daemon/internal/filebatches"
)

func transferRequest(s *Server, method, query string, data []byte, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "https://phonepad/api/file-transfers"+query, bytes.NewReader(data))
	r.RemoteAddr = "127.0.0.1:12345"
	r.AddCookie(&httpCookie)
	r.Header.Set("Origin", "https://phonepad")
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.RemoteHandler("https://phonepad").ServeHTTP(w, r)
	return w
}
func transferFixture(t *testing.T) (*Server, *batchClipboardProbe, filebatches.Manifest, [][]byte) {
	t.Helper()
	s, p, _ := batchFixture(t)
	contents := [][]byte{[]byte("first photo bytes"), []byte("second photo bytes")}
	m := filebatches.Manifest{Version: 2, ID: fixtureBatchID}
	for _, data := range contents {
		h := sha256.Sum256(data)
		m.Files = append(m.Files, filebatches.FileSpec{Name: "photo.png", Type: "image/png", Bytes: int64(len(data)), SHA256: hex.EncodeToString(h[:])})
	}
	return s, p, m, contents
}
func transferBegin(t *testing.T, s *Server, m filebatches.Manifest) transferReceipt {
	t.Helper()
	data, _ := json.Marshal(m)
	w := transferRequest(s, "POST", "?action=begin", data, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var receipt transferReceipt
	if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	return receipt
}
func transferChunk(t *testing.T, s *Server, id string, index, offset int, data []byte) transferReceipt {
	t.Helper()
	hash := sha256.Sum256(data)
	w := transferRequest(s, "PUT", "?id="+id+"&index="+strconv.Itoa(index)+"&offset="+strconv.Itoa(offset), data, map[string]string{"X-Chunk-SHA256": hex.EncodeToString(hash[:])})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var receipt transferReceipt
	if err := json.Unmarshal(w.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	return receipt
}

func TestFileTransferGatewayResumesAfterRestartAndCopiesOnlyOnExplicitAction(t *testing.T) {
	s, p, m, contents := transferFixture(t)
	w := transferRequest(s, "GET", "", nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"maxChunkBytes":1048576`) {
		t.Fatal(w.Code, w.Body.String())
	}
	transferBegin(t, s, m)
	transferChunk(t, s, m.ID, 0, 0, contents[0][:5])
	// Re-create daemon, keeping only disk state. The mobile loses a receipt.
	s2 := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s2.uploadDir, s2.clipboard = s.uploadDir, p
	if receipt := transferBegin(t, s2, m); receipt.Files[0].ReceivedBytes != 5 {
		t.Fatal(receipt)
	}
	transferChunk(t, s2, m.ID, 0, 3, contents[0][3:])
	w = transferRequest(s2, "POST", "?action=commit&id="+m.ID, nil, nil)
	if w.Code != 409 || p.calls != 0 {
		t.Fatal(w.Code, p.calls)
	}
	transferChunk(t, s2, m.ID, 1, 0, contents[1])
	w = transferRequest(s2, "POST", "?action=commit&id="+m.ID, nil, nil)
	if w.Code != 200 || p.calls != 0 {
		t.Fatal(w.Code, w.Body.String(), p.calls)
	}
	for i, name := range []string{"1-photo.png", "2-photo.png"} {
		data, err := os.ReadFile(filepath.Join(s.uploadDir, "batch-"+m.ID, name))
		if err != nil || !bytes.Equal(data, contents[i]) {
			t.Fatal(name, err)
		}
	}
	w = transferRequest(s2, "POST", "?action=clipboard&id="+m.ID, nil, nil)
	if w.Code != 200 || p.calls != 1 || len(p.paths) != 2 || strings.Contains(w.Body.String(), `"replayed":true`) {
		t.Fatal(w.Code, w.Body.String(), p)
	}
	s3 := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s3.uploadDir, s3.clipboard = s.uploadDir, p
	w = transferRequest(s3, "POST", "?action=clipboard&id="+m.ID, nil, nil)
	if w.Code != 200 || p.calls != 1 || !strings.Contains(w.Body.String(), `"replayed":true`) {
		t.Fatal(w.Code, w.Body.String(), p.calls)
	}
}

func TestFileTransferCrashClaimNeverReplaysClipboard(t *testing.T) {
	s, p, m, contents := transferFixture(t)
	transferBegin(t, s, m)
	for i, data := range contents {
		transferChunk(t, s, m.ID, i, 0, data)
	}
	w := transferRequest(s, "POST", "?action=commit&id="+m.ID, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if err := os.WriteFile(filepath.Join(s.uploadDir, "batch-"+m.ID, transferClipboardFile), []byte(`{"state":"uncertain"}`), 0600); err != nil {
		t.Fatal(err)
	}
	w = transferRequest(s, "POST", "?action=clipboard&id="+m.ID, nil, nil)
	if w.Code != 200 || p.calls != 0 || !strings.Contains(w.Body.String(), `"state":"uncertain"`) {
		t.Fatal(w.Code, w.Body.String(), p.calls)
	}
}

func TestFileTransferDoesNotCopyFilesChangedAfterCommit(t *testing.T) {
	s, p, m, contents := transferFixture(t)
	transferBegin(t, s, m)
	for i, data := range contents {
		transferChunk(t, s, m.ID, i, 0, data)
	}
	w := transferRequest(s, "POST", "?action=commit&id="+m.ID, nil, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	path := filepath.Join(s.uploadDir, "batch-"+m.ID, "1-photo.png")
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), len(contents[0])), 0600); err != nil {
		t.Fatal(err)
	}
	w = transferRequest(s, "POST", "?action=clipboard&id="+m.ID, nil, nil)
	if w.Code != 200 || p.calls != 0 || !strings.Contains(w.Body.String(), `"state":"uncertain"`) {
		t.Fatal(w.Code, w.Body.String(), p.calls)
	}
}

func TestFileTransferRejectsIncompleteMetadataAndUnauthorizedRequests(t *testing.T) {
	s, p, _, _ := transferFixture(t)
	for _, raw := range []string{`{"version":2,"id":"` + fixtureBatchID + `","files":[{"name":"empty","type":"text/plain","sha256":"` + strings.Repeat("0", 64) + `"}]}`, `{} {}`, `{"unexpected":true}`} {
		if w := transferRequest(s, "POST", "?action=begin", []byte(raw), nil); w.Code != 400 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, scenario := range []string{"auth", "origin", "cross-site", "remote"} {
		r := httptest.NewRequest("GET", "https://phonepad/api/file-transfers", nil)
		r.RemoteAddr = "127.0.0.1:12345"
		r.Header.Set("Origin", "https://phonepad")
		if scenario != "auth" {
			r.AddCookie(&httpCookie)
		}
		if scenario == "origin" {
			r.Header.Set("Origin", "https://evil.test")
		}
		if scenario == "cross-site" {
			r.Header.Set("Origin", "https://evil.test")
			r.Header.Set("Sec-Fetch-Site", "cross-site")
		}
		if scenario == "remote" {
			r.RemoteAddr = "8.8.8.8:1234"
		}
		w := httptest.NewRecorder()
		s.RemoteHandler("https://phonepad").ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized && w.Code != http.StatusForbidden {
			t.Fatal(scenario, w.Code)
		}
	}
	if p.calls != 0 {
		t.Fatal("unexpected clipboard mutation")
	}
}
