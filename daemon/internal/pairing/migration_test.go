package pairing

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLegacyMigrationAndRollbackPreservePairing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, fileName)
	token, err := genToken()
	if err != nil {
		t.Fatal(err)
	}
	// The stable daemon's on-disk schema has only these two fields.
	type legacyState struct {
		Token  string `json:"token"`
		Paired bool   `json:"paired"`
	}
	legacy, _ := json.Marshal(legacyState{Token: token})
	if err := os.WriteFile(path, legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	current, err := Open(dir)
	if err != nil || current.Token() != token || current.Paired() {
		t.Fatal("legacy credential was not retained", err)
	}
	unchanged, _ := os.ReadFile(path)
	if string(unchanged) != string(legacy) {
		t.Fatal("opening legacy config unexpectedly rewrote it")
	}
	if err := current.MarkPaired(); err != nil {
		t.Fatal(err)
	}
	versioned, _ := os.ReadFile(path)
	var modern state
	if json.Unmarshal(versioned, &modern) != nil || modern.Version != 1 {
		t.Fatal("explicit mutation did not write v1")
	}
	var previous legacyState
	if json.Unmarshal(versioned, &previous) != nil || previous.Token != token || !previous.Paired {
		t.Fatal("previous schema cannot read the migrated config")
	}
	// A write by the old daemon omits version. Upgrading again recognizes it
	// as legacy without rotating keys or discarding the paired state.
	rolledBack, _ := json.Marshal(previous)
	if err := os.WriteFile(path, rolledBack, 0o600); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil || reopened.Token() != token || !reopened.Paired() {
		t.Fatal("rollback and re-upgrade lost pairing", err)
	}
}

func TestUnreadableOrFutureConfigurationIsNeverReplaced(t *testing.T) {
	token := strings.Repeat("A", 32)
	for name, data := range map[string]string{
		"future":        `{"version":2,"token":"` + token + `","paired":true,"permissions":{"input":false}}`,
		"null":          `null`,
		"truncated":     `{"token":`,
		"nullVersion":   `{"version":null,"token":"` + token + `","paired":true}`,
		"nullPaired":    `{"token":"` + token + `","paired":null}`,
		"missingPaired": `{"token":"` + token + `"}`,
		"extra":         `{"token":"` + token + `","paired":true,"permissions":{"input":false}}`,
		"oversized":     strings.Repeat(" ", maxStateBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, fileName)
			if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			store, err := Open(dir)
			if store != nil || err == nil {
				t.Fatal("unrecognized config was accepted")
			}
			if name == "future" && !errors.Is(err, ErrUnsupportedVersion) {
				t.Fatal("future schema was reported as recoverable corruption", err)
			}
			kept, readErr := os.ReadFile(path)
			if readErr != nil || string(kept) != data {
				t.Fatal("open replaced an existing configuration")
			}
		})
	}
	t.Run("ioError", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, fileName)
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(dir); err == nil {
			t.Fatal("an I/O failure generated a new credential")
		}
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatal("existing config path was replaced")
		}
	})
}
