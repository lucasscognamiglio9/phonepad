package filebatches

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const testBatchID = "01234567-0123-4567-8901-012345678901"

func manifestFor(id string, namesAndData ...string) (Manifest, [][]byte) {
	manifest := Manifest{Version: SchemaVersion, ID: id}
	data := make([][]byte, 0, len(namesAndData)/2)
	for i := 0; i < len(namesAndData); i += 2 {
		contents := []byte(namesAndData[i+1])
		hash := sha256.Sum256(contents)
		manifest.Files = append(manifest.Files, FileSpec{
			Name:   namesAndData[i],
			Type:   "application/octet-stream",
			Bytes:  int64(len(contents)),
			SHA256: hex.EncodeToString(hash[:]),
		})
		data = append(data, contents)
	}
	return manifest, data
}

func chunkHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func withLimits(t *testing.T, update func(*LimitSet)) {
	t.Helper()
	previous := Limits
	update(&Limits)
	t.Cleanup(func() { Limits = previous })
}

func TestStoreResumesOverlapAndPublishesOnce(t *testing.T) {
	root := t.TempDir()
	manifest, data := manifestFor(testBatchID, "photo.png", "abcdefgh")
	store := New(root)
	status, err := store.Begin(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != stateReceiving || status.Files[0].Name != "1-photo.png" || status.Files[0].Type != manifest.Files[0].Type {
		t.Fatalf("unexpected begin status: %#v", status)
	}

	if _, err := store.WriteChunk(testBatchID, 0, 0, data[0][:4], chunkHash(data[0][:4])); err != nil {
		t.Fatal(err)
	}
	// A full duplicate is an acknowledged no-op.  An overlapping retry may
	// append only the suffix after matching the existing prefix.
	if _, err := store.WriteChunk(testBatchID, 0, 0, data[0][:4], chunkHash(data[0][:4])); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteChunk(testBatchID, 0, 2, data[0][2:6], chunkHash(data[0][2:6])); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteChunk(testBatchID, 0, 8, data[0][6:], chunkHash(data[0][6:])); !errors.Is(err, ErrInvalid) {
		t.Fatalf("gap accepted: %v", err)
	}
	if _, err := store.WriteChunk(testBatchID, 0, 3, []byte("X"), chunkHash([]byte("X"))); !errors.Is(err, ErrConflict) {
		t.Fatalf("overlap mismatch accepted: %v", err)
	}

	// A fresh Store reads the authoritative file size.  Truncation models a
	// process dying between a partially synced write and its next retry.
	stageFile := filepath.Join(root, stagingDirName, testBatchID, "file-0")
	status, err = New(root).Status(testBatchID)
	if err != nil || status.Files[0].ReceivedBytes != 6 {
		t.Fatalf("resume status = %#v, %v", status, err)
	}
	if err := os.Truncate(stageFile, 4); err != nil {
		t.Fatal(err)
	}
	status, err = New(root).Status(testBatchID)
	if err != nil || status.Files[0].ReceivedBytes != 4 {
		t.Fatalf("truncated status = %#v, %v", status, err)
	}
	if _, err := New(root).WriteChunk(testBatchID, 0, 4, data[0][4:], chunkHash(data[0][4:])); err != nil {
		t.Fatal(err)
	}

	status, published, err := New(root).Commit(testBatchID)
	if err != nil || !published || status.State != stateStored {
		t.Fatalf("commit = %#v, %v, %v", status, published, err)
	}
	if got, err := os.ReadFile(filepath.Join(root, "batch-"+testBatchID, "1-photo.png")); err != nil || string(got) != string(data[0]) {
		t.Fatalf("published file = %q, %v", got, err)
	}
	status, published, err = New(root).Commit(testBatchID)
	if err != nil || published || status.State != stateStored {
		t.Fatalf("replayed commit = %#v, %v, %v", status, published, err)
	}
	if _, err := os.Stat(filepath.Join(root, stagingDirName, testBatchID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging directory survived publication: %v", err)
	}
}

func TestStoreRequiresCompleteChecksumsAndRejectsIdentityReuse(t *testing.T) {
	root := t.TempDir()
	manifest, data := manifestFor(testBatchID, "a.txt", "complete")
	store := New(root)
	if _, err := store.Begin(manifest); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Commit(testBatchID); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("incomplete commit = %v", err)
	}
	if _, err := store.WriteChunk(testBatchID, 0, 0, data[0], chunkHash(data[0])); err != nil {
		t.Fatal(err)
	}
	changed := manifest
	changed.Files[0].Name = "different.txt"
	if _, err := store.Begin(changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("same ID with changed manifest = %v", err)
	}
	if _, _, err := store.Commit(testBatchID); err != nil {
		t.Fatal(err)
	}
	// A pre-existing v1-looking directory has no valid marker and cannot be
	// silently adopted or overwritten.
	otherID := "01234567-0123-4567-8901-012345678902"
	other, _ := manifestFor(otherID, "x", "x")
	if err := os.Mkdir(filepath.Join(root, "batch-"+otherID), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).Begin(other); !errors.Is(err, ErrCorrupt) && !errors.Is(err, ErrConflict) {
		t.Fatalf("ambiguous destination accepted: %v", err)
	}
}

func TestStoreCancelTombstoneRejectsLateRetry(t *testing.T) {
	root := t.TempDir()
	manifest, data := manifestFor(testBatchID, "draft.txt", "draft")
	store := New(root)
	if _, err := store.Begin(manifest); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteChunk(testBatchID, 0, 0, data[0][:2], chunkHash(data[0][:2])); err != nil {
		t.Fatal(err)
	}
	status, err := store.Cancel(testBatchID)
	if err != nil || status.State != stateCancelled || status.Files[0].ReceivedBytes != 2 {
		t.Fatalf("cancel = %#v, %v", status, err)
	}
	stage := filepath.Join(root, stagingDirName, testBatchID)
	if _, err := os.Stat(filepath.Join(stage, "file-0")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancelled payload survived: %v", err)
	}
	// Model a crash after the tombstone became durable but before payload
	// cleanup completed. A new Store finishes only the owned payload cleanup.
	if err := os.WriteFile(filepath.Join(stage, "file-0"), data[0][:2], 0600); err != nil {
		t.Fatal(err)
	}
	status, err = New(root).Status(testBatchID)
	if err != nil || status.State != stateCancelled {
		t.Fatalf("cancelled status = %#v, %v", status, err)
	}
	if _, err := os.Stat(filepath.Join(stage, "file-0")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restart did not finish tombstone cleanup: %v", err)
	}
	if _, err := New(root).WriteChunk(testBatchID, 0, 2, data[0][2:], chunkHash(data[0][2:])); !errors.Is(err, ErrConflict) {
		t.Fatalf("late retry resurrected batch: %v", err)
	}
	if _, _, err := New(root).Commit(testBatchID); !errors.Is(err, ErrConflict) {
		t.Fatalf("cancelled commit accepted: %v", err)
	}
}

func TestStoreValidationAndCapacity(t *testing.T) {
	root := t.TempDir()
	bad, _ := manifestFor("01234567-0123-4567-8901-012345678903", "../outside", "x")
	if _, err := New(root).Begin(bad); !errors.Is(err, ErrInvalid) {
		t.Fatalf("traversal name accepted: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, stagingDirName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid begin mutated root: %v", err)
	}
	tooLarge, _ := manifestFor("01234567-0123-4567-8901-012345678904", "large", "")
	tooLarge.Files[0].Bytes = DefaultMaxTotalBytes + 1
	if _, err := New(root).Begin(tooLarge); !errors.Is(err, ErrCapacity) {
		t.Fatalf("total size accepted: %v", err)
	}
	withLimits(t, func(l *LimitSet) { l.MaxFiles = 1 })
	second, _ := manifestFor("01234567-0123-4567-8901-012345678905", "a", "a", "b", "b")
	if _, err := New(t.TempDir()).Begin(second); !errors.Is(err, ErrCapacity) {
		t.Fatalf("file count accepted: %v", err)
	}
	var decoded Manifest
	if err := json.Unmarshal([]byte(`{"version":2,"id":"`+testBatchID+`","files":[{"name":"x","type":"text/plain","sha256":"`+chunkHash(nil)+`"}]}`), &decoded); err == nil {
		t.Fatal("JSON manifest without bytes was accepted")
	}
}

func TestStorePreservesDuplicateNamesWithPublishedPrefixes(t *testing.T) {
	root := t.TempDir()
	manifest, data := manifestFor("01234567-0123-4567-8901-012345678907", "photo.png", "one", "photo.png", "two")
	store := New(root)
	if _, err := store.Begin(manifest); err != nil {
		t.Fatal(err)
	}
	for i := range data {
		if _, err := store.WriteChunk(manifest.ID, i, 0, data[i], chunkHash(data[i])); err != nil {
			t.Fatal(err)
		}
	}
	if _, published, err := store.Commit(manifest.ID); err != nil || !published {
		t.Fatalf("commit = %v, %v", published, err)
	}
	for i, want := range []string{"one", "two"} {
		path := filepath.Join(root, "batch-"+manifest.ID, publishedName(i, "photo.png"))
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("published duplicate %d = %q, %v", i, got, err)
		}
	}
}

