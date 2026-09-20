package pairing

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestOpen_RejectsMalformedShortToken(t *testing.T) {
	dir := t.TempDir()
	b, _ := json.Marshal(state{Token: "short", Paired: true})
	if err := os.WriteFile(filepath.Join(dir, fileName), b, 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(dir)
	if !errors.Is(err, ErrInvalidState) || s != nil {
		t.Fatalf("invalid existing credential should require recovery: %v", err)
	}
	kept, readErr := os.ReadFile(filepath.Join(dir, fileName))
	if readErr != nil || string(kept) != string(b) {
		t.Fatal("opening invalid config destroyed the existing file")
	}
	st, err := os.Stat(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("pairing.json mode=%o, want 0600", st.Mode().Perm())
	}
}

func TestOpen_GeneratesPersistentToken(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if s.Token() == "" {
		t.Fatal("token vacío tras Open")
	}
	if s.Paired() {
		t.Error("un store recién creado no debería estar paired")
	}
	if _, err := os.Stat(filepath.Join(dir, "pairing.json")); err != nil {
		t.Errorf("no persistió pairing.json: %v", err)
	}
}

func TestValid(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !s.Valid(s.Token()) {
		t.Error("Valid(token real) = false, want true")
	}
	for _, bad := range []string{"", "wrong", s.Token() + "x", s.Token()[:len(s.Token())-1]} {
		if s.Valid(bad) {
			t.Errorf("Valid(%q) = true, want false", bad)
		}
	}
}

func TestMarkPaired_Persists(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if s.Paired() {
		t.Fatal("no debería arrancar paired")
	}
	if err := s.MarkPaired(); err != nil {
		t.Fatalf("MarkPaired: %v", err)
	}
	if !s.Paired() {
		t.Error("Paired() = false tras MarkPaired")
	}
	// Reabrir: el flag persiste.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if !s2.Paired() {
		t.Error("Paired() = false tras reabrir; el flag no persistió")
	}
}

func TestRotate_RevokesOldToken(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	old := s.Token()
	if err := s.MarkPaired(); err != nil {
		t.Fatalf("MarkPaired: %v", err)
	}

	neu, err := s.Rotate()
	if err != nil {
		t.Fatalf("Rotate: %v", err)
	}
	if neu == old {
		t.Error("Rotate devolvió el mismo token")
	}
	if s.Token() != neu {
		t.Errorf("Token() = %q, want %q (el rotado)", s.Token(), neu)
	}
	if s.Valid(old) {
		t.Error("el token viejo sigue siendo válido tras Rotate")
	}
	if s.Paired() {
		t.Error("Rotate debería desemparejar (Paired=false)")
	}
	// Persistido: reabrir trae el token nuevo.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if s2.Token() != neu {
		t.Errorf("tras reabrir Token() = %q, want %q", s2.Token(), neu)
	}
}

func TestOpen_ReusesTokenAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	s1, err := Open(dir)
	if err != nil {
		t.Fatalf("Open #1: %v", err)
	}
	tok := s1.Token()

	// Segundo Open sobre el mismo dir = simular reinicio del daemon.
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("Open #2: %v", err)
	}
	if s2.Token() != tok {
		t.Errorf("token cambió tras reabrir: %q != %q", s2.Token(), tok)
	}
}
