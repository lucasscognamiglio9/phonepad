//go:build !windows

package privatefs

import "os"

func Secure(path string, directory bool) error {
	if directory {
		return os.Chmod(path, 0o700)
	}
	return os.Chmod(path, 0o600)
}

func IsPrivate(path string, directory bool) (bool, error) {
	info, err := os.Stat(path)
	if err != nil {
		return false, err
	}
	if directory {
		return info.IsDir() && info.Mode().Perm() == 0o700, nil
	}
	return info.Mode().IsRegular() && info.Mode().Perm() == 0o600, nil
}
