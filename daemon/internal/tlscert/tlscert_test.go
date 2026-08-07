package tlscert

import (
	"crypto/x509"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func leafOf(t *testing.T, dir string) *x509.Certificate {
	t.Helper()
	cert, ok := loadValid(filepath.Join(dir, certFile), filepath.Join(dir, keyFile), nil)
	if !ok {
		t.Fatal("loadValid: cert persistido no válido")
	}
	if cert.Leaf == nil {
		t.Fatal("leaf nil")
	}
	return cert.Leaf
}

func TestLoadOrCreate_RoundTripAndSAN(t *testing.T) {
	dir := t.TempDir()
	cert, err := LoadOrCreate(dir, []string{"192.168.1.40"})
	if err != nil {
		t.Fatalf("LoadOrCreate: %v", err)
	}
	if len(cert.Certificate) == 0 {
		t.Fatal("cert vacío")
	}
	// Los archivos deben existir.
	for _, f := range []string{certFile, keyFile} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("falta %s: %v", f, err)
		}
	}
	// La IP de LAN debe estar en el SAN, además del loopback.
	leaf := leafOf(t, dir)
	if !covers(leaf, "192.168.1.40") {
		t.Errorf("SAN no incluye 192.168.1.40: %v", leaf.IPAddresses)
	}
	if !covers(leaf, "127.0.0.1") {
		t.Errorf("SAN no incluye loopback")
	}
	if !covers(leaf, "localhost") {
		t.Errorf("SAN no incluye localhost")
	}
}

func TestLoadOrCreate_ReusesPersisted(t *testing.T) {
	dir := t.TempDir()
	c1, err := LoadOrCreate(dir, []string{"192.168.1.40"})
	if err != nil {
		t.Fatal(err)
	}
	c2, err := LoadOrCreate(dir, []string{"192.168.1.40"})
	if err != nil {
		t.Fatal(err)
	}
	// Mismo cert: misma serie (no se regeneró).
	l1, _ := x509.ParseCertificate(c1.Certificate[0])
	l2, _ := x509.ParseCertificate(c2.Certificate[0])
	if l1.SerialNumber.Cmp(l2.SerialNumber) != 0 {
		t.Errorf("el cert se regeneró sin necesidad (series distintas)")
	}
}

func TestLoadOrCreate_RegeneratesWhenIPChanges(t *testing.T) {
	dir := t.TempDir()
	c1, err := LoadOrCreate(dir, []string{"192.168.1.40"})
	if err != nil {
		t.Fatal(err)
	}
	// Nueva IP no cubierta por el cert viejo → debe regenerar.
	c2, err := LoadOrCreate(dir, []string{"10.0.0.5"})
	if err != nil {
		t.Fatal(err)
	}
	l1, _ := x509.ParseCertificate(c1.Certificate[0])
	l2, _ := x509.ParseCertificate(c2.Certificate[0])
	if l1.SerialNumber.Cmp(l2.SerialNumber) == 0 {
		t.Errorf("no regeneró el cert pese a cambiar la IP")
	}
	if !covers(l2, "10.0.0.5") {
		t.Errorf("el cert nuevo no cubre la IP nueva: %v", l2.IPAddresses)
	}
}

func TestCoversIPv6Loopback(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreate(dir, nil); err != nil {
		t.Fatal(err)
	}
	leaf := leafOf(t, dir)
	if !covers(leaf, net.IPv6loopback.String()) {
		t.Errorf("SAN no incluye ::1")
	}
}
