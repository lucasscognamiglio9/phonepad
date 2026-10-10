package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

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

func mutationPermissions(files, clipboard string) Permissions {
	return Permissions{
		View:      Permission{State: "granted"},
		Input:     Permission{State: "granted"},
		Files:     Permission{State: files},
		Clipboard: Permission{State: clipboard},
	}
}

type transferReadSignal struct {
	io.Reader
	once    sync.Once
	started chan<- struct{}
}

func (r *transferReadSignal) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	return r.Reader.Read(p)
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

func TestFileTransferRevokedBeforeCommitPreservesReceivingAndCancelManifest(t *testing.T) {
	s, p, m, contents := transferFixture(t)
	transferBegin(t, s, m)
	for i, data := range contents {
		transferChunk(t, s, m.ID, i, 0, data)
	}
	if err := s.SetPermissions(mutationPermissions("revoked", "granted")); err != nil {
		t.Fatal(err)
	}
	if w := transferRequest(s, "POST", "?action=commit&id="+m.ID, nil, nil); w.Code != http.StatusForbidden {
		t.Fatalf("revoked commit status = %d, body = %s", w.Code, w.Body.String())
	}
	if p.calls != 0 {
		t.Fatal("revoked commit touched clipboard")
	}
	if w := transferRequest(s, "GET", "?id="+m.ID, nil, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"receiving"`) {
		t.Fatalf("receiving status after denied commit = %d, %s", w.Code, w.Body.String())
	}
	manifest, _ := json.Marshal(m)
	if w := transferRequest(s, "POST", "?action=cancel&id="+m.ID, manifest, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"cancelled"`) {
		t.Fatalf("cancel during revocation = %d, %s", w.Code, w.Body.String())
	}
	if err := s.SetPermissions(mutationPermissions("granted", "granted")); err != nil {
		t.Fatal(err)
	}
	if receipt := transferBegin(t, s, m); receipt.State != "cancelled" {
		t.Fatalf("late begin recreated cancelled batch: %#v", receipt)
	}
	if _, err := os.Stat(filepath.Join(s.uploadDir, "batch-"+m.ID)); !os.IsNotExist(err) {
		t.Fatalf("cancelled batch was published: %v", err)
	}
}

