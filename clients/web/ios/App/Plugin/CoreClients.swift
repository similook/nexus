import Foundation
import Nexus

/// The app's two libbox command clients on the extension's command socket (AppGroup basePath,
/// command.sock): status ticks and the log stream. iOS twin of NexusPlugin.kt's statusClient and
/// logClient - hop 2 of core/docs/ipc-boundary.md.
///
/// The socket path is relative to libbox's base path, so the APP process must have run
/// nexuscore's Setup with the same App Group paths before connecting (NexusPlugin.load).
final class CoreClients {
    /// Status tick, already shaped as the plugin's StatusMessage payload.
    var onStatus: (([String: Any]) -> Void)?

    private let queue = DispatchQueue(label: "io.nexus.core-clients")
    private var statusClient: LibboxCommandClient?
    private var logClient: LibboxCommandClient?
    private var reconnect: DispatchWorkItem?

    /// The log ring, bounded like the core's own (LogMaxLines 512). Lines may name hosts: they
    /// stay in this process, are shown on the Logs screen only, and are never sent anywhere.
    private var logs: [String] = []
    private let maxLogLines = 512

    /// Connect both clients, retrying while the extension's command server comes up. Gives up
    /// after `attempts` tries; the system's VPN status still drives the UI's state.
    func connect(attempts: Int = 40) {
        queue.async { self.connectLocked(remaining: attempts) }
    }

    func disconnect() {
        queue.async {
            self.reconnect?.cancel()
            self.reconnect = nil
            try? self.statusClient?.disconnect()
            try? self.logClient?.disconnect()
            self.statusClient = nil
            self.logClient = nil
        }
    }

    func readLogs(limit: Int) -> [String] {
        queue.sync { Array(logs.suffix(max(0, limit))) }
    }

    func clearLogs() {
        queue.async { self.logs.removeAll() }
    }

    private func connectLocked(remaining: Int) {
        if statusClient == nil {
            let options = LibboxCommandClientOptions()
            options.addCommand(LibboxCommandStatus)
            options.statusInterval = 1_000_000_000 // 1 s, as on Android
            let handler = StatusHandler { [weak self] payload in self?.onStatus?(payload) }
            if let client = LibboxNewCommandClient(handler, options), (try? client.connect()) != nil {
                statusClient = client
            }
        }
        if logClient == nil {
            let options = LibboxCommandClientOptions()
            options.addCommand(LibboxCommandLog)
            let handler = LogHandler { [weak self] lines in
                guard let self else { return }
                self.queue.async {
                    self.logs.append(contentsOf: lines)
                    if self.logs.count > self.maxLogLines { self.logs.removeFirst(self.logs.count - self.maxLogLines) }
                }
            } clear: { [weak self] in
                self?.queue.async { self?.logs.removeAll() }
            }
            if let client = LibboxNewCommandClient(handler, options), (try? client.connect()) != nil {
                logClient = client
            }
        }
        guard statusClient == nil || logClient == nil, remaining > 1 else { return }
        let retry = DispatchWorkItem { [weak self] in self?.connectLocked(remaining: remaining - 1) }
        reconnect = retry
        queue.asyncAfter(deadline: .now() + 0.5, execute: retry)
    }
}

/// Status ticks only. Every other callback is unused for this client.
private final class StatusHandler: NSObject, LibboxCommandClientHandlerProtocol {
    private let emit: ([String: Any]) -> Void
    init(_ emit: @escaping ([String: Any]) -> Void) { self.emit = emit }

    func writeStatus(_ message: LibboxStatusMessage?) {
        guard let m = message else { return }
        emit([
            "trafficAvailable": m.trafficAvailable,
            "uplink": m.uplink,
            "downlink": m.downlink,
            "uplinkTotal": m.uplinkTotal,
            "downlinkTotal": m.downlinkTotal,
            "connectionsIn": m.connectionsIn,
            "connectionsOut": m.connectionsOut,
            "memory": m.memory,
            "goroutines": m.goroutines,
        ])
    }

    func connected() {}
    func disconnected(_ message: String?) {}
    func setDefaultLogLevel(_ level: Int32) {}
    func clearLogs() {}
    func writeLogs(_ messageList: (any LibboxLogIteratorProtocol)?) {}
    func writeGroups(_ message: (any LibboxOutboundGroupIteratorProtocol)?) {}
    func writeOutbounds(_ message: (any LibboxOutboundGroupItemIteratorProtocol)?) {}
    func initializeClashMode(_ modeList: (any LibboxStringIteratorProtocol)?, currentMode: String?) {}
    func updateClashMode(_ newMode: String?) {}
    func write(_ events: LibboxConnectionEvents?) {}
}

/// The log stream only.
private final class LogHandler: NSObject, LibboxCommandClientHandlerProtocol {
    private let append: ([String]) -> Void
    private let clear: () -> Void
    init(_ append: @escaping ([String]) -> Void, clear: @escaping () -> Void) {
        self.append = append
        self.clear = clear
    }

    func writeLogs(_ messageList: (any LibboxLogIteratorProtocol)?) {
        guard let list = messageList else { return }
        var lines: [String] = []
        while list.hasNext() {
            if let entry = list.next() { lines.append(entry.message) }
        }
        if !lines.isEmpty { append(lines) }
    }

    func clearLogs() { clear() }

    func connected() {}
    func disconnected(_ message: String?) {}
    func setDefaultLogLevel(_ level: Int32) {}
    func writeStatus(_ message: LibboxStatusMessage?) {}
    func writeGroups(_ message: (any LibboxOutboundGroupIteratorProtocol)?) {}
    func writeOutbounds(_ message: (any LibboxOutboundGroupItemIteratorProtocol)?) {}
    func initializeClashMode(_ modeList: (any LibboxStringIteratorProtocol)?, currentMode: String?) {}
    func updateClashMode(_ newMode: String?) {}
    func write(_ events: LibboxConnectionEvents?) {}
}