func TestStoreBoundsCancelledTombstonesWithoutEviction(t *testing.T) {
	withLimits(t, func(l *LimitSet) {
		l.MaxTotalStaging = 2
	})
	root := t.TempDir()
	first, firstData := manifestFor("01234567-0123-4567-8901-012345678908", "one", "payload")
	if _, err := New(root).Begin(first); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).WriteChunk(first.ID, 0, 0, firstData[0], chunkHash(firstData[0])); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).Cancel(first.ID); err != nil {
		t.Fatal(err)
	}
	second, _ := manifestFor("01234567-0123-4567-8901-012345678909", "two", "payload")
	if _, err := New(root).Begin(second); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).Cancel(second.ID); err != nil {
		t.Fatalf("cancel at total-stage bound was blocked: %v", err)
	}
	third, _ := manifestFor("01234567-0123-4567-8901-012345678913", "three", "payload")
	if _, err := New(root).Begin(third); !errors.Is(err, ErrCapacity) {
		t.Fatalf("third stage unexpectedly evicted/accepted: %v", err)
	}
	status, err := New(root).Status(first.ID)
	if err != nil || status.State != stateCancelled {
		t.Fatalf("first tombstone was evicted: %#v, %v", status, err)
	}
}

func TestStoreBoundsTotalStages(t *testing.T) {
	withLimits(t, func(l *LimitSet) {
		l.MaxTotalStaging = 1
	})
	root := t.TempDir()
	first, _ := manifestFor("01234567-0123-4567-8901-012345678911", "one", "payload")
	if _, err := New(root).Begin(first); err != nil {
		t.Fatal(err)
	}
	second, _ := manifestFor("01234567-0123-4567-8901-012345678912", "two", "payload")
	if _, err := New(root).Begin(second); !errors.Is(err, ErrCapacity) {
		t.Fatalf("second active stage accepted: %v", err)
	}
	if _, err := New(root).Cancel(first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).Begin(second); !errors.Is(err, ErrCapacity) {
		t.Fatalf("cancelled stage did not count toward total bound: %v", err)
	}
}

