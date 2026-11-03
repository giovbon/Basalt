//go:build darwin

package vault

import (
	"os"
	"syscall"
	"time"
)

// createdTime returns the timestamp shown as a note's creation date. Darwin
// reports the inode change time in Ctimespec; filesystems without it fall
// back to the modification time.
func createdTime(info os.FileInfo) time.Time {
	if sys := info.Sys(); sys != nil {
		if stat, ok := sys.(*syscall.Stat_t); ok {
			return time.Unix(int64(stat.Ctimespec.Sec), int64(stat.Ctimespec.Nsec))
		}
	}
	return info.ModTime()
}
