package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// Handlers de la vista pairing (SPEC §12). El contrato (rutas, eventos, JSON)
// está fijado en el diseño UX+pairing; esto lo implementa 1:1.

// handlePair sirve la página de pairing (web/pair.html) desde el FS embebido.
func (s *Server) handlePair(webFS fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !localOnly(w, r) {
			return
		}
		data, err := fs.ReadFile(webFS, "pair.html")
		if err != nil {
			http.Error(w, "pairing view no disponible", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(data)
	}
}

// handleQR responde el QR de la URL de pairing como SVG escalable. Codifica
// EXACTAMENTE la misma URL que imprime la terminal (s.pairURL): única fuente.
func (s *Server) handleQR(w http.ResponseWriter, r *http.Request) {
	if !localOnly(w, r) {
		return
	}
	q, err := qrcode.New(s.pairURL, qrcode.Medium)
	if err != nil {
		http.Error(w, "qr", http.StatusInternalServerError)
		return
	}
	svg := bitmapToSVG(q.Bitmap())
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(svg))
}

// bitmapToSVG dibuja la matriz del QR como SVG vectorial (sin dep extra).
// La lib incluye un quiet zone en el bitmap; usamos un módulo de 1 unidad y
// dejamos que el navegador escale vía CSS (width).
func bitmapToSVG(bm [][]bool) string {
	n := len(bm)
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`, n, n)
	b.WriteString(`<rect width="100%" height="100%" fill="#ffffff"/>`)
	b.WriteString(`<path fill="#000000" d="`)
	for y := 0; y < n; y++ {
		row := bm[y]
		for x := 0; x < len(row); x++ {
			if row[x] {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x, y)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String()
}

// handlePairInfo expone la metadata de pairing en JSON (URL, IP, puerto) para
// que la vista muestre texto legible sin decodificar el QR.
func (s *Server) handlePairInfo(w http.ResponseWriter, r *http.Request) {
	if !localOnly(w, r) {
		return
	}
	ip, port := hostPort(s.pairURL)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		// Nunca devolvemos el token en una respuesta HTTP legible por JS. El QR
		// sigue codificando la URL completa, pero solo está disponible desde la
		// laptop (localOnly).
		"url":    safePairURL(s.pairURL),
		"ip":     ip,
		"port":   port,
		"paired": s.auth.Paired(),
	})
}

// handleAuth permite que la PWA haga un preflight HTTP y distinga un 401 de una
// caída de red antes de abrir el WebSocket. El token viaja en Authorization, no
// en la URL ni en el body de la respuesta; esto evita el bucle de reconexión
// infinito que los browsers provocan al ocultar el status del handshake WS.
func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(tok), "bearer ") {
		tok = strings.TrimSpace(tok[len("Bearer "):])
	} else {
		tok = ""
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Authorization")
	if !s.auth.Valid(tok) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// localOnly protege la vista/QR/metadata de pairing: son secretos de operador
// y no deben quedar expuestos a cualquier host de la LAN. La PWA remota solo
// necesita / y /ws (con token). No confiamos en X-Forwarded-For porque el
// daemon no corre detrás de un proxy confiable.
func localOnly(w http.ResponseWriter, r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if host != "" && ip != nil && ip.IsLoopback() {
		return true
	}
	http.Error(w, "pairing disponible solo localmente", http.StatusForbidden)
	return false
}

func safePairURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	q := u.Query()
	q.Del("token")
	u.RawQuery = q.Encode()
	return u.String()
}

// hostPort extrae IP y puerto de la URL de pairing para /api/pair-info.
func hostPort(raw string) (ip string, port int) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", 0
	}
	ip = u.Hostname()
	if p, err := strconv.Atoi(u.Port()); err == nil {
		port = p
	}
	return ip, port
}

// handleEvents es el canal SSE: snapshot inicial + transiciones + heartbeat.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !localOnly(w, r) {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming no soportado", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")

	ch, snapshot, cancel := s.hub.subscribe()
	defer cancel()

	writeSSE(w, snapshot)
	flusher.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			writeSSE(w, ev)
			flusher.Flush()
		case <-ticker.C:
			// Comentario SSE para sobrevivir proxies/idle.
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

func writeSSE(w http.ResponseWriter, ev sseEvent) {
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.name, ev.data)
}
