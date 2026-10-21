import Foundation
import Network

/// The phone's own link, never the tunnel: the plugin's networkStatus (useNetworkStatus.ts), and
/// the physical interface that TCP ping and Test All bind to while the tunnel is up.
/// Push-driven by NWPathMonitor - no polling, no timer. Runs only while the UI is visible.
final class NetworkPath {
    var onChange: (([String: Any]) -> Void)?

    private var monitor: NWPathMonitor?
    private let queue = DispatchQueue(label: "io.nexus.network-path")
    private var status: [String: Any] = ["state": "unknown", "transport": "unknown"]
    private var interface: NWInterface?

    var current: [String: Any] { queue.sync { status } }

    /// The interface the phone's own traffic leaves on (en0, pdp_ip0, ...), from the last path
    /// update; nil before the first one or with no network. Kept across stop(): a stale value
    /// only makes a bound probe fail, and the next start() replaces it within milliseconds.
    var physicalInterface: NWInterface? { queue.sync { interface } }

    func start() {
        // Our tunnel's utun is an "other" interface. Excluded, the path is the physical link
        // underneath it, whether or not the tunnel is up.
        let monitor = NWPathMonitor(prohibitedInterfaceTypes: [.other])
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let status = Self.describe(path)
            self.status = status
            // By type: a physical link, never loopback or another "other" interface.
            self.interface = path.status == .satisfied
                ? path.availableInterfaces.first(where: { [.wifi, .cellular, .wiredEthernet].contains($0.type) })
                : nil
            self.onChange?(status)
        }
        queue.sync {
            self.monitor?.cancel()
            self.monitor = monitor
        }
        // A cancelled NWPathMonitor cannot be started again; each start() makes a new one.
        monitor.start(queue: queue)
    }

    func stop() {
        queue.sync {
            monitor?.cancel()
            monitor = nil
        }
    }

    static func describe(_ path: NWPath) -> [String: Any] {
        let state: String
        switch path.status {
        case .satisfied: state = "ok"
        case .unsatisfied: state = "no_network"
        case .requiresConnection: state = "unverified"
        @unknown default: state = "unknown"
        }
        let transport: String
        if path.usesInterfaceType(.wifi) {
            transport = "wifi"
        } else if path.usesInterfaceType(.cellular) {
            transport = "cellular"
        } else if path.usesInterfaceType(.wiredEthernet) {
            transport = "ethernet"
        } else {
            transport = "unknown"
        }
        return ["state": state, "transport": transport]
    }
}
