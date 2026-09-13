package server

// Clipboard support deliberately lives behind a very small interface. The
// HTTP handler never talks to the desktop selection directly, which keeps
// upload tests deterministic and means that an upload can never read (or
// restore) the user's existing clipboard contents.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type clipboardKind string

const (
	clipboardImage clipboardKind = "image"
	clipboardFile  clipboardKind = "file"
)

const (
	// Decoding an image necessarily uses more memory than streaming an upload
	// to disk. Keep a generous but finite bound for a clipboard image. It is
	// large enough for ordinary phone photos while preventing a tiny compressed
	// image from allocating an unbounded pixel buffer.
	maxClipboardPixels      = 64 * 1024 * 1024
	maxClipboardImageBytes  = 128 << 20
	clipboardCommandTimeout = 15 * time.Second
)

// clipboardWriter is injectable so HTTP tests can use synthetic fixtures
// without touching a user's clipboard. Copy receives the already published
// private path; implementations must not inspect the current selection.
type clipboardWriter interface {
	Copy(path string, kind clipboardKind, mediaType string) error
}

// wlClipboard uses wl-copy's MIME override. wl-copy forks a clipboard data
// provider by default and keeps it alive until the compositor cancels the
// selection. That gives applications repeated paste requests and lets the
// provider stop naturally on selection loss. We intentionally do not use
// --paste-once: XWayland clients can request a second transfer while pasting.
//
// The copy function is a field rather than hard-coded in Copy so tests can
// capture the offered MIME and bytes with a synthetic reader.
type wlClipboard struct {
	copy func(mediaType string, src io.Reader) error
}

func (c wlClipboard) Copy(path string, kind clipboardKind, mediaType string) error {
	if c.copy == nil {
		return errors.New("clipboard writer unavailable")
	}
	switch kind {
	case clipboardImage:
		pngPath, cleanup, err := clipboardPNG(path)
		if err != nil {
			return err
		}
		defer cleanup()

		file, err := os.Open(pngPath)
		if err != nil {
			return err
		}
		defer file.Close()
		// Every image offer is a real PNG, including JPEG and HEIC input. The
		// incoming MIME is only used to choose image vs file in the handler.
		return c.copy("image/png", file)

	case clipboardFile:
		uri, err := fileURI(path)
		if err != nil {
			return err
		}
		// text/uri-list is the interoperable file-drop format understood by
		// GTK, Qt, browsers, office applications, and XWayland clients. It
		// carries a URI rather than leaking a local path as plain text.
		return c.copy("text/uri-list", strings.NewReader(uri+"\r\n"))
	default:
		return os.ErrInvalid
	}
}

// xClipboard is the X11/XWayland fallback. xclip also remains a clipboard
// owner after its parent exits, and is useful on sessions where WAYLAND_DISPLAY
// is unavailable. It intentionally has the same Copy contract as wlClipboard
// so conversion and URI behavior stay identical.
type xClipboard struct {
	copy func(mediaType string, src io.Reader) error
}

func (c xClipboard) Copy(path string, kind clipboardKind, mediaType string) error {
	return wlClipboard{copy: c.copy}.Copy(path, kind, mediaType)
}

// systemClipboard selects the session-native clipboard command. A desktop can
// expose both variables (for example GNOME Wayland with XWayland); prefer
// Wayland because it is the compositor's primary selection, then use X11 when
// only DISPLAY is present. wl-copy remains the final fallback so a caller
// receives a normal unavailable error instead of a panic when no session is
// attached.
func systemClipboard() clipboardWriter {
	var native clipboardWriter
	if os.Getenv("WAYLAND_DISPLAY") != "" {
		native = wlClipboard{copy: runWLClipboard}
	} else if os.Getenv("DISPLAY") != "" {
		native = xClipboard{copy: runXClipboard}
	} else {
		native = wlClipboard{copy: runWLClipboard}
	}
	return &desktopClipboard{gtk: &gtkClipboard{}, native: native}
}

func runWLClipboard(mediaType string, src io.Reader) error {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardCommandTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "wl-copy", "--type", mediaType)
	command.Stdin = src
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("wl-copy timed out: %w", ctx.Err())
		}
		return err
	}
	return nil
}

func runXClipboard(mediaType string, src io.Reader) error {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardCommandTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "xclip", "-selection", "clipboard", "-t", mediaType, "-i")
	command.Stdin = src
	if err := command.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("xclip timed out: %w", ctx.Err())
		}
		return err
	}
	return nil
}

