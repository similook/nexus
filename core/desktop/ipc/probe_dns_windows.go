package ipc

import (
	"net/netip"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// physicalDNSServers lists the DNS servers configured on the interface with this index - the
// physical one the tunnel's upstream uses - in the order Windows reports them. nil when none
// can be read. Same source and filtering as Go's own Windows resolver config
// (net/dnsconfig_windows.go), narrowed to one interface.
func physicalDNSServers(index int) []netip.Addr {
	size := uint32(15 * 1024)
	for attempt := 0; attempt < 3; attempt++ {
		buffer := make([]byte, size)
		first := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0]))
		err := windows.GetAdaptersAddresses(syscall.AF_UNSPEC,
			windows.GAA_FLAG_SKIP_UNICAST|windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST, 0, first, &size)
		if err == windows.ERROR_BUFFER_OVERFLOW {
			continue
		}
		if err != nil {
			return nil
		}
		for adapter := first; adapter != nil; adapter = adapter.Next {
			if int(adapter.IfIndex) != index && int(adapter.Ipv6IfIndex) != index {
				continue
			}
			var servers []netip.Addr
			for dns := adapter.FirstDnsServerAddress; dns != nil; dns = dns.Next {
				sockaddr, err := dns.Address.Sockaddr.Sockaddr()
				if err != nil {
					continue
				}
				switch sa := sockaddr.(type) {
				case *syscall.SockaddrInet4:
					servers = append(servers, netip.AddrFrom4(sa.Addr))
				case *syscall.SockaddrInet6:
					addr := netip.AddrFrom16(sa.Addr)
					if addr.Is6() && sa.Addr[0] == 0xfe && sa.Addr[1] == 0xc0 {
						continue // fec0::/10 site-local anycast defaults, which Go skips too
					}
					if addr.IsLinkLocalUnicast() {
						addr = addr.WithZone(strconv.Itoa(int(sa.ZoneId)))
					}
					servers = append(servers, addr)
				}
			}
			return servers
		}
		return nil
	}
	return nil
}
