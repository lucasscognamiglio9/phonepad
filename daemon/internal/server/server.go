package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"phonepad/daemon/internal/devreload"
	"phonepad/daemon/internal/filebatches"
	"phonepad/daemon/internal/input"
)

// Authenticator es la credencial que autoriza a un cliente. La implementa
// internal/pairing.Store; el server depende del concepto "¿este token vale?" y
// de marcar el primer emparejamiento, no de un string suelto.
type Authenticator interface {
	Valid(token string) bool // comparación en tiempo constante
	MarkPaired() error       // registra el primer handshake válido (idempotente)
	Paired() bool            // ¿ya se emparejó un dispositivo?
}

// Server sirve la PWA por HTTP y expone el endpoint WebSocket /ws que valida el
// token, rutea mensajes al Injector y maneja ping/pong. Asume 1 cliente (SPEC
// §1 no-goals): una conexión nueva con token válido reemplaza a la anterior.
type Server struct {
	inputSession      string
	inputLeases       map[string]inputLease
	nativeUpdatePath  string
	uploadMu          sync.Mutex
	uploadDir         string
	fileTransfersOnce sync.Once
	fileTransfers     *filebatches.Store
	fileTransfersErr  error
	clipboardMu       sync.Mutex
	clipboard         clipboardWriter
	readClipboardText func(context.Context) (string, error)
	trustedPeer       func(*http.Request) bool
	pairMu            sync.Mutex
	pairCode          string
	pairExpires       time.Time

	desktop desktopRelay
	browserPreview bool
	auth    Authenticator
	inj     input.Injector
	mux     *http.ServeMux
	pairURL string // URL de pairing (única fuente de verdad: terminal + /qr.svg)
	hub     *hub   // canal SSE de eventos de conexión (vista pairing)

	mu      sync.Mutex
	current *websocket.Conn // conexión activa; nil si no hay
	gen     uint64          // generación monotónica; invalida frames de sesiones viejas
	// sessionEpoch is the random identity of the control connection. It is
	// separate from inputSession, which may rotate on a text quota renewal.
	sessionEpoch         string
	currentProtocol      int
	capabilityRevision   uint64
	permissionRevision   uint64
	inputResetIncomplete bool
	actionOps            map[string]actionOperation
	media                mediaObservation
	permissions          Permissions
	readTimeout          time.Duration // 0 uses defaultWSReadTimeout; app ping keeps idle sessions alive

	// mutationGate is held only while a bounded side effect is committed. It is
	// never held while an HTTP upload body is read.
	mutationGate           sync.Mutex
	capabilitySendMu       sync.Mutex
	capabilitySentRevision uint64

	// lifecycleMu guards the process-wide admission barrier. It is separate
	// from mu/mutationGate so HTTP shutdown never waits on a provider while
	// holding session state.
	lifecycleMu      sync.Mutex
	lifecycleCtx     context.Context
	lifecycleCancel  context.CancelFunc
	lifecycleDone    chan struct{}
	lifecycleClosing bool
	lifecycleErr     error

	demo      bool
	devInject bool // dev: inyectar el flag dev en index.html y no cachear
	// pointerCalibration is an explicit, validated device-local profile. It is
	// applied only when a protocol-v2 peer opts into pointer geometry.
	pointerCalibration   *input.PointerGeometry
	pointerGeometryOptIn bool
	directPointerOptIn   bool
	controlCtx           context.Context
	controlCancel        context.CancelFunc
}

const maxActionOperations = 128

type actionOperation struct {
	sessionEpoch string
	action       string
	key          string
	mods         []string
	active       bool
	state        string
	repeatCount  int
	nextSequence uint64
	cancelled    bool
	receipts     map[uint64]actionReceipt
	sequenceDone map[uint64]chan struct{}
	// dispatchMu serializes the short admission decision with cancel. The
	// provider itself runs outside this lock so cancel can mark an in-flight
	// action immediately, while a future action cannot pass the same gate.
	dispatchMu *sync.Mutex
}

const (
	defaultWSReadTimeout = 125 * time.Second
	wsHeartbeatInterval  = 5 * time.Second
	wsHeartbeatTimeout   = 3 * time.Second
)

// Option configura el Server en New. Las opciones de dev quedan apagadas por
// defecto, así producción no carga ningún camino de dev.
type Option func(*Server)

