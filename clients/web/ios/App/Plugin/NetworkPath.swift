import Foundation
import Network

/// The phone's own link, never the tunnel: the plugin's networkStatus (useNetworkStatus.ts).
/// Push-driven by NWPathMonitor - no polling, no timer.
final class NetworkPath {
    var onChange: (([String: Any]) -> Void)?

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "io.nexus.network-path")
    private(set) var current: [String: Any] = ["state": "unknown", "transport": "unknown"]

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let status = Self.describe(path)
            self.current = status
            self.onChange?(status)
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor.cancel()
    }

    /// While our VPN is up the default path is the tunnel (an "other" interface); the transport
    /// reported is the physical one underneath it.
    static func describe(_ path: NWPath) -> [String: Any] {
        let state: String
        switch path.status {
        case .satisfied: state = "ok"
        case .unsatisfied: state = "no_network"
        case .requiresConnection: state = "unverified"
        @unknown default: state = "unknown"
        }
        let transport: String
        if path.availableInterfaces.contains(where: { $0.type == .wifi }) {
            transport = "wifi"
        } else if path.availableInterfaces.contains(where: { $0.type == .cellular }) {
            transport = "cellular"
        } else if path.availableInterfaces.contains(where: { $0.type == .wiredEthernet }) {
            transport = "ethernet"
        } else {
            transport = "unknown"
        }
        return ["state": state, "transport": transport]
    }
}
