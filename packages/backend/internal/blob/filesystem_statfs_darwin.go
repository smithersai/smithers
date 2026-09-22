//go:build darwin

package blob

import "golang.org/x/sys/unix"

func filesystemAvailableBytes(stat *unix.Statfs_t) int64 {
	return int64(stat.Bavail) * int64(stat.Bsize)
}
