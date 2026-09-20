// Package pairing encapsula la credencial que autoriza a un cliente: un token
// persistente (estable entre reinicios del daemon) y el estado de "ya se
// emparejó un dispositivo". Esconde la persistencia, la comparación en tiempo
// constante y la rotación detrás de una interfaz chica, para que el server
// dependa del concepto "¿este token es válido?" y no de un string suelto.
package pairing

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const fileName = "pairing.json"
const stateVersion = 1
const maxStateBytes = 64 << 10

var ErrInvalidState = errors.New("pairing configuration is invalid; existing file preserved")
var ErrUnsupportedVersion = errors.New("pairing configuration requires a newer version; existing file preserved")

// state es lo que se persiste en disco.
type state struct {
	Version int    `json:"version,omitempty"`
	Token   string `json:"token"`
	Paired  bool   `json:"paired"`
}

// Store es la credencial viva del daemon. Seguro para el caso de 1 daemon.
type Store struct {
	dir string
	mu  sync.RWMutex
	st  state
}

// Open carga el estado de pairing desde dir. La primera vez genera un token
// nuevo y lo persiste; en arranques siguientes reusa el token guardado (así el
// acceso directo del celular no muere al reiniciar el daemon).
func Open(dir string) (*Store, error) {
	s := &Store{dir: dir}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, err
	}

	path := filepath.Join(dir, fileName)
	if file, err := os.Open(path); err == nil {
		b, readErr := io.ReadAll(io.LimitReader(file, maxStateBytes+1))
		closeErr := file.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read pairing: %w", readErr)
		}
		if closeErr != nil {
			return nil, closeErr
		}
		st, err := decodeState(b)
		if err != nil {
			return nil, err
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return nil, err
		}
		// Opening a legacy file does not rewrite it or rotate its credential.
		// The next explicit mutation writes the additive v1 field. The previous
		// daemon can still read token/paired and safely omit version on a write.
		st.Version = stateVersion
		s.st = st
		return s, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("open pairing: %w", err)
	}

	tok, err := genToken()
	if err != nil {
		return nil, err
	}
	s.st = state{Version: stateVersion, Token: tok, Paired: false}
	if err := s.save(); err != nil {
		return nil, err
	}
	return s, nil
}

func decodeState(b []byte) (state, error) {
	var st state
	if len(b) == 0 || len(b) > maxStateBytes {
		return st, ErrInvalidState
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(b, &fields) != nil || fields == nil {
		return st, ErrInvalidState
	}
	if raw, present := fields["version"]; present {
		if bytes.Equal(raw, []byte("null")) || json.Unmarshal(raw, &st.Version) != nil {
			return st, ErrInvalidState
		}
		if st.Version != stateVersion {
			return st, ErrUnsupportedVersion
		}
	}
	for key := range fields {
		if key != "version" && key != "token" && key != "paired" {
			return st, ErrInvalidState
		}
	}
	if raw, ok := fields["paired"]; !ok || bytes.Equal(raw, []byte("null")) {
		return st, ErrInvalidState
	}
	if json.Unmarshal(b, &st) != nil || !validToken(st.Token) {
		return st, ErrInvalidState
	}
	return st, nil
}

// Token devuelve el token actual (para construir la URL de pairing).
func (s *Store) Token() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.Token
}

// Valid compara token contra la credencial en tiempo constante (evita timing
// attacks sobre el prefijo). Tokens de distinta longitud no son válidos.
func (s *Store) Valid(token string) bool {
	if !validToken(token) {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return subtle.ConstantTimeCompare([]byte(token), []byte(s.st.Token)) == 1
}

// Paired indica si ya se emparejó un dispositivo (lo consulta el toggle para
// decidir si abrir la vista de pairing).
func (s *Store) Paired() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.st.Paired
}

// MarkPaired registra que un dispositivo se emparejó (lo llama el server tras el
// primer handshake válido). Idempotente: si ya estaba paired, no reescribe.
func (s *Store) MarkPaired() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.st.Paired {
		return nil
	}
	prev := s.st
	s.st.Paired = true
	if err := s.saveLocked(); err != nil {
		s.st = prev
		return err
	}
	return nil
}

// Rotate revoca la credencial actual: genera un token nuevo y vuelve a estado
// no-emparejado, persistiendo el cambio. Úsese si el QR pudo filtrarse; obliga a
// re-escanear. Devuelve el token nuevo.
func (s *Store) Rotate() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tok, err := genToken()
	if err != nil {
		return "", err
	}
	prev := s.st
	s.st = state{Version: stateVersion, Token: tok, Paired: false}
	if err := s.saveLocked(); err != nil {
		s.st = prev
		return "", err
	}
	return tok, nil
}

func (s *Store) save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(s.st)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, fileName)
	// Escribir a un temporal + rename evita dejar un JSON truncado si el daemon
	// muere o el disco devuelve un error a mitad de escritura. El archivo nunca
	// sale de modo 0600.
	tmp, err := os.CreateTemp(s.dir, ".pairing-*.tmp")
	if err != nil {
		return fmt.Errorf("crear temporal de pairing: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("permisos de pairing: %w", err)
	}
	if _, err := tmp.Write(b); err != nil {
		cleanup()
		return fmt.Errorf("escribir pairing: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync pairing: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("cerrar pairing: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		return fmt.Errorf("instalar pairing: %w", err)
	}
	return nil
}

// genToken genera un token base64url de 24 bytes (≥16, SPEC §7).
func genToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func validToken(token string) bool {
	if len(token) != 32 || strings.ContainsAny(token, "\r\n") {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil
}
