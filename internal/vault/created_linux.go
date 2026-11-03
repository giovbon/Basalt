//go:build linux

package vault

import (
	"os"
	"syscall"
	"time"
)

// createdTime returns the timestamp shown as a note's creation date. Linux
// does not expose the birth time through Stat_t; Ctim (the inode change time)
// is the closest available value and matches what the app reported before,
// so filesystems without it fall back to the modification time.
func createdTime(info os.FileInfo) time.Time {
	if sys := info.Sys(); sys != nil {
		if stat, ok := sys.(*syscall.Stat_t); ok {
			return time.Unix(int64(stat.Ctim.Sec), int64(stat.Ctim.Nsec))
		}
	}
	return info.ModTime()
}
