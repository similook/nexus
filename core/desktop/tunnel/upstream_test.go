package tunnel

import (
	"context"
	"net"
	"testing"
)

// UpstreamInterface reads sing-box's own interface pick: nothing before Start or after Close,
// and while running a real interface of this machine (socks-only: loopback inbound, no tun).
func TestUpstreamInterface(t *testing.T) {
	instance, err := Open(context.Background(), read(t, socksOnly))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, ok := instance.UpstreamInterface(); ok {
		t.Error("an upstream interface before Start")
	}
	if err = instance.Start(); err != nil {
		t.Fatal(err)
	}
	if name, index, ok := instance.UpstreamInterface(); ok {
		found, err := net.InterfaceByIndex(index)
		if err != nil || found.Name != name {
			t.Errorf("upstream %q #%d is not an interface of this machine (%v)", name, index, err)
		}
	} else {
		t.Log("no default interface reported on this machine")
	}
	if err = instance.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := instance.UpstreamInterface(); ok {
		t.Error("an upstream interface after Close")
	}
}
