// Portions of this file (openTun's network settings, the file-descriptor lookup, the default
// interface monitor and clearDNSCache) are adapted from sing-box for Apple,
// https://github.com/SagerNet/sing-box-for-apple, commit 008f73fc6d576aced976659d6dc52a9a12365c24,
// Library/Network/ExtensionPlatformInterface.swift.
// Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>
// Licensed under the GNU General Public License, version 3 or (at your option) any later version.
// Modified for Nexus, 2026-10-21: written against libbox v1.14.0's PlatformInterface (27 methods,
// GetDNSServerAddress returning an iterator), no HTTP proxy, no Wi-Fi/location, no shell or
// bridge, and the default-interface monitor feeding nexuscore's power policy.

import Foundation
import Network
import NetworkExtension
import Nexus // Nexus.xcframework (gomobile): Libbox* and Nexuscore*

/// libbox's PlatformInterface for the packet-tunnel extension (ios-plan/phase2-design.md §1).
///
/// Only the platform half: the command-server half is nexuscore.Service itself
/// (core/nexuscore/service.go: libbox.NewCommandServer(s, platform)).
///
/// Real work: openTun, the default-interface monitor, clearDNSCache, underNetworkExtension.
/// Everything else is a stub that says no, matching Android's PlatformInterfaceWrapper.kt: no
/// process lookup (iOS cannot attribute flows to apps), no Wi-Fi state (no SSID rules, so no
/// location permission), no shell, SFTP, bridge or Tailscale.
///
/// Nothing here runs per packet: the tun file descriptor goes straight to the Go core, so no
/// packet crosses into Swift (CLAUDE.md, the ~50 MB extension ceiling).
final class ExtensionPlatformInterface: NSObject, LibboxPlatformInterfaceProtocol {
    private unowned let provider: NEPacketTunnelProvider

    /// Set once the service exists, so path changes reach Service.NetworkChanged. Read from the
    /// path monitor's queue, written from the lifecycle queue: guarded.
    private let serviceLock = NSLock()
    private weak var _service: NexuscoreService?
    var service: NexuscoreService? {
        get { serviceLock.lock(); defer { serviceLock.unlock() }; return _service }
        set { serviceLock.lock(); _service = newValue; serviceLock.unlock() }
    }

    /// The last settings openTun applied, for clearDNSCache.
    private var networkSettings: NEPacketTunnelNetworkSettings?

    private var pathMonitor: NWPathMonitor?
    private let pathQueue = DispatchQueue(label: "io.nexus.app.tunnel.path", qos: .utility)

    init(provider: NEPacketTunnelProvider) {
        self.provider = provider
        super.init()
    }

    /// Called by the provider on stop, in case the core did not close the monitor itself.
    func closeMonitors() {
        pathMonitor?.cancel()
        pathMonitor = nil
    }

    // MARK: - The tunnel

    func openTun(_ options: LibboxTunOptionsProtocol?, ret0_: UnsafeMutablePointer<Int32>?) throws {
        guard let options else { throw PlatformError("openTun: no options") }
        guard let ret0_ else { throw PlatformError("openTun: no return pointer") }

        let settings = try buildSettings(options)
        try applySettings(settings)
        networkSettings = settings

        // The utun file descriptor behind packetFlow. NEPacketTunnelFlow does not expose it;
        // KVC on its socket does, on every iOS that sing-box for Apple supports. libbox's own
        // lookup (tun_darwin.go) is the fallback.
        if let fd = provider.packetFlow.value(forKeyPath: "socket.fileDescriptor") as? Int32 {
            ret0_.pointee = fd
            return
        }
        let fd = LibboxGetTunnelFileDescriptor()
        guard fd != -1 else { throw PlatformError("openTun: missing tun file descriptor") }
        ret0_.pointee = fd
    }

