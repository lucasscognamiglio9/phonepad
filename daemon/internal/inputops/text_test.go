package inputops

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

func manifest(text string) Manifest {
	sum := sha256.Sum256([]byte(text))
	return Manifest{Version: Version, OperationID: "operation-1", Session: "session-1", Context: "editor-1", Sequence: 1, Bytes: len(text), SHA256: hex.EncodeToString(sum[:])}
}
func transfer(t *testing.T, text string) (*Registry, *TextTransfer) {
	t.Helper()
	r, err := NewRegistry("session-1")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := r.Begin(manifest(text))
	if err != nil {
		t.Fatal(err)
	}
	return r, tx
}
func upload(t *testing.T, tx *TextTransfer, text string) {
	t.Helper()
	for offset, index := 0, 0; offset < len(text); index++ {
		end := offset + MaxChunkBytes
		if end > len(text) {
			end = len(text)
		}
		if _, err := tx.Append(index, []byte(text[offset:end])); err != nil {
			t.Fatal(err)
		}
		offset = end
	}
	if _, err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestLiteralUnicodeAndBoundaries(t *testing.T) {
	samples := []string{"¿? _ @ # [] {} ñ é e\u0301 👨‍👩‍👧‍👦", "a\r\nb\nc\rd\tfin"}
	for _, size := range []int{2047, 2048, 2049, 8191, 8192, 8193, 100 * 1024, MaxTextBytes} {
		samples = append(samples, strings.Repeat("x", size))
	}
	samples = append(samples, strings.Repeat("ñ", 50*1024+1))
	for _, text := range samples {
		t.Run(fmt.Sprint(len(text)), func(t *testing.T) {
			_, tx := transfer(t, text)
			upload(t, tx, text)
			got, err := tx.Claim()
			if err != nil || got != text {
				t.Fatalf("literal changed: err=%v", err)
			}
			if _, err := tx.Claim(); !errors.Is(err, ErrState) {
				t.Fatal("claim was replayable")
			}
			receipt, err := tx.Finish(Dispatched)
			if err != nil || receipt.State != Dispatched {
				t.Fatal(receipt, err)
			}
		})
	}
}

func TestUTF8MayCrossChunks(t *testing.T) {
	text := "A😀B"
	_, tx := transfer(t, text)
	for index, b := range []byte(text) {
		if _, err := tx.Append(index, []byte{b}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	got, err := tx.Claim()
	if got != text || err != nil {
		t.Fatal("split UTF-8 changed", err)
	}
}

func TestNoPartialInjectionAndSafeRetries(t *testing.T) {
	r, tx := transfer(t, "abcdef")
	if _, err := tx.Append(1, []byte("def")); !errors.Is(err, ErrIncomplete) {
		t.Fatal(err)
	}
	tx.Append(0, []byte("abc"))
	if _, err := tx.Commit(); !errors.Is(err, ErrIncomplete) {
		t.Fatal(err)
	}
	if _, err := tx.Claim(); !errors.Is(err, ErrState) {
		t.Fatal("partial text escaped")
	}
	if _, err := tx.Append(0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Append(0, []byte("xyz")); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	again, err := r.Begin(manifest("abcdef"))
	if err != nil || again != tx {
		t.Fatal("duplicate was not deduplicated")
	}
	changed := manifest("abcdef")
	changed.Context = "other"
	if _, err := r.Begin(changed); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	tx.Append(1, []byte("def"))
	tx.Commit()
	tx.Claim()
	tx.Finish(Uncertain)
	if receipt, _ := tx.Commit(); receipt.State != Uncertain {
		t.Fatal("commit replay reset uncertainty")
	}
	if _, err := tx.Claim(); !errors.Is(err, ErrState) {
		t.Fatal("uncertain text replayed")
	}
	if receipt, ok := r.Lookup("operation-1"); !ok || receipt.State != Uncertain {
		t.Fatal(receipt, ok)
	}
}

func TestRejectChecksumInvalidUTF8AndNUL(t *testing.T) {
	for _, text := range []string{"abc", string([]byte{0xff}), "a\x00b"} {
		_, tx := transfer(t, text)
		payload := []byte(text)
		if text == "abc" {
			payload = []byte("abd")
		}
		tx.Append(0, payload)
		if receipt, err := tx.Commit(); !errors.Is(err, ErrInvalid) || receipt.State != Rejected {
			t.Fatal(receipt, err)
		}
		if _, err := tx.Claim(); !errors.Is(err, ErrState) {
			t.Fatal("rejected data escaped")
		}
	}
}

func TestSessionSequenceLimitsAndCancellation(t *testing.T) {
	r, tx := transfer(t, "text")
	m := manifest("text")
	m.Session = "stale"
	if _, err := r.Begin(m); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	m = manifest("text")
	m.OperationID = "new-id"
	if _, err := r.Begin(m); !errors.Is(err, ErrConflict) {
		t.Fatal("repeated sequence accepted")
	}
	for _, size := range []int{0, MaxTextBytes + 1} {
		m = manifest("text")
		m.Bytes = size
		if _, err := r.Begin(m); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	}
	tx.Append(0, []byte("text"))
	tx.Commit()
	tx.Cancel()
	if _, err := tx.Claim(); !errors.Is(err, ErrState) {
		t.Fatal("cancelled operation injected")
	}
	for i := 2; i <= MaxOperations; i++ {
		m = manifest("x")
		m.OperationID = fmt.Sprint(i)
		m.Sequence = uint64(i)
		if _, err := r.Begin(m); err != nil {
			t.Fatal(err)
		}
	}
	m.OperationID = "full"
	m.Sequence++
	if _, err := r.Begin(m); !errors.Is(err, ErrCapacity) {
		t.Fatal("capacity not enforced")
	}
	if _, ok := r.Lookup("operation-1"); !ok {
		t.Fatal("receipt evicted")
	}
}

func TestConcurrentClaimOnlyDispatchesOnce(t *testing.T) {
	_, tx := transfer(t, "one")
	upload(t, tx, "one")
	var wg sync.WaitGroup
	claimed := make(chan string, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if text, err := tx.Claim(); err == nil {
				claimed <- text
			}
		}()
	}
	wg.Wait()
	close(claimed)
	if len(claimed) != 1 {
		t.Fatal("duplicate dispatch", len(claimed))
	}
}

func TestSharedIntegrityCorpus(t *testing.T) {
	data, err := os.ReadFile("../../../tests/fixtures/input-integrity.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		TextCases []struct {
			Name  string
			Value string
		}
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.TextCases) == 0 {
		t.Fatal("empty corpus")
	}
	for _, sample := range fixture.TextCases {
		t.Run(sample.Name, func(t *testing.T) {
			_, tx := transfer(t, sample.Value)
			upload(t, tx, sample.Value)
			got, err := tx.Claim()
			if err != nil || got != sample.Value {
				t.Fatal("literal corpus altered", err)
			}
		})
	}
}

func TestMalformedChunkAndManifestLimits(t *testing.T) {
	r, tx := transfer(t, "abc")
	for _, index := range []int{-1, MaxChunks} {
		if _, err := tx.Append(index, []byte("a")); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	}
	for _, data := range [][]byte{nil, []byte("abcd"), []byte(strings.Repeat("x", MaxChunkBytes+1))} {
		if _, err := tx.Append(0, data); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	}
	variants := []Manifest{manifest("abc"), manifest("abc"), manifest("abc"), manifest("abc")}
	variants[0].Version = 2
	variants[1].Sequence = 9007199254740992
	variants[2].SHA256 = "no"
	variants[3].Context = "../bad"
	for _, m := range variants {
		if _, err := r.Begin(m); !errors.Is(err, ErrInvalid) {
			t.Fatal(err)
		}
	}
	if tx.Receipt().ReceivedBytes != 0 {
		t.Fatal("invalid chunk mutated transfer")
	}
}
