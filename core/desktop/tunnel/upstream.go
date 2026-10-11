package tunnel

// UpstreamInterface is the network interface this tunnel sends its OWN proxy connections on:
// the physical default interface sing-box's monitor picked (route.auto_detect_interface), never
// the tun. ok is false while the tunnel is not started or the monitor has no interface.
//
// Read-only. It exists so a Test All probe can leave over the same path the tunnel's upstream
// does (ADR-0003 §3.5): a desktop TUN is system-wide, and a socket not bound to this interface
// is captured by the tunnel - which would measure the active server instead of the one tested.
func (t *Tunnel) UpstreamInterface() (name string, index int, ok bool) {
	t.mu.Lock()
	instance, started, closed := t.instance, t.started, t.closed
	t.mu.Unlock()
	if instance == nil || !started || closed {
		return "", 0, false
	}
	monitor := instance.Network().InterfaceMonitor()
	if monitor == nil {
		return "", 0, false
	}
	upstream := monitor.DefaultInterface()
	if upstream == nil {
		return "", 0, false
	}
	return upstream.Name, upstream.Index, true
}
