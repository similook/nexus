//go:build windows

package main

import (
	"fmt"
	"syscall"
)

// watchParent returns a channel that is closed when process pid ends.
//
// The desktop app starts this daemon (clients/desktop/src-tauri/src/daemon.rs) and passes its
// own pid as -parent, so that the daemon - and any tunnel it holds - cannot outlive the app. A
// process handle opened for SYNCHRONIZE is signalled when the process ends, however it ends: a
// quit, a crash, or Task Manager. Waiting on it costs a parked goroutine, not a poll.
//
// An error means the parent is already gone (or never existed), and serve() refuses to start:
// a daemon launched for an app that has exited would be an orphan from its first instant.
func watchParent(pid int) (<-chan struct{}, error) {
	handle, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil, fmt.Errorf("watch parent process %d: %w", pid, err)
	}

	gone := make(chan struct{})
	go func() {
		defer syscall.CloseHandle(handle)
		// WAIT_OBJECT_0 is the parent exiting. WAIT_FAILED on a handle we hold cannot be told
		// apart from it and is treated the same: shutting down is the safe reading.
		_, _ = syscall.WaitForSingleObject(handle, syscall.INFINITE)
		close(gone)
	}()
	return gone, nil
}
