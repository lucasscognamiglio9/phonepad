package server

import (
	"context"
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
	inputSession     string
	inputLeases      map[string]inputLease
	nativeUpdatePath string
	uploadMu         sync.Mutex
	uploadDir        string
	clipboardMu      sync.Mutex
	clipboard        clipboardWriter
	trustedPeer      func(*http.Request) bool
	pairMu           sync.Mutex
	pairCode         string
	pairExpires      time.Time

	desktop desktopRelay
	auth    Authenticator
	inj     input.Injector
	mux     *http.ServeMux
	pairURL string // URL de pairing (única fuente de verdad: terminal + /qr.svg)
	hub     *hub   // canal SSE de eventos de conexión (vista pairing)

	mu          sync.Mutex
	current     *websocket.Conn // conexión activa; nil si no hay
	gen         uint64          // generación monotónica; invalida frames de sesiones viejas
	readTimeout time.Duration   // 0 uses defaultWSReadTimeout; app ping keeps idle sessions alive

	demo      bool
	devInject bool // dev: inyectar el flag dev en index.html y no cachear
}

const (
	defaultWSReadTimeout = 15 * time.Second
	wsHeartbeatInterval  = 5 * time.Second
	wsHeartbeatTimeout   = 3 * time.Second
)

// Option configura el Server en New. Las opciones de dev quedan apagadas por
// defecto, así producción no carga ningún camino de dev.
type Option func(*Server)

func WithDemo() Option { return func(s *Server) { s.demo = true } }

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
	s := &Server{
		auth:        auth,
		inj:         inj,
		mux:         http.NewServeMux(),
		pairURL:     pairURL,
		hub:         newHub(),
		readTimeout: defaultWSReadTimeout,
	}
	for _, o := range opts {
		o(s)
	}
	s.mux.HandleFunc("/ws", s.handleWS)
	s.mux.HandleFunc("/api/preview/", s.handlePreview)
	s.mux.HandleFunc("/api/desktop", s.handleDesktop)
	s.mux.HandleFunc("/api/files", s.handleFiles)
	s.mux.HandleFunc("/api/input", s.handleInput)
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
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Validar token ANTES de hacer el upgrade (SPEC §3: "valida antes de
	// procesar nada"). El token viaja en la query, no en un mensaje.
	if !trustedNode(r) && !s.auth.Valid(sessionToken(r)) {
		http.Error(w, "bad token", http.StatusUnauthorized)
		return
	}

	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Printf("ws accept: %v", err)
		return
	}

	c.SetReadLimit(maxFrameBytes)
	gen := s.setCurrent(c, r.UserAgent())
	defer s.clearCurrent(c, gen)

	// El ciclo de vida del WS debe sobrevivir al fin del request HTTP: coder/
	// websocket "hijackea" el TCP en Accept, pero r.Context() se cancela cuando
	// el ServeMux da por cerrado el request, lo que mataría el read loop al
	// instante y dispararía un bucle de reconexión. Derivamos de Background con
	// un cancel propio atado al cierre del handler.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Confirmar handshake (SPEC §3: {"t":"ok"}).
	hello := s.inputHello(gen)
	if len(hello) == 0 {
		return
	}
	if err := c.Write(ctx, websocket.MessageText, hello); err != nil {
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
func (s *Server) setCurrent(c *websocket.Conn, ua string) uint64 {
	// Unlock explícito (no defer) a propósito: no sostener el mutex durante el
	// I/O de red de abajo (old.Close / hub). El reset físico sí queda dentro de
	// la sección crítica para que ningún frame atraviese la transición.
	s.mu.Lock()
	old := s.current
	s.current = c
	s.gen++
	s.newInputLease()
	gen := s.gen
	// El reset ocurre dentro de la misma sección crítica que cambia la
	// generación: ningún frame viejo ni nuevo puede tocar el Injector durante la
	// transición. Si había teclas/botones/contactos activos, quedan liberados
	// antes de aceptar el primer frame de la sesión nueva.
	resetInjector(s.inj)
	s.mu.Unlock()
	if old != nil {
		old.Close(websocket.StatusPolicyViolation, "replaced by new client")
	}
	s.hub.clientConnected(ua)
	return gen
}

// clearCurrent limpia la referencia solo si sigue siendo esta conexión (no
// pisa una conexión más nueva que ya la reemplazó). Solo cuando current pasa a
// nil emite client_disconnected (no en reemplazo).
func (s *Server) clearCurrent(c *websocket.Conn, gen uint64) {
	s.mu.Lock()
	disconnected := false
	if s.current == c && s.gen == gen {
		s.current = nil
		if lease, ok := s.inputLeases[s.inputSession]; ok {
			lease.registry.Retire()
			lease.retired = time.Now()
			s.inputLeases[s.inputSession] = lease
		}
		s.gen++
		resetInjector(s.inj)
		disconnected = true
	}
	s.mu.Unlock()
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
		s.routeInjector(m)
		s.mu.Unlock()
		return
	}
	s.routeInjector(m)
}

func (s *Server) routeInjector(m Msg) {
	switch m.Type {
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
