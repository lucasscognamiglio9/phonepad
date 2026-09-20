// Package filebatches stores upload batches until all of their files have
// been verified.  A receiving batch lives below .phonepad-staging and only a
// complete batch is renamed into the caller's root directory.
package filebatches

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	// SchemaVersion is the on-disk and wire version implemented by this
	// package.
	SchemaVersion = 2
	Version       = SchemaVersion

	DefaultMaxFiles        = 20
	DefaultMaxTotalBytes   = int64(100 << 20)
	DefaultMaxChunkBytes   = int64(1 << 20)
	DefaultMaxStaging      = 4
	DefaultMaxTotalStaging = 128
	DefaultTTL             = 24 * time.Hour

	// The short names are useful to callers that only need a compile-time
	// bound.  Limits is the run-time form used by the store and is exported so
	// a test or an embedding daemon can choose a smaller bound.
	MaxFiles      = DefaultMaxFiles
	MaxTotalBytes = DefaultMaxTotalBytes
	MaxChunkBytes = DefaultMaxChunkBytes
	MaxStaging    = DefaultMaxStaging
	TTL           = DefaultTTL
)

// LimitSet contains the resource bounds for a Store.  The package defaults
// are deliberately conservative: a chunk is at most 1 MiB, while a complete
// batch is at most 100 MiB and has at most 20 files. MaxStaging counts
// receiving batches. Cancelled tombstones are retained for the TTL
// deduplication window. A total-stage bound keeps repeated cancellations from
// retaining unbounded stage directories, while the active bound still limits
// concurrent receiving batches.
type LimitSet struct {
	MaxFiles        int
	MaxTotalBytes   int64
	MaxChunkBytes   int64
	MaxStaging      int
	MaxTotalStaging int
	TTL             time.Duration
}

