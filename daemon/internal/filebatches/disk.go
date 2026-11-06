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
	"strings"
	"time"

	"phonepad/daemon/internal/privatefs"
)

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
	if err := privatefs.Secure(s.root, true); err != nil {
		return err
	}
	stagingRoot := filepath.Join(s.root, stagingDirName)
	if info, err := os.Lstat(stagingRoot); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return conflictf("staging root is not a directory")
		}
		if err := privatefs.Secure(stagingRoot, true); err != nil {
			return err
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.Mkdir(stagingRoot, 0700); err != nil {
			return err
		}
		if err := privatefs.Secure(stagingRoot, true); err != nil {
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
	if err := privatefs.Secure(stage, true); err != nil {
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
		if err := privatefs.Secure(stageFilePath(stage, i), false); err != nil {
			_ = file.Close()
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
	if err := privatefs.Secure(temporaryName, false); err != nil {
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
	return privatefs.Secure(path, false)
}
