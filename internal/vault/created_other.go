//go:build !linux && !darwin && !windows

package vault

import (
	"os"
	"time"
)

// createdTime returns the timestamp shown as a note's creation date. On the
// remaining platforms the creation timestamp is not available through
// os.FileInfo, so the modification time is used instead.
func createdTime(info os.FileInfo) time.Time {
	return info.ModTime()
}