    private func buildSettings(_ options: LibboxTunOptionsProtocol) throws -> NEPacketTunnelNetworkSettings {
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        // The generated config always sets auto_route (singboxConfig.ts). Without it there is
        // nothing to route, and an empty settings object is still valid.
        guard options.getAutoRoute() else { return settings }

        settings.mtu = NSNumber(value: options.getMTU())

        // libbox 1.14: an iterator of addresses, not a single string.
        var dnsServers: [String] = []
        let dnsIterator = try options.getDNSServerAddress()
        while dnsIterator.hasNext() {
            dnsServers.append(dnsIterator.next())
        }
        let dnsSettings = NEDNSSettings(servers: dnsServers)
        settings.dnsSettings = dnsSettings

        // IPv4.
        let inet4 = prefixes(options.getInet4Address())
        var ipv4Routes: [NEIPv4Route] = []
        if !inet4.isEmpty {
            let ipv4 = NEIPv4Settings(addresses: inet4.map { $0.address() }, subnetMasks: inet4.map { $0.mask() })
            let routes = prefixes(options.getInet4RouteAddress())
            ipv4Routes = routes.isEmpty
                ? [NEIPv4Route.default()]
                : routes.map { NEIPv4Route(destinationAddress: $0.address(), subnetMask: $0.mask()) }
            ipv4.includedRoutes = ipv4Routes
            ipv4.excludedRoutes = prefixes(options.getInet4RouteExcludeAddress())
                .map { NEIPv4Route(destinationAddress: $0.address(), subnetMask: $0.mask()) }
            settings.ipv4Settings = ipv4
        }

        // IPv6, only when the config gives the tun an IPv6 address.
        let inet6 = prefixes(options.getInet6Address())
        if !inet6.isEmpty {
            let ipv6 = NEIPv6Settings(
                addresses: inet6.map { $0.address() },
                networkPrefixLengths: inet6.map { NSNumber(value: $0.prefix()) }
            )
            let routes = prefixes(options.getInet6RouteAddress())
            ipv6.includedRoutes = routes.isEmpty
                ? [NEIPv6Route.default()]
                : routes.map { NEIPv6Route(destinationAddress: $0.address(), networkPrefixLength: NSNumber(value: $0.prefix())) }
            ipv6.excludedRoutes = prefixes(options.getInet6RouteExcludeAddress())
                .map { NEIPv6Route(destinationAddress: $0.address(), networkPrefixLength: NSNumber(value: $0.prefix())) }
            settings.ipv6Settings = ipv6
        }

        // Without a default route the tunnel only covers some destinations; send every DNS
        // query to the tunnel's resolver anyway, as sing-box for Apple does.
        let hasDefaultRoute = ipv4Routes.contains {
            $0.destinationAddress == "0.0.0.0" && $0.destinationSubnetMask == "0.0.0.0"
        }
        if !hasDefaultRoute {
            dnsSettings.matchDomains = [""]
            dnsSettings.matchDomainsNoSearch = true
        }

        // options.isHTTPProxyEnabled(): Nexus never generates platform.http_proxy, so no
        // NEProxySettings. Add it here if that ever changes.
        return settings
    }

    private func prefixes(_ iterator: LibboxRoutePrefixIteratorProtocol?) -> [LibboxRoutePrefix] {
        guard let iterator else { return [] }
        var result: [LibboxRoutePrefix] = []
        while iterator.hasNext() {
            if let prefix = iterator.next() { result.append(prefix) }
        }
        return result
    }

    /// setTunnelNetworkSettings, waited for. libbox calls openTun synchronously from a Go
    /// thread; the completion runs on a NetworkExtension queue, so waiting here cannot deadlock.
    private func applySettings(_ settings: NEPacketTunnelNetworkSettings?) throws {
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        provider.setTunnelNetworkSettings(settings) { error in
            failure = error
            done.signal()
        }
        done.wait()
        if let failure { throw failure }
    }

    func clearDNSCache() {
        guard let networkSettings else { return }
        provider.reasserting = true
        defer { provider.reasserting = false }
        try? applySettings(nil)
        try? applySettings(networkSettings)
    }

    func underNetworkExtension() -> Bool {
        // This is what makes nexuscore pick the 40 MiB GOMEMLIMIT (runtime.go).
        true
    }

    func includeAllNetworks() -> Bool {
        false
    }

    // MARK: - Default interface monitor

    func startDefaultInterfaceMonitor(_ listener: LibboxInterfaceUpdateListenerProtocol?) throws {
        guard let listener else { return }
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        // libbox expects the first default interface before this returns.
        let first = DispatchSemaphore(value: 0)
        var delivered = false
        monitor.pathUpdateHandler = { [weak self] path in
            self?.updateDefaultInterface(listener, path)
            if !delivered {
                delivered = true
                first.signal()
            } else {
                // A real change of network: let the power policy react (Service.NetworkChanged).
                self?.service?.networkChanged()
            }
        }
        monitor.start(queue: pathQueue)
        first.wait()
    }