func WithDemo() Option { return func(s *Server) { s.demo = true } }

// WithBrowserPreview uses the existing local browser publisher as the screen
// capture provider. The publisher requires an explicit screen-share grant.
func WithBrowserPreview() Option { return func(s *Server) { s.browserPreview = true } }

// WithPointerCalibration enables the persisted square profile for peers that
// explicitly request the P04 extension. Invalid profiles are ignored here so
// a malformed operator file can only keep the legacy mapper active.
func WithPointerCalibration(profile input.PointerGeometry) Option {
	return func(s *Server) {
		if err := input.ValidatePointerGeometry(profile); err != nil {
			log.Printf("ignoring pointer calibration: %v", err)
			return
		}
		profile.GeometryEpoch = 0
		s.pointerCalibration = &profile
	}
}

// WithDevInject hace que el server inyecte el flag dev en index.html (para que
// la PWA desregistre el service worker) y mande las páginas con Cache-Control:
// no-store. Lo activa main solo en modo dev (PHONEPAD_DEV_SRC).
func WithDevInject() Option {
	return func(s *Server) { s.devInject = true }
}

// New arma el Server. webFS es el contenido de web/ (embebido en main).
// pairURL es la URL de pairing que también imprime la terminal (SPEC §12):
// el QR de /qr.svg codifica exactamente esa URL para evitar drift.
func New(auth Authenticator, inj input.Injector, webFS fs.FS, pairURL string, opts ...Option) *Server {
	lifecycleCtx, lifecycleCancel := context.WithCancel(context.Background())
	s := &Server{
		auth:            auth,
		inj:             inj,
		mux:             http.NewServeMux(),
		pairURL:         pairURL,
		hub:             newHub(),
		readTimeout:     defaultWSReadTimeout,
		lifecycleCtx:    lifecycleCtx,
		lifecycleCancel: lifecycleCancel,
		lifecycleDone:   make(chan struct{}),
		actionOps:       make(map[string]actionOperation),
	}
	for _, o := range opts {
		o(s)
	}
	s.permissions = defaultPermissions(inj)
	s.capabilityRevision = 1
	s.mux.HandleFunc("/ws", s.handleWS)
	s.mux.HandleFunc("/api/preview/", s.handlePreview)
	s.mux.HandleFunc("/api/desktop", s.handleDesktop)
	s.mux.HandleFunc("/api/files", s.handleFiles)
	s.mux.HandleFunc("/api/file-batches", s.handleFileBatches)
	s.mux.HandleFunc("/api/file-transfers", s.handleFileTransfers)
	s.mux.HandleFunc("/api/input", s.handleInput)
	s.mux.HandleFunc("/api/clipboard", s.handleClipboardText)
	s.mux.HandleFunc(nativeUpdateRoute, s.handleNativeUpdate)
	s.mux.HandleFunc("/share", s.handleShare(webFS))
	// Vista de pairing (SPEC §12): página + QR + canal SSE + metadata.
	s.mux.HandleFunc("/pair", s.handlePair(webFS))
	s.mux.HandleFunc("/qr.svg", s.handleQR)
	s.mux.HandleFunc("/events", s.handleEvents)
	s.mux.HandleFunc("/api/pair-info", s.handlePairInfo)
	s.mux.HandleFunc("/api/auth", s.handleAuth)
	s.mux.HandleFunc("/api/claim", s.handleClaim)
	s.mux.HandleFunc("/api/mode", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		fmt.Fprintf(w, `{"demo":%t}`, s.demo)
	})
	// La PWA se sirve siempre, con o sin token (SPEC §7): el token solo lo
	// exige el WS. Sin token la PWA carga pero no puede conectar.
	s.mux.Handle("/", s.staticHandler(webFS))
	return s
}

// staticHandler sirve la PWA. En prod es un FileServer pelado. En dev intercepta
// index.html para inyectar el flag dev (que desregistra el SW) y marca todo
// como no-store, para que un cambio en web/ se vea sin pelear con el cache.
func (s *Server) staticHandler(webFS fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(webFS))
	if !s.devInject {
		return fileServer
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		switch r.URL.Path {
		case "/sw.js":
			// Servir el SW de autodestrucción: limpia cualquier SW de prod que el
			// celular tenga cacheado (ver devreload.KillSwitchSW).
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Write(devreload.KillSwitchSW)
			return
		case "/", "/index.html":
			if b, err := devreload.ReadInjected(webFS, "index.html"); err == nil {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.Write(b)
				return
			}
		}
		fileServer.ServeHTTP(w, r)
	})
}

