import Foundation
import Nexus

/// pingProxy: sing-box's URL test of the RUNNING proxy outbound, through it. Port of
/// NexusPlugin.kt's pingProxy / onPingSnapshot / finishPing; plugin.ts has the contract.
///
/// CommandClient.urlTest stores its result in the core's URL-test history, which only the
/// Outbounds stream reports. So each request opens its own Outbounds client. The stream's FIRST
/// snapshot is history: it becomes the baseline, and only then is the test dispatched. After
/// that a "proxy" entry is this test's result only if it is newer than both the request and the
/// baseline, and only if the running server has not changed meanwhile.
///
/// One test at a time. A failed test deletes its history entry instead of writing a zero, so
/// "no answer within the timeout" is the failure signal.
final class ProxyPinger {
    struct Result {
        var ok: Bool
        var delayMs: Int32 = 0
        var testedAtSec: Int64 = 0
        var discarded = false
        var silent: Bool

        var payload: [String: Any] {
            ["ok": ok, "delayMs": ok ? delayMs : 0, "testedAt": testedAtSec * 1000, "discarded": discarded]
        }
    }

    enum Failure: Error {
        case busy
        case notRunning
        case other(String)
    }

    /// The tag singboxConfig.ts gives the one proxy outbound.
    static let proxyTag = "proxy"
    // urltest's own dial deadline is shorter; the margin covers a slow relay plus one tick.
    static let timeout: TimeInterval = 12
    // How long a dispatched test can still finish inside the core: sing-box's 5 s connect
    // timeout plus its 15 s request timeout, with margin.
    static let coreMax: TimeInterval = 25

    private final class Request {
        let id: Int64
        let silent: Bool
        let requestedAtSec: Int64
        let identity: String?
        let completion: (Result) -> Void
        var baselineSec: Int64 = 0
        var dispatched = false

        init(id: Int64, silent: Bool, identity: String?, completion: @escaping (Result) -> Void) {
            self.id = id
            self.silent = silent
            requestedAtSec = Int64(Date().timeIntervalSince1970)
            self.identity = identity
            self.completion = completion
        }
    }

    private let queue = DispatchQueue(label: "io.nexus.ping")
    private let clients: CoreClients
    /// The running server's identity now, to tell a result for another server.
    private let identity: () -> String?
    private var request: Request?
    private var client: LibboxCommandClient?
    private var timeoutItem: DispatchWorkItem?
    private var busyUntil = Date.distantPast
    private var sequence: Int64 = 0

    init(clients: CoreClients, identity: @escaping () -> String?) {
        self.clients = clients
        self.identity = identity
    }

    /// Starts one test. `completion` gets the result, or a Failure when none could start.
    func ping(silent: Bool, completion: @escaping (Result?, Failure?) -> Void) {
        let identity = identity()
        queue.async { [self] in
            guard clients.isConnected else {
                completion(nil, .notRunning)
                return
            }
            if request != nil || Date() < busyUntil {
                completion(nil, .busy)
                return
            }
            sequence += 1
            let request = Request(id: sequence, silent: silent, identity: identity) { completion($0, nil) }
            self.request = request
            do {
                try connect(request.id)
            } catch {
                self.request = nil
                disconnect()
                completion(nil, .other(error.localizedDescription))
            }
        }
    }

    /// Abandons a running test (the app left the foreground): it resolves as discarded.
    func cancel() {
        queue.async { [self] in
            if let request { finish(request.id, ok: false, discarded: true) }
        }
    }

    // MARK: - On `queue`

    private func connect(_ requestId: Int64) throws {
        disconnect()
        let options = LibboxCommandClientOptions()
        options.addCommand(LibboxCommandOutbounds)
        let handler = OutboundsHandler { [weak self] testedAtSec, delay in
            // Judged on the queue, including a snapshot with no proxy entry: the first one is
            // what dispatches the test. It also keeps teardown out of the client's callback.
            self?.queue.async { self?.snapshot(requestId, testedAtSec: testedAtSec, delay: delay) }
        }
        guard let client = LibboxNewCommandClient(handler, options) else {
            throw TunnelError("url test failed")
        }
        try client.connect()
        self.client = client

        let item = DispatchWorkItem { [weak self] in
            guard let self, self.request?.id == requestId else { return }
            self.finish(requestId, ok: false)
        }
        timeoutItem = item
        queue.asyncAfter(deadline: .now() + Self.timeout, execute: item)
    }

    private func disconnect() {
        timeoutItem?.cancel()
        timeoutItem = nil
        try? client?.disconnect()
        client = nil
    }

    private func snapshot(_ requestId: Int64, testedAtSec: Int64, delay: Int32) {
        guard let request, request.id == requestId else { return }
        if !request.dispatched {
            request.baselineSec = testedAtSec
            request.dispatched = true
            busyUntil = Date().addingTimeInterval(Self.coreMax)
            clients.command({ client in try client.urlTest(Self.proxyTag) }) { [weak self] error in
                guard error != nil else { return }
                self?.queue.async { self?.finish(requestId, ok: false) }
            }
            return
        }
        // 0 is "no history entry", what a FAILED test leaves; the timeout reports that.
        guard delay > 0, testedAtSec >= request.requestedAtSec, testedAtSec > request.baselineSec else { return }
        if identity() != request.identity {
            finish(requestId, ok: false, discarded: true)
            return
        }
        finish(requestId, ok: true, delayMs: delay, testedAtSec: testedAtSec)
    }

    /// Settles a request exactly once and closes its stream.
    private func finish(_ requestId: Int64, ok: Bool, delayMs: Int32 = 0, testedAtSec: Int64 = 0, discarded: Bool = false) {
        guard let request, request.id == requestId else { return }
        self.request = nil
        // The core's test is over only when its result arrived; otherwise it may still land.
        if ok { busyUntil = .distantPast }
        disconnect()
        request.completion(Result(ok: ok, delayMs: delayMs, testedAtSec: testedAtSec, discarded: discarded, silent: request.silent))
    }
}

/// Outbounds snapshots only; every other callback is unused for this client.
private final class OutboundsHandler: NSObject, LibboxCommandClientHandlerProtocol {
    private let onSnapshot: (Int64, Int32) -> Void
    init(_ onSnapshot: @escaping (Int64, Int32) -> Void) { self.onSnapshot = onSnapshot }

    func writeOutbounds(_ message: (any LibboxOutboundGroupItemIteratorProtocol)?) {
        guard let message else { return }
        var testedAtSec: Int64 = 0
        var delay: Int32 = 0
        while message.hasNext() {
            guard let item = message.next(), item.tag == ProxyPinger.proxyTag else { continue }
            testedAtSec = item.urlTestTime
            delay = item.urlTestDelay
            break
        }
        onSnapshot(testedAtSec, delay)
    }

    func connected() {}
    func disconnected(_ message: String?) {}
    func setDefaultLogLevel(_ level: Int32) {}
    func clearLogs() {}
    func writeLogs(_ messageList: (any LibboxLogIteratorProtocol)?) {}
    func writeStatus(_ message: LibboxStatusMessage?) {}
    func writeGroups(_ message: (any LibboxOutboundGroupIteratorProtocol)?) {}
    func initializeClashMode(_ modeList: (any LibboxStringIteratorProtocol)?, currentMode: String?) {}
    func updateClashMode(_ newMode: String?) {}
    func write(_ events: LibboxConnectionEvents?) {}
}
