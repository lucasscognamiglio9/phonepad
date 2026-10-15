//go:build linux

package input

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/bendahl/uinput"
)

//go:embed clipboard_lease.py
var clipboardLeaseScript string

type clipboardLease struct {
	input    io.WriteCloser
	receipts <-chan LiteralResult
}

func startClipboardLease(text string) (*clipboardLease, error) {
	command := exec.Command("/usr/bin/python3", "-c", clipboardLeaseScript)
	if os.Getenv("DISPLAY") != "" {
		command.Env = append(os.Environ(), "GDK_BACKEND=x11")
	}
	in, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := command.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	if err := command.Start(); err != nil {
		in.Close()
		out.Close()
		return nil, err
	}
	receipts := make(chan LiteralResult, 4)
	go func() {
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 1024), 4096)
		for scanner.Scan() {
			var receipt LiteralResult
			if json.Unmarshal(scanner.Bytes(), &receipt) != nil {
				break
			}
			receipts <- receipt
		}
		close(receipts)
		_ = command.Wait()
	}()
	lease := &clipboardLease{input: in, receipts: receipts}
	if err := json.NewEncoder(in).Encode(map[string]string{"text": text}); err != nil {
		in.Close()
		return nil, err
	}
	return lease, nil
}

func (l *clipboardLease) send(op string) error {
	return json.NewEncoder(l.input).Encode(map[string]string{"op": op})
}

func (l *clipboardLease) read(ctx context.Context) LiteralResult {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case result, ok := <-l.receipts:
		if ok {
			return result
		}
		return LiteralResult{State: "uncertain", Detail: "clipboard_provider_closed"}
	case <-ctx.Done():
		return LiteralResult{State: "uncertain", Detail: "clipboard_request_cancelled"}
	case <-timer.C:
		return LiteralResult{State: "uncertain", Detail: "clipboard_provider_timeout"}
	}
}

func (d *uinputDevice) clipboardLiteralText(ctx context.Context, text string) LiteralResult {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	ClipboardMu.Lock()
	defer ClipboardMu.Unlock()
	lease, err := startClipboardLease(text)
	if err != nil {
		return LiteralResult{State: "rejected", Detail: "clipboard_preservation_unavailable"}
	}
	defer lease.input.Close()
	result := lease.read(ctx)
	if result.State != "ready" {
		_ = lease.send("cancel")
		return result
	}
	if ctx.Err() != nil || lease.send("arm") != nil {
		_ = lease.send("cancel")
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	result = lease.read(ctx)
	if result.State != "armed" {
		_ = lease.send("cancel")
		return result
	}
	if ctx.Err() != nil {
		_ = lease.send("cancel")
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	d.mu.Lock()
	down := d.keyDownResult(uinput.KeyLeftctrl)
	if down.State != "executed" {
		_ = d.keyUpResult(uinput.KeyLeftctrl)
		d.mu.Unlock()
		_ = lease.send("cancel")
		return LiteralResult{State: "uncertain", Detail: "paste_dispatch_unconfirmed"}
	}
	press := d.keyPressResult(uinput.KeyV)
	up := d.keyUpResult(uinput.KeyLeftctrl)
	d.mu.Unlock()
	if press.State != "executed" || up.State != "executed" || lease.send("sent") != nil {
		_ = lease.send("cancel")
		return LiteralResult{State: "uncertain", Detail: "paste_dispatch_unconfirmed"}
	}
	return lease.read(ctx)
}
