//go:build linux

package input

import (
	"os"
	"testing"
)

func TestWriteEventsReportsWriteError(t *testing.T) {
	f, err := os.Open("/dev/null") // descriptor de solo lectura
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := writeEvents(int(f.Fd()), []evt{{typ: evSyn, code: synReport}}); err == nil {
		t.Fatal("writeEvents ocultó el error de escritura")
	}
}

func TestMTTouchFailedWriteDoesNotCommitState(t *testing.T) {
	f, err := os.Open("/dev/null")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	m := &mtTouchpad{fd: int(f.Fd()), state: newMTState(2800, 1960)}
	m.touch([]Contact{{ID: 7, X: .4, Y: .5}})
	if m.state.count != 0 || m.state.slotID[0] != -1 || !m.desynced {
		t.Fatalf("fallo de write mutó estado: count=%d slots=%v desynced=%v", m.state.count, m.state.slotID, m.desynced)
	}
}
