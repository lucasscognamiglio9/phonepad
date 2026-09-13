package input

import (
	"os"
	"reflect"
	"testing"
)

func TestMTFrameLiftAll(t *testing.T) {
	s := newMTState(2800, 1960)
	s.frame([]Contact{{ID: 1, X: 0.4, Y: 0.5}}) // 1 dedo
	got := s.frame(nil)                         // se levanta (foto vacía)
	want := []evt{
		{evAbs, absMTSlot, 0},
		{evAbs, absMTTrackingID, -1}, // liberar el contacto
		{evKey, btnToolFinger, 0},    // 1→0
		{evKey, btnTouch, 0},
		{evSyn, synReport, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("frame(lift) =\n%#v\nwant\n%#v", got, want)
	}
}

func TestMTFramePartialLift(t *testing.T) {
	s := newMTState(2800, 1960)
	s.frame([]Contact{{ID: 1, X: 0.3, Y: 0.5}, {ID: 2, X: 0.7, Y: 0.5}}) // 2 dedos
	got := s.frame([]Contact{{ID: 2, X: 0.7, Y: 0.5}})                   // se levanta el #1
	want := []evt{
		{evAbs, absMTSlot, 0},        // el contacto #1 estaba en slot 0
		{evAbs, absMTTrackingID, -1}, // liberarlo
		{evAbs, absMTSlot, 1},        // el #2 sigue en slot 1
		{evAbs, absMTPositionX, 1960},
		{evAbs, absMTPositionY, 980},
		{evAbs, absX, 1960}, // mirror = único presente (#2)
		{evAbs, absY, 980},
		{evKey, btnToolDoubletap, 0}, // 2→1
		{evKey, btnToolFinger, 1},
		{evSyn, synReport, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("frame(partial lift) =\n%#v\nwant\n%#v", got, want)
	}
}

func TestMTFrameSecondFingerAdded(t *testing.T) {
	s := newMTState(2800, 1960)
	s.frame([]Contact{{ID: 1, X: 0.4, Y: 0.5}}) // 1 dedo
	got := s.frame([]Contact{{ID: 1, X: 0.4, Y: 0.5}, {ID: 2, X: 0.6, Y: 0.5}})
	want := []evt{
		{evAbs, absMTSlot, 0}, // contacto 1 (existente)
		{evAbs, absMTPositionX, 1120},
		{evAbs, absMTPositionY, 980},
		{evAbs, absMTSlot, 1}, // contacto 2 (nuevo)
		{evAbs, absMTToolType, mtToolFinger},
		{evAbs, absMTTrackingID, 2},
		{evAbs, absMTPositionX, 1680},
		{evAbs, absMTPositionY, 980},
		{evAbs, absX, 1120}, // mirror = primer contacto del frame
		{evAbs, absY, 980},
		{evKey, btnToolFinger, 0},    // transición 1→2: limpiar FINGER
		{evKey, btnToolDoubletap, 1}, // y declarar DOUBLETAP
		{evSyn, synReport, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("frame(2º dedo) =\n%#v\nwant\n%#v", got, want)
	}
}

func TestMTFrameContactMoves(t *testing.T) {
	s := newMTState(2800, 1960)
	s.frame([]Contact{{ID: 7, X: 0.5, Y: 0.5}}) // down
	got := s.frame([]Contact{{ID: 7, X: 0.6, Y: 0.5}})
	// Mismo contacto: solo posición, SIN nuevo TRACKING_ID, sin tocar BTN_TOOL/BTN_TOUCH.
	want := []evt{
		{evAbs, absMTSlot, 0},
		{evAbs, absMTPositionX, 1680},
		{evAbs, absMTPositionY, 980},
		{evAbs, absX, 1680},
		{evAbs, absY, 980},
		{evSyn, synReport, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("frame(move) =\n%#v\nwant\n%#v", got, want)
	}
}

func TestMTFrameSingleContactDown(t *testing.T) {
	s := newMTState(2800, 1960)
	got := s.frame([]Contact{{ID: 7, X: 0.5, Y: 0.25}})
	want := []evt{
		{evAbs, absMTSlot, 0},
		{evAbs, absMTToolType, mtToolFinger},
		{evAbs, absMTTrackingID, 1},
		{evAbs, absMTPositionX, 1400},
		{evAbs, absMTPositionY, 490},
		{evAbs, absX, 1400},
		{evAbs, absY, 490},
		{evKey, btnToolFinger, 1},
		{evKey, btnTouch, 1},
		{evSyn, synReport, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("frame =\n%#v\nwant\n%#v", got, want)
	}
}

func TestMTResetReleasesSlotsAndRestartsTrackingIDs(t *testing.T) {
	s := newMTState(2800, 1960)
	s.frame([]Contact{{ID: 9, X: .2, Y: .3}})
	got := s.reset()
	want := []evt{
		{evAbs, absMTSlot, 0},
		{evAbs, absMTToolType, mtToolPalm},
		{evSyn, synReport, 0},
		{evAbs, absMTSlot, 0},
		{evAbs, absMTTrackingID, -1},
		{evKey, btnToolFinger, 0},
		{evKey, btnToolDoubletap, 0},
		{evKey, btnToolTripletap, 0},
		{evKey, btnToolQuadtap, 0},
		{evKey, btnToolQuinttap, 0},
		{evKey, btnTouch, 0},
		{evSyn, synReport, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reset = %#v, want %#v", got, want)
	}
	if got := s.frame([]Contact{{ID: 10, X: .4, Y: .4}}); len(got) < 3 || got[2].val != 1 {
		t.Fatalf("tracking ID no reinició en 1: %#v", got)
	}
}

func TestMTCancelMarksActiveSlotsPalmThenLifts(t *testing.T) {
	s := newMTState(2800, 1960)
	s.frame([]Contact{{ID: 9, X: .2, Y: .3}, {ID: 10, X: .8, Y: .7}})
	got := s.cancel()
	want := []evt{
		{evAbs, absMTSlot, 0},
		{evAbs, absMTToolType, mtToolPalm},
		{evAbs, absMTSlot, 1},
		{evAbs, absMTToolType, mtToolPalm},
		{evSyn, synReport, 0},
		{evAbs, absMTSlot, 0},
		{evAbs, absMTTrackingID, -1},
		{evAbs, absMTSlot, 1},
		{evAbs, absMTTrackingID, -1},
		{evKey, btnToolFinger, 0},
		{evKey, btnToolDoubletap, 0},
		{evKey, btnToolTripletap, 0},
		{evKey, btnToolQuadtap, 0},
		{evKey, btnToolQuinttap, 0},
		{evKey, btnTouch, 0},
		{evSyn, synReport, 0},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cancel =\n%#v\nwant\n%#v", got, want)
	}
	if s.count != 0 || s.nextTID != 1 {
		t.Fatalf("cancel state = count %d nextTID %d, want empty/reset", s.count, s.nextTID)
	}
	for slot, id := range s.slotID {
		if id != -1 {
			t.Fatalf("slot %d remained active: %d", slot, id)
		}
	}
}

func TestMTCancelWithoutActiveContactsStillSynchronizes(t *testing.T) {
	s := newMTState(2800, 1960)
	got := s.cancel()
	want := []evt{{evSyn, synReport, 0}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("empty cancel = %#v, want %#v", got, want)
	}
}

func TestMTHardResetReleasesEverySlotAfterDesync(t *testing.T) {
	s := newMTState(2800, 1960)
	s.slotID[0], s.slotID[3], s.count, s.nextTID = 41, 99, 2, 123
	got := s.hardReset()
	if len(got) != maxSlots*2+6+1 {
		t.Fatalf("hardReset events=%d, want %d", len(got), maxSlots*2+6+1)
	}
	for i := 0; i < maxSlots; i++ {
		if got[2*i] != (evt{evAbs, absMTSlot, int32(i)}) || got[2*i+1] != (evt{evAbs, absMTTrackingID, -1}) {
			t.Fatalf("hardReset slot %d = %#v/%#v", i, got[2*i], got[2*i+1])
		}
	}
	if got[len(got)-1] != (evt{evSyn, synReport, 0}) || s.count != 0 || s.nextTID != 1 {
		t.Fatalf("hardReset final/state = %#v count=%d nextTID=%d", got[len(got)-1], s.count, s.nextTID)
	}
	for i, id := range s.slotID {
		if id != -1 {
			t.Fatalf("slot %d quedó ocupado: %d", i, id)
		}
	}
}

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
