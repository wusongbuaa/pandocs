package main

import (
	"errors"
	"os"
	"path/filepath"
	"time"
)

var (
	errLocked = errors.New("another pandocs is working on this copy")
	// How long to wait for one that is, such as a commit while `sync --watch` runs a round.
	lockWait = 2 * time.Minute
)

// lockCopy keeps two pandocs from working on one copy at once: each would save the state it had, and the second would
// undo what the first recorded. The system lets go of the lock when the process ends, however it ends.
func lockCopy(root string) (func(), error) {
	if err := os.MkdirAll(filepath.Join(root, metaDir), 0o755); err != nil {
		return nil, err
	}
	return lockFile(filepath.Join(root, metaDir, "lock"))
}

// lockFile waits, up to lockWait, for the lock on a file only pandocs uses for this.
func lockFile(path string) (func(), error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(lockWait)
	for {
		taken, err := tryLock(file)
		if err != nil {
			file.Close()
			return nil, err
		}
		if taken {
			return func() {
				_ = unlock(file)
				file.Close()
			}, nil
		}
		if time.Now().After(deadline) {
			file.Close()
			return nil, errLocked
		}
		time.Sleep(100 * time.Millisecond)
	}
}