// PushReload manda {"t":"reload"} al cliente activo (si hay). Lo usa el watcher
// de dev cuando cambia un archivo de web/. No-op sin cliente. Snapshotea la
// conexión bajo el lock y escribe afuera, para no serializar el I/O (igual que
// setCurrent).
func (s *Server) PushReload() {
	if s.isClosing() {
		return
	}
	s.mu.Lock()
	c := s.current
	s.mu.Unlock()
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, respReload); err != nil {
		log.Printf("dev: push reload: %v", err)
	}
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		ip := net.ParseIP(host)
		if ip == nil || (!ip.IsLoopback() && !ip.IsPrivate()) {
			http.Error(w, "Phonepad solo admite clientes de LAN o loopback", http.StatusForbidden)
			return
		}
		if s.rejectIfClosing(w) {
			return
		}
		ctx, cancel := s.contextWithLifecycle(r.Context())
		defer cancel()
		s.mux.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if s.rejectIfClosing(w) {
		return
	}
	// Validar token ANTES de hacer el upgrade (SPEC §3: "valida antes de
	// procesar nada"). El token viaja en la query, no en un mensaje.
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "bad token", http.StatusUnauthorized)
		return
	}
	protocol, supported := protocolForRequest(r.URL.Query().Get("protocol"))
	if !supported {
		w.Header().Set("Accept-Protocol", "1, 2")
		http.Error(w, "unsupported protocol", http.StatusUpgradeRequired)
		return
	}

	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}

	c.SetReadLimit(maxFrameBytes)
	geometryOptIn := protocol == protocolVersion && r.URL.Query().Get("pointerGeometry") == "1"
	gen, err := s.setCurrent(c, r.UserAgent(), protocol, geometryOptIn, r.URL.Query().Get("directPointer") == "1")
	if err != nil {
		// The websocket handshake already happened, so report the reason on
		// the wire instead of sending a v2 hello with an empty epoch. Keep the
		// failure local to this connection; the previous session (if any) was
		// not replaced because epoch allocation failed before taking the lock.
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		code := "session_unavailable"
		if errors.Is(err, ErrServerClosing) {
			code = "server_closing"
		}
		_ = c.Write(ctx, websocket.MessageText, rejectedMessage("session", code, 0, ""))
		cancel()
		c.CloseNow()
		return
	}
	defer s.clearCurrent(c, gen)

	// El ciclo de vida del WS debe sobrevivir al fin del request HTTP: coder/
	// websocket "hijackea" el TCP en Accept, pero r.Context() se cancela cuando
	// el ServeMux da por cerrado el request, lo que mataría el read loop al
	// instante y dispararía un bucle de reconexión. Derivamos de Background con
	// un cancel propio atado al cierre del handler.
	ctx, cancel := s.contextWithLifecycle(context.Background())
	defer cancel()

	// Capability updates use the same writer lock. Take it before building the
	// hello so a permission update cannot write a newer revision first and leave
	// the client with an out-of-order initial frame.
	s.capabilitySendMu.Lock()
	hello := s.inputHello(gen)
	if len(hello) == 0 {
		s.capabilitySendMu.Unlock()
		return
	}
	err = c.Write(ctx, websocket.MessageText, hello)
	s.capabilitySendMu.Unlock()
	if err != nil {
		return
	}

	// El token fue válido y la conexión se estableció: registrar que ya hay un
	// dispositivo emparejado (idempotente). El toggle usa este flag para no
	// reabrir la vista de pairing en cada arranque.
	if err := s.auth.MarkPaired(); err != nil {
		log.Printf("marcar paired: %v", err)
	}

	watchCtx, stopWatch := context.WithCancel(ctx)
	defer stopWatch()
	go s.watchdog(watchCtx, c, wsHeartbeatInterval, wsHeartbeatTimeout)
	s.readLoop(ctx, c, gen)
}

// setCurrent registra la conexión nueva y cierra la vieja si existía. Notifica
// a la vista pairing: en un reemplazo emite un solo client_connected con el
// cliente nuevo (no parpadea disconnect+connect; ver SPEC §12).

