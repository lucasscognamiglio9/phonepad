// Package filebatches stores upload batches until all of their files have
// been verified.  A receiving batch lives below .phonepad-staging and only a
// complete batch is renamed into the caller's root directory.
package filebatches

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
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
