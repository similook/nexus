package ipc

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
)

// DefaultSocketPath is where the daemon listens unless told otherwise.
//
// Production paths per ADR-0003 §3 are /run/nexusd/nexusd.sock (Linux) and
// /var/run/nexusd.sock (macOS), both root-owned directories created by the installer. Those
// arrive with the service harness in Phases 5-7. Until then the default is under the user's
// temp directory so a developer can run both ends without root.
func DefaultSocketPath() string {
	switch runtime.GOOS {
	case "windows":
		// AF_UNIX on Windows is a real file on disk, not an abstract name, so it needs a
		// writable directory rather than the \\.\pipe\ namespace.
		return filepath.Join(os.TempDir(), "nexusd.sock")
	default:
		return filepath.Join(os.TempDir(), "nexusd.sock")
	}
}

// Listen binds the daemon's socket.
//
// ============================================================================================
// ONE TRANSPORT ON ALL THREE PLATFORMS, AND THE CAVEAT THAT COMES WITH IT
//
// AF_UNIX works on Windows 10 1803+ and is supported by Go's net package, verified on this
// toolchain. So the same net.Listen("unix", path) serves Linux, macOS and Windows, with no
// build tags, no named-pipe dependency, and one code path to test.
//
// ADR-0003 §3.1 specifies a named pipe with an SDDL ACL for Windows, and that is still the
// right end state — NOT because AF_UNIX fails to work, but because of what it cannot express:
//
//	PEER IDENTITY. A named pipe server can ask who connected
//	(GetNamedPipeClientProcessId, then the token). SO_PEERCRED on Linux and LOCAL_PEERCRED on
//	macOS answer the same question. A Windows AF_UNIX socket answers none of it, so the only
//	access control available is the filesystem ACL on the socket file.
//
// That is the difference between "only this user may drive the tunnel" enforced by the kernel
// on every call, and enforced once by a file permission. Good enough for a developer running
// both ends as themselves; not good enough for a LocalSystem service on a shared machine.
//
// The swap is confined to this file. Phase 6 replaces the Windows branch with a named pipe and
// adds a peer check; nothing above this line changes.
// ============================================================================================
func Listen(path string) (net.Listener, error) {
	// A stale socket file from a crashed daemon makes bind fail with "address already in
	// use", which reads as "another daemon is running" and is the wrong diagnosis. Remove it
	// first — if a live daemon really does hold it, the removal is harmless on unix (the
	// listener keeps its inode) and the subsequent bind is what would conflict.
	//
	// This is the smallest instance of the janitor problem ADR-0003 §4.3 describes: state on
	// disk outliving the process that made it.
	_ = os.Remove(path)

	if directory := filepath.Dir(path); directory != "" {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			return nil, err
		}
	}

	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}

	// 0600: owner only.
	//
	// On unix this is the actual access control — the socket file's mode is what the kernel
	// checks on connect. On Windows it is approximately meaningless (Go maps Chmod onto the
	// read-only attribute), which is the caveat above, stated again where it bites.
	if err = os.Chmod(path, 0o600); err != nil {
		_ = listener.Close()
		return nil, err
	}

	return listener, nil
}

// Dial connects a client to the daemon.
func Dial(path string) (net.Conn, error) {
	return net.Dial("unix", path)
}
