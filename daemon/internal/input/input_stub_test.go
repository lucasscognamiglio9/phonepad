//go:build !linux && !darwin && !windows

package input

import (
	"errors"
	"testing"
)

func TestProviderUnavailableDoesNotFallbackToDemo(t *testing.T) {
	if got, err := New(); got != nil || !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("New() = (%T, %v), want nil and ErrProviderUnavailable", got, err)
	}

}
