//go:build !windows

package main

import "errors"

// watchParent is Windows-only: there the desktop app starts the daemon itself until the Phase 6
// service exists (ADR-0003). Linux and macOS will run nexusd under systemd and launchd, which
// own its lifetime, so -parent has no job there and is refused rather than half-implemented.
func watchParent(int) (<-chan struct{}, error) {
	return nil, errors.New("-parent is only supported on Windows")
}