func clipboardMediaType(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if i := strings.IndexByte(value, ';'); i >= 0 {
		value = strings.TrimSpace(value[:i])
	}
	return value
}

// clipboardKindFor chooses the clipboard representation. Image data is
// normalized to PNG so image-aware paste targets receive an actual decoded
// raster image rather than JPEG/HEIC bytes mislabeled as image/png.
func clipboardKindFor(mediaType string) (clipboardKind, string) {
	if strings.HasPrefix(clipboardMediaType(mediaType), "image/") {
		return clipboardImage, "image/png"
	}
	return clipboardFile, "text/uri-list"
}

func fileURI(path string) (string, error) {
	path = filepath.Clean(path)
	if path == "." || path == "" {
		return "", os.ErrInvalid
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return (&url.URL{Scheme: "file", Path: absolute}).String(), nil
}

// clipboardPNG converts a supported image to a temporary PNG file. The
// stdlib handles PNG/JPEG/GIF without another process. HEIC, AVIF, JXL and
// other formats provided by installed GdkPixbuf loaders are delegated to
// GdkPixbuf through the small Python GI bridge below. The temporary file is
// mode 0600 and is removed once wl-copy/xclip has consumed it.
func clipboardPNG(path string) (string, func(), error) {
	if path == "" {
		return "", func() {}, os.ErrInvalid
	}

	input, err := os.Open(path)
	if err != nil {
		return "", func() {}, err
	}
	config, _, configErr := image.DecodeConfig(input)
	_ = input.Close()
	if configErr == nil {
		if err := validClipboardDimensions(config.Width, config.Height); err != nil {
			return "", func() {}, err
		}
		// GdkPixbuf is asked first for camera formats because it applies the
		// EXIF orientation metadata that Go's JPEG decoder intentionally
		// ignores. If its optional GI bridge is unavailable, the stdlib still
		// provides a correctly encoded (but unrotated) fallback.
		if orientationSensitiveImage(path) {
			if converted, convertedCleanup, convertErr := gdkPixbufPNG(path); convertErr == nil {
				return converted, convertedCleanup, nil
			}
		}
		return stdlibPNG(path)
	}

	// The MIME may be a valid GdkPixbuf format that the Go standard library
	// does not know (notably HEIC). Try the system GdkPixbuf loaders before
	// reporting the image unavailable.
	return gdkPixbufPNG(path)
}

func orientationSensitiveImage(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".avif", ".heic", ".heif", ".jpeg", ".jpg", ".jxl", ".tif", ".tiff":
		return true
	default:
		return false
	}
}

func validClipboardDimensions(width, height int) error {
	if width <= 0 || height <= 0 {
		return fmt.Errorf("invalid image dimensions")
	}
	if width > maxClipboardPixels/height {
		return fmt.Errorf("image exceeds clipboard pixel limit")
	}
	return nil
}

func newClipboardTemp(dir string) (*os.File, func(), error) {
	file, err := os.CreateTemp(dir, ".clipboard-image-*.png")
	if err != nil {
		return nil, func() {}, err
	}
	if err := file.Chmod(0600); err != nil {
		file.Close()
		_ = os.Remove(file.Name())
		return nil, func() {}, err
	}
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	}
	return file, cleanup, nil
}

// limitedFileWriter turns an output-size limit into an encoder error. A
// LimitWriter that silently discards bytes would produce corrupt PNGs while
// still claiming clipboard readiness.
type limitedFileWriter struct {
	file  io.Writer
	left  int64
	limit int64
}

func (w *limitedFileWriter) Write(data []byte) (int, error) {
	if int64(len(data)) > w.left {
		return 0, fmt.Errorf("clipboard image exceeds %d-byte limit", w.limit)
	}
	n, err := w.file.Write(data)
	w.left -= int64(n)
	return n, err
}

func stdlibPNG(path string) (string, func(), error) {
	tmp, cleanup, err := newClipboardTemp(filepath.Dir(path))
	if err != nil {
		return "", func() {}, err
	}
	input, err := os.Open(path)
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	decoded, _, err := image.Decode(input)
	_ = input.Close()
	if err != nil {
		cleanup()
		return "", func() {}, err
	}
	// This is normally handled by the GdkPixbuf path above. Keep a small EXIF
	// fallback for sessions where the optional GI bridge is unavailable, so a
	// camera JPEG is not pasted sideways merely because Go's decoder ignores
	// orientation metadata.
	if orientation, orientationErr := jpegOrientation(path); orientationErr == nil {
		decoded = applyJPEGOrientation(decoded, orientation)
	}
	writer := &limitedFileWriter{file: tmp, left: maxClipboardImageBytes, limit: maxClipboardImageBytes}
	if err := png.Encode(writer, decoded); err != nil {
		cleanup()
		return "", func() {}, err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}
	return tmp.Name(), cleanup, nil
}

