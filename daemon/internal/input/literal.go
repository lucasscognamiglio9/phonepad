package input

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"os/exec"
	"time"
	"unicode/utf8"
)

// LiteralResult never claims to observe the destination application. Rejected
// means no edit was attempted; an interrupted/failed edit is uncertain.
type LiteralResult struct {
	State  string `json:"state"`
	Detail string `json:"detail"`
	Target string `json:"target,omitempty"`
}
type LiteralInjector interface {
	LiteralText(context.Context, string, string) LiteralResult
	LiteralFocus(context.Context) LiteralResult
}

//go:embed literal_text.py
var literalTextScript string

func (d *uinputDevice) LiteralFocus(ctx context.Context) LiteralResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	return runLiteral(ctx, map[string]string{"op": "probe"})
}
func (d *uinputDevice) LiteralText(ctx context.Context, text, target string) LiteralResult {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !utf8.ValidString(text) || len(text) == 0 || len(text) > 128*1024 || bytes.IndexByte([]byte(text), 0) >= 0 || len(target) != 64 {
		return LiteralResult{State: "rejected", Detail: "invalid_literal"}
	}
	return runLiteral(ctx, map[string]string{"op": "insert", "text": text, "target": target})
}
func runLiteral(ctx context.Context, request map[string]string) LiteralResult {
	if ctx.Err() != nil {
		return LiteralResult{State: "rejected", Detail: "cancelled_before_dispatch"}
	}
	payload, _ := json.Marshal(request)
	bounded, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	command := exec.CommandContext(bounded, "/usr/bin/python3", "-c", literalTextScript)
	command.Stdin = bytes.NewReader(payload)
	// Only a fixed-size status is emitted by the helper; stderr is not logged.
	var output bytes.Buffer
	command.Stdout = &output
	if err := command.Start(); err != nil {
		return LiteralResult{State: "rejected", Detail: "literal_adapter_unavailable"}
	}
	if err := command.Wait(); err != nil {
		return LiteralResult{State: "uncertain", Detail: "literal_adapter_interrupted"}
	}
	var result LiteralResult
	if output.Len() > 4096 || json.Unmarshal(output.Bytes(), &result) != nil {
		return LiteralResult{State: "uncertain", Detail: "invalid_adapter_receipt"}
	}
	if result.State != "ready" && result.State != "rejected" && result.State != "dispatched" && result.State != "uncertain" {
		return LiteralResult{State: "uncertain", Detail: "invalid_adapter_receipt"}
	}
	return result
}
