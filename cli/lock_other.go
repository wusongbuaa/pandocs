//go:build !unix && !windows

package main

import "os"

// Elsewhere there is nothing to lock with, and one pandocs at a time is up to whoever runs it.
func tryLock(*os.File) (bool, error) { return true, nil }

func unlock(*os.File) error { return nil }
