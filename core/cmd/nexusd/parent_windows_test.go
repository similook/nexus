//go:build windows

package main

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/nexus/nexus-core/desktop/ipc"
)

// The desktop app's stand-in: a copy of this test binary that lives until its stdin closes.
func TestMain(m *testing.M) {
	if os.Getenv("NEXUSD_TEST_PARENT") == "1" {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// startParent returns a live process and a function that makes it exit.
func startParent(t *testing.T) (int, func()) {
	t.Helper()
	parent := exec.Command(os.Args[0])
	parent.Env = append(os.Environ(), "NEXUSD_TEST_PARENT=1")
	stdin, err := parent.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = parent.Start(); err != nil {
		t.Fatal(err)
	}
	var ended bool
	end := func() {
		if ended {
			return
		}
		ended = true
		_ = stdin.Close()
		_ = parent.Wait()
	}
	t.Cleanup(end)
	return parent.Process.Pid, end
}

func TestWatchParentFiresOnlyWhenTheParentEnds(t *testing.T) {
	pid, end := startParent(t)

	gone, err := watchParent(pid)
	if err != nil {
		t.Fatalf("watchParent(%d): %v", pid, err)
	}

	select {
	case <-gone:
		t.Fatal("fired while the parent was still running")
	case <-time.After(300 * time.Millisecond):
	}

	end()
	select {
	case <-gone:
	case <-time.After(5 * time.Second):
		t.Fatal("did not fire within 5 s of the parent exiting")
	}
}

func TestWatchParentRefusesAProcessThatDoesNotExist(t *testing.T) {
	// Windows pids are multiples of 4 and nowhere near this; OpenProcess rejects it.
	if _, err := watchParent(0x7FFFFFFC); err == nil {
		t.Fatal("watchParent accepted a pid with no process behind it")
	}
}

// The wiring that matters: serve() with -parent returns when the app exits, through the
// graceful path, and takes its socket with it so nothing is left for the next daemon to find.
func TestServeExitsAndRemovesItsSocketWhenTheParentEnds(t *testing.T) {
	pid, end := startParent(t)

	dir := t.TempDir()
	socket := filepath.Join(dir, "d.sock")
	served := make(chan error, 1)
	go func() { served <- serve(socket, filepath.Join(dir, "state"), pid) }()

	// Up and answering: a hello proves it is the daemon, not just a file.
	deadline := time.Now().Add(5 * time.Second)
	for {
		client, err := ipc.Connect(socket, nil)
		if err == nil {
			_, err = client.Hello(2 * time.Second)
			_ = client.Close()
			if err != nil {
				t.Fatalf("connected, but no hello: %v", err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("daemon never answered on %s: %v", socket, err)
		}
		time.Sleep(50 * time.Millisecond)
	}

	end()
	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("serve returned %v; want a clean exit", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve still running 10 s after its parent exited")
	}

	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Errorf("socket file still present after exit (stat: %v)", err)
	}
}

func TestServeRefusesAParentThatIsAlreadyGone(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "d.sock")
	if err := serve(socket, filepath.Join(dir, "state"), 0x7FFFFFFC); err == nil {
		t.Fatal("serve started for a parent that does not exist")
	}
	if _, err := os.Stat(socket); !os.IsNotExist(err) {
		t.Errorf("serve bound the socket before refusing (stat: %v)", err)
	}
}