func (s *Server) setCurrent(c *websocket.Conn, ua string, protocol int, geometryOptIn bool, directOptIn ...bool) (uint64, error) {
	// Unlock explícito (no defer) a propósito: no sostener el mutex durante el
	// I/O de red de abajo (old.Close / hub). mutationGate ordena el reset físico
	// sin retener el mutex usado por status y la coordinación de cierre.
	epoch, epochErr := newSessionEpoch()
	if epochErr != nil && protocol == protocolVersion {
		return 0, epochErr
	}
	if epochErr != nil {
		log.Printf("session epoch for legacy connection: %v", epochErr)
		epoch = ""
	}
	s.mutationGate.Lock()
	s.lifecycleMu.Lock()
	if s.lifecycleClosing {
		s.lifecycleMu.Unlock()
		s.mutationGate.Unlock()
		return 0, ErrServerClosing
	}
	s.lifecycleMu.Unlock()
	if err := s.applyPointerGeometry(context.Background(), geometryOptIn); err != nil {
		s.mutationGate.Unlock()
		return 0, fmt.Errorf("apply pointer geometry: %w", err)
	}
	s.mu.Lock()
	old := s.current
	s.current = c
	if s.controlCancel != nil {
		s.controlCancel()
	}
	s.controlCtx, s.controlCancel = context.WithCancel(context.Background())
	s.gen++
	s.currentProtocol = protocol
	s.sessionEpoch = epoch
	s.pointerGeometryOptIn = geometryOptIn
	s.directPointerOptIn = protocol == protocolVersion && len(directOptIn) > 0 && directOptIn[0]
	s.actionOps = make(map[string]actionOperation)
	s.capabilityRevision++
	s.newInputLease()
	gen := s.gen
	// El reset ocurre dentro de la misma sección crítica que cambia la
	// generación: ningún frame viejo ni nuevo puede tocar el Injector durante la
	// transición. Si había teclas/botones/contactos activos, quedan liberados
	// antes de aceptar el primer frame de la sesión nueva.
	s.mu.Unlock()
	if err := s.resetForTransition(); err != nil {
		log.Printf("input reset before connection: %v", err)
	}
	s.mutationGate.Unlock()
	if old != nil {
		// Tell the replaced peer why control moved, but never make the new
		// handshake wait for the old peer to answer. coder/websocket bounds its
		// close handshake internally; running it here would otherwise block a
		// reconnect for several seconds.
		go func() {
			if err := old.Close(websocket.StatusPolicyViolation, "replaced"); err != nil {
				log.Printf("ws replaced close: %v", err)
			}
		}()
	}
	s.hub.clientConnected(ua)
	return gen, nil
}

// clearCurrent limpia la referencia solo si sigue siendo esta conexión (no
// pisa una conexión más nueva que ya la reemplazó). Solo cuando current pasa a
// nil emite client_disconnected (no en reemplazo).
func (s *Server) clearCurrent(c *websocket.Conn, gen uint64) {
	s.mutationGate.Lock()
	s.mu.Lock()
	disconnected := false
	if s.current == c && s.gen == gen {
		s.current = nil
		s.currentProtocol = 0
		if s.controlCancel != nil {
			s.controlCancel()
			s.controlCancel = nil
			s.controlCtx = nil
		}
		s.pointerGeometryOptIn = false
		s.directPointerOptIn = false
		// A permit captured by the disconnected control session must not become
		// a mutation after the connection is gone. The next connection receives
		// a fresh random epoch in setCurrent.
		s.sessionEpoch = ""
		s.capabilityRevision++
		if lease, ok := s.inputLeases[s.inputSession]; ok {
			lease.registry.Retire()
			lease.retired = time.Now()
			s.inputLeases[s.inputSession] = lease
		}
		s.gen++
		disconnected = true
	}
	s.mu.Unlock()
	if disconnected {
		if err := s.resetForTransition(); err != nil {
			log.Printf("input reset after disconnect: %v", err)
		}
		if err := s.applyPointerGeometry(context.Background(), false); err != nil {
			log.Printf("legacy pointer geometry after disconnect: %v", err)
		}
	}
	s.mutationGate.Unlock()
	c.CloseNow()
	if disconnected {
		s.hub.clientDisconnected()
	}
}

