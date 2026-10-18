package tunnel

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestStoreFakeIPCacheStaysInWorkingDir pins where the fakeip table goes on desktop.
//
// From 1.3.3 the shared UI's buildConfig asks for experimental.cache_file with store_fakeip and
// no path, as on Android. sing-box resolves that to "cache.db" in the process's working
// directory - the same file a non-nil LogWriter already forces into existence (see Options). And
// nexusd's working directory is always its state directory: daemon.rs starts the unelevated
// daemon with current_dir(user_state) and the elevated one with lpDirectory = <install>\state.
// So the table is added to an existing file in the state directory, never next to the binary
// in Program Files and never in System32.
//
// No TUN and no route changes: the socks-only fixture, loopback only.
func TestStoreFakeIPCacheStaysInWorkingDir(t *testing.T) {
	var config map[string]any
	if err := json.Unmarshal([]byte(read(t, socksOnly)), &config); err != nil {
		t.Fatal(err)
	}
	config["experimental"] = map[string]any{
		"cache_file": map[string]any{"enabled": true, "store_fakeip": true},
	}
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}

	stateDir := t.TempDir()
	t.Chdir(stateDir)

	// Twice: the table must not break the stop-then-start reuse of the bbolt file.
	for round := 1; round <= 2; round++ {
		instance, err := Open(context.Background(), string(raw))
		if err != nil {
			t.Fatalf("round %d Open: %v", round, err)
		}
		if err = instance.Start(); err != nil {
			_ = instance.Close()
			t.Fatalf("round %d Start: %v", round, err)
		}
		if err = instance.Close(); err != nil {
			t.Fatalf("round %d Close: %v", round, err)
		}
	}

	if _, err := os.Stat(filepath.Join(stateDir, "cache.db")); err != nil {
		t.Fatalf("cache.db is not in the working (state) directory: %v", err)
	}
}
