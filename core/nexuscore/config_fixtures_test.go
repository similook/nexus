package nexuscore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sagernet/sing-box/experimental/libbox"
)

// TestGeneratedConfigsPass runs every config the TypeScript assembler can produce through
// libbox.CheckConfig - the same validator ConfigGuard calls on device.
//
// WHY: every protocol gap so far was found by building an APK, installing it, connecting, and
// inferring a schema mistake from a runtime symptom three layers away. That is hours per
// protocol, and it only ever covered the one protocol a test node happened to use. This covers
// every supported link shape in seconds.
//
// Run it through the wrapper, which regenerates the fixtures and supplies the build tags:
//
//	./core/scripts/check-configs.sh
//
// THE BUILD TAGS MATTER. `go test ./nexuscore/` with no tags links a core without QUIC or uTLS,
// so Hysteria2, TUIC and every REALITY fixture fail with "not included in this build" - which
// says nothing about the config and everything about the test binary. The wrapper reads the
// tags from build-android.sh so this can never validate against a different core than the AAR.
//
// A failure here means the app would build that config and the core would refuse it - which on
// device looks like "connects and carries nothing", not like a config error.
func TestGeneratedConfigsPass(t *testing.T) {
	dir := filepath.Join("..", "testdata", "configs")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read fixtures: %v (run the emitter - see the doc comment)", err)
	}

	var found int
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		found++

		name := strings.TrimSuffix(entry.Name(), ".json")
		t.Run(name, func(t *testing.T) {
			content, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				t.Fatalf("read: %v", err)
			}
			if err := libbox.CheckConfig(string(content)); err != nil {
				t.Errorf("core rejects this config:\n  %v\n\nconfig:\n%s", err, content)
			}
		})
	}

	// An empty fixture directory would make this test pass while checking nothing, which is
	// worse than no test at all.
	if found == 0 {
		t.Fatal("no fixtures found - the emitter did not run")
	}
}