func (s *Server) readLoop(ctx context.Context, c *websocket.Conn, gen uint64) {
	for {
		readCtx := ctx
		cancel := func() {}
		timeout := s.readTimeout
		if timeout <= 0 {
			timeout = defaultWSReadTimeout
		}
		readCtx, cancel = context.WithTimeout(ctx, timeout)
		typ, data, err := c.Read(readCtx)
		cancel()
		if err != nil {
			var ce websocket.CloseError
			if !errors.As(err, &ce) && !errors.Is(err, context.Canceled) {
				log.Printf("ws read: %v", err)
			}
			return
		}
		if typ != websocket.MessageText {
			continue // el protocolo es JSON en text frames
		}
		msg, ok := Parse(data)
		if !ok {
			continue // inválido/desconocido: ignorar (SPEC §3)
		}
		s.routeGeneration(ctx, c, gen, msg)
	}
}

// watchdog sends protocol-level pings independently of application frames.
// Browsers answer these control frames automatically, so a half-open TCP peer
// is detected even when the peer has stopped sending JSON. On any ping timeout
// the connection is closed; the handler's deferred clearCurrent then performs
// the complete input Reset.
func (s *Server) watchdog(ctx context.Context, c *websocket.Conn, interval, timeout time.Duration) {
	if interval <= 0 {
		interval = wsHeartbeatInterval
	}
	if timeout <= 0 {
		timeout = wsHeartbeatTimeout
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, timeout)
			err := c.Ping(pingCtx)
			cancel()
			if err != nil {
				log.Printf("ws heartbeat: %v", err)
				c.CloseNow()
				return
			}
		}
	}
}

// route despacha un mensaje parseado al Injector o responde (ping→pong).
func (s *Server) route(ctx context.Context, c *websocket.Conn, m Msg) {
	s.routeGeneration(ctx, c, 0, m)
}

func (s *Server) routeGeneration(ctx context.Context, c *websocket.Conn, gen uint64, m Msg) {
	if s.isClosing() {
		return
	}
	// Las pruebas unitarias llaman route con c=nil para ejercitar el ruteo puro.
	// Las conexiones reales pasan por el mutex + generación: si fueron
	// reemplazadas, sus frames se descartan aunque el read loop aún no haya
	// recibido el CloseError del socket viejo.
	if c != nil {
		s.mu.Lock()
		if s.current != c || s.gen != gen {
			s.mu.Unlock()
			return
		}
		if m.Type == "ping" {
			s.mu.Unlock()
			if err := c.Write(ctx, websocket.MessageText, respPong); err != nil {
				log.Printf("ws pong write: %v", err)
				c.CloseNow()
			}
			return
		}
		if inputMessage(m) {
			// A cancel is a local admission record that stops future repeats. It
			// remains allowed after input permission is revoked so a UI release
			// cannot leave an operation eligible for late work.
			cancelAction := m.Type == "k" && m.Action == "cancel" && m.OperationID != ""
			if s.currentProtocol == protocolVersion && (s.sessionEpoch == "" || m.SessionEpoch != s.sessionEpoch) {
				s.mu.Unlock()
				s.rejectInput(c, "stale_session_epoch")
				return
			}
			if !cancelAction {
				permission, allowed := s.permissionLocked(mutationScopeInput)
				if !allowed {
					code := permissionRejectionCode(permission, "input_unavailable")
					s.mu.Unlock()
					s.rejectInput(c, code)
					return
				}
			}
			permit := mutationPermit{scope: mutationScopeInput, revision: s.permissionRevision, generation: s.gen, sessionEpoch: s.sessionEpoch}
			s.mu.Unlock()
			if m.Type == "k" && m.OperationID != "" && (m.Action == "special" || m.Action == "combo" || m.Action == "cancel") {
				receipt := s.routeKeyOperation(ctx, permit, m)
				s.writeActionReceipt(ctx, c, receipt)
				return
			}
			if err := s.runLifecycleMutation(permit, func() error {
				s.routeInjector(m)
				return nil
			}); err != nil && !errors.Is(err, ErrServerClosing) {
				s.rejectInput(c, "input_unavailable")
			}
			return
		}
		s.routeInjector(m)
		s.mu.Unlock()
		return
	}
	s.routeInjector(m)
}

