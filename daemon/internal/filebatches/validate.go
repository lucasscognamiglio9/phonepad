package filebatches

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode"
)

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
