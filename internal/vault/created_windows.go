//go:build windows

package vault

import (
	"os"
	"time"
)

// createdTime returns the timestamp shown as a note's creation date. The
// portable os.FileInfo API used here carries no birth time, so the
// modification time is the best value available on this platform.
func createdTime(info os.FileInfo) time.Time {
	return info.ModTime()
}