// routeKeyOperation gives protocol-v2 key actions an idempotent, bounded
// receipt. A legacy action without operationId keeps the old admission-only
// behavior and is routed by routeInjector above. Repeat never creates a new
// operation, and cancel only stops future repeats: it cannot claim that a key
// already accepted by a provider was undone.
func (s *Server) routeKeyOperation(ctx context.Context, permit mutationPermit, m Msg) actionReceipt {
	phase := m.Phase
	if phase == "" {
		phase = "press"
	}
	if m.Action == "cancel" {
		s.mu.Lock()
		op, ok := s.actionOps[m.OperationID]
		dispatchMu := op.dispatchMu
		valid := ok && op.sessionEpoch == permit.sessionEpoch
		s.mu.Unlock()
		if !valid {
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "rejected", Detail: "unknown_operation", SessionEpoch: permit.sessionEpoch}
		}
		if dispatchMu != nil {
			dispatchMu.Lock()
			defer dispatchMu.Unlock()
		}
		s.mu.Lock()
		op, ok = s.actionOps[m.OperationID]
		if !ok || op.sessionEpoch != permit.sessionEpoch {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "rejected", Detail: "unknown_operation", SessionEpoch: permit.sessionEpoch}
		}
		if op.cancelled {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "cancelled", RepeatCount: op.repeatCount, Replayed: true, SessionEpoch: permit.sessionEpoch}
		}
		detail := ""
		if op.state == "uncertain" {
			detail = "repeat_stopped_after_uncertain"
		}
		op.active = false
		op.cancelled = true
		op.state = "cancelled"
		for sequence, done := range op.sequenceDone {
			close(done)
			delete(op.sequenceDone, sequence)
		}
		s.actionOps[m.OperationID] = op
		s.mu.Unlock()
		return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "cancel", State: "cancelled", RepeatCount: op.repeatCount, Detail: detail, SessionEpoch: permit.sessionEpoch}
	}

	s.mu.Lock()
	if s.actionOps == nil {
		s.actionOps = make(map[string]actionOperation)
	}
	op, exists := s.actionOps[m.OperationID]
	if exists {
		if op.sessionEpoch != permit.sessionEpoch || op.action != m.Action || op.key != m.Key || !sameStrings(op.mods, m.Mods) {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: "rejected", Detail: "operation_conflict", SessionEpoch: permit.sessionEpoch}
		}
		if phase == "press" {
			if m.ActionSequence > 1 {
				s.mu.Unlock()
				return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: "rejected", Detail: "sequence_conflict", SessionEpoch: permit.sessionEpoch}
			}
			receipt, found := op.receipts[1]
			if !found {
				state := op.state
				if state == "" || state == "pending" {
					state = "uncertain"
				}
				receipt = actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: state, RepeatCount: op.repeatCount, SessionEpoch: permit.sessionEpoch}
			}
			receipt.Replayed = true
			s.mu.Unlock()
			return receipt
		}
		if !op.active {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "operation_cancelled", SessionEpoch: permit.sessionEpoch}
		}
		if m.ActionSequence < op.nextSequence {
			receipt, found := op.receipts[m.ActionSequence]
			if found {
				receipt.Replayed = true
				s.mu.Unlock()
				return receipt
			}
			pending := op.sequenceDone[m.ActionSequence]
			s.mu.Unlock()
			if pending != nil {
				if ctx == nil {
					ctx = context.Background()
				}
				select {
				case <-pending:
					s.mu.Lock()
					op = s.actionOps[m.OperationID]
					receipt, found = op.receipts[m.ActionSequence]
					s.mu.Unlock()
					if found {
						receipt.Replayed = true
						return receipt
					}
				case <-ctx.Done():
				}
			}
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "sequence_unknown", SessionEpoch: permit.sessionEpoch}
		}
		if m.ActionSequence > op.nextSequence {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "sequence_gap", SessionEpoch: permit.sessionEpoch}
		}
		if op.repeatCount >= maxActionOperations {
			op.active = false
			op.state = "rejected"
			s.actionOps[m.OperationID] = op
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "repeat", State: "rejected", RepeatCount: op.repeatCount, Detail: "repeat_limit", SessionEpoch: permit.sessionEpoch}
		}
		op.repeatCount++
		op.nextSequence++
		if op.sequenceDone == nil {
			op.sequenceDone = make(map[uint64]chan struct{})
		}
		op.sequenceDone[m.ActionSequence] = make(chan struct{})
		s.actionOps[m.OperationID] = op
	} else {
		if phase != "press" {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: "rejected", Detail: "unknown_operation", SessionEpoch: permit.sessionEpoch}
		}
		if len(s.actionOps) >= maxActionOperations {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: "rejected", Detail: "operation_capacity", SessionEpoch: permit.sessionEpoch}
		}
		if m.ActionSequence > 1 {
			s.mu.Unlock()
			return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: "press", State: "rejected", Detail: "sequence_conflict", SessionEpoch: permit.sessionEpoch}
		}
		op = actionOperation{sessionEpoch: permit.sessionEpoch, action: m.Action, key: m.Key, mods: append([]string(nil), m.Mods...), active: true, state: "pending", nextSequence: 2, receipts: make(map[uint64]actionReceipt), sequenceDone: map[uint64]chan struct{}{1: make(chan struct{})}, dispatchMu: &sync.Mutex{}}
		s.actionOps[m.OperationID] = op
	}
	s.mu.Unlock()

	// Reserve repeat sequences under s.mu above, but wait for the preceding
	// provider call before entering the lifecycle gate. This keeps a fast repeat
	// from overtaking a delayed press when websocket frames are handled by
	// separate goroutines.
	if phase == "repeat" {
		if ctx == nil {
			ctx = context.Background()
		}
		s.mu.Lock()
		op = s.actionOps[m.OperationID]
		previous := op.sequenceDone[m.ActionSequence-1]
		s.mu.Unlock()
		if previous != nil {
			select {
			case <-previous:
			case <-ctx.Done():
				return s.finishQueuedAction(m, phase, "dispatch_wait_interrupted", "uncertain")
			}
		}
		s.mu.Lock()
		op = s.actionOps[m.OperationID]
		cancelled := op.cancelled || !op.active
		s.mu.Unlock()
		if cancelled {
			return s.finishQueuedAction(m, phase, "operation_cancelled", "rejected")
		}
	}
	if !s.admitActionProvider(m.OperationID) {
		return s.finishQueuedAction(m, phase, "operation_cancelled", "rejected")
	}

	resultState, detail := s.executeKeyAction(ctx, permit, m)
	s.mu.Lock()
	op, operationPresent := s.actionOps[m.OperationID]
	if !operationPresent || op.sessionEpoch != permit.sessionEpoch {
		s.mu.Unlock()
		// The provider may have run before a reconnect retired this operation;
		// do not recreate it in the new session or make it replayable there.
		return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: resultState, Detail: "session_replaced", SessionEpoch: permit.sessionEpoch}
	}
	if op.cancelled {
		// Cancellation stops future sequences but cannot undo a provider call
		// already admitted. Preserve the terminal operation state while returning
		// the provider's actual result for this sequence.
		op.active = false
		switch resultState {
		case "executed":
			detail = "executed_after_cancel"
		case "admitted":
			detail = "admitted_after_cancel"
		case "uncertain":
			detail = "uncertain_after_cancel"
		}
	} else if resultState == "executed" || resultState == "admitted" {
		op.state = resultState
	} else {
		op.state = resultState
		op.active = false
	}
	s.actionOps[m.OperationID] = op
	repeatCount := op.repeatCount
	sequence := m.ActionSequence
	if sequence == 0 {
		sequence = 1
	}
	receipt := actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: resultState, RepeatCount: repeatCount, Detail: detail, SessionEpoch: permit.sessionEpoch}
	if op.receipts == nil {
		op.receipts = make(map[uint64]actionReceipt)
	}
	op.receipts[sequence] = receipt
	closeActionSequenceLocked(&op, sequence)
	s.actionOps[m.OperationID] = op
	s.mu.Unlock()
	return receipt
}