func jpegOrientation(path string) (int, error) {
	if ext := strings.ToLower(filepath.Ext(path)); ext != ".jpg" && ext != ".jpeg" {
		return 1, errors.New("not a JPEG")
	}
	file, err := os.Open(path)
	if err != nil {
		return 1, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return 1, err
	}
	if len(data) < 2 || data[0] != 0xff || data[1] != 0xd8 {
		return 1, errors.New("invalid JPEG")
	}
	for offset := 2; offset+4 <= len(data); {
		if data[offset] != 0xff {
			return 1, errors.New("invalid JPEG marker")
		}
		for offset < len(data) && data[offset] == 0xff {
			offset++
		}
		if offset >= len(data) {
			break
		}
		marker := data[offset]
		offset++
		if marker == 0xda || marker == 0xd9 {
			break
		}
		if marker == 0xd8 || (marker >= 0xd0 && marker <= 0xd7) {
			continue
		}
		if offset+2 > len(data) {
			break
		}
		segmentLength := int(binary.BigEndian.Uint16(data[offset : offset+2]))
		offset += 2
		if segmentLength < 2 || offset+segmentLength-2 > len(data) {
			break
		}
		segment := data[offset : offset+segmentLength-2]
		if marker == 0xe1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
			if orientation, ok := parseEXIFOrientation(segment[6:]); ok {
				return orientation, nil
			}
		}
		offset += segmentLength - 2
	}
	return 1, errors.New("JPEG orientation unavailable")
}

func parseEXIFOrientation(data []byte) (int, bool) {
	if len(data) < 8 {
		return 1, false
	}
	var order binary.ByteOrder = binary.BigEndian
	if bytes.Equal(data[:2], []byte("II")) {
		order = binary.LittleEndian
	} else if !bytes.Equal(data[:2], []byte("MM")) {
		return 1, false
	}
	if order.Uint16(data[2:4]) != 42 {
		return 1, false
	}
	ifdOffset := int(order.Uint32(data[4:8]))
	if ifdOffset < 0 || ifdOffset+2 > len(data) {
		return 1, false
	}
	entries := int(order.Uint16(data[ifdOffset : ifdOffset+2]))
	if entries > (len(data)-ifdOffset-2)/12 {
		return 1, false
	}
	for i := 0; i < entries; i++ {
		entry := data[ifdOffset+2+i*12 : ifdOffset+14+i*12]
		if order.Uint16(entry[:2]) != 0x0112 || order.Uint16(entry[2:4]) != 3 || order.Uint32(entry[4:8]) != 1 {
			continue
		}
		orientation := int(order.Uint16(entry[8:10]))
		if orientation >= 1 && orientation <= 8 {
			return orientation, true
		}
	}
	return 1, false
}

func applyJPEGOrientation(src image.Image, orientation int) image.Image {
	if orientation <= 1 || orientation > 8 {
		return src
	}
	bounds := src.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			dx, dy := x, y
			switch orientation {
			case 2:
				dx = w - 1 - x
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dy = h - 1 - y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, src.At(bounds.Min.X+x, bounds.Min.Y+y))
		}
	}
	return dst
}

// GdkPixbuf is deliberately used through the system Python GI bindings: the
// daemon is built without cgo and therefore does not need to ship GTK headers
// or link against a specific distro's ABI. The Python process exits after the
// conversion; no desktop or clipboard state is read by it.
const gdkPixbufConvertScript = `
import gi
import sys
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf

source, destination = sys.argv[1], sys.argv[2]
format, width, height = GdkPixbuf.Pixbuf.get_file_info(source)
if format is None or width <= 0 or height <= 0 or width * height > 67108864:
    raise RuntimeError("image exceeds clipboard pixel limit")
pixbuf = GdkPixbuf.Pixbuf.new_from_file(source)
width, height = pixbuf.get_width(), pixbuf.get_height()
if width <= 0 or height <= 0 or width * height > 67108864:
    raise RuntimeError("image exceeds clipboard pixel limit")
pixbuf = pixbuf.apply_embedded_orientation()
if not pixbuf.savev(destination, "png", [], []):
    raise RuntimeError("GdkPixbuf could not save PNG")
`

