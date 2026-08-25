//go:build linux

package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func validateTrustedStat(stat *syscall.Stat_t, directory bool, cfg config) error {
	if stat.Uid != cfg.expectedUID || stat.Mode&0022 != 0 {
		return reject("path_untrusted")
	}
	if directory {
		if stat.Mode&syscall.S_IFMT != syscall.S_IFDIR {
			return reject("path_untrusted")
		}
	} else if stat.Mode&syscall.S_IFMT != syscall.S_IFREG || stat.Nlink != 1 {
		return reject("path_untrusted")
	}
	return nil
}

func openTrusted(path string, finalDirectory bool, cfg config) (*os.File, error) {
	clean, err := filepath.Abs(path)
	if err != nil || clean != filepath.Clean(path) {
		return nil, reject("path_untrusted")
	}
	boundary := filepath.Clean(cfg.trustBoundary)
	relative, err := filepath.Rel(boundary, clean)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return nil, reject("path_untrusted")
	}
	fd, err := syscall.Open(boundary, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, reject("path_untrusted")
	}
	closeFD := true
	defer func() {
		if closeFD {
			syscall.Close(fd)
		}
	}()
	var boundaryStat syscall.Stat_t
	if syscall.Fstat(fd, &boundaryStat) != nil || validateTrustedStat(&boundaryStat, true, cfg) != nil {
		return nil, reject("path_untrusted")
	}
	components := strings.Split(relative, string(os.PathSeparator))
	for index, name := range components {
		flags := syscall.O_RDONLY | syscall.O_NOFOLLOW
		directory := index < len(components)-1 || finalDirectory
		if directory {
			flags |= syscall.O_DIRECTORY
		}
		next, openErr := syscall.Openat(fd, name, flags, 0)
		if openErr != nil {
			return nil, reject("path_untrusted")
		}
		syscall.Close(fd)
		fd = next
		var raw syscall.Stat_t
		if syscall.Fstat(fd, &raw) != nil {
			return nil, reject("path_untrusted")
		}
		if err = validateTrustedStat(&raw, directory, cfg); err != nil {
			return nil, err
		}
	}
	closeFD = false
	return os.NewFile(uintptr(fd), clean), nil
}

func openTrustedFile(path string, cfg config) (*os.File, error) {
	return openTrusted(path, false, cfg)
}

func openTrustedDirectory(path string, cfg config) (*os.File, error) {
	return openTrusted(path, true, cfg)
}

func acquireTransactionLock(path string, cfg config) (*os.File, error) {
	file, err := openTrustedFile(path, cfg)
	if err != nil {
		return nil, reject("transaction_lock_invalid")
	}
	if err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX); err != nil {
		file.Close()
		return nil, reject("transaction_lock_unavailable")
	}
	return file, nil
}

func releaseTransactionLock(file *os.File) {
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	_ = file.Close()
}