func (s *Server) admitActionProvider(operationID string) bool {
	s.mu.Lock()
	op, found := s.actionOps[operationID]
	dispatchMu := op.dispatchMu
	s.mu.Unlock()
	if !found || dispatchMu == nil {
		return false
	}
	dispatchMu.Lock()
	defer dispatchMu.Unlock()
	s.mu.Lock()
	op, found = s.actionOps[operationID]
	allowed := found && !op.cancelled && op.active
	s.mu.Unlock()
	return allowed
}

func (s *Server) finishQueuedAction(m Msg, phase, detail, state string) actionReceipt {
	s.mu.Lock()
	defer s.mu.Unlock()
	op, found := s.actionOps[m.OperationID]
	if !found {
		return actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: "rejected", Detail: "unknown_operation", SessionEpoch: m.SessionEpoch}
	}
	receipt := actionReceipt{Type: "receipt", OperationID: m.OperationID, Phase: phase, State: state, RepeatCount: op.repeatCount, Detail: detail, SessionEpoch: op.sessionEpoch}
	if state != "executed" && state != "admitted" {
		op.active = false
		if !op.cancelled {
			op.state = state
		}
	}
	if op.receipts == nil {
		op.receipts = make(map[uint64]actionReceipt)
	}
	op.receipts[m.ActionSequence] = receipt
	closeActionSequenceLocked(&op, m.ActionSequence)
	s.actionOps[m.OperationID] = op
	return receipt
}

