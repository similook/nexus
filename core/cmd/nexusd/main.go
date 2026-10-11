// Command nexusd is the Nexus desktop daemon.
//
// ============================================================================================
// WHAT THIS IS, AND WHAT IT IS NOT YET
//
// ADR-0003 Phase 2: a walking skeleton. It reads a sing-box config, brings the tunnel up, and
// tears it down cleanly on a signal. That is the whole scope, and everything the finished
// daemon needs is deliberately absent:
//
//	no IPC             Phase 3 adds the 8-method + 3-event contract over a pipe
//	no service harness Phases 5-7 add systemd / SCM / launchd
//	no janitor         Phase 8 adds stale-route and stale-adapter recovery
//	no ConfigGuard     Phase 8 ports it from Kotlin, as a security control
//
// That last absence matters most and is called out in Usage below: this build takes a config
// from a file path on the command line, chosen by whoever is already root. The privilege
// boundary that ADR-0003 §3.4 is about — an unprivileged GUI handing a config to a privileged
// daemon — does not exist yet, and must not be opened before the guard exists.
//
// # WHY IT RUNS IN THE FOREGROUND
//
// It logs to stderr, stays attached, and exits on SIGINT. Every service manager we will use
// prefers exactly that: systemd Type=simple, Windows SCM with its own wrapper, launchd with
// no daemonisation. Nothing here should ever fork.
// ============================================================================================
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/nexus/nexus-core/desktop/ipc"
	"github.com/nexus/nexus-core/desktop/tunnel"
)

// version is stamped at link time by core/scripts/build-desktop.sh.
//
// WHY THIS IS NOT nexuscore.Version()
//
// It was, and it broke the Linux build outright:
//
//	link: github.com/sagernet/sing-box/experimental/libbox/internal/oomprofile:
//	      invalid reference to runtime/pprof.parseProcSelfMaps
//
// nexuscore imports libbox, so importing nexuscore for one string pulled all of libbox in -
// including a package that //go:linkname's into the runtime and needs -checklinkname=0 to
// link. The Android build passes that flag; a desktop build should not have to, because it
// should not contain libbox at all.
//
// That link error was useful. It is the build system noticing what the package comment in
// desktop/tunnel argues: the mobile path and the desktop path share sing-box, not libbox.
// Taking the flag to silence it would have kept ~3 packages of dead mobile plumbing linked
// into a daemon that can never call them.
//
// The cost is that this constant and nexuscore's appVersion are two strings that must be kept
// in step. docs/RELEASE.md is where that belongs when the desktop client starts shipping.
var version = "0.1.0"

