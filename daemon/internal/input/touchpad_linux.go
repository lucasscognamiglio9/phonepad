//go:build linux

package input

import (
	"errors"
	"fmt"
	"io"
	"log"
	"syscall"
	"time"
	"unsafe"
)

// touchpad_linux.go crea y maneja el device uinput de touchpad de precisión
// multitouch (Type B) validado en el Paso 0 (ADR 0005). La lib vendoreada
// bendahl/uinput no sirve (usa el path legacy, sin resolución, sin BTN_TOOL_*,
// sin INPUT_PROP_*), así que escribimos los ioctls a mano. El mapeo
// contacto->slot es puro y vive en touchpad.go (testeado sin hardware); acá solo
// está el setup del device y la escritura de eventos.

// ioctls UI_* (uapi/linux/uinput.h). UI_ABS_SETUP y UI_SET_PROPBIT no están en
// x/sys/unix ni en el vendor: van a mano. Valores verificados en el Paso 0.
const (
	uiSetEvbit   = 0x40045564
	uiSetKeybit  = 0x40045565
	uiSetAbsbit  = 0x40045567
	uiSetPropbit = 0x4004556e
	uiAbsSetup   = 0x401c5504
	uiDevSetup   = 0x405c5503
	uiDevCreate  = 0x5501
	uiDevDestroy = 0x5502
)

const (
	btnLeft = 0x110

	inputPropPointer   = 0x00
	inputPropButtonpad = 0x02

	busUSB = 0x03

	// Rango lógico del device: ~100x70mm a 28 units/mm (Paso 0).
	devMaxX = 2800
	devMaxY = 1960
	devRes  = 28
)

type inputID struct{ Bustype, Vendor, Product, Version uint16 }

type uinputSetup struct {
	ID           inputID
	Name         [80]byte
	FFEffectsMax uint32
}

type inputAbsinfo struct{ Value, Minimum, Maximum, Fuzz, Flat, Resolution int32 }

type uinputAbsSetup struct {
	Code    uint16
	_       uint16
	Absinfo inputAbsinfo
}

// inputEvent es la struct de 24 bytes que espera el kernel. Time queda en cero:
// uinput lo descarta y lo sella el kernel al write (hallazgo del Paso 0).
type inputEvent struct {
	Sec   int64
	Usec  int64
	Type  uint16
	Code  uint16
	Value int32
}

// mtTouchpad es el device uinput de precisión más el estado de slots Type B.
type mtTouchpad struct {
	fd       int
	state    *mtState
	res      int32
	desynced bool // last frame failed; next frame performs a release recovery
}

func ioctl(fd uintptr, req uint, arg uintptr) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, uintptr(req), arg); errno != 0 {
		return errno
	}
	return nil
}

// newMTTouchpad crea el device. Falla si no hay permiso sobre /dev/uinput.
func newMTTouchpad() (*mtTouchpad, error) {
	return newMTTouchpadWithGeometry(devMaxX, devMaxY, devRes)
}

// newMTTouchpadWithGeometry is the private fixture/provider seam for a
// device-local physical size. The production constructor above keeps the
// established 100x70mm, 28 units/mm geometry byte-for-byte equivalent.
// Geometry must be selected before UI_DEV_CREATE; uinput does not support
// changing ABS resolution or range after the device exists.
func newMTTouchpadWithGeometry(maxX, maxY, res int32) (*mtTouchpad, error) {
	if maxX <= 0 || maxY <= 0 || res <= 0 {
		return nil, fmt.Errorf("geometría touchpad inválida: max=%dx%d res=%d", maxX, maxY, res)
	}
	// O_CLOEXEC: en el hot-reload de dev el daemon hace re-exec; sin esto el fd se
	// hereda y el device uinput queda colgado (un touchpad zombi por reload). Con
	// CLOEXEC el kernel cierra el fd en el exec y destruye el device viejo.
	fd, err := syscall.Open("/dev/uinput", syscall.O_WRONLY|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("abrir /dev/uinput: %w", err)
	}
	ufd := uintptr(fd)
	set := func(req uint, bit int) error { return ioctl(ufd, req, uintptr(bit)) }

	for _, t := range []int{evSyn, evKey, evAbs} {
		if err := set(uiSetEvbit, t); err != nil {
			return failClose(fd, "UI_SET_EVBIT", err)
		}
	}
	// Clickpad como el touchpad físico: INPUT_PROP_BUTTONPAD (abajo) + BTN_LEFT,
	// SIN BTN_RIGHT (un clickpad no anuncia botón derecho; libinput sintetiza el
	// click-derecho por click-method). Declararlo da el warning "clickpad
	// advertising right button".
	for _, k := range []int{btnToolFinger, btnToolDoubletap, btnToolTripletap, btnToolQuadtap, btnToolQuinttap, btnTouch, btnLeft} {
		if err := set(uiSetKeybit, k); err != nil {
			return failClose(fd, "UI_SET_KEYBIT", err)
		}
	}
	for _, a := range []int{absX, absY, absMTSlot, absMTTrackingID, absMTPositionX, absMTPositionY, absMTToolType} {
		if err := set(uiSetAbsbit, a); err != nil {
			return failClose(fd, "UI_SET_ABSBIT", err)
		}
	}
	// INPUT_PROP_POINTER (indirecto = touchpad). NUNCA INPUT_PROP_DIRECT.
	for _, p := range []int{inputPropPointer, inputPropButtonpad} {
		if err := set(uiSetPropbit, p); err != nil {
			return failClose(fd, "UI_SET_PROPBIT", err)
		}
	}
	axes := []struct {
		code          uint16
		min, max, res int32
	}{
		{absX, 0, maxX, res},
		{absY, 0, maxY, res},
		{absMTPositionX, 0, maxX, res},
		{absMTPositionY, 0, maxY, res},
		{absMTSlot, 0, maxSlots - 1, 0},
		{absMTToolType, mtToolFinger, mtToolPalm, 0},
		{absMTTrackingID, 0, 65535, 0},
	}
	for _, a := range axes {
		s := uinputAbsSetup{Code: a.code, Absinfo: inputAbsinfo{Minimum: a.min, Maximum: a.max, Resolution: a.res}}
		if err := ioctl(ufd, uiAbsSetup, uintptr(unsafe.Pointer(&s))); err != nil {
			return failClose(fd, "UI_ABS_SETUP", err)
		}
	}
	setup := uinputSetup{ID: inputID{Bustype: busUSB, Vendor: 0x1d6b, Product: 0x0104, Version: 1}}
	copy(setup.Name[:], "phonepad-touchpad")
	if err := ioctl(ufd, uiDevSetup, uintptr(unsafe.Pointer(&setup))); err != nil {
		return failClose(fd, "UI_DEV_SETUP", err)
	}
	if err := ioctl(ufd, uiDevCreate, 0); err != nil {
		return failClose(fd, "UI_DEV_CREATE", err)
	}
	return &mtTouchpad{fd: fd, state: newMTState(maxX, maxY), res: res}, nil
}

