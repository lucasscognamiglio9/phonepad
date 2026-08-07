// Command phonepad-daemon: sirve la PWA, expone el WS de control e imprime un
// QR de pairing en la terminal. Ver SPEC.md (contrato).
package main

import (
	"crypto/tls"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	qrcode "github.com/skip2/go-qrcode"

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
	port := flag.Int("port", 8080, "puerto HTTP/WS")
	rotateToken := flag.Bool("rotate-token", false, "revoca el pairing y genera un token nuevo; reiniciar el daemon después")
	// --sens se expone para el operador, pero la sensibilidad la aplica el
	// CLIENTE antes de mandar deltas (SPEC §5). Acá solo lo mostramos para que
	// el valor configurado quede visible; el server no escala (SPEC §4).
	sens := flag.Float64("sens", 1.0, "factor de sensibilidad (informativo; lo aplica el cliente)")
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

	ip, err := lanIP()
	if err != nil {
		log.Fatalf("no pude detectar IP de LAN: %v", err)
	}

	// Pairing persistente: el token vive en ~/.config/phonepad y se reusa entre
	// reinicios, así el acceso directo del celular no muere al reiniciar el
	// daemon (la 1ª vez se genera y persiste).
	pair, err := pairing.Open(configDir())
	if err != nil {
		log.Fatalf("no pude abrir el pairing: %v", err)
	}
	token := pair.Token()

	inj, err := input.New()
	if err != nil {
		fmt.Fprintf(os.Stderr, `
ERROR: no pude abrir /dev/uinput: %v

Probablemente falten permisos. Corré el setup (requiere sudo) y volvé a
loguearte para tomar el grupo 'input':

    ./setup/setup.sh

`, err)
		os.Exit(1)
	}
	// Saca la inyección de texto (lenta: wl-copy + Ctrl+V + sleep) del read loop
	// para no latir el cursor mientras se escribe/dicta (SPEC §4).
	inj = input.NewAsyncText(inj, 256)
	defer inj.Close()

	// Modo dev: si PHONEPAD_DEV_SRC apunta al repo, servimos web/ DESDE DISCO y
	// activamos hot-reload (ver ADR 0003). Sin esa env var es producción pura:
	// la PWA va embebida y el service worker cachea. El servicio systemd local
	// la setea, así el toggle de GNOME da hot-reload sin ningún comando.
	devSrc := os.Getenv("PHONEPAD_DEV_SRC")
	var webFS fs.FS
	var srvOpts []server.Option
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
	// API (SPEC §8). El celular acepta el warning del cert self-signed una vez.
	url := fmt.Sprintf("https://%s:%d/?token=%s", ip, *port, token)

	srv := server.New(pair, inj, webFS, url, srvOpts...)

	cert, err := tlscert.LoadOrCreate(configDir(), []string{ip})
	if err != nil {
		log.Fatalf("cert TLS: %v", err)
	}

	printQR(url)
	fmt.Printf("\nphonepad listo. sens=%.2f\nAbrí en el celular:\n  %s\n", *sens, url)
	// /pair y su QR están restringidos a loopback: no publicamos la pantalla
	// de pairing en la LAN. El QR sigue codificando `url`, que sí apunta al cel.
	fmt.Printf("Vista de pairing (solo esta compu):\n  https://localhost:%d/pair\n", *port)
	fmt.Print("\nLa PRIMERA vez el celular mostrará una advertencia de certificado:\n" +
		"tocá 'Avanzado' -> 'Continuar de todos modos'. Es esperado (cert casero).\n\n")

	if devSrc != "" {
		startDevWatchers(devSrc, srv)
	}

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("escuchando (https) en %s", addr)
	httpSrv := &http.Server{
		Addr:      addr,
		Handler:   srv.Handler(),
		TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}
	// Cert y key vacíos: el certificado ya está en TLSConfig.
	if err := httpSrv.ListenAndServeTLS("", ""); err != nil {
		log.Fatalf("server: %v", err)
	}
}

// startDevWatchers lanza el hot-reload (modo dev). Dos pollers de ~400ms atados
// al proceso del daemon (que el toggle de GNOME prende/apaga): uno por web/ que
// recarga el cel, otro por *.go que recompila y re-ejecuta el daemon. Apagar el
// toggle frena el servicio y mata ambos — no queda nada corriendo por fuera.
func startDevWatchers(src string, srv *server.Server) {
	webW := devreload.NewWatcher([]string{filepath.Join(src, "web")}, func(string) bool { return true })
	goW := devreload.NewWatcher([]string{src}, func(p string) bool { return strings.HasSuffix(p, ".go") })

	go func() {
		for range time.Tick(400 * time.Millisecond) {
			if webW.Changed() {
				log.Printf("dev: cambió web/ → reload al cel")
				srv.PushReload()
			}
		}
	}()
	go func() {
		for range time.Tick(400 * time.Millisecond) {
			if goW.Changed() {
				rebuildAndReexec(src)
			}
		}
	}()
}

// rebuildAndReexec recompila el daemon (go build -o <binario-actual>) y se
// re-ejecuta a sí mismo con syscall.Exec: mismo PID, así systemd no lo cuenta
// como caída. Si el build falla, lo loguea y sigue con el binario viejo. La env
// (incluida PHONEPAD_DEV_SRC) se preserva, así el proceso nuevo sigue en dev.
func rebuildAndReexec(src string) {
	self, err := os.Executable()
	if err != nil {
		log.Printf("dev: os.Executable: %v", err)
		return
	}
	log.Printf("dev: cambió .go → recompilando…")
	build := exec.Command(goBinPath(), "build", "-o", self, ".")
	build.Dir = src
	if out, err := build.CombinedOutput(); err != nil {
		log.Printf("dev: build FALLÓ (sigo con el binario viejo):\n%s", out)
		return
	}
	log.Printf("dev: recompilado OK → re-ejecutando")
	if err := syscall.Exec(self, os.Args, os.Environ()); err != nil {
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
			if ip4 != nil && !ip4.IsLoopback() {
				return ip4.String(), nil
			}
		}
	}
	return "", fmt.Errorf("ninguna interfaz con IPv4 de LAN")
}

// printQR imprime el QR en la terminal usando half-blocks (ToSmallString).
func printQR(url string) {
	q, err := qrcode.New(url, qrcode.Medium)
	if err != nil {
		log.Printf("no pude generar QR: %v", err)
		return
	}
	fmt.Print(q.ToSmallString(false))
}
