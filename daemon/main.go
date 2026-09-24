// Command phonepad-daemon: sirve la PWA, expone el WS de control e imprime un
// QR de pairing en la terminal. Ver SPEC.md (contrato).
package main

import (
	"context"
	"crypto/tls"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"phonepad/daemon/internal/devreload"
	"phonepad/daemon/internal/input"
	"phonepad/daemon/internal/pairing"
	"phonepad/daemon/internal/server"
	"phonepad/daemon/internal/tlscert"
)

// La PWA se embebe en el binario. all: incluye archivos que empiezan con "_"/".".
// El placeholder web/index.html garantiza que el patrón siempre matchee algo.
//
//go:embed all:web
var webEmbed embed.FS

func main() {
	gatewayPort := flag.Int("gateway-port", 0, "HTTP loopback port for an external HTTPS gateway; 0 disables")
	localSharePort := flag.Int("local-share-port", 0, "HTTP loopback port for local screen sharing; 0 disables")
	publicURL := flag.String("public-url", "", "trusted HTTPS origin exposed by private gateway")
	certPath := flag.String("tls-cert", "", "certificado TLS firmado por una CA confiable (opcional)")
	keyPath := flag.String("tls-key", "", "clave del certificado TLS (requiere --tls-cert)")
	demo := flag.Bool("demo", false, "demo sin entrada física; visible en la interfaz")
	bind := flag.String("bind", "127.0.0.1", "IP de escucha o lan (solo clientes privados/locales)")
	advertiseHost := flag.String("advertise-host", "", "nombre DNS/mDNS estable del equipo para pairing")
	port := flag.Int("port", 8080, "puerto HTTP/WS")
	rotateToken := flag.Bool("rotate-token", false, "revoca el pairing y genera un token nuevo; reiniciar el daemon después")
	flag.Parse()
	if *rotateToken {
		pair, err := pairing.Open(configDir())
		if err != nil {
			log.Fatalf("no pude abrir el pairing: %v", err)
		}
		if _, err := pair.Rotate(); err != nil {
			log.Fatalf("no pude rotar el token: %v", err)
		}
		fmt.Println("token de phonepad rotado; detené y volvé a iniciar el daemon para invalidar sesiones activas y mostrar el QR nuevo")
		return
	}

	// El FileServer no conoce .webmanifest por defecto → servirlo con el tipo
	// correcto para que el navegador lo acepte como manifest de PWA.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	ip := *bind
	bindLAN := ip == "lan"
	if bindLAN {
		var err error
		ip, err = lanIP()
		if err != nil {
			ip = "127.0.0.1"
		}
	}
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil || (!parsedIP.IsLoopback() && !parsedIP.IsPrivate()) {
		log.Fatal("--bind debe ser una IP loopback o privada de LAN")
	}
	var err error

	// Pairing persistente: el token vive en ~/.config/phonepad y se reusa entre
	// reinicios, así el acceso directo del celular no muere al reiniciar el
	// daemon (la 1ª vez se genera y persiste).
	pair, err := pairing.Open(configDir())
	if err != nil {
		log.Fatalf("no pude abrir el pairing: %v", err)
	}

	var inj input.Injector
	if *demo {
		inj = &input.Demo{}
	} else {
		inj, err = input.New()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "ADVERTENCIA: input no disponible; inicio en modo solo visualización: %v\n", err)
		inj = nil
	}
	// Saca la inyección de texto (lenta: wl-copy + Ctrl+V + sleep) del read loop
	// para no latir el cursor mientras se escribe/dicta (SPEC §4).
	if inj != nil {
		inj = input.NewAsyncText(inj, 256)
	}

	// Modo dev: si PHONEPAD_DEV_SRC apunta al repo, servimos web/ DESDE DISCO y
	// activamos hot-reload (ver ADR 0003). Sin esa env var es producción pura:
	// la PWA va embebida y el service worker cachea. El servicio systemd local
	// la setea, así el toggle de GNOME da hot-reload sin ningún comando.
	devSrc := os.Getenv("PHONEPAD_DEV_SRC")
	var webFS fs.FS
	var srvOpts []server.Option
	if *demo {
		srvOpts = append(srvOpts, server.WithDemo())
	}
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		srvOpts = append(srvOpts, server.WithBrowserPreview())
	}
	calibrationPath := filepath.Join(configDir(), "pointer-geometry.json")
	if profile, ok, calibrationErr := input.LoadPointerCalibration(calibrationPath, input.MobilePointerGeometryDeviceID); calibrationErr != nil {
		log.Printf("calibración pointer ignorada; se conserva legacy: %v", calibrationErr)
	} else if ok {
		srvOpts = append(srvOpts, server.WithPointerCalibration(profile))
		log.Printf("calibración pointer disponible para %s", input.MobilePointerGeometryDeviceID)
	}
	if devSrc != "" {
		webFS = os.DirFS(filepath.Join(devSrc, "web"))
		srvOpts = append(srvOpts, server.WithDevInject())
		log.Printf("MODO DEV: sirvo %s/web desde disco + hot-reload", devSrc)
	} else {
		// La PWA vive bajo web/ dentro del embed; servimos esa subcarpeta como raíz.
		sub, err := fs.Sub(webEmbed, "web")
		if err != nil {
			log.Fatalf("subFS web: %v", err)
		}
		webFS = sub
	}

	// URL de pairing: única fuente de verdad (terminal + /qr.svg la comparten).
	// HTTPS porque secure-context desbloquea el micrófono y la VirtualKeyboard
	// API (SPEC §8). El acceso remoto requiere HTTPS públicamente confiable.
	host := ip
	if *advertiseHost != "" {
		host = *advertiseHost
	}
	pairURL := fmt.Sprintf("https://%s/", net.JoinHostPort(host, fmt.Sprint(*port)))
	if *gatewayPort != 0 {
		u, e := url.Parse(*publicURL)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
			log.Fatal("gateway requiere --public-url con origen HTTPS válido")
		}
		if *gatewayPort < 1 || *gatewayPort > 65535 || *gatewayPort == *port {
			log.Fatal("puerto gateway inválido")
		}
		pairURL = *publicURL
	}
	if *localSharePort != 0 && (*localSharePort < 1 || *localSharePort > 65535 || *localSharePort == *gatewayPort || *localSharePort == *port) {
		log.Fatal("puerto local de pantalla inválido")
	}

	srvOpts = append(srvOpts, server.WithTrustedTailscaleNode(os.Getenv("PHONEPAD_TRUSTED_NODE")))
	srvOpts = append(srvOpts, server.WithNativeUpdate(os.Getenv("PHONEPAD_NATIVE_UPDATE")))
	srv := server.New(pair, inj, webFS, pairURL, srvOpts...)
	var httpServers []*http.Server
	if *gatewayPort != 0 {
		gateway := &http.Server{Addr: net.JoinHostPort("127.0.0.1", fmt.Sprint(*gatewayPort)), Handler: srv.RemoteHandler(*publicURL), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
		httpServers = append(httpServers, gateway)
	}
	var shareServer *http.Server
	if *localSharePort != 0 {
		shareServer = &http.Server{Addr: net.JoinHostPort("127.0.0.1", fmt.Sprint(*localSharePort)), Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
		httpServers = append(httpServers, shareServer)
	}

	var cert tls.Certificate
	if (*certPath == "") != (*keyPath == "") {
		log.Fatal("usar --tls-cert y --tls-key juntos")
	}
	if *certPath != "" {
		cert, err = tls.LoadX509KeyPair(*certPath, *keyPath)
	} else {
		cert, err = tlscert.LoadOrCreate(configDir(), []string{ip, host})
	}
	if err != nil {
		log.Fatalf("cert TLS: %v", err)
	}

	fmt.Printf("\nPhonepad listo. Dirección del teléfono: %s\n", pairURL)
	// /pair y su QR están restringidos a loopback: no publicamos la pantalla
	// de pairing en la LAN. El QR sigue codificando `url`, que sí apunta al cel.
	fmt.Printf("Vista de pairing (solo esta compu):\n  https://localhost:%d/pair\n", *port)
	if *certPath == "" {
		fmt.Println("Certificado autofirmado: para Safari/PWA usá el certificado confiable explicado en docs/iphone.md.")
	}
	if *demo {
		fmt.Println("DEMO: no se envían eventos a Linux.")
	}
	if parsedIP.IsLoopback() && !bindLAN {
		fmt.Println("Solo localhost. Para el teléfono, reiniciar con --bind IP_PRIVADA_DE_LA_LAPTOP.")
	}

	stopWatchers := func() {}
	if devSrc != "" {
		stopWatchers = startDevWatchers(devSrc, srv)
	}

	addr := net.JoinHostPort(ip, fmt.Sprint(*port))
	if bindLAN {
		addr = net.JoinHostPort("0.0.0.0", fmt.Sprint(*port))
	}
	log.Printf("escuchando (https) en %s", addr)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}
	httpServers = append(httpServers, httpSrv)
	// Keep operator endpoints available on loopback when explicitly binding LAN.
	if !parsedIP.IsLoopback() && !bindLAN {
		localSrv := &http.Server{Addr: net.JoinHostPort("127.0.0.1", fmt.Sprint(*port)), Handler: srv.Handler(), TLSConfig: httpSrv.TLSConfig, ReadHeaderTimeout: 5 * time.Second}
		httpServers = append(httpServers, localSrv)
	}

	// All listeners share one admission barrier and one shutdown deadline. The
	// Server owns hijacked WebSockets; net/http owns the listener goroutines.
	serveErr := make(chan error, len(httpServers))
	for i, listener := range httpServers {
		go serveHTTP(listener, (i == 0 && *gatewayPort != 0) || listener == shareServer, serveErr)
	}
	signalCtx, stopSignal := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignal()
	var runErr error
	select {
	case <-signalCtx.Done():
		log.Printf("señal recibida; cerrando phonepad")
	case runErr = <-serveErr:
		if runErr != nil {
			log.Printf("listener: %v", runErr)
		}
	}
	stopWatchers()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	// HTTP handlers and hijacked resources can unwind in parallel. The input
	// owner closes after Server.Shutdown has completed its reset barrier.
	httpDone := make(chan error, 1)
	go func() { httpDone <- shutdownHTTPServers(shutdownCtx, httpServers) }()
	serverErr := srv.Shutdown(shutdownCtx)
	httpErr := <-httpDone
	inputErr := closeInput(shutdownCtx, inj)
	for _, shutdownErr := range []error{serverErr, httpErr, inputErr} {
		if shutdownErr != nil && !errors.Is(shutdownErr, context.Canceled) {
			log.Printf("shutdown: %v", shutdownErr)
		}
	}
	if runErr != nil {
		os.Exit(1)
	}
}