    private func updateDefaultInterface(_ listener: LibboxInterfaceUpdateListenerProtocol, _ path: Network.NWPath) {
        guard path.status != .unsatisfied, let interface = path.availableInterfaces.first else {
            listener.updateDefaultInterface("", interfaceIndex: -1, isExpensive: false, isConstrained: false)
            return
        }
        listener.updateDefaultInterface(
            interface.name,
            interfaceIndex: Int32(interface.index),
            isExpensive: path.isExpensive,
            isConstrained: path.isConstrained
        )
    }

    func closeDefaultInterfaceMonitor(_: LibboxInterfaceUpdateListenerProtocol?) throws {
        closeMonitors()
    }

    func getInterfaces() throws -> LibboxNetworkInterfaceIteratorProtocol {
        guard let pathMonitor else { throw PlatformError("getInterfaces: monitor not started") }
        let path = pathMonitor.currentPath
        guard path.status != .unsatisfied else { return InterfaceIterator([]) }
        let interfaces: [LibboxNetworkInterface] = path.availableInterfaces.map { nw in
            let interface = LibboxNetworkInterface()
            interface.name = nw.name
            interface.index = Int32(nw.index)
            switch nw.type {
            case .wifi: interface.type = LibboxInterfaceTypeWIFI
            case .cellular: interface.type = LibboxInterfaceTypeCellular
            case .wiredEthernet: interface.type = LibboxInterfaceTypeEthernet
            default: interface.type = LibboxInterfaceTypeOther
            }
            return interface
        }
        return InterfaceIterator(interfaces)
    }

    private final class InterfaceIterator: NSObject, LibboxNetworkInterfaceIteratorProtocol {
        private var iterator: IndexingIterator<[LibboxNetworkInterface]>
        private var current: LibboxNetworkInterface?

        init(_ interfaces: [LibboxNetworkInterface]) {
            iterator = interfaces.makeIterator()
        }

        func hasNext() -> Bool {
            current = iterator.next()
            return current != nil
        }

        func next() -> LibboxNetworkInterface? {
            current
        }
    }

    // MARK: - Stubs (no on iOS, or not used by Nexus)

    func localDNSTransport() -> LibboxLocalDNSTransportProtocol? {
        nil
    }

    func usePlatformAutoDetectControl() -> Bool {
        // The provider's own sockets already bypass its tunnel.
        false
    }

    func autoDetectControl(_: Int32) throws {}

    func useProcFS() -> Bool {
        false
    }

    func findConnectionOwner(
        _: Int32,
        sourceAddress _: String?,
        sourcePort _: Int32,
        destinationAddress _: String?,
        destinationPort _: Int32
    ) throws -> LibboxConnectionOwner {
        throw PlatformError("process lookup is not available on iOS")
    }

    func readWIFIState() -> LibboxWIFIState? {
        nil
    }

    func send(_: LibboxNotification?) throws {}

    func cancelNotification(_: String?, typeID _: Int32) throws {}

    func startNeighborMonitor(_: LibboxNeighborUpdateListenerProtocol?) throws {}

    func closeNeighborMonitor(_: LibboxNeighborUpdateListenerProtocol?) throws {}

    func registerMyInterface(_: String?) {}

    func usePlatformShell() -> Bool {
        false
    }

    func checkPlatformShell() throws {}

    func openShellSession(
        _: LibboxPlatformUser?,
        command _: String?,
        environ _: LibboxStringIteratorProtocol?,
        term _: String?,
        rows _: Int32,
        cols _: Int32
    ) throws -> LibboxShellSessionProtocol {
        throw PlatformError("shell is disabled on mobile")
    }

    func lookupUser(_: String?) throws -> LibboxPlatformUser {
        throw PlatformError("shell is disabled on mobile")
    }

    // Go: LookupSFTPServer() (string, error) and ReadSystemSSHHostKey() (string, error). A
    // non-optional string with an error out-parameter is not imported as `throws`; if the
    // generated header says otherwise, change these to `() throws -> String`.
    func lookupSFTPServer(_: NSErrorPointer) -> String {
        ""
    }

    func readSystemSSHHostKey(_: NSErrorPointer) -> String {
        ""
    }

    func tailscaleHostname() -> String {
        ""
    }

    func usePlatformBridge() -> Bool {
        false
    }

    func createBridge(_: LibboxBridgeOptions?) throws -> LibboxBridgeSessionProtocol {
        throw PlatformError("platform bridge is not used")
    }
}

/// A plain error with a fixed message. Never carries a server address or a config.
struct PlatformError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
