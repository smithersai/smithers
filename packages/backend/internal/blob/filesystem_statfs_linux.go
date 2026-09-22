//go:build linux

package blob

import "golang.org/x/sys/unix"

func filesystemAvailableBytes(stat *unix.Statfs_t) int64 {
	fragmentSize := stat.Frsize
	if fragmentSize <= 0 {
		fragmentSize = stat.Bsize
	}
	return int64(stat.Bavail) * fragmentSize
}