func failClose(fd int, what string, err error) (*mtTouchpad, error) {
	syscall.Close(fd)
	return nil, fmt.Errorf("crear touchpad uinput (%s): %w", what, err)
}

// touch difea la foto de contactos contra el estado y escribe el frame Type B.
func (m *mtTouchpad) touch(cs []Contact) {
	if m.desynced {
		recovery := *m.state
		if err := writeEvents(m.fd, recovery.hardReset()); err != nil {
			log.Printf("touchpad uinput recovery reset: %v", err)
			return
		}
		*m.state = recovery
		m.desynced = false
	}
	next := *m.state
	if err := writeEvents(m.fd, next.frame(cs)); err != nil {
		log.Printf("touchpad uinput write: %v", err)
		m.desynced = true
		return
	}
	*m.state = next
}

const maxWriteRetries = 3

func writeEvents(fd int, evs []evt) error {
	if len(evs) == 0 {
		return nil
	}
	buf := make([]byte, 0, len(evs)*24)
	for _, e := range evs {
		ie := inputEvent{Type: e.typ, Code: e.code, Value: e.val}
		buf = append(buf, (*[24]byte)(unsafe.Pointer(&ie))[:]...)
	}
	for off, retries := 0, 0; off < len(buf); {
		n, err := syscall.Write(fd, buf[off:])
		if n > 0 {
			// uinput consumes complete input_event records. A non-record-aligned
			// short write cannot be resumed safely and marks the device desynced.
			if n%24 != 0 {
				return fmt.Errorf("write %d/%d bytes: %w", off+n, len(buf), io.ErrShortWrite)
			}
			off += n
			retries = 0
		}
		if err == nil {
			if n == 0 {
				if retries >= maxWriteRetries {
					return fmt.Errorf("write %d/%d bytes: %w", off, len(buf), io.ErrShortWrite)
				}
				retries++
				time.Sleep(time.Duration(retries) * time.Millisecond)
			}
			continue
		}
		if (errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK)) && retries < maxWriteRetries {
			retries++
			time.Sleep(time.Duration(retries) * time.Millisecond)
			continue
		}
		return fmt.Errorf("write %d/%d bytes: %w", off, len(buf), err)
	}
	return nil
}

func (m *mtTouchpad) reset() {
	next := *m.state
	events := next.cancel()
	if m.desynced {
		// A failed frame may have written an uncommitted prefix. Release every
		// slot/tool bit instead of trusting the last committed snapshot.
		events = next.hardReset()
	}
	if err := writeEvents(m.fd, events); err != nil {
		log.Printf("touchpad uinput reset: %v", err)
		m.desynced = true
		return
	}
	*m.state = next
	m.desynced = false
}

// cancel reports active contacts as palms for one SYN_REPORT before releasing
// them. This gives libinput the cancellation signal it needs to suppress a
// ghost click when a touch sequence ends unexpectedly (pointercancel,
// reconnect, or a transport reset).
func (m *mtTouchpad) cancel() {
	next := *m.state
	events := next.cancel()
	if m.desynced {
		// A failed frame may have written an unknown prefix. The hard reset is
		// the only safe recovery because the committed slot snapshot may be
		// stale; it still emits a complete release frame.
		events = next.hardReset()
	}
	if err := writeEvents(m.fd, events); err != nil {
		log.Printf("touchpad uinput cancel: %v", err)
		m.desynced = true
		return
	}
	*m.state = next
	m.desynced = false
}

func (m *mtTouchpad) close() {
	if err := ioctl(uintptr(m.fd), uiDevDestroy, 0); err != nil {
		log.Printf("touchpad uinput destroy: %v", err)
	}
	if err := syscall.Close(m.fd); err != nil {
		log.Printf("touchpad uinput close: %v", err)
	}
}