func closeActionSequenceLocked(op *actionOperation, sequence uint64) {
	if op.sequenceDone == nil {
		return
	}
	if done, ok := op.sequenceDone[sequence]; ok {
		close(done)
		delete(op.sequenceDone, sequence)
	}
}

func (s *Server) executeKeyAction(ctx context.Context, permit mutationPermit, m Msg) (string, string) {
	var result input.ActionResult
	err := s.runLifecycleMutation(permit, func() error {
		actionCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if executor, ok := s.inj.(input.ActionExecutor); ok {
			if m.Action == "special" {
				result = executor.SpecialAction(actionCtx, m.Key)
			} else {
				result = executor.ComboAction(actionCtx, m.Mods, m.Key)
			}
		} else {
			s.routeInjector(m)
			result = input.ActionResult{State: "admitted", Detail: "provider_execution_unobserved"}
		}
		return nil
	})
	if err != nil {
		return "rejected", "input_permission_changed"
	}
	if result.State != "executed" && result.State != "admitted" && result.State != "rejected" && result.State != "uncertain" {
		return "uncertain", "invalid_provider_receipt"
	}
	return result.State, result.Detail
}

func (s *Server) writeActionReceipt(ctx context.Context, c *websocket.Conn, receipt actionReceipt) {
	if c == nil {
		return
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return
	}
	s.capabilitySendMu.Lock()
	defer s.capabilitySendMu.Unlock()
	if err := c.Write(ctx, websocket.MessageText, data); err != nil {
		c.CloseNow()
	}
}

func sameStrings(a, b []string) bool {
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

func (s *Server) routeInjector(m Msg) {
	if s.inj == nil {
		return
	}
	switch m.Type {
	case "p":
		if d, ok := s.inj.(input.DirectPointer); ok && d.SupportsDirectPointer() {
			d.MoveNormalized(m.Dx, m.Dy)
		}
	case "m":
		s.inj.Move(m.Dx, m.Dy)
	case "b":
		s.inj.Button(m.Button, m.Action == "down")
	case "s":
		s.inj.Scroll(m.Dx, m.Dy)
	case "k":
		switch m.Action {
		case "text":
			s.inj.Text(m.Text)
		case "special":
			s.inj.Special(m.Key)
		case "combo":
			s.inj.Combo(m.Mods, m.Key)
		}
	case "g":
		// Gesto discreto de 3 dedos (SPEC §3/§4). El cliente manda intención
		// ("overview"/"ws-left"/"ws-right"); el Injector elige las teclas, así
		// el atajo se reconfigura sin tocar la PWA.
		s.inj.Gesture(m.Name)
	case "t":
		// Foto de contactos del frame (touchpad de precisión, ADR 0005). El
		// cliente reenvía contactos crudos; libinput clasifica los gestos.
		if m.Cancel {
			if canceler, ok := s.inj.(input.TouchCanceler); ok {
				canceler.CancelTouch()
			} else {
				// Compatibility fallback for older Injectors. New MT devices
				// implement TouchCanceler so this path reports a palm before
				// lifting; legacy snapshot-only devices still receive lift-all.
				s.inj.Touch(nil)
			}
		} else {
			s.inj.Touch(m.Touches)
		}
	case "ping":
		// Las conexiones reales responden en route antes de llegar acá; el caso
		// nil solo aparece en tests y no tiene un socket donde escribir.
	default:
		// tipo desconocido: ignorar (forward-compat)
	}
}

func resetInjector(inj input.Injector) {
	if r, ok := inj.(input.Resettable); ok {
		r.Reset()
	}
}
