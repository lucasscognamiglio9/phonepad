package server

import "os"

// Directory FlushFileBuffers is unsupported for ordinary Windows directory
// handles. The claim and receipt files are flushed before their atomic rename.
func syncTransferDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return f.Close()
}
