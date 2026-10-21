import dnssd
import Foundation
import Network
import Nexus

// ============================================================================================
// TEST ALL AND TCP PING ON iOS: KEEPING THE PROBES OUT OF THE TUNNEL
//
// Android runs both in the app process, which its VpnService deny list keeps out of the tunnel.
// iOS has no such list: while our VPN is up the app's own sockets go INTO it, and its DNS is
// answered by the tunnel's fakeip (198.18.0.0/15). A probe would then measure the ACTIVE server
// instead of the one it names. So, as the desktop does for its system-wide TUN
// (core/desktop/ipc/probe.go):
//
//   - every probe connection is bound to the physical interface (NetworkPath, which excludes
//     the tunnel's utun): ProbeServersBound's bind_interface for Test All, requiredInterface
//     for TCP ping. The tunnel's includeAllNetworks is false, which is what lets a socket scoped
//     to another interface leave beside it;
//   - server names are resolved on that interface (DNSServiceGetAddrInfo scoped to its index),
//     and an answer from the fakeip range is dropped defensively.
//
// With no tunnel up nothing is bound: plain OS routing and resolution, Android's behaviour.
// Both stay user-initiated and bounded (ADR-0001 §5.2): never on a timer.
// ============================================================================================

/// HostResolver for nexuscore's probe: every answer as comma-separated IP literals, "" for none.
/// Go applies ConfigGuard's poisoned/private policy to them. Called on Go threads, blocking.
/// Never logs the host or an answer.
final class ProbeResolver: NSObject, NexuscoreHostResolverProtocol {
    /// 0: any interface (no tunnel up). Otherwise the physical interface's index.
    private let interfaceIndex: UInt32
    static let timeout: TimeInterval = 4

    init(interfaceIndex: UInt32) {
        self.interfaceIndex = interfaceIndex
    }

    func resolve(_ host: String?) -> String {
        guard let host, !host.isEmpty else { return "" }
        let lookup = Lookup()
        let queue = DispatchQueue(label: "io.nexus.probe-dns")
        var ref: DNSServiceRef?
        let flags = DNSServiceFlags(kDNSServiceFlagsTimeout | kDNSServiceFlagsReturnIntermediates)
        let families = DNSServiceProtocol(kDNSServiceProtocol_IPv4 | kDNSServiceProtocol_IPv6)
        let context = Unmanaged.passUnretained(lookup).toOpaque()
        guard DNSServiceGetAddrInfo(&ref, flags, interfaceIndex, families, host, Lookup.reply, context)
            == DNSServiceErrorType(kDNSServiceErr_NoError), let ref
        else { return "" }
        DNSServiceSetDispatchQueue(ref, queue)
        _ = lookup.done.wait(timeout: .now() + Self.timeout)
        // On the queue it was attached to: after this no callback can run.
        queue.sync { DNSServiceRefDeallocate(ref) }
        return queue.sync { lookup.answers }.filter { !Self.isFakeIP($0) }.joined(separator: ",")
    }

    /// singboxConfig.ts's fakeip block: an answer from it came from a tunnel, not a resolver.
    static func isFakeIP(_ literal: String) -> Bool {
        let parts = literal.split(separator: ".").compactMap { UInt8($0) }
        return parts.count == 4 && parts[0] == 198 && (parts[1] & 0xFE) == 18
    }

    /// One query's state, only ever touched on its queue.
    private final class Lookup {
        let done = DispatchSemaphore(value: 0)
        var answers: [String] = []
        private var seenV4 = false
        private var seenV6 = false
        private var finished = false

        static let reply: DNSServiceGetAddrInfoReply = { _, flags, _, error, _, address, _, context in
            guard let context else { return }
            Unmanaged<Lookup>.fromOpaque(context).takeUnretainedValue().handle(flags, error, address)
        }

