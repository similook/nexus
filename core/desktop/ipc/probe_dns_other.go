//go:build !windows

package ipc

import "net/netip"

// physicalDNSServers has no per-interface source outside Windows: the resolver then uses the
// system's servers, still over sockets bound to the physical interface. Desktop ships on
// Windows only; this keeps the package building elsewhere.
func physicalDNSServers(index int) []netip.Addr {
	return nil
}