// gtkClipboard owns a GdkClipboard through a tiny foreground helper. GTK's
// GdkContentProvider union is the one desktop API that can advertise all of
// the URI targets expected by GTK, Qt, and file pickers at once. The helper has
// no window, so installing a selection does not move keyboard focus away from
// the user's prompt. It polls only the selection ownership bit and exits as
// soon as another application takes the selection.
type gtkClipboard struct {
	mu      sync.Mutex
	command *exec.Cmd
	done    chan struct{}
}

// desktopClipboard uses the session-native command for images. wl-copy's
// image/png data source is understood directly by Wayland browsers, whereas
// an XWayland GTK owner can report a local selection without exposing its
// bytes to a Wayland client. Documents use GTK's union provider first so a
// file picker can choose any of the common URI-list targets; the native
// command remains the fallback when GTK/GI is unavailable.
type desktopClipboard struct {
	gtk    *gtkClipboard
	native clipboardWriter
}

func (c *desktopClipboard) Copy(path string, kind clipboardKind, mediaType string) error {
	if c == nil {
		return errors.New("clipboard writer unavailable")
	}
	if kind == clipboardImage && c.native != nil {
		if err := c.native.Copy(path, kind, mediaType); err == nil {
			return nil
		}
	}
	if c.gtk != nil {
		if err := c.gtk.Copy(path, kind, mediaType); err == nil {
			return nil
		}
	}
	if c.native == nil {
		return errors.New("clipboard writer unavailable")
	}
	return c.native.Copy(path, kind, mediaType)
}

func (c *gtkClipboard) Copy(path string, kind clipboardKind, mediaType string) error {
	if c == nil || (os.Getenv("WAYLAND_DISPLAY") == "" && os.Getenv("DISPLAY") == "") {
		return errors.New("GTK display unavailable")
	}
	python := ""
	for _, candidate := range []string{"/usr/bin/python3", "python3"} {
		if _, err := os.Stat(candidate); err == nil {
			python = candidate
			break
		}
	}
	if python == "" {
		return errors.New("Python GI unavailable")
	}

	preparedPath := path
	cleanup := func() {}
	if kind == clipboardImage {
		var err error
		preparedPath, cleanup, err = clipboardPNG(path)
		if err != nil {
			return err
		}
	}
	defer cleanup()

	if kind != clipboardImage && kind != clipboardFile {
		return os.ErrInvalid
	}
	if _, err := os.Stat(preparedPath); kind == clipboardImage && err != nil {
		return err
	}

	// A replacement selection must release the old provider before we install
	// a new one. This also bounds the number of helper processes at one.
	c.stop()
	command := exec.Command(python, "-c", gtkClipboardScript, preparedPath, string(kind))
	// On GNOME Wayland, a headless GDK Wayland data source can appear local to
	// the daemon while native clients cannot request it until a focused input
	// surface exists. When XWayland is available, its selection bridge provides
	// a focus-independent owner; the helper still creates no window.
	if os.Getenv("DISPLAY") != "" {
		command.Env = append(os.Environ(), "GDK_BACKEND=x11")
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		return err
	}
	waitDone := make(chan struct{})
	waitErr := make(chan error, 1)
	go func() {
		waitErr <- command.Wait()
		close(waitDone)
	}()
	ready := make(chan error, 1)
	go func() {
		line, readErr := bufio.NewReader(stdout).ReadString('\n')
		if readErr != nil {
			ready <- readErr
			return
		}
		if strings.TrimSpace(line) != "ready" {
			ready <- fmt.Errorf("GTK clipboard did not become ready: %q", strings.TrimSpace(line))
			return
		}
		ready <- nil
	}()

	timer := time.NewTimer(clipboardCommandTimeout)
	defer timer.Stop()
	select {
	case err := <-ready:
		if err != nil {
			_ = command.Process.Kill()
			<-waitDone
			_ = <-waitErr
			if stderr.Len() > 0 {
				return fmt.Errorf("GTK clipboard: %w: %s", err, strings.TrimSpace(stderr.String()))
			}
			return err
		}
		// A helper that printed ready and exited immediately did not establish
		// a persistent provider. Check the wait channel before publishing the
		// success result to the HTTP handler.
		select {
		case <-waitDone:
			err := <-waitErr
			if err == nil {
				err = errors.New("GTK clipboard provider exited")
			}
			if stderr.Len() > 0 {
				return fmt.Errorf("GTK clipboard: %w: %s", err, strings.TrimSpace(stderr.String()))
			}
			return err
		default:
		}
		c.mu.Lock()
		c.command = command
		c.done = waitDone
		c.mu.Unlock()
		go c.clearWhenDone(command, waitDone)
		return nil
	case <-waitDone:
		processErr := <-waitErr
		err := processErr
		if processErr == nil {
			err = errors.New("GTK clipboard provider exited before ready")
		}
		if stderr.Len() > 0 {
			return fmt.Errorf("GTK clipboard: %w: %s", err, strings.TrimSpace(stderr.String()))
		}
		return err
	case <-timer.C:
		_ = command.Process.Kill()
		<-waitDone
		_ = <-waitErr
		return errors.New("GTK clipboard provider timed out")
	}
}