// Limits is the default limit set.  It is a variable to permit short TTLs in
// tests and in constrained embedding environments.  A zero field means that
// the corresponding package default is used.
var Limits = LimitSet{
	MaxFiles:        DefaultMaxFiles,
	MaxTotalBytes:   DefaultMaxTotalBytes,
	MaxChunkBytes:   DefaultMaxChunkBytes,
	MaxStaging:      DefaultMaxStaging,
	MaxTotalStaging: DefaultMaxTotalStaging,
	TTL:             DefaultTTL,
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Errors returned by Store methods.  Callers can use errors.Is to distinguish
// bad input from an identity conflict, an unknown batch, or a resource bound.
var (
	ErrInvalid    = errors.New("filebatches: invalid request")
	ErrConflict   = errors.New("filebatches: conflict")
	ErrNotFound   = errors.New("filebatches: batch not found")
	ErrCapacity   = errors.New("filebatches: capacity exceeded")
	ErrExpired    = errors.New("filebatches: batch expired")
	ErrCorrupt    = errors.New("filebatches: corrupt persisted state")
	ErrIncomplete = errors.New("filebatches: batch incomplete")
)

// Manifest identifies a resumable batch.  Every file has an explicit size
// and checksum; this makes a commit independently verifiable after a restart.
type Manifest struct {
	Version int        `json:"version"`
	ID      string     `json:"id"`
	Files   []FileSpec `json:"files"`
}

// FileSpec is the expected metadata for one file in a Manifest.
type FileSpec struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`

	// bytesSet lets JSON decoding distinguish a required bytes field from a
	// legitimate zero-byte file.  Go callers naturally have the field set by
	// constructing a FileSpec value, so validation accepts Bytes == 0 there.
	bytesSet bool
}

// FileStatus describes progress for one manifest entry. Name is the published
// filename: Index+1 is prefixed to preserve order in a consumer that reads
// the folder.
type FileStatus struct {
	Index         int    `json:"index"`
	Name          string `json:"name"`
	Type          string `json:"type"`
	Bytes         int64  `json:"bytes"`
	ReceivedBytes int64  `json:"receivedBytes"`
	SHA256        string `json:"sha256"`
}

// Status is the durable state of a batch.
type Status struct {
	Version int          `json:"version"`
	ID      string       `json:"id"`
	State   string       `json:"state"`
	Files   []FileStatus `json:"files"`
	Folder  string       `json:"folder,omitempty"`
}

// Store is safe for concurrent use.  The mutex serializes every operation,
// including filesystem publication, so two Commit calls on one Store cannot
// publish the same batch twice.
type Store struct {
	root string
	mu   sync.Mutex
}

const (
	stagingDirName = ".phonepad-staging"
	ownerName      = ".phonepad-filebatch"
	manifestName   = ".manifest.json"
	stateName      = ".state.json"
	receiptName    = ".receipt.json"
)

const (
	stateReceiving = "receiving"
	stateStored    = "stored"
	stateCancelled = "cancelled"

	Receiving = stateReceiving
	Stored    = stateStored
	Cancelled = stateCancelled
)

// New constructs a persistent store rooted at root.  It does not create any
// directories until the first valid operation, so an invalid request cannot
// leave storage behind.
func New(root string) *Store {
	if root == "" {
		root = "."
	}
	return &Store{root: filepath.Clean(root)}
}

// Begin validates and starts (or resumes) a batch.  A same-ID, same-manifest
// batch is resumable; a same-ID, different-manifest batch is a conflict.
func (s *Store) Begin(manifest Manifest) (Status, error) {
	return s.begin(manifest, nil)
}

// BeginWithGuard is the guarded form used by an HTTP caller whose permission
// may change while the manifest is being decoded. The store lock is acquired
// before the guard, so callers preserve the store.mu -> mutationGate order.
// Validation and capacity checks happen before the guarded stage creation.
func (s *Store) BeginWithGuard(manifest Manifest, guard func(func() error) error) (Status, error) {
	return s.begin(manifest, guard)
}

func (s *Store) begin(manifest Manifest, guard func(func() error) error) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limits := limitSnapshot()
	if err := validateManifest(manifest, limits); err != nil {
		return Status{}, err
	}
	// Expiry cleanup is deliberately after manifest validation.  Invalid input
	// must not mutate even an unrelated staging directory.
	s.cleanupExpiredLocked(limits)

	destination := s.destinationPath(manifest.ID)
	if exists, status, existing, err := s.readDestinationLocked(manifest.ID, destination, limits); exists {
		if err != nil {
			return Status{}, err
		}
		if !manifestsEqual(manifest, existing) {
			return Status{}, conflictf("batch ID already belongs to another manifest")
		}
		return status, nil
	}

	stage := s.stagePath(manifest.ID)
	if exists, record, err := s.readStageLocked(manifest.ID, stage, limits); exists {
		if err != nil {
			return Status{}, err
		}
		if !manifestsEqual(manifest, record.manifest) {
			return Status{}, conflictf("batch ID already belongs to another manifest")
		}
		if record.state.State == stateCancelled {
			return record.status, nil
		}
		if record.state.State != stateReceiving {
			return Status{}, corruptf("staging state is not resumable")
		}
		return record.status, nil
	}

	if counts, err := s.stageCountsLocked(limits); err != nil {
		return Status{}, err
	} else if counts.receiving >= limits.MaxStaging {
		return Status{}, capacityf("maximum active staging batches reached")
	} else if counts.total >= limits.MaxTotalStaging {
		return Status{}, capacityf("maximum total staging directories reached")
	}
	create := func() error {
		if err := s.ensureStorageLocked(); err != nil {
			return err
		}
		if _, err := os.Lstat(destination); err == nil {
			// A destination may have appeared while the store was preparing the
			// stage. It is never safe to overwrite it.
			return conflictf("destination appeared during begin")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if _, err := os.Lstat(stage); err == nil {
			return conflictf("staging path appeared during begin")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return s.createStageLocked(manifest, stage)
	}
	if guard != nil {
		if err := guard(create); err != nil {
			return Status{}, err
		}
	} else if err := create(); err != nil {
		return Status{}, err
	}
	return statusForStage(manifest, diskState{
		Version: SchemaVersion,
		ID:      manifest.ID,
		State:   stateReceiving,
		Files:   initialFileStatuses(manifest),
	}, stage, limits)
}

// Status returns durable state for id.  Unknown or malformed state is
// returned as an error rather than being guessed into a replay decision.
func (s *Store) Status(id string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateID(id); err != nil {
		return Status{}, err
	}
	limits := limitSnapshot()

	destination := s.destinationPath(id)
	if exists, status, _, err := s.readDestinationLocked(id, destination, limits); exists {
		if err != nil {
			return Status{}, err
		}
		return status, nil
	}
	stage := s.stagePath(id)
	if exists, record, err := s.readStageLocked(id, stage, limits); exists {
		if err != nil {
			return Status{}, err
		}
		if expired, expireErr := s.expireStageIfNeededLocked(record, stage, limits); expireErr != nil {
			return Status{}, expireErr
		} else if expired {
			return Status{}, expiredf("batch TTL elapsed")
		}
		return record.status, nil
	}
	return Status{}, notFoundf("unknown batch")
}

// WriteChunk verifies a chunk checksum and writes it at offset.  A retry may
// overlap an already written prefix only when all overlapping bytes match;
// a gap or a mismatch is rejected.  The resulting file is synced before the
// operation is acknowledged.
func (s *Store) WriteChunk(id string, index int, offset int64, data []byte, chunkSHA256 string) (Status, error) {
	return s.writeChunk(id, index, offset, data, chunkSHA256, nil)
}

// WriteChunkWithGuard is the guarded form used by an HTTP caller. It reads
// and validates the request data before invoking the guard, then keeps the
// store lock while the guarded file and state update run. This preserves the
// store.mu -> mutationGate order used by CommitWithGuard.
func (s *Store) WriteChunkWithGuard(id string, index int, offset int64, data []byte, chunkSHA256 string, guard func(func() error) error) (Status, error) {
	return s.writeChunk(id, index, offset, data, chunkSHA256, guard)
}

func (s *Store) writeChunk(id string, index int, offset int64, data []byte, chunkSHA256 string, guard func(func() error) error) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	limits := limitSnapshot()
	if err := validateID(id); err != nil {
		return Status{}, err
	}
	if index < 0 {
		return Status{}, invalidf("negative file index")
	}
	if offset < 0 {
		return Status{}, invalidf("negative chunk offset")
	}
	if int64(len(data)) > limits.MaxChunkBytes {
		return Status{}, capacityf("chunk exceeds %d bytes", limits.MaxChunkBytes)
	}
	if err := validateHash(chunkSHA256); err != nil {
		return Status{}, err
	}
	got := sha256.Sum256(data)
	if hex.EncodeToString(got[:]) != chunkSHA256 {
		return Status{}, conflictf("chunk checksum mismatch")
	}
	stage := s.stagePath(id)
	if exists, record, err := s.readStageLocked(id, stage, limits); exists {
		if err != nil {
			return Status{}, err
		}
		if expired, expireErr := s.expireStageIfNeededLocked(record, stage, limits); expireErr != nil {
			return Status{}, expireErr
		} else if expired {
			return Status{}, expiredf("batch TTL elapsed")
		}
		if record.state.State == stateCancelled {
			return record.status, conflictf("batch was cancelled")
		}
		if record.state.State != stateReceiving {
			return record.status, conflictf("batch is not receiving")
		}
		if index >= len(record.manifest.Files) {
			return record.status, invalidf("file index out of range")
		}
		fileSpec := record.manifest.Files[index]
		path := stageFilePath(stage, index)
		file, info, err := openOwnedStageFile(path, false)
		if err != nil {
			return record.status, err
		}
		defer file.Close()
		if info.Size() < 0 || info.Size() > fileSpec.Bytes {
			return record.status, corruptf("staged file size is outside manifest bounds")
		}
		current := info.Size()
		if offset > current {
			return record.status, invalidf("chunk leaves a gap")
		}
		if int64(len(data)) > fileSpec.Bytes-offset {
			return record.status, capacityf("chunk exceeds declared file size")
		}
		overlap := int64(len(data))
		if overlap > current-offset {
			overlap = current - offset
		}
		if overlap > 0 {
			existing := make([]byte, int(overlap))
			if _, err := file.ReadAt(existing, offset); err != nil && !errors.Is(err, io.EOF) {
				return record.status, corruptf("cannot read staged prefix: %v", err)
			}
			if !equalBytes(existing, data[:overlap]) {
				return record.status, conflictf("overlapping chunk bytes differ")
			}
		}
		write := func() error {
			if suffix := data[overlap:]; len(suffix) > 0 {
				if _, err := file.WriteAt(suffix, current); err != nil {
					return err
				}
			}
			// Also sync an entirely repeated chunk: an earlier interrupted write
			// may have reached the page cache without reaching its durability ACK.
			if err := file.Sync(); err != nil {
				return err
			}
			if err := file.Close(); err != nil {
				return err
			}
			// File size is authoritative. Persisting a refreshed state makes the
			// activity and cancellation snapshot survive a daemon restart.
			record.state.UpdatedAt = time.Now().UTC()
			record.state.Files, err = fileStatusesFromStage(record.manifest, stage, limits)
			if err != nil {
				return err
			}
			if err := writeJSONAtomic(filepath.Join(stage, stateName), record.state); err != nil {
				return err
			}
			record.status, err = statusForStage(record.manifest, record.state, stage, limits)
			return err
		}
		if guard != nil {
			if err := guard(write); err != nil {
				return record.status, err
			}
		} else if err := write(); err != nil {
			return record.status, err
		}
		return record.status, nil
	}

	// A published destination is intentionally checked after the staging path:
	// a completed batch cannot be changed by a late chunk, but its durable
	// receipt can still be returned to a caller.
	if exists, status, _, err := s.readDestinationLocked(id, s.destinationPath(id), limits); exists {
		if err != nil {
			return Status{}, err
		}
		return status, conflictf("batch is already stored")
	}
	return Status{}, notFoundf("unknown batch")
}

// Commit verifies all files, writes a durable receipt, and atomically renames
// the private stage to root/batch-ID.  The boolean is true only for the call
// that actually published the directory; replaying a stored batch is false.
func (s *Store) Commit(id string) (Status, bool, error) {
	return s.commit(id, nil)
}

// CommitWithGuard is the guarded form used by the HTTP server when a host
// permission can be revoked while a complete batch is being hashed. The
// guard runs only after all file sizes and hashes have been verified and wraps
// the receipt/publication effects. It must not be held while Commit reads or
// hashes staged payloads. A stored replay returns without invoking guard; the
// HTTP caller validates its request permission before calling this method.
func (s *Store) CommitWithGuard(id string, guard func(func() error) error) (Status, bool, error) {
	return s.commit(id, guard)
}

func (s *Store) commit(id string, guard func(func() error) error) (Status, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateID(id); err != nil {
		return Status{}, false, err
	}
	limits := limitSnapshot()
	destination := s.destinationPath(id)

	if exists, status, _, err := s.readDestinationLocked(id, destination, limits); exists {
		if err != nil {
			return Status{}, false, err
		}
		return status, false, nil
	}
	stage := s.stagePath(id)
	exists, record, err := s.readStageLocked(id, stage, limits)
	if !exists {
		return Status{}, false, notFoundf("unknown batch")
	}
	if err != nil {
		return Status{}, false, err
	}
	if expired, expireErr := s.expireStageIfNeededLocked(record, stage, limits); expireErr != nil {
		return Status{}, false, expireErr
	} else if expired {
		return Status{}, false, expiredf("batch TTL elapsed")
	}
	if record.state.State == stateCancelled {
		return record.status, false, conflictf("batch was cancelled")
	}
	if record.state.State != stateReceiving {
		return Status{}, false, corruptf("staging state is not receiving")
	}

	statuses, err := fileStatusesFromStage(record.manifest, stage, limits)
	if err != nil {
		return Status{}, false, err
	}
	for i, spec := range record.manifest.Files {
		if statuses[i].ReceivedBytes != spec.Bytes {
			return statusWithFiles(record.manifest, stateReceiving, statuses, ""), false, incompletef("file %d has %d of %d bytes", i, statuses[i].ReceivedBytes, spec.Bytes)
		}
		actual, err := hashOwnedStageFile(stageFilePath(stage, i), spec.Bytes)
		if err != nil {
			return statusWithFiles(record.manifest, stateReceiving, statuses, ""), false, err
		}
		if actual != spec.SHA256 {
			return statusWithFiles(record.manifest, stateReceiving, statuses, ""), false, conflictf("file %d checksum mismatch", i)
		}
	}
	// Check before creating or replacing anything in the destination.  An
	// existing path is never overwritten, even if it is an empty directory.
	if info, statErr := os.Lstat(destination); statErr == nil {
		_ = info
		return Status{}, false, conflictf("destination already exists")
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return Status{}, false, statErr
	}

	storedStatus := statusWithFiles(record.manifest, stateStored, statuses, filepath.Base(destination))
	receipt := diskReceipt{
		Version:      SchemaVersion,
		ID:           id,
		State:        stateStored,
		Manifest:     record.manifest,
		ManifestHash: manifestDigest(record.manifest),
		Files:        statuses,
		Folder:       filepath.Base(destination),
	}
	renamed := false
	publish := func() error {
		// The receipt is inside the stage before rename. A process dying before
		// rename leaves a clearly identifiable private state; readStage rejects
		// unknown receipt entries instead of replaying it on the next start.
		if err := writeJSONAtomic(filepath.Join(stage, receiptName), receipt); err != nil {
			return err
		}
		if err := writeJSONAtomic(filepath.Join(stage, stateName), diskState{
			Version:   SchemaVersion,
			ID:        id,
			State:     stateReceiving,
			CreatedAt: record.state.CreatedAt,
			UpdatedAt: time.Now().UTC(),
			Files:     statuses,
		}); err != nil {
			return err
		}
		if err := renamePublishedFiles(stage, record.manifest); err != nil {
			return err
		}
		if err := syncDir(stage); err != nil {
			return err
		}
		if err := os.Rename(stage, destination); err != nil {
			return err
		}
		renamed = true
		if err := syncDir(s.root); err != nil {
			// The rename has happened. The receipt remains authoritative and a
			// later Status/Commit call will return stored; surface the durability
			// error without pretending a second publication is needed.
			return err
		}
		return nil
	}
	if guard != nil {
		if err := guard(publish); err != nil {
			if renamed {
				return storedStatus, true, err
			}
			return Status{}, false, err
		}
	} else if err := publish(); err != nil {
		if renamed {
			return storedStatus, true, err
		}
		return Status{}, false, err
	}
	return storedStatus, true, nil
}

// Cancel writes a tombstone in place of a receiving stage.  The tombstone is
// retained for the TTL, so a late retry cannot recreate or append to it.
func (s *Store) Cancel(id string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := validateID(id); err != nil {
		return Status{}, err
	}
	limits := limitSnapshot()
	if exists, status, _, err := s.readDestinationLocked(id, s.destinationPath(id), limits); exists {
		if err != nil {
			return Status{}, err
		}
		return status, conflictf("stored batch cannot be cancelled")
	}
	stage := s.stagePath(id)
	exists, record, err := s.readStageLocked(id, stage, limits)
	if !exists {
		return Status{}, notFoundf("unknown batch")
	}
	if err != nil {
		return Status{}, err
	}
	if expired, expireErr := s.expireStageIfNeededLocked(record, stage, limits); expireErr != nil {
		return Status{}, expireErr
	} else if expired {
		return Status{}, expiredf("batch TTL elapsed")
	}
	if record.state.State == stateCancelled {
		return record.status, nil
	}
	if record.state.State != stateReceiving {
		return record.status, conflictf("batch is not receiving")
	}
	statuses, err := fileStatusesFromStage(record.manifest, stage, limits)
	if err != nil {
		return Status{}, err
	}
	record.state.State = stateCancelled
	record.state.UpdatedAt = time.Now().UTC()
	record.state.Files = statuses
	if err := writeJSONAtomic(filepath.Join(stage, stateName), record.state); err != nil {
		return Status{}, err
	}
	if err := syncDir(stage); err != nil {
		return Status{}, err
	}
	if err := cleanupCancelledPayloads(stage, record.manifest); err != nil {
		// The tombstone is already durable. Keep it queryable and let a later
		// Store recreation retry cleanup rather than deleting uncertain paths.
		return statusWithFiles(record.manifest, stateCancelled, statuses, ""), err
	}
	return statusWithFiles(record.manifest, stateCancelled, statuses, ""), nil
}

type diskState struct {
	Version   int          `json:"version"`
	ID        string       `json:"id"`
	State     string       `json:"state"`
	CreatedAt time.Time    `json:"createdAt"`
	UpdatedAt time.Time    `json:"updatedAt"`
	Files     []FileStatus `json:"files"`
}

type diskReceipt struct {
	Version      int          `json:"version"`
	ID           string       `json:"id"`
	State        string       `json:"state"`
	Manifest     Manifest     `json:"manifest"`
	ManifestHash string       `json:"manifestHash"`
	Files        []FileStatus `json:"files"`
	Folder       string       `json:"folder"`
}

type ownerMarker struct {
	Version int    `json:"version"`
	ID      string `json:"id"`
}

type stageRecord struct {
	manifest Manifest
	state    diskState
	status   Status
}

func limitSnapshot() LimitSet {
	l := Limits
	if l.MaxFiles <= 0 {
		l.MaxFiles = DefaultMaxFiles
	}
	if l.MaxTotalBytes <= 0 {
		l.MaxTotalBytes = DefaultMaxTotalBytes
	}
	if l.MaxChunkBytes <= 0 {
		l.MaxChunkBytes = DefaultMaxChunkBytes
	}
	if l.MaxStaging <= 0 {
		l.MaxStaging = DefaultMaxStaging
	}
	if l.MaxTotalStaging <= 0 {
		l.MaxTotalStaging = DefaultMaxTotalStaging
	}
	if l.TTL <= 0 {
		l.TTL = DefaultTTL
	}
	return l
}

func validateManifest(m Manifest, limits LimitSet) error {
	if m.Version != SchemaVersion {
		return invalidf("manifest version must be %d", SchemaVersion)
	}
	if err := validateID(m.ID); err != nil {
		return err
	}
	if len(m.Files) == 0 {
		return invalidf("manifest must contain at least one file")
	}
	if len(m.Files) > limits.MaxFiles {
		return capacityf("manifest contains %d files; maximum is %d", len(m.Files), limits.MaxFiles)
	}
	var total int64
	for i, file := range m.Files {
		if err := validateFilename(file.Name); err != nil {
			return fmt.Errorf("%w: file %d: %v", ErrInvalid, i, err)
		}
		if len(file.Type) > 128 || strings.IndexFunc(file.Type, unicode.IsControl) >= 0 {
			return invalidf("invalid file type for %q", file.Name)
		}
		if file.Bytes < 0 {
			return invalidf("negative file size for %q", file.Name)
		}
		if file.Bytes > limits.MaxTotalBytes || total > limits.MaxTotalBytes-file.Bytes {
			return capacityf("manifest exceeds %d bytes", limits.MaxTotalBytes)
		}
		total += file.Bytes
		if err := validateHash(file.SHA256); err != nil {
			return fmt.Errorf("%w: file %d checksum: %v", ErrInvalid, i, err)
		}
	}
	return nil
}

func validateFilename(name string) error {
	if name == "" || name == "." || name == ".." {
		return errors.New("empty or dot filename")
	}
	if len(name) > 180 {
		return errors.New("filename is too long")
	}
	if strings.ContainsAny(name, `/\\`) {
		return errors.New("filename contains a path separator")
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return errors.New("filename contains a control character")
	}
	return nil
}

func validateID(id string) error {
	if !uuidPattern.MatchString(id) {
		return invalidf("ID must be a lowercase canonical UUID")
	}
	return nil
}

func validateHash(sum string) error {
	if len(sum) != sha256.Size*2 || sum != strings.ToLower(sum) {
		return invalidf("checksum must be lowercase hexadecimal SHA256")
	}
	if _, err := hex.DecodeString(sum); err != nil {
		return invalidf("checksum is not hexadecimal")
	}
	return nil
}

func manifestsEqual(a, b Manifest) bool {
	if a.Version != b.Version || a.ID != b.ID || len(a.Files) != len(b.Files) {
		return false
	}
	for i := range a.Files {
		if a.Files[i].Name != b.Files[i].Name || a.Files[i].Type != b.Files[i].Type || a.Files[i].Bytes != b.Files[i].Bytes || a.Files[i].SHA256 != b.Files[i].SHA256 {
			return false
		}
	}
	return true
}

func manifestDigest(m Manifest) string {
	data, _ := json.Marshal(m)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func initialFileStatuses(m Manifest) []FileStatus {
	files := make([]FileStatus, len(m.Files))
	for i, spec := range m.Files {
		files[i] = FileStatus{
			Index:  i,
			Name:   publishedName(i, spec.Name),
			Type:   spec.Type,
			Bytes:  spec.Bytes,
			SHA256: spec.SHA256,
		}
	}
	return files
}

func publishedName(index int, name string) string {
	return fmt.Sprintf("%d-%s", index+1, name)
}

func statusWithFiles(m Manifest, state string, files []FileStatus, folder string) Status {
	copyFiles := append([]FileStatus(nil), files...)
	return Status{Version: SchemaVersion, ID: m.ID, State: state, Files: copyFiles, Folder: folder}
}

func statusForStage(m Manifest, state diskState, stage string, limits LimitSet) (Status, error) {
	files, err := fileStatusesFromStage(m, stage, limits)
	if err != nil {
		return Status{}, err
	}
	if state.State == stateCancelled && len(state.Files) == len(m.Files) {
		files = append([]FileStatus(nil), state.Files...)
	}
	return statusWithFiles(m, state.State, files, ""), nil
}

func (f *FileSpec) UnmarshalJSON(data []byte) error {
	type wire struct {
		Name   string `json:"name"`
		Type   string `json:"type"`
		Bytes  *int64 `json:"bytes"`
		SHA256 string `json:"sha256"`
	}
	var value wire
	if err := decodeStrict(data, &value); err != nil {
		return err
	}
	if value.Bytes == nil {
		return errors.New("bytes is required")
	}
	f.Name, f.Type, f.Bytes, f.SHA256, f.bytesSet = value.Name, value.Type, *value.Bytes, value.SHA256, true
	return nil
}

func (m *Manifest) UnmarshalJSON(data []byte) error {
	type wire struct {
		Version int        `json:"version"`
		ID      string     `json:"id"`
		Files   []FileSpec `json:"files"`
	}
	var value wire
	if err := decodeStrict(data, &value); err != nil {
		return err
	}
	m.Version, m.ID, m.Files = value.Version, value.ID, value.Files
	return nil
}

func decodeStrict(data []byte, value any) error {
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON data")
		}
		return err
	}
	return nil
}

func (s *Store) destinationPath(id string) string {
	return filepath.Join(s.root, "batch-"+id)
}

func (s *Store) stagePath(id string) string {
	return filepath.Join(s.root, stagingDirName, id)
}

func stageFilePath(stage string, index int) string {
	return filepath.Join(stage, fmt.Sprintf("file-%d", index))
}

func (s *Store) ensureStorageLocked() error {
	if info, err := os.Lstat(s.root); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return conflictf("batch root is not a directory")
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(s.root, 0700); err != nil {
			return err
		}
	} else {
		return err
	}
	stagingRoot := filepath.Join(s.root, stagingDirName)
	if info, err := os.Lstat(stagingRoot); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return conflictf("staging root is not a directory")
		}
		if err := os.Chmod(stagingRoot, 0700); err != nil {
			return err
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(stagingRoot, 0700); err != nil {
			return err
		}
	} else {
		return err
	}
	return nil
}

func (s *Store) checkRootPathLocked() error {
	info, err := os.Lstat(s.root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return conflictf("batch root is not a directory")
	}
	return nil
}

func checkStagingRoot(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return conflictf("staging root is not a directory")
	}
	return nil
}

func readStagingEntries(path string) ([]os.DirEntry, error) {
	if err := checkStagingRoot(path); err != nil {
		return nil, err
	}
	return os.ReadDir(path)
}

func (s *Store) createStageLocked(m Manifest, stage string) (err error) {
	if err := os.Mkdir(stage, 0700); err != nil {
		return err
	}
	ownerWritten := false
	success := false
	defer func() {
		if success {
			return
		}
		if ownerWritten {
			_ = removeOwnedStage(stage, m.ID)
		} else {
			_ = os.Remove(stage)
		}
	}()
	if err := writeJSONAtomic(filepath.Join(stage, ownerName), ownerMarker{Version: SchemaVersion, ID: m.ID}); err != nil {
		return err
	}
	ownerWritten = true
	if err := writeJSONAtomic(filepath.Join(stage, manifestName), m); err != nil {
		return err
	}
	state := diskState{
		Version:   SchemaVersion,
		ID:        m.ID,
		State:     stateReceiving,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
		Files:     initialFileStatuses(m),
	}
	for i := range m.Files {
		file, err := os.OpenFile(stageFilePath(stage, i), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return err
		}
		if err := file.Sync(); err != nil {
			_ = file.Close()
			return err
		}
		if err := file.Close(); err != nil {
			return err
		}
	}
	if err := writeJSONAtomic(filepath.Join(stage, stateName), state); err != nil {
		return err
	}
	if err := syncDir(stage); err != nil {
		return err
	}
	success = true
	return nil
}

func (s *Store) readStageLocked(id, stage string, limits LimitSet) (bool, stageRecord, error) {
	var zero stageRecord
	if err := s.checkRootPathLocked(); err != nil {
		return true, zero, err
	}
	if err := checkStagingRoot(filepath.Dir(stage)); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, zero, nil
		}
		return true, zero, err
	}
	info, err := os.Lstat(stage)
	if errors.Is(err, os.ErrNotExist) {
		return false, zero, nil
	}
	if err != nil {
		return true, zero, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return true, zero, conflictf("staging path is not a directory")
	}
	marker, err := readJSONFile[ownerMarker](filepath.Join(stage, ownerName), 4096)
	if err != nil {
		return true, zero, corruptf("owner marker: %v", err)
	}
	if marker.Version != SchemaVersion || marker.ID != id {
		return true, zero, corruptf("owner marker does not match batch")
	}
	manifest, err := readJSONFile[Manifest](filepath.Join(stage, manifestName), 64<<10)
	if err != nil {
		return true, zero, corruptf("manifest: %v", err)
	}
	if err := validateManifest(manifest, limits); err != nil || manifest.ID != id {
		return true, zero, corruptf("persisted manifest is invalid: %v", err)
	}
	state, err := readJSONFile[diskState](filepath.Join(stage, stateName), 64<<10)
	if err != nil {
		return true, zero, corruptf("state: %v", err)
	}
	if state.Version != SchemaVersion || state.ID != id || (state.State != stateReceiving && state.State != stateCancelled) || state.CreatedAt.IsZero() || state.UpdatedAt.IsZero() {
		return true, zero, corruptf("persisted staging state is invalid")
	}
	if len(state.Files) != len(manifest.Files) {
		return true, zero, corruptf("persisted status has the wrong file count")
	}
	if err := checkStatusShape(manifest, state.Files); err != nil {
		return true, zero, corruptf("persisted status: %v", err)
	}
	entries, err := checkStageEntries(stage, manifest)
	if err != nil {
		return true, zero, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == receiptName || isPublishedStageName(name, manifest) || (state.State == stateReceiving && strings.HasPrefix(name, ".phonepad-tmp-")) {
			return true, zero, corruptf("staging publication is incomplete")
		}
	}
	if state.State == stateReceiving {
		files, err := fileStatusesFromStage(manifest, stage, limits)
		if err != nil {
			return true, zero, err
		}
		state.Files = files
	} else if err := cleanupCancelledPayloads(stage, manifest); err != nil {
		return true, zero, err
	}
	status := statusWithFiles(manifest, state.State, state.Files, "")
	return true, stageRecord{manifest: manifest, state: state, status: status}, nil
}

func (s *Store) readDestinationLocked(id, destination string, limits LimitSet) (bool, Status, Manifest, error) {
	if err := s.checkRootPathLocked(); err != nil {
		return true, Status{}, Manifest{}, err
	}
	info, err := os.Lstat(destination)
	if errors.Is(err, os.ErrNotExist) {
		return false, Status{}, Manifest{}, nil
	}
	if err != nil {
		return true, Status{}, Manifest{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return true, Status{}, Manifest{}, conflictf("published path is not a directory")
	}
	marker, err := readJSONFile[ownerMarker](filepath.Join(destination, ownerName), 4096)
	if err != nil || marker.Version != SchemaVersion || marker.ID != id {
		return true, Status{}, Manifest{}, corruptf("published owner marker is invalid")
	}
	receipt, err := readJSONFile[diskReceipt](filepath.Join(destination, receiptName), 128<<10)
	if err != nil {
		return true, Status{}, Manifest{}, corruptf("published receipt: %v", err)
	}
	if receipt.Version != SchemaVersion || receipt.ID != id || receipt.State != stateStored || receipt.Folder != filepath.Base(destination) || receipt.ManifestHash != manifestDigest(receipt.Manifest) {
		return true, Status{}, Manifest{}, corruptf("published receipt is invalid")
	}
	if err := validateManifest(receipt.Manifest, limits); err != nil {
		return true, Status{}, Manifest{}, corruptf("published manifest: %v", err)
	}
	if err := checkStatusShape(receipt.Manifest, receipt.Files); err != nil {
		return true, Status{}, Manifest{}, corruptf("published status: %v", err)
	}
	for _, file := range receipt.Files {
		if file.ReceivedBytes != file.Bytes {
			return true, Status{}, Manifest{}, corruptf("published status is incomplete")
		}
	}
	status := statusWithFiles(receipt.Manifest, stateStored, receipt.Files, receipt.Folder)
	return true, status, receipt.Manifest, nil
}

func checkStatusShape(m Manifest, files []FileStatus) error {
	if len(files) != len(m.Files) {
		return errors.New("wrong file count")
	}
	for i, status := range files {
		spec := m.Files[i]
		if status.Index != i || status.Name != publishedName(i, spec.Name) || status.Type != spec.Type || status.Bytes != spec.Bytes || status.SHA256 != spec.SHA256 || status.ReceivedBytes < 0 || status.ReceivedBytes > status.Bytes {
			return fmt.Errorf("file %d does not match manifest", i)
		}
	}
	return nil
}

func checkStageEntries(stage string, manifest Manifest) ([]os.DirEntry, error) {
	entries, err := os.ReadDir(stage)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{ownerName: true, manifestName: true, stateName: true, receiptName: true}
	for i := 0; i < len(manifest.Files); i++ {
		allowed[fmt.Sprintf("file-%d", i)] = true
		allowed[publishedName(i, manifest.Files[i].Name)] = true
	}
	for _, entry := range entries {
		name := entry.Name()
		if !allowed[name] && !strings.HasPrefix(name, ".phonepad-tmp-") {
			return nil, corruptf("unexpected staging entry %q", name)
		}
		info, err := os.Lstat(filepath.Join(stage, entry.Name()))
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return nil, corruptf("unsafe staging entry %q", name)
		}
		if strings.HasPrefix(name, ".phonepad-tmp-") && len(name) > 128 {
			return nil, corruptf("temporary staging entry is too long")
		}
	}
	return entries, nil
}

func isPublishedStageName(name string, manifest Manifest) bool {
	for i, file := range manifest.Files {
		if name == publishedName(i, file.Name) {
			return true
		}
	}
	return false
}

// cleanupCancelledPayloads removes only the payload and temporary files from
// a durable tombstone. The state and manifest stay queryable for the TTL
// deduplication window. The complete entry validation happens before the first
// remove, so an unexpected child causes a conservative refusal rather than a
// partial cleanup that could touch an unrelated file.
func cleanupCancelledPayloads(stage string, manifest Manifest) error {
	entries, err := checkStageEntries(stage, manifest)
	if err != nil {
		return err
	}
	allowedPayloads := make(map[string]bool, len(manifest.Files))
	for i := range manifest.Files {
		allowedPayloads[fmt.Sprintf("file-%d", i)] = true
	}
	removed := false
	for _, entry := range entries {
		name := entry.Name()
		if allowedPayloads[name] || strings.HasPrefix(name, ".phonepad-tmp-") {
			if err := os.Remove(filepath.Join(stage, name)); err != nil {
				return err
			}
			removed = true
		}
	}
	if removed {
		return syncDir(stage)
	}
	return nil
}

func fileStatusesFromStage(m Manifest, stage string, limits LimitSet) ([]FileStatus, error) {
	files := initialFileStatuses(m)
	for i, spec := range m.Files {
		file, info, err := openOwnedStageFile(stageFilePath(stage, i), false)
		if err != nil {
			return nil, err
		}
		if info.Size() < 0 || info.Size() > spec.Bytes {
			_ = file.Close()
			return nil, corruptf("staged file %d exceeds manifest size", i)
		}
		files[i].ReceivedBytes = info.Size()
		if err := file.Close(); err != nil {
			return nil, err
		}
	}
	_ = limits
	return files, nil
}

func openOwnedStageFile(path string, create bool) (*os.File, os.FileInfo, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) && create {
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if createErr != nil {
			return nil, nil, createErr
		}
		info, err = file.Stat()
		if err != nil {
			_ = file.Close()
			return nil, nil, err
		}
		return file, info, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, nil, corruptf("staged path is not a regular file")
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		return nil, nil, err
	}
	return file, info, nil
}

func hashOwnedStageFile(path string, expected int64) (string, error) {
	file, info, err := openOwnedStageFile(path, false)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if info.Size() != expected {
		return "", incompletef("staged file size is %d, expected %d", info.Size(), expected)
	}
	hash := sha256.New()
	if _, err := io.CopyBuffer(hash, file, make([]byte, 64<<10)); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// renamePublishedFiles changes private file names to their deterministic
// public names while the containing directory is still hidden.  If a process
// dies during this small preparation step, readStage sees the unexpected
// layout and refuses to guess; it never publishes a partial directory.
func renamePublishedFiles(stage string, m Manifest) error {
	for i, spec := range m.Files {
		source := stageFilePath(stage, i)
		destination := filepath.Join(stage, publishedName(i, spec.Name))
		if info, err := os.Lstat(destination); err == nil {
			_ = info
			return conflictf("published staging name already exists")
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.Rename(source, destination); err != nil {
			return err
		}
	}
	return nil
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type stageCounts struct {
	receiving int
	total     int
}

func (s *Store) stageCountsLocked(limits LimitSet) (stageCounts, error) {
	stagingRoot := filepath.Join(s.root, stagingDirName)
	entries, err := readStagingEntries(stagingRoot)
	if errors.Is(err, os.ErrNotExist) {
		return stageCounts{}, nil
	}
	if err != nil {
		return stageCounts{}, err
	}
	counts := stageCounts{}
	for _, entry := range entries {
		if !uuidPattern.MatchString(entry.Name()) || !entry.IsDir() {
			continue
		}
		stage := filepath.Join(stagingRoot, entry.Name())
		marker, markerErr := readJSONFile[ownerMarker](filepath.Join(stage, ownerName), 4096)
		if markerErr != nil || marker.Version != SchemaVersion || marker.ID != entry.Name() {
			continue
		}
		state, stateErr := readJSONFile[diskState](filepath.Join(stage, stateName), 64<<10)
		if stateErr == nil && state.Version == SchemaVersion && state.ID == entry.Name() {
			switch state.State {
			case stateReceiving:
				counts.receiving++
				counts.total++
			case stateCancelled:
				counts.total++
			}
		}
	}
	_ = limits
	return counts, nil
}

func (s *Store) cleanupExpiredLocked(limits LimitSet) {
	stagingRoot := filepath.Join(s.root, stagingDirName)
	entries, err := readStagingEntries(stagingRoot)
	if err != nil {
		return
	}
	now := time.Now()
	for _, entry := range entries {
		if !uuidPattern.MatchString(entry.Name()) || !entry.IsDir() {
			continue
		}
		stage := filepath.Join(stagingRoot, entry.Name())
		marker, markerErr := readJSONFile[ownerMarker](filepath.Join(stage, ownerName), 4096)
		if markerErr != nil || marker.Version != SchemaVersion || marker.ID != entry.Name() {
			continue
		}
		state, stateErr := readJSONFile[diskState](filepath.Join(stage, stateName), 64<<10)
		if stateErr != nil || state.Version != SchemaVersion || state.ID != entry.Name() || (state.State != stateReceiving && state.State != stateCancelled) {
			continue
		}
		manifest, manifestErr := readJSONFile[Manifest](filepath.Join(stage, manifestName), 64<<10)
		if manifestErr != nil || manifest.ID != entry.Name() || validateManifest(manifest, limits) != nil {
			// An ambiguous or malformed state is left in place for inspection;
			// expiry cleanup only removes storage that we can positively identify.
			continue
		}
		if expired, _ := stageExpired(stage, state, now, limits); expired {
			_ = removeOwnedStage(stage, entry.Name())
		}
	}
}

func (s *Store) expireStageIfNeededLocked(record stageRecord, stage string, limits LimitSet) (bool, error) {
	expired, err := stageExpired(stage, record.state, time.Now(), limits)
	if err != nil {
		return false, err
	}
	if !expired {
		return false, nil
	}
	if err := removeOwnedStage(stage, record.state.ID); err != nil {
		return false, err
	}
	return true, nil
}

func stageExpired(stage string, state diskState, now time.Time, limits LimitSet) (bool, error) {
	activity := state.UpdatedAt
	if activity.IsZero() {
		return false, corruptf("staging state has no update time")
	}
	if info, err := os.Stat(stage); err == nil && info.ModTime().Before(activity) {
		activity = info.ModTime()
	}
	if info, err := os.Stat(filepath.Join(stage, stateName)); err == nil && info.ModTime().Before(activity) {
		activity = info.ModTime()
	}
	return now.Sub(activity) >= limits.TTL, nil
}

func removeOwnedStage(stage, id string) error {
	info, err := os.Lstat(stage)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return corruptf("refusing to remove non-directory stage")
	}
	manifest, entries, err := validateOwnedStageEntries(stage, id)
	if err != nil {
		return err
	}
	_ = manifest
	// validateOwnedStageEntries has proved that every child is a regular file
	// in one of the explicit namespaces. There are no recursive RemoveAll
	// calls and therefore no opportunity to follow an injected directory or
	// symlink.
	for _, entry := range entries {
		if err := os.Remove(filepath.Join(stage, entry.Name())); err != nil {
			return err
		}
	}
	return os.Remove(stage)
}

func validateOwnedStageEntries(stage, id string) (Manifest, []os.DirEntry, error) {
	marker, err := readJSONFile[ownerMarker](filepath.Join(stage, ownerName), 4096)
	if err != nil || marker.Version != SchemaVersion || marker.ID != id {
		return Manifest{}, nil, corruptf("refusing to remove unowned stage")
	}
	limits := limitSnapshot()
	manifest, err := readJSONFile[Manifest](filepath.Join(stage, manifestName), 64<<10)
	if err != nil || manifest.ID != id {
		return Manifest{}, nil, corruptf("refusing to remove invalid manifest")
	}
	if err := validateManifest(manifest, limits); err != nil {
		return Manifest{}, nil, corruptf("refusing to remove invalid manifest: %v", err)
	}
	state, err := readJSONFile[diskState](filepath.Join(stage, stateName), 64<<10)
	if err != nil || state.Version != SchemaVersion || state.ID != id || state.CreatedAt.IsZero() || state.UpdatedAt.IsZero() || (state.State != stateReceiving && state.State != stateCancelled) {
		return Manifest{}, nil, corruptf("refusing to remove invalid state")
	}
	if err := checkStatusShape(manifest, state.Files); err != nil {
		return Manifest{}, nil, corruptf("refusing to remove invalid status: %v", err)
	}
	entries, err := checkStageEntries(stage, manifest)
	if err != nil {
		return Manifest{}, nil, err
	}
	return manifest, entries, nil
}

func readJSONFile[T any](path string, limit int64) (T, error) {
	var value T
	info, err := os.Lstat(path)
	if err != nil {
		return value, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return value, errors.New("not a regular metadata file")
	}
	file, err := os.Open(path)
	if err != nil {
		return value, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return value, err
	}
	if int64(len(data)) > limit {
		return value, errors.New("metadata exceeds limit")
	}
	if err := decodeStrict(data, &value); err != nil {
		return value, err
	}
	return value, nil
}

func writeJSONAtomic(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	temporary, err := os.CreateTemp(dir, ".phonepad-tmp-")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if err := temporary.Chmod(0600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return errors.New("refusing to replace non-regular metadata")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(temporaryName, path); err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}

func syncDir(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

func conflictf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrConflict, fmt.Sprintf(format, args...))
}

func notFoundf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrNotFound, fmt.Sprintf(format, args...))
}

func capacityf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrCapacity, fmt.Sprintf(format, args...))
}

func expiredf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrExpired, fmt.Sprintf(format, args...))
}

func corruptf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrCorrupt, fmt.Sprintf(format, args...))
}

func incompletef(format string, args ...any) error {
	// An incomplete commit is a caller-visible identity/state conflict as well
	// as a more specific diagnostic.  Joining both sentinels keeps HTTP
	// adapters from accidentally reporting it as a storage failure.
	return fmt.Errorf("%w: %w: %s", ErrIncomplete, ErrConflict, fmt.Sprintf(format, args...))
}