func serveHTTP(srv *http.Server, gateway bool, errorsCh chan<- error) {
	var err error
	if gateway {
		err = srv.ListenAndServe()
	} else {
		// Cert y key vacíos: el certificado ya está en TLSConfig.
		err = srv.ListenAndServeTLS("", "")
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	errorsCh <- err
}

func shutdownHTTPServers(ctx context.Context, servers []*http.Server) error {
	var wg sync.WaitGroup
	errs := make(chan error, len(servers))
	for _, srv := range servers {
		if srv == nil {
			continue
		}
		wg.Add(1)
		go func(srv *http.Server) {
			defer wg.Done()
			if err := srv.Shutdown(ctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errs <- err
			}
		}(srv)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		return err
	}
	return nil
}

func closeInput(ctx context.Context, inj input.Injector) error {
	if inj == nil {
		return nil
	}
	if closer, ok := inj.(input.ContextCloser); ok {
		return closer.CloseContext(ctx)
	}
	done := make(chan struct{})
	go func() {
		inj.Close()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// startDevWatchers lanza el hot-reload (modo dev). Dos pollers de ~400ms atados
// al proceso del daemon (que el toggle de GNOME prende/apaga): uno por web/ que
// recarga el cel, otro por *.go que recompila y re-ejecuta el daemon. Apagar el
// toggle frena el servicio y mata ambos — no queda nada corriendo por fuera.
func startDevWatchers(src string, srv *server.Server) func() {
	webW := devreload.NewWatcher([]string{filepath.Join(src, "web")}, func(string) bool { return true })
	goW := devreload.NewWatcher([]string{src}, func(p string) bool { return strings.HasSuffix(p, ".go") })
	watchCtx, cancelWatch := context.WithCancel(context.Background())
	done := make(chan struct{})
	var stopOnce sync.Once

	go func() {
		ticker := time.NewTicker(400 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if webW.Changed() {
					log.Printf("dev: cambió web/ → reload al cel")
					srv.PushReload()
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(400 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if goW.Changed() {
					rebuildAndReexecContext(watchCtx, src)
				}
			}
		}
	}()
	return func() {
		stopOnce.Do(func() {
			cancelWatch()
			close(done)
		})
	}
}

// rebuildAndReexec recompila el daemon (go build -o <binario-actual>) y se
// re-ejecuta a sí mismo con syscall.Exec: mismo PID, así systemd no lo cuenta
// como caída. Si el build falla, lo loguea y sigue con el binario viejo. La env
// (incluida PHONEPAD_DEV_SRC) se preserva, así el proceso nuevo sigue en dev.
func rebuildAndReexec(src string) {
	rebuildAndReexecContext(context.Background(), src)
}

func rebuildAndReexecContext(ctx context.Context, src string) {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return
	}
	self, err := os.Executable()
	if err != nil {
		log.Printf("dev: os.Executable: %v", err)
		return
	}
	log.Printf("dev: cambió .go → recompilando…")
	build := exec.CommandContext(ctx, goBinPath(), "build", "-o", self, ".")
	build.Dir = src
	if out, err := build.CombinedOutput(); err != nil {
		log.Printf("dev: build FALLÓ (sigo con el binario viejo):\n%s", out)
		return
	}
	if ctx.Err() != nil {
		log.Printf("dev: reexec cancelado durante shutdown")
		return
	}
	log.Printf("dev: recompilado OK → re-ejecutando")
	if err := reexecCurrent(self, os.Args, os.Environ()); err != nil {
		log.Printf("dev: re-exec falló: %v", err)
	}
}

// goBinPath ubica el binario de go: PATH primero, luego ~/.local/go/bin/go
// (donde lo tiene Lucas), con fallback al nombre pelado.
func goBinPath() string {
	if p, err := exec.LookPath("go"); err == nil {
		return p
	}
	if home, err := os.UserHomeDir(); err == nil {
		if cand := filepath.Join(home, ".local", "go", "bin", "go"); fileExists(cand) {
			return cand
		}
	}
	return "go"
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// configDir devuelve ~/.config/phonepad (o el equivalente del SO) para persistir
// el cert. Cae a un subdir temporal si no hay config dir disponible.
func configDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = os.TempDir()
	}
	return filepath.Join(base, "phonepad")
}

// lanIP devuelve la primera IPv4 no-loopback de una interfaz activa.
func lanIP() (string, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipnet.IP.To4()
			if ip4 != nil && ip4.IsPrivate() {
				return ip4.String(), nil
			}
		}
	}
	return "", fmt.Errorf("ninguna interfaz con IPv4 de LAN")
}
