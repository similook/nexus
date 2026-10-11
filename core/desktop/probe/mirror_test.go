package probe

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestMirrorsNexuscore keeps this package an exact copy of nexuscore's engine (see doc.go).
// The only permitted difference is the package clause.
func TestMirrorsNexuscore(t *testing.T) {
	for _, name := range []string{"probe.go", "probe_platform.go", "probe_test.go"} {
		original, err := os.ReadFile(filepath.Join("..", "..", "nexuscore", name))
		if err != nil {
			t.Fatalf("read the nexuscore original of %s: %v", name, err)
		}
		mirror, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		want := strings.Replace(normalize(original), "package nexuscore\n", "package probe\n", 1)
		if normalize(mirror) != want {
			t.Errorf("%s differs from core/nexuscore/%s beyond the package clause; re-copy it (doc.go)", name, name)
		}
	}
}

// normalize ignores line endings, which git may rewrite on checkout.
func normalize(content []byte) string {
	return strings.ReplaceAll(string(content), "\r\n", "\n")
}