func (c *gtkClipboard) clearWhenDone(command *exec.Cmd, done chan struct{}) {
	<-done
	c.mu.Lock()
	if c.command == command {
		c.command = nil
		c.done = nil
	}
	c.mu.Unlock()
}

func (c *gtkClipboard) stop() {
	if c == nil {
		return
	}
	c.mu.Lock()
	command, done := c.command, c.done
	c.command, c.done = nil, nil
	c.mu.Unlock()
	if command == nil {
		return
	}
	_ = command.Process.Kill()
	if done != nil {
		<-done
	}
}

// This script intentionally uses no Gtk.Window. GdkClipboard can be attached
// to the default GdkDisplay directly; the process therefore never requests
// activation or changes the focused laptop prompt. is_local() reports owner
// loss without fetching clipboard bytes.
const gtkClipboardScript = `
import gi
import pathlib
import sys
gi.require_version("Gtk", "4.0")
gi.require_version("Gdk", "4.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gtk, Gdk, GLib

source, kind = sys.argv[1], sys.argv[2]
Gtk.init()
display = Gdk.Display.get_default()
if display is None:
    raise RuntimeError("no GDK display")
clipboard = display.get_clipboard()
providers = []
if kind == "image":
    data = pathlib.Path(source).read_bytes()
    providers.append(Gdk.ContentProvider.new_for_bytes("image/png", GLib.Bytes.new(data)))
elif kind == "file":
    uri = pathlib.Path(source).resolve().as_uri()
    for mime, value in (
		("text/uri-list", uri + "\r\n"),
		("x-special/gnome-copied-files", "copy\n" + uri + "\n"),
		("application/x-kde4-urilist", uri + "\n"),
    ):
        providers.append(Gdk.ContentProvider.new_for_bytes(mime, GLib.Bytes.new(value.encode("utf-8"))))
else:
    raise RuntimeError("invalid clipboard kind")
provider = Gdk.ContentProvider.new_union(providers)
if not clipboard.set_content(provider):
    raise RuntimeError("could not claim clipboard")
sys.stdout.write("ready\n")
sys.stdout.flush()

def still_local():
    if not clipboard.is_local():
        loop.quit()
        return False
    return True

loop = GLib.MainLoop()
GLib.timeout_add(250, still_local)
loop.run()
`

func gdkPixbufPNG(path string) (string, func(), error) {
	tmp, cleanup, err := newClipboardTemp(filepath.Dir(path))
	if err != nil {
		return "", func() {}, err
	}
	destination := tmp.Name()
	if err := tmp.Close(); err != nil {
		cleanup()
		return "", func() {}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), clipboardCommandTimeout)
	defer cancel()
	var lastErr error
	for _, python := range []string{"/usr/bin/python3", "python3"} {
		if _, err := os.Stat(python); err != nil {
			continue
		}
		command := exec.CommandContext(ctx, python, "-c", gdkPixbufConvertScript, path, destination)
		output, runErr := command.CombinedOutput()
		if runErr == nil {
			info, statErr := os.Stat(destination)
			if statErr == nil && info.Size() > 0 && info.Size() <= maxClipboardImageBytes {
				return destination, cleanup, nil
			}
			if statErr != nil {
				lastErr = statErr
			} else {
				lastErr = fmt.Errorf("GdkPixbuf produced an empty or oversized PNG")
			}
		} else {
			lastErr = runErr
			if len(output) > 0 {
				lastErr = fmt.Errorf("GdkPixbuf conversion: %w: %s", runErr, strings.TrimSpace(string(output)))
			}
		}
		// If /usr/bin/python3 was present but lacked GI, trying another
		// interpreter may still succeed in a developer environment.
		if ctx.Err() != nil {
			break
		}
	}
	cleanup()
	if lastErr == nil {
		lastErr = errors.New("GdkPixbuf unavailable")
	}
	return "", func() {}, lastErr
}
