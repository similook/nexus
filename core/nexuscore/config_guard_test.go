package nexuscore

import (
	"context"
	"encoding/json"
	"net/netip"
	"strings"
	"testing"
)

type guardTestResolver map[string][]netip.Addr

func (r guardTestResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return r[host], nil
}

// The Apple path pins a server hostname exactly as ConfigGuard.kt does on Android; the rules
// themselves are desktop/guard's and tested there.
func TestGuardConfigPinsTheServer(t *testing.T) {
	config := `{
	  "inbounds": [{"type": "tun", "tag": "tun-in", "stack": "system"}],
	  "dns": {"servers": [{"type": "https", "tag": "dns-direct", "server": "1.1.1.1"}]},
	  "outbounds": [
	    {"type": "vless", "tag": "proxy", "server": "node.example.test", "server_port": 443,
	     "uuid": "00000000-0000-4000-8000-000000000000",
	     "domain_resolver": {"server": "dns-direct"}},
	    {"type": "direct", "tag": "direct"}
	  ]
	}`
	resolver := guardTestResolver{"node.example.test": {netip.MustParseAddr("203.0.113.7")}}
	guarded, err := guardConfig(context.Background(), config, resolver)
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	var root map[string]any
	if err := json.Unmarshal([]byte(guarded), &root); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if !strings.Contains(guarded, "203.0.113.7") {
		t.Errorf("the resolved address is not pinned in the guarded config")
	}
	if !strings.Contains(guarded, `"node.example.test"`) {
		t.Errorf("the hostname is gone; the outbound must keep it for SNI")
	}
}

func TestGuardConfigRefusesPoisonedAnswers(t *testing.T) {
	config := `{"outbounds": [{"type": "vless", "tag": "proxy", "server": "node.example.test", "server_port": 443}]}`
	resolver := guardTestResolver{"node.example.test": {netip.MustParseAddr("10.10.34.35")}}
	if _, err := guardConfig(context.Background(), config, resolver); err == nil {
		t.Fatal("a private answer for the server was accepted")
	}
}

func TestGuardConfigRefusesNonJSON(t *testing.T) {
	if _, err := GuardConfig("not json"); err == nil {
		t.Fatal("non-JSON accepted")
	}
}
