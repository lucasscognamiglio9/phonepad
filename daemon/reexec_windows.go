//go:build windows

package main

import "errors"

// The development watcher is Linux-only. Do not emulate in-place exec on Windows.
func reexecCurrent(string, []string, []string) error {
    return errors.New("development re-exec is unavailable on Windows")
}
