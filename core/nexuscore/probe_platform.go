package nexuscore

import (
	"context"
	"net/netip"
	"os"
	"sync/atomic"

	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/option"
	tun "github.com/sagernet/sing-tun"
	"github.com/sagernet/sing/common/control"
	"github.com/sagernet/sing/common/logger"
	"github.com/sagernet/sing/common/x/list"
)

// probePlatform is the platform the probe box runs on: none at all.
//
// The probe box (probe.go) is a second, short-lived sing-box instance inside the APP process,
// next to - never inside - the tunnel that :core runs. It has no TUN, no inbound and no
// listener, so it needs nothing from the platform; this stub exists only because box.New on
// Android otherwise reaches for netlink and the package manager, which an app is refused.
//
// Modelled on libbox's own CheckConfig stub (experimental/libbox/config.go, unexported). The
// one difference: its interface monitor STARTS (returns nil) - libbox's never starts a box, so
// its stub can afford to fail there; ours must.
//
// openInterfaceCalls counts any attempt to open a TUN through this platform. It must stay 0;
// the tests assert it.
type probePlatform struct {
	openInterfaceCalls atomic.Int32
}

var _ adapter.PlatformInterface = (*probePlatform)(nil)

func (p *probePlatform) Initialize(networkManager adapter.NetworkManager) error { return nil }

// No socket protection: the probe runs in the app process, which the VPN already excludes.
func (p *probePlatform) UsePlatformAutoDetectInterfaceControl() bool { return true }
func (p *probePlatform) AutoDetectInterfaceControl(fd int) error     { return nil }

func (p *probePlatform) UsePlatformInterface() bool { return false }

func (p *probePlatform) OpenInterface(options *tun.Options, platformOptions option.TunPlatformOptions) (tun.Tun, error) {
	p.openInterfaceCalls.Add(1)
	return nil, os.ErrInvalid
}

func (p *probePlatform) ProcessPlatformOptions(options option.TunPlatformOptions) error { return nil }

// A monitor that reports no default interface: dialers then use ordinary OS routing.
func (p *probePlatform) UsePlatformDefaultInterfaceMonitor() bool { return true }
func (p *probePlatform) CreateDefaultInterfaceMonitor(logger logger.Logger) tun.DefaultInterfaceMonitor {
	return probeInterfaceMonitor{}
}

func (p *probePlatform) UsePlatformNetworkInterfaces() bool { return false }
func (p *probePlatform) NetworkInterfaces() ([]adapter.NetworkInterface, error) {
	return nil, os.ErrInvalid
}
func (p *probePlatform) UnderNetworkExtension() bool              { return false }
func (p *probePlatform) NetworkExtensionIncludeAllNetworks() bool { return false }
func (p *probePlatform) ClearDNSCache()                           {}
func (p *probePlatform) RequestPermissionForWIFIState() error     { return nil }
func (p *probePlatform) UsePlatformWIFIMonitor() bool             { return false }
func (p *probePlatform) ReadWIFIState(ctx context.Context) adapter.WIFIState {
	return adapter.WIFIState{}
}
func (p *probePlatform) UsePlatformConnectionOwnerFinder() bool { return false }
func (p *probePlatform) FindConnectionOwner(request *adapter.FindConnectionOwnerRequest) (*adapter.ConnectionOwner, error) {
	return nil, os.ErrInvalid
}
func (p *probePlatform) UsePlatformNotification() bool                             { return false }
func (p *probePlatform) SendNotification(notification *adapter.Notification) error { return nil }
func (p *probePlatform) CancelNotification(identifier string, typeID int32) error  { return nil }
func (p *probePlatform) MyInterfaceAddress() []netip.Addr                          { return nil }
func (p *probePlatform) UsePlatformNeighborResolver() bool                         { return false }
func (p *probePlatform) StartNeighborMonitor(listener adapter.NeighborUpdateListener) error {
	return os.ErrInvalid
}
func (p *probePlatform) CloseNeighborMonitor(listener adapter.NeighborUpdateListener) error {
	return nil
}
func (p *probePlatform) UsePlatformShell() bool    { return false }
func (p *probePlatform) CheckPlatformShell() error { return nil }
func (p *probePlatform) OpenShellSession(user *adapter.PlatformUser, command string, env []string, term string, rows int32, cols int32) (adapter.ShellSession, error) {
	return nil, os.ErrInvalid
}
func (p *probePlatform) LookupSFTPServer() (string, error)     { return "", os.ErrInvalid }
func (p *probePlatform) ReadSystemSSHHostKey() ([]byte, error) { return nil, os.ErrInvalid }
func (p *probePlatform) TailscaleHostname() string             { return "" }
func (p *probePlatform) UsePlatformBridge() bool               { return false }
func (p *probePlatform) CreateBridge(options adapter.BridgeOptions) (adapter.BridgeSession, error) {
	return nil, os.ErrInvalid
}
func (p *probePlatform) LookupUser(username string) (*adapter.PlatformUser, error) {
	return nil, os.ErrInvalid
}

// probeInterfaceMonitor never watches anything and never reports an interface.
type probeInterfaceMonitor struct{}

func (probeInterfaceMonitor) Start() error                         { return nil }
func (probeInterfaceMonitor) Close() error                         { return nil }
func (probeInterfaceMonitor) DefaultInterface() *control.Interface { return nil }
func (probeInterfaceMonitor) OverrideAndroidVPN() bool             { return false }
func (probeInterfaceMonitor) AndroidVPNEnabled() bool              { return false }
func (probeInterfaceMonitor) RegisterCallback(callback tun.DefaultInterfaceUpdateCallback) *list.Element[tun.DefaultInterfaceUpdateCallback] {
	return nil
}
func (probeInterfaceMonitor) UnregisterCallback(element *list.Element[tun.DefaultInterfaceUpdateCallback]) {
}
func (probeInterfaceMonitor) RegisterMyInterface(interfaceName string) {}
func (probeInterfaceMonitor) MyInterfaces() []string                   { return nil }