        private func handle(_ flags: DNSServiceFlags, _ error: DNSServiceErrorType, _ address: UnsafePointer<sockaddr>?) {
            guard !finished else { return }
            let noSuchRecord = error == DNSServiceErrorType(kDNSServiceErr_NoSuchRecord)
            guard error == DNSServiceErrorType(kDNSServiceErr_NoError) || noSuchRecord else {
                finish() // timeout or a real failure: what arrived so far is the answer
                return
            }
            if let address {
                switch Int32(address.pointee.sa_family) {
                case AF_INET: seenV4 = true
                case AF_INET6: seenV6 = true
                default: break
                }
                if !noSuchRecord, flags & DNSServiceFlags(kDNSServiceFlagsAdd) != 0, let literal = Self.literal(address) {
                    answers.append(literal)
                }
            }
            // Both families answered (an address or "none") and nothing more is queued.
            if seenV4, seenV6, flags & DNSServiceFlags(kDNSServiceFlagsMoreComing) == 0 { finish() }
        }

        private func finish() {
            finished = true
            done.signal()
        }

        private static func literal(_ address: UnsafePointer<sockaddr>) -> String? {
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let length = socklen_t(address.pointee.sa_len)
            guard getnameinfo(address, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else {
                return nil
            }
            return String(cString: host)
        }
    }
}

/// ProbeHandler for nexuscore's probe: "serverProbe" per server, then one "serverProbeDone".
/// Called on Go threads, one call at a time.
final class ProbeEvents: NSObject, NexuscoreProbeHandlerProtocol {
    private let emit: (String, [String: Any]) -> Void

    init(_ emit: @escaping (String, [String: Any]) -> Void) {
        self.emit = emit
    }

    func onResult(_ runID: Int64, serverID: String?, fingerprint: String?, status: String?, delayMs: Int32) {
        emit("serverProbe", [
            "runId": runID,
            "serverId": serverID ?? "",
            "fingerprint": fingerprint ?? "",
            "status": status ?? "failed",
            "delayMs": delayMs,
        ])
    }

    func onDone(_ runID: Int64, cancelled: Bool) {
        emit("serverProbeDone", ["runId": runID, "cancelled": cancelled])
    }
}

/// tcpPing: TCP handshake time to each endpoint, name resolution included, as Android measures
/// it (NexusPlugin.kt measure()). -1 when it did not complete. Bounded: 8 at a time, 3 s each.
enum TCPPinger {
    static let timeout: TimeInterval = 3
    static let fanout = 8

    struct Target {
        let id: String
        let host: String
        let port: UInt16
    }

    /// `interface`: the physical interface to bind to; nil leaves routing to the OS, minus the
    /// tunnel's interface type. The completion runs on a background queue.
    static func run(_ targets: [Target], interface: NWInterface?, completion: @escaping ([[String: Any]]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let slots = DispatchSemaphore(value: fanout)
            let group = DispatchGroup()
            let lock = NSLock()
            var results = [Int](repeating: -1, count: targets.count)
            for (index, target) in targets.enumerated() {
                slots.wait()
                group.enter()
                measure(target, interface: interface) { ms in
                    lock.lock()
                    results[index] = ms
                    lock.unlock()
                    slots.signal()
                    group.leave()
                }
            }
            group.wait()
            completion(zip(targets, results).map { target, ms -> [String: Any] in ["id": target.id, "ms": ms] })
        }
    }

    private static func measure(_ target: Target, interface: NWInterface?, done: @escaping (Int) -> Void) {
        guard let port = NWEndpoint.Port(rawValue: target.port) else {
            done(-1)
            return
        }
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = Int(timeout)
        let parameters = NWParameters(tls: nil, tcp: tcp)
        if let interface {
            parameters.requiredInterface = interface
        } else {
            parameters.prohibitedInterfaceTypes = [.other]
        }
        let connection = NWConnection(host: NWEndpoint.Host(target.host), port: port, using: parameters)
        let queue = DispatchQueue(label: "io.nexus.tcp-ping")
        let started = DispatchTime.now()
        var finished = false
        let finish: (Int) -> Void = { ms in
            guard !finished else { return }
            finished = true
            connection.stateUpdateHandler = nil
            connection.cancel()
            done(ms)
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                finish(max(1, Int((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)))
            case .failed, .waiting:
                // Refused, unreachable, unresolvable: all the same answer to the user.
                finish(-1)
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { finish(-1) }
    }
}