func TestFileTransferSlowChunkRevokedBeforeWrite(t *testing.T) {
	s, p, m, contents := transferFixture(t)
	transferBegin(t, s, m)
	pipeReader, pipeWriter := io.Pipe()
	started := make(chan struct{})
	body := &transferReadSignal{Reader: pipeReader, started: started}
	r := httptest.NewRequest("PUT", "https://phonepad/api/file-transfers?id="+m.ID+"&index=0&offset=0", body)
	r.RemoteAddr = "127.0.0.1:12345"
	r.AddCookie(&httpCookie)
	r.Header.Set("Origin", "https://phonepad")
	r.Header.Set("Content-Type", "application/octet-stream")
	hash := sha256.Sum256(contents[0])
	r.Header.Set("X-Chunk-SHA256", hex.EncodeToString(hash[:]))
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		s.RemoteHandler("https://phonepad").ServeHTTP(w, r)
		close(done)
	}()
	if _, err := pipeWriter.Write(contents[0]); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("chunk handler did not start reading")
	}
	if err := s.SetPermissions(mutationPermissions("revoked", "granted")); err != nil {
		t.Fatal(err)
	}
	if err := pipeWriter.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("slow chunk handler did not finish")
	}
	if w.Code != http.StatusForbidden || p.calls != 0 {
		t.Fatalf("revoked slow chunk = %d, %s, clipboard calls=%d", w.Code, w.Body.String(), p.calls)
	}
	if status := transferRequest(s, "GET", "?id="+m.ID, nil, nil); status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"receivedBytes":0`) {
		t.Fatalf("revoked slow chunk changed staging: %d, %s", status.Code, status.Body.String())
	}
}

func TestFileTransferGuardOperationsDoNotInvertStoreLock(t *testing.T) {
	s, _, m, contents := transferFixture(t)
	store := filebatches.New(s.uploadDir)
	if _, err := store.Begin(m); err != nil {
		t.Fatal(err)
	}
	for i, data := range contents {
		hash := sha256.Sum256(data)
		if _, err := store.WriteChunk(m.ID, i, 0, data, hex.EncodeToString(hash[:])); err != nil {
			t.Fatal(err)
		}
	}
	permit, ok := s.captureMutationPermit(mutationScopeFiles)
	if !ok {
		t.Fatal("files permission was not granted")
	}
	s.mutationGate.Lock()
	guardEntered := make(chan struct{})
	commitDone := make(chan error, 1)
	go func() {
		_, _, err := store.CommitWithGuard(m.ID, func(effect func() error) error {
			close(guardEntered)
			return s.runPermittedMutation(permit, effect)
		})
		commitDone <- err
	}()
	select {
	case <-guardEntered:
	case <-time.After(time.Second):
		s.mutationGate.Unlock()
		t.Fatal("commit did not reach its guarded publication")
	}
	chunkDone := make(chan error, 1)
	go func() {
		data := contents[0]
		hash := sha256.Sum256(data)
		_, err := store.WriteChunkWithGuard(m.ID, 0, 0, data, hex.EncodeToString(hash[:]), func(effect func() error) error {
			return s.runPermittedMutation(permit, effect)
		})
		chunkDone <- err
	}()
	s.mutationGate.Unlock()
	select {
	case err := <-commitDone:
		if err != nil {
			t.Fatalf("guarded commit = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("guarded commit deadlocked")
	}
	select {
	case err := <-chunkDone:
		if !errors.Is(err, filebatches.ErrConflict) {
			t.Fatalf("late guarded chunk = %v, want stored conflict", err)
		}
	case <-time.After(time.Second):
		t.Fatal("guarded chunk deadlocked behind commit")
	}
}

func TestFileTransferRevokedClipboardDoesNotCopy(t *testing.T) {
	s, p, m, contents := transferFixture(t)
	transferBegin(t, s, m)
	for i, data := range contents {
		transferChunk(t, s, m.ID, i, 0, data)
	}
	if w := transferRequest(s, "POST", "?action=commit&id="+m.ID, nil, nil); w.Code != http.StatusOK {
		t.Fatalf("commit status = %d, body = %s", w.Code, w.Body.String())
	}
	if err := s.SetPermissions(mutationPermissions("granted", "revoked")); err != nil {
		t.Fatal(err)
	}
	if w := transferRequest(s, "POST", "?action=clipboard&id="+m.ID, nil, nil); w.Code != http.StatusForbidden {
		t.Fatalf("revoked clipboard status = %d, body = %s", w.Code, w.Body.String())
	}
	if p.calls != 0 {
		t.Fatal("revoked clipboard request copied files")
	}
	if w := transferRequest(s, "GET", "?id="+m.ID, nil, nil); w.Code != http.StatusOK {
		t.Fatalf("stored status unavailable after clipboard revocation: %d", w.Code)
	}
}

func TestFileTransferCancelStoredReturnsReceiptWithoutDeleting(t *testing.T) {
	s, p, m, contents := transferFixture(t)
	transferBegin(t, s, m)
	for i, data := range contents {
		transferChunk(t, s, m.ID, i, 0, data)
	}
	if w := transferRequest(s, "POST", "?action=commit&id="+m.ID, nil, nil); w.Code != http.StatusOK {
		t.Fatalf("commit status = %d, body = %s", w.Code, w.Body.String())
	}
	manifest, _ := json.Marshal(m)
	if w := transferRequest(s, "POST", "?action=cancel&id="+m.ID, manifest, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"stored"`) {
		t.Fatalf("manifest cancel of stored batch = %d, %s", w.Code, w.Body.String())
	}
	if w := transferRequest(s, "POST", "?action=cancel&id="+m.ID, nil, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"stored"`) {
		t.Fatalf("legacy cancel of stored batch = %d, %s", w.Code, w.Body.String())
	}
	if p.calls != 0 {
		t.Fatal("cancel unexpectedly touched clipboard")
	}
	if _, err := os.Stat(filepath.Join(s.uploadDir, "batch-"+m.ID)); err != nil {
		t.Fatalf("stored batch was deleted by cancel: %v", err)
	}
}

func TestFileTransferLegacyCancelRegisteredBatch(t *testing.T) {
	s, p, m, _ := transferFixture(t)
	transferBegin(t, s, m)
	if w := transferRequest(s, "POST", "?action=cancel&id="+m.ID, nil, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"cancelled"`) {
		t.Fatalf("legacy cancel = %d, %s", w.Code, w.Body.String())
	}
	if w := transferRequest(s, "GET", "?id="+m.ID, nil, nil); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"cancelled"`) {
		t.Fatalf("cancelled status = %d, %s", w.Code, w.Body.String())
	}
	if p.calls != 0 {
		t.Fatal("legacy cancel touched clipboard")
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
