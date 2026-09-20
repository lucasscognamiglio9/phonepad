//go:build !linux

package input

// New reports the lack of a native provider on non-Linux platforms. Demo is an
// explicit test/demonstration injector and is never selected implicitly here.
func New() (Injector, error) {
	return nil, ErrProviderUnavailable
}

// NewAbsolute reports the lack of a native provider on non-Linux platforms.
func NewAbsolute(_, _ int) (AbsInjector, error) {
	return nil, ErrProviderUnavailable
}
