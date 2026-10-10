package filebatches

import "os"

// Windows does not permit FlushFileBuffers on directory handles opened by
// os.Open. File contents are flushed before publication; check the directory
// exists here, then rely on the same-volume rename for atomic publication.
func syncDir(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	return directory.Close()
}
