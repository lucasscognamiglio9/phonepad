package input

// Contact es un dedo en contacto con el pad, en coordenadas normalizadas 0..1
// (SPEC §3, ADR 0005). El cliente reenvía contactos crudos por frame; el daemon
// los mapea a slots del protocolo multitouch Type B y deja que libinput
// clasifique los gestos nativamente.
type Contact struct {
	ID int     `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

// evt es un evento evdev sin timestamp (el kernel lo sella al write, por eso no
// lo llevamos). La capa de IO (touchpad_linux.go) lo serializa a la struct
// input_event de 24 bytes. Separar el mapeo puro de la escritura permite testear
// la lógica Type B sin /dev/uinput.
type evt struct {
	typ  uint16
	code uint16
	val  int32
}

// Códigos evdev (uapi/linux/input-event-codes.h), validados en el Paso 0.
const (
	evSyn = 0x00
	evKey = 0x01
	evAbs = 0x03

	synReport = 0x00

	btnTouch         = 0x14a
	btnToolFinger    = 0x145
	btnToolDoubletap = 0x14d
	btnToolTripletap = 0x14e
	btnToolQuadtap   = 0x14f
	btnToolQuinttap  = 0x148

	absX            = 0x00
	absY            = 0x01
	absMTSlot       = 0x2f
	absMTPositionX  = 0x35
	absMTPositionY  = 0x36
	absMTTrackingID = 0x39
)

const maxSlots = 5

// mtState lleva el estado de los slots Type B entre frames: qué contacto ocupa
// cada slot y cuántos dedos declaramos. El cliente manda una "foto" de los
// contactos vivos por frame; el daemon difea contra este estado para asignar
// slots a contactos nuevos, mover los existentes y levantar (TRACKING_ID -1) los
// que desaparecieron de la foto.
type mtState struct {
	maxX, maxY int32
	slotID     [maxSlots]int // contactID en cada slot; -1 = libre
	nextTID    int32         // TRACKING_ID monotónico para contactos nuevos
	count      int           // dedos activos declarados (para emitir transiciones)
}

func newMTState(maxX, maxY int32) *mtState {
	s := &mtState{maxX: maxX, maxY: maxY, nextTID: 1}
	for i := range s.slotID {
		s.slotID[i] = -1
	}
	return s
}

// present indica si algún contacto de la foto tiene ese id.
func present(cs []Contact, id int) bool {
	for _, c := range cs {
		if c.ID == id {
			return true
		}
	}
	return false
}

// assign devuelve el slot que ocupa el contacto id (reusándolo si ya tenía uno)
// e isNew=true si recién se le asignó. Devuelve -1 si no hay slots libres.
func (s *mtState) assign(id int) (slot int, isNew bool) {
	for i, sid := range s.slotID {
		if sid == id {
			return i, false
		}
	}
	for i, sid := range s.slotID {
		if sid == -1 {
			s.slotID[i] = id
			return i, true
		}
	}
	return -1, false
}

// scale convierte una coordenada normalizada 0..1 al rango lógico del device.
func scale(v float64, max int32) int32 {
	if v < 0 {
		v = 0
	} else if v > 1 {
		v = 1
	}
	return int32(v*float64(max) + 0.5)
}

// toolBit devuelve el BTN_TOOL_* que declara n dedos en contacto.
func toolBit(n int) uint16 {
	switch n {
	case 1:
		return btnToolFinger
	case 2:
		return btnToolDoubletap
	case 3:
		return btnToolTripletap
	case 4:
		return btnToolQuadtap
	default:
		return btnToolQuinttap
	}
}

// frame difea los contactos vivos contra el estado y devuelve los eventos evdev
// (terminados en SYN_REPORT) a escribir.
func (s *mtState) frame(cs []Contact) []evt {
	var ev []evt
	// 1. Lift: slots cuyo contacto desapareció de la foto -> TRACKING_ID -1.
	for i, sid := range s.slotID {
		if sid != -1 && !present(cs, sid) {
			ev = append(ev, evt{evAbs, absMTSlot, int32(i)}, evt{evAbs, absMTTrackingID, -1})
			s.slotID[i] = -1
		}
	}
	// 2. Asignar contactos nuevos y actualizar los existentes.
	for _, c := range cs {
		slot, isNew := s.assign(c.ID)
		if slot < 0 {
			continue // sin slots libres (más de maxSlots dedos): se ignora
		}
		ev = append(ev, evt{evAbs, absMTSlot, int32(slot)})
		if isNew {
			ev = append(ev, evt{evAbs, absMTTrackingID, s.nextTID})
			s.nextTID++
		}
		ev = append(ev,
			evt{evAbs, absMTPositionX, scale(c.X, s.maxX)},
			evt{evAbs, absMTPositionY, scale(c.Y, s.maxY)},
		)
	}
	if len(cs) > 0 {
		ev = append(ev, evt{evAbs, absX, scale(cs[0].X, s.maxX)}, evt{evAbs, absY, scale(cs[0].Y, s.maxY)})
	}
	if n := len(cs); n != s.count {
		if s.count > 0 {
			ev = append(ev, evt{evKey, toolBit(s.count), 0}) // limpiar el conteo viejo
		}
		if n > 0 {
			ev = append(ev, evt{evKey, toolBit(n), 1})
		}
		switch {
		case s.count == 0 && n > 0:
			ev = append(ev, evt{evKey, btnTouch, 1})
		case s.count > 0 && n == 0:
			ev = append(ev, evt{evKey, btnTouch, 0})
		}
		s.count = n
	}
	ev = append(ev, evt{evSyn, synReport, 0})
	return ev
}

// reset libera cualquier slot que el último frame haya dejado activo y vuelve
// a una secuencia de tracking IDs fresca. El frame vacío siempre termina en
// SYN_REPORT, incluso si ya no había dedos, para que libinput reciba la
// frontera del estado al desconectar/reemplazar el cliente.
func (s *mtState) reset() []evt {
	ev := s.frame(nil)
	s.nextTID = 1
	return ev
}

// hardReset emits a device-wide release rather than relying on the daemon's
// last committed snapshot. It is used after a short/failed write: the kernel
// may have consumed a prefix of a frame that the snapshot never observed, so
// releasing only s.slotID could leave an unknown slot or tool bit stuck.
func (s *mtState) hardReset() []evt {
	ev := make([]evt, 0, maxSlots*2+6)
	for i := 0; i < maxSlots; i++ {
		ev = append(ev,
			evt{evAbs, absMTSlot, int32(i)},
			evt{evAbs, absMTTrackingID, -1},
		)
	}
	for _, code := range []uint16{btnToolFinger, btnToolDoubletap, btnToolTripletap, btnToolQuadtap, btnToolQuinttap, btnTouch} {
		ev = append(ev, evt{evKey, code, 0})
	}
	ev = append(ev, evt{evSyn, synReport, 0})
	for i := range s.slotID {
		s.slotID[i] = -1
	}
	s.count = 0
	s.nextTID = 1
	return ev
}
