//go:build !linux && !darwin && !windows

package input

// New reports the lack of a native provider on non-Linux platforms. Demo is an
// explicit test/demonstration injector and is never selected implicitly here.
func New() (Injector, error) {
	return nil, ErrProviderUnavailable
}
