//go:build !linux

package main

import "os"

func openTrustedFile(_ string, _ config) (*os.File, error) {
	return nil, reject("platform_unsupported")
}

func openTrustedDirectory(_ string, _ config) (*os.File, error) {
	return nil, reject("platform_unsupported")
}

func acquireTransactionLock(_ string, _ config) (*os.File, error) {
	return nil, reject("platform_unsupported")
}

func releaseTransactionLock(_ *os.File) {}