const usage = `nexusd - the Nexus desktop daemon (ADR-0003 Phase 2)

Usage:
  nexusd serve  [-s <socket>] [-state <dir>] [-parent <pid>]
                                    listen for clients and own the tunnel; with -parent,
                                    exit when that process does (Windows)
  nexusd run    -c <config.json>    bring the tunnel up until interrupted
  nexusd check  -c <config.json>    validate a config and exit; needs no privileges
  nexusd version

"serve" is the real daemon: the GUI and nexusctl connect to it. "run" is the Phase 2
walking skeleton, kept because it is the shortest path to "does the tunnel work at all"
with nothing else in the way.

"run" needs elevated privileges, because creating a TUN device and changing the routing
table do:

  Linux    sudo ./nexusd run -c config.json
           (or setcap cap_net_admin,cap_net_raw+eip ./nexusd)
  macOS    sudo ./nexusd run -c config.json
  Windows  run from an Administrator console, with wintun.dll beside the binary

"check" needs none, and is the right first command on a new machine.

WARNING: "run" with a tun inbound takes over this machine's default route for as long as it
is running. Interrupt it (Ctrl-C) to restore. There is no crash recovery yet - if this
process is killed with SIGKILL while connected, stale routes may survive it (ADR-0003 §4.3,
Phase 8).
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	command := os.Args[1]
	flags := flag.NewFlagSet(command, flag.ExitOnError)
	configPath := flags.String("c", "", "path to a sing-box config JSON file")
	flags.StringVar(configPath, "config", "", "path to a sing-box config JSON file")

	socketPath := flags.String("s", ipc.DefaultSocketPath(), "IPC socket path")
	stateDir := flags.String("state", "", "directory the daemon may write to (default: alongside the socket)")
	parentPID := flags.Int("parent", 0, "exit, stopping any tunnel, when this process ends (Windows)")

	switch command {
	case "serve":
		_ = flags.Parse(os.Args[2:])
		exit(serve(*socketPath, *stateDir, *parentPID))
	case "run":
		_ = flags.Parse(os.Args[2:])
		exit(run(*configPath))
	case "check":
		_ = flags.Parse(os.Args[2:])
		exit(check(*configPath))
	case "version":
		fmt.Printf("nexusd %s (%s/%s, %s)\n",
			version, runtime.GOOS, runtime.GOARCH, runtime.Version())
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func exit(err error) {
	if err == nil {
		return
	}
	fmt.Fprintln(os.Stderr, "nexusd: "+err.Error())
	os.Exit(1)
}

func check(configPath string) error {
	configJSON, err := readConfig(configPath)
	if err != nil {
		return err
	}

	if err = tunnel.Check(context.Background(), configJSON); err != nil {
		return err
	}

	fmt.Println("config is valid")
	return nil
}

func run(configPath string) error {
	configJSON, err := readConfig(configPath)
	if err != nil {
		return err
	}

	// Signals are trapped BEFORE the tunnel exists.
	//
	// Not tidiness - a correctness requirement. Start() installs routes partway through, and
	// if a Ctrl-C between "routes installed" and "handler registered" landed on the default
	// SIGINT disposition, the process would die instantly with the routing table still
	// pointing at a tun device that no longer has an owner. Registering first means every
	// interrupt from now on reaches the teardown path.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	instance, err := tunnel.Open(context.Background(), configJSON)
	if err != nil {
		return err
	}

	started := time.Now()
	if err = instance.Start(); err != nil {
		// Close the constructed-but-unstarted instance. box.New allocates real resources
		// (listeners, the cache-file lock), and a partial start leaves some of them held.
		// Dropping the reference instead would leak the bbolt flock on cache.db and make the
		// NEXT start fail with "initialize cache-file: timeout" - the mobile bug, reproduced
		// by tidiness rather than by concurrency.
		_ = instance.Close()
		return err
	}

	fmt.Fprintf(os.Stderr, "nexusd: tunnel up in %s. Ctrl-C to stop.\n",
		time.Since(started).Round(time.Millisecond))

	received := <-signals
	fmt.Fprintf(os.Stderr, "nexusd: %s received, tearing down...\n", received)

	// A SECOND signal must not kill us mid-teardown.
	//
	// The reflex when something looks stuck is to press Ctrl-C again, and the default
	// disposition would grant it - terminating the process with routes still installed, which
	// is precisely the state the user was trying to get out of. So the handler stays
	// registered and the second signal is consumed and reported.
	go func() {
		for range signals {
			fmt.Fprintln(os.Stderr,
				"nexusd: still tearing down - interrupting again would leave stale routes behind")
		}
	}()

	if err = instance.Close(); err != nil {
		if errors.Is(err, tunnel.ErrCloseTimeout) {
			return fmt.Errorf(
				"%w. Routes and the tun device may still be installed; "+
					"check with `ip route` (Linux), `route print` (Windows) or `netstat -rn` (macOS)",
				err)
		}
		return err
	}

	fmt.Fprintln(os.Stderr, "nexusd: stopped cleanly")
	return nil
}

// serve runs the daemon: own the socket, own the tunnel, outlive every client.
//
// THE TUNNEL IS NOT TORN DOWN WHEN A CLIENT DISCONNECTS. A GUI that quits, crashes, or closes
// to the tray must not take a user's VPN with it - on desktop the window and the tunnel have
// genuinely independent lifetimes, which is the whole reason this is a daemon rather than a
// library the GUI links. Only an explicit stop, or the daemon exiting, ends it.
//
// With -parent the daemon belongs to the desktop app that started it, and exits when that app
// does - through the same path as a signal, so the tunnel is stopped and the socket removed.
// The window closing is not the app exiting (it hides to the tray); quitting or a crash is.
func serve(socketPath, stateDir string, parentPID int) error {
	if stateDir == "" {
		stateDir = filepath.Dir(socketPath)
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}

	// Signals trapped before the listener exists, for the same reason as in run(): the window
	// between "we own something" and "we can clean it up" must not exist.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)

	// Before the listener too: a parent that is already gone means nobody will ever drive or
	// stop this daemon, so it must not take the socket. nil (no -parent) never fires.
	var parentGone <-chan struct{}
	if parentPID != 0 {
		gone, err := watchParent(parentPID)
		if err != nil {
			return err
		}
		parentGone = gone
	}

	listener, err := ipc.Listen(socketPath)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", socketPath, err)
	}
	defer listener.Close()

	server := ipc.NewServer(ipc.ServerOptions{StateDir: stateDir, Version: version})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	served := make(chan error, 1)
	go func() { served <- server.Serve(ctx, listener) }()

	fmt.Fprintf(os.Stderr, "nexusd: listening on %s (protocol v%d)\n", socketPath, ipc.Protocol)
	fmt.Fprintf(os.Stderr, "nexusd: state dir %s\n", stateDir)

	select {
	case received := <-signals:
		fmt.Fprintf(os.Stderr, "nexusd: %s received, shutting down...\n", received)
	case <-parentGone:
		fmt.Fprintf(os.Stderr, "nexusd: parent process %d has exited, shutting down...\n", parentPID)
	case err = <-served:
		if err != nil {
			return fmt.Errorf("serve: %w", err)
		}
	}

	cancel()

	// Stop the tunnel LAST and unconditionally. A daemon exiting with routes still installed
	// is the failure ADR-0003 §4.3 is about, and it is worse than a slow shutdown.
	if err = server.Shutdown(); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	_ = os.Remove(socketPath)
	fmt.Fprintln(os.Stderr, "nexusd: stopped cleanly")
	return nil
}

func readConfig(path string) (string, error) {
	if path == "" {
		return "", errors.New("no config: pass -c <config.json>")
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read config: %w", err)
	}
	if len(content) == 0 {
		return "", errors.New("config file is empty")
	}
	return string(content), nil
}
