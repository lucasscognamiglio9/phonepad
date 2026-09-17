package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type batchClipboardProbe struct {
	calls int
	paths []string
}

func (p *batchClipboardProbe) Copy(path string, kind clipboardKind, media string) error {
	p.calls++
	p.paths = []string{path}
	return nil
}
func (p *batchClipboardProbe) CopyFiles(paths []string) error {
	p.calls++
	p.paths = append([]string(nil), paths...)
	return nil
}

const fixtureBatchID = "01234567-0123-4567-8901-012345678901"

func batchRequest(s *Server, manifest batchManifest, contents []string, extra bool) *httptest.ResponseRecorder {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	data, _ := json.Marshal(manifest)
	writer.WriteField("manifest", string(data))
	for i, content := range contents {
		part, _ := writer.CreateFormFile("file-"+strconv.Itoa(i), "ignored")
		io.WriteString(part, content)
	}
	if extra {
		writer.WriteField("extra", "unexpected")
	}
	writer.Close()
	r := httptest.NewRequest("POST", "https://phonepad/api/file-batches", &body)
	r.AddCookie(&httpCookie)
	r.Header.Set("Origin", "https://phonepad")
	r.Header.Set("Content-Type", writer.FormDataContentType())
	w := httptest.NewRecorder()
	s.handleFileBatches(w, r)
	return w
}
func batchFixture(t *testing.T) (*Server, *batchClipboardProbe, batchManifest) {
	t.Helper()
	p := &batchClipboardProbe{}
	s := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s.uploadDir = t.TempDir()
	s.clipboard = p
	return s, p, batchManifest{Version: 1, ID: fixtureBatchID, Files: []batchFile{{Name: "foto.png", Type: "image/png"}, {Name: "foto.png", Type: "image/png"}}}
}
func TestBatchPublishesWholeOrderedListAndDeduplicates(t *testing.T) {
	s, p, m := batchFixture(t)
	w := batchRequest(s, m, []string{"first", "second"}, false)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	if p.calls != 1 || len(p.paths) != 2 {
		t.Fatal(p)
	}
	for i, path := range p.paths {
		data, err := os.ReadFile(path)
		if err != nil || string(data) != []string{"first", "second"}[i] {
			t.Fatal(path, err)
		}
	}
	var receipt batchReceipt
	json.Unmarshal(w.Body.Bytes(), &receipt)
	hash := sha256.Sum256([]byte("second"))
	if receipt.Files[1].SHA256 != hex.EncodeToString(hash[:]) {
		t.Fatal(receipt)
	}
	w = batchRequest(s, m, []string{"first", "second"}, false)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"replayed":true`) || p.calls != 1 {
		t.Fatal(w.Code, w.Body.String(), p.calls)
	}
	m.Files[0].Name = "changed.png"
	if w = batchRequest(s, m, nil, false); w.Code != 409 {
		t.Fatal("identity conflict accepted")
	}
	// A daemon restart still recognizes published batches without re-copying.
	s2 := New(staticAuth("tok"), &fakeInjector{}, nil, "")
	s2.uploadDir = s.uploadDir
	s2.clipboard = p
	m.Files[0].Name = "foto.png"
	if w = batchRequest(s2, m, nil, false); w.Code != 200 || p.calls != 1 {
		t.Fatal(w.Code, p.calls)
	}
}
func TestBatchInvalidOrPartialNeverPublishes(t *testing.T) {
	for _, scenario := range []string{"missing", "extra", "size", "checksum", "path"} {
		t.Run(scenario, func(t *testing.T) {
			s, p, m := batchFixture(t)
			contents := []string{"first", "second"}
			extra := false
			switch scenario {
			case "missing":
				contents = contents[:1]
			case "extra":
				extra = true
			case "size":
				size := int64(99)
				m.Files[1].Bytes = &size
			case "checksum":
				m.Files[1].SHA256 = strings.Repeat("0", 64)
			case "path":
				m.Files[0].Name = "../outside"
			}
			w := batchRequest(s, m, contents, extra)
			if w.Code < 400 || p.calls != 0 {
				t.Fatal(w.Code, p.calls)
			}
			entries, _ := os.ReadDir(s.uploadDir)
			if len(entries) != 0 {
				t.Fatal("partial batch leaked", entries)
			}
		})
	}
}
func TestBatchClipboardURIListPreservesOrderAndEscapes(t *testing.T) {
	var mime, data string
	writer := wlClipboard{copy: func(kind string, reader io.Reader) error {
		mime = kind
		b, _ := io.ReadAll(reader)
		data = string(b)
		return nil
	}}
	paths := []string{filepath.Join(t.TempDir(), "a #.png"), filepath.Join(t.TempDir(), "ñ.png")}
	if err := writer.CopyFiles(paths); err != nil {
		t.Fatal(err)
	}
	want := []string{}
	for _, p := range paths {
		uri, _ := fileURI(p)
		want = append(want, uri)
	}
	if mime != "text/uri-list" || !reflect.DeepEqual(strings.Split(strings.TrimSuffix(data, "\r\n"), "\r\n"), want) {
		t.Fatal(mime, data)
	}
}
