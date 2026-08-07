// Package tlscert genera y persiste un certificado self-signed para servir
// https+wss (SPEC §8). HTTPS es secure-context, lo que desbloquea el micrófono
// (Web Speech API), la VirtualKeyboard API y la PWA instalable. El cert es para
// LAN casera: self-signed, sin CA. El celular acepta el warning una sola vez.
package tlscert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

const (
	certFile = "cert.pem"
	keyFile  = "key.pem"
)

// LoadOrCreate devuelve un tls.Certificate, generándolo y persistiéndolo la
// primera vez en dir (típicamente ~/.config/phonepad). Lo regenera si está por
// vencer, si no parsea, o si alguno de los hosts pedidos no está en el SAN (caso
// "cambié de red, la IP cambió"). hosts = IPs/DNS que deben quedar en el SAN.
func LoadOrCreate(dir string, hosts []string) (tls.Certificate, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return tls.Certificate{}, fmt.Errorf("crear %s: %w", dir, err)
	}
	cp := filepath.Join(dir, certFile)
	kp := filepath.Join(dir, keyFile)

	if cert, ok := loadValid(cp, kp, hosts); ok {
		return cert, nil
	}

	cert, certPEM, keyPEM, err := generate(hosts)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.WriteFile(cp, certPEM, 0o600); err != nil {
		return tls.Certificate{}, fmt.Errorf("escribir cert: %w", err)
	}
	if err := os.WriteFile(kp, keyPEM, 0o600); err != nil {
		return tls.Certificate{}, fmt.Errorf("escribir key: %w", err)
	}
	return cert, nil
}

// loadValid intenta reusar el cert persistido. Devuelve ok=false si falta, no
// parsea, está vencido/por vencer, o no cubre todos los hosts pedidos.
func loadValid(certPath, keyPath string, hosts []string) (tls.Certificate, bool) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return tls.Certificate{}, false
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return tls.Certificate{}, false
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return tls.Certificate{}, false
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return tls.Certificate{}, false
	}
	// Vencido o por vencer (margen de 30 días).
	if time.Now().Add(30 * 24 * time.Hour).After(leaf.NotAfter) {
		return tls.Certificate{}, false
	}
	// Todos los hosts pedidos deben estar en el SAN.
	for _, h := range hosts {
		if !covers(leaf, h) {
			return tls.Certificate{}, false
		}
	}
	cert.Leaf = leaf
	return cert, true
}

// covers indica si el host (IP o DNS) está en el SAN del cert.
func covers(leaf *x509.Certificate, host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		for _, cip := range leaf.IPAddresses {
			if cip.Equal(ip) {
				return true
			}
		}
		return false
	}
	for _, dns := range leaf.DNSNames {
		if dns == host {
			return true
		}
	}
	return false
}

// generate crea un cert self-signed ECDSA P-256 con SAN = hosts + loopback +
// localhost. Los browsers modernos ignoran el CN y exigen SAN.
func generate(hosts []string) (cert tls.Certificate, certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return cert, nil, nil, fmt.Errorf("generar clave: %w", err)
	}

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return cert, nil, nil, fmt.Errorf("serial: %w", err)
	}

	now := time.Now()
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "phonepad"},
		NotBefore:             now.Add(-1 * time.Hour), // tolerar clock skew
		NotAfter:              now.AddDate(10, 0, 0),   // LAN casera: sin rotación
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, h)
		}
	}

	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		return cert, nil, nil, fmt.Errorf("crear cert: %w", err)
	}

	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return cert, nil, nil, fmt.Errorf("marshal key: %w", err)
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	cert, err = tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return cert, nil, nil, fmt.Errorf("armar par: %w", err)
	}
	return cert, certPEM, keyPEM, nil
}