func TestStoreRefusesUnknownChildDuringTombstoneCleanup(t *testing.T) {
	withLimits(t, func(l *LimitSet) { l.TTL = time.Hour })
	root := t.TempDir()
	manifest, data := manifestFor("01234567-0123-4567-8901-012345678910", "file.bin", "payload")
	store := New(root)
	if _, err := store.Begin(manifest); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteChunk(manifest.ID, 0, 0, data[0], chunkHash(data[0])); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Cancel(manifest.ID); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(root, stagingDirName, manifest.ID)
	unknown := filepath.Join(stage, "user-added")
	if err := os.WriteFile(unknown, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "file-0"), data[0], 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).Status(manifest.ID); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("unknown child was accepted: %v", err)
	}
	if _, err := os.Stat(unknown); err != nil {
		t.Fatalf("unknown child was removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stage, "file-0")); err != nil {
		t.Fatalf("payload was removed despite unknown child: %v", err)
	}
}

func TestStoreExpiresOwnStageOnly(t *testing.T) {
	withLimits(t, func(l *LimitSet) { l.TTL = time.Hour })
	root := t.TempDir()
	manifest, _ := manifestFor(testBatchID, "old", "old")
	store := New(root)
	if _, err := store.Begin(manifest); err != nil {
		t.Fatal(err)
	}
	foreignID := "01234567-0123-4567-8901-012345678906"
	foreign := filepath.Join(root, stagingDirName, foreignID)
	if err := os.MkdirAll(foreign, 0700); err != nil {
		t.Fatal(err)
	}
	foreignSentinel := filepath.Join(foreign, "keep-me")
	if err := os.WriteFile(foreignSentinel, []byte("user"), 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(filepath.Join(root, stagingDirName, testBatchID), old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).Status(testBatchID); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired status = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, stagingDirName, testBatchID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired owned stage survived: %v", err)
	}
	if got, err := os.ReadFile(foreignSentinel); err != nil || string(got) != "user" {
		t.Fatalf("foreign stage touched: %q, %v", got, err)
	}
}

func TestStoreConcurrentCommitPublishesOnce(t *testing.T) {
	root := t.TempDir()
	manifest, data := manifestFor(testBatchID, "a.bin", "payload")
	store := New(root)
	if _, err := store.Begin(manifest); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteChunk(testBatchID, 0, 0, data[0], chunkHash(data[0])); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	var mu sync.Mutex
	published := 0
	errorsSeen := 0
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, once, err := store.Commit(testBatchID)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				errorsSeen++
			}
			if once {
				published++
			}
		}()
	}
	wait.Wait()
	if errorsSeen != 0 || published != 1 {
		t.Fatalf("concurrent commits: errors=%d published=%d", errorsSeen, published)
	}
}
