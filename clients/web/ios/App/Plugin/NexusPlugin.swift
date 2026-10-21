import Capacitor
import Foundation
import Nexus
import NetworkExtension
import UIKit

/// The NexusCore Capacitor plugin on iOS: hop 1 of core/docs/ipc-boundary.md, the JSON bridge
/// between the WebView and native code. Mirrors clients/web/src/core/plugin.ts and Android's
/// NexusPlugin.kt; a method missing here fails at runtime, not at build time.
///
/// Every method of plugin.ts. What differs from Android, and why:
///   - Probes (tcpPing, probeServers) are bound to the physical interface while the tunnel is
///     up: iOS sends the app's own traffic into its VPN, Android excludes it (Probes.swift).
///   - fetchViaTunnel is a plain request: while connected, the app's requests already go
///     through the tunnel.
///   - reload swaps the config inside the running extension (Shared/AppMessage.swift).
///
/// No update check on iOS: getInstallInfo is unavailable, which update.ts reads as "install info
/// unavailable" before it would fetch anything. The App Store updates the app.
@objc(NexusCorePlugin)
public class NexusCorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NexusCorePlugin"
    public let jsName = "NexusCore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getNetworkStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readLogs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearLogs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLogStreaming", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInstallInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportDiagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectOutbound", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "urlTest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pingProxy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "tcpPing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probeServers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelProbe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fetchViaTunnel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setClashMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeConnections", returnType: CAPPluginReturnPromise),
    ]

    private let tunnel = TunnelManager.shared
    private let clients = CoreClients()
    private let network = NetworkPath()
    private lazy var pinger = ProxyPinger(clients: clients) { [weak self] in self?.runningIdentity() }
    private var lastStatus: [String: Any] = [:]
    private var observers: [NSObjectProtocol] = []
    /// The WebView is on screen. Streams and the network monitor run only then (R1): a hidden
    /// UI that keeps a 1 Hz subscription is a wakeup a second for nobody.
    private var uiVisible = true

    override public func load() {
        // The command socket is relative to libbox's base path: this process needs the same
        // Setup as the extension before any command client can find it (CoreClients).
        do {
            try AppGroup.prepareDirectories()
            var error: NSError?
            if !NexuscoreSetup(AppGroup.basePath, AppGroup.workingPath, AppGroup.tempPath, &error), let error {
                CAPLog.print("[nexus] core setup failed: \(error.localizedDescription)")
            }
        } catch {
            CAPLog.print("[nexus] app group directories: \(error.localizedDescription)")
        }

        clients.onStatus = { [weak self] status in
            guard let self else { return }
            self.lastStatus = status
            self.notifyListeners("status", data: status)
        }
        network.onChange = { [weak self] status in self?.notifyListeners("networkStatus", data: status) }
        network.start()

        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: .NEVPNStatusDidChange, object: nil, queue: .main) { [weak self] _ in
                self?.serviceStateChanged()
            },
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) {
                [weak self] _ in self?.uiHidden()
            },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) {
                [weak self] _ in self?.uiShown()
            },
        ]

        tunnel.load { [weak self] _ in
            DispatchQueue.main.async { self?.serviceStateChanged() }
        }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        NexuscoreCancelProbe(0)
        network.stop()
        clients.disconnect()
    }

    // MARK: - visibility (Android's handleOnResume / handleOnPause)

    private func uiShown() {
        uiVisible = true
        network.start()
        if tunnel.serviceState != "stopped" { clients.connect() }
        tunnel.send(.uiForeground(true)) { _ in }
    }

    private func uiHidden() {
        uiVisible = false
        // A Test All run is for the screen the user is looking at; it never runs on in the
        // background. Its done event still reaches the UI, which drops the run.
        NexuscoreCancelProbe(0)
        pinger.cancel()
        network.stop()
        clients.disconnect()
        tunnel.send(.uiForeground(false)) { _ in }
    }

    private func serviceStateChanged() {
        let state = tunnel.serviceState
        if state == "started" {
            if uiVisible { clients.connect() }
        } else if state == "stopped" {
            clients.disconnect()
            lastStatus = [:]
        }
        notifyListeners("serviceState", data: [
            "state": state,
            "runningServer": state == "stopped" ? NSNull() : (tunnel.runningServer() ?? NSNull()),
        ])
    }

    // MARK: - lifecycle

    @objc func start(_ call: CAPPluginCall) {
        guard let config = call.getString("config"), !config.isEmpty else {
            call.reject("config is required")
            return
        }
        tunnel.start(config: config, name: call.getString("name")) { error in
            if let error {
                // The user declining the VPN permission lands here too; the message is the system's.
                call.reject(error.localizedDescription)
            } else {
                call.resolve()
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        tunnel.stop()
        call.resolve()
    }

    /// Swaps the config inside the running extension (Service.Reload, as Android's ACTION_RELOAD):
    /// the tunnel, the command socket and the status stream survive. With no tunnel up it is a
    /// start. If the extension cannot take the message, it falls back to stop, wait until the
    /// system reports the tunnel down, start.
    @objc func reload(_ call: CAPPluginCall) {
        guard let config = call.getString("config"), !config.isEmpty else {
            call.reject("config is required")
            return
        }
        let name = call.getString("name")
        guard tunnel.serviceState == "started" else {
            start(call)
            return
        }
        tunnel.send(.reload(config: config, name: name)) { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if error == nil {
                    // The running server changed; the UI reads it from serviceState.
                    self.serviceStateChanged()
                    call.resolve()
                    return
                }
                self.tunnel.stop()
                self.tunnel.whenStopped(timeout: 10) {
                    self.tunnel.start(config: config, name: name) { error in
                        if let error { call.reject(error.localizedDescription) } else { call.resolve() }
                    }
                }
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        var snapshot = lastStatus
        let state = tunnel.serviceState
        snapshot["state"] = state
        snapshot["runningServer"] = state == "stopped" ? NSNull() : (tunnel.runningServer() ?? NSNull())
        call.resolve(snapshot)
    }

    @objc func getNetworkStatus(_ call: CAPPluginCall) {
        call.resolve(network.current)
    }

    // MARK: - logs

    @objc func readLogs(_ call: CAPPluginCall) {
        call.resolve(["lines": clients.readLogs(limit: call.getInt("limit") ?? 200)])
    }

    @objc func clearLogs(_ call: CAPPluginCall) {
        clients.clearLogs()
        call.resolve()
    }

    /// The log client streams while the tunnel runs; there is no separate switch to flip yet.
    @objc func setLogStreaming(_ call: CAPPluginCall) {
        call.resolve()
    }

    // MARK: - install info

    @objc func getInstallInfo(_ call: CAPPluginCall) {
        call.unavailable("The App Store updates this app; there is no in-app update check on iOS.")
    }

    // MARK: - diagnostics (bench/B-03 stage 2, ios-plan/DEVICE-SESSION.md)

    /// Share sheet with one text file: build and device facts, then the extension's memory
    /// samples. No log lines and no server details - it is meant to be sent to the developers.
    @objc func exportDiagnostics(_ call: CAPPluginCall) {
        let samples = (try? String(contentsOf: TunnelOptions.memoryLogURL, encoding: .utf8)) ?? ""
        let info = Bundle.main.infoDictionary ?? [:]
        var machine = utsname()
        uname(&machine)
        let model = withUnsafeBytes(of: &machine.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        let header = [
            "# Nexus B-03 device diagnostics",
            "app \(info["CFBundleShortVersionString"] ?? "?") (\(info["CFBundleVersion"] ?? "?"))",
            "core \(NexuscoreVersion())",
            "device \(model), iOS \(UIDevice.current.systemVersion)",
            "exported \(ISO8601DateFormatter().string(from: Date()))",
            "columns: unix_ms os_proc_available_memory_bytes go_held_bytes",
            "samples \(samples.split(separator: "\n").count)",
            "",
        ].joined(separator: "\n")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nexus-b03-diagnostics.txt")
        do {
            try (header + samples).write(to: url, atomically: true, encoding: .utf8)
        } catch {
            call.reject(error.localizedDescription)
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let controller = self?.bridge?.viewController else {
                call.reject("no view to present from")
                return
            }
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = controller.view
            controller.present(sheet, animated: true)
            call.resolve()
        }
    }

    // MARK: - control (the status client; one-shot, never streaming)

    @objc func selectOutbound(_ call: CAPPluginCall) {
        guard let group = call.getString("group"), let outbound = call.getString("outbound") else {
            call.reject("group and outbound are required")
            return
        }
        clients.command({ try $0.selectOutbound(group, outboundTag: outbound) }, completion: settle(call))
    }

    @objc func urlTest(_ call: CAPPluginCall) {
        let group = call.getString("group") ?? ""
        clients.command({ try $0.urlTest(group) }, completion: settle(call))
    }

    @objc func setClashMode(_ call: CAPPluginCall) {
        guard let mode = call.getString("mode") else {
            call.reject("mode is required")
            return
        }
        clients.command({ try $0.setClashMode(mode) }, completion: settle(call))
    }

    @objc func closeConnections(_ call: CAPPluginCall) {
        clients.command({ try $0.closeConnections() }, completion: settle(call))
    }

    private func settle(_ call: CAPPluginCall) -> (Error?) -> Void {
        { error in
            if let error { call.reject(error.localizedDescription) } else { call.resolve() }
        }
    }

    // MARK: - latency

    /// The running proxy outbound's URL test, through it (ProxyPinger.swift).
    @objc func pingProxy(_ call: CAPPluginCall) {
        let silent = call.getBool("silent") ?? false
        pinger.ping(silent: silent) { [weak self] result, failure in
            switch failure {
            case .busy?:
                call.reject("a latency test is already running", "PING_BUSY")
            case .notRunning?:
                call.reject("core is not running")
            case let .other(message)?:
                call.reject(message)
            case nil:
                guard let result else {
                    call.reject("url test failed")
                    return
                }
                call.resolve(result.payload)
                if !result.silent, !result.discarded {
                    self?.notifyListeners("proxyDelay", data: ["delayMs": result.ok ? result.delayMs : 0, "ok": result.ok])
                }
            }
        }
    }

    /// TCP handshake time per endpoint, off the tunnel (Probes.swift).
    @objc func tcpPing(_ call: CAPPluginCall) {
        let items = call.options["targets"] as? [[String: Any]] ?? []
        let targets = items.compactMap { item -> TCPPinger.Target? in
            guard let id = item["id"] as? String, !id.isEmpty,
                  let host = item["server"] as? String, !host.isEmpty,
                  let port = (item["port"] as? NSNumber)?.intValue, (1 ... 65535).contains(port)
            else { return nil }
            return TCPPinger.Target(id: id, host: host, port: UInt16(port))
        }
        guard !targets.isEmpty else {
            call.reject("no usable targets")
            return
        }
        TCPPinger.run(targets, interface: network.physicalInterface) { results in
            call.resolve(["results": results])
        }
    }

    /// Delay for every server through its own config, in a short-lived core in this process;
    /// the tunnel is never touched (nexuscore probe.go). Results stream as serverProbe events.
    @objc func probeServers(_ call: CAPPluginCall) {
        guard let runId = (call.options["runId"] as? NSNumber)?.int64Value, runId > 0,
              let targets = call.options["targets"] as? [[String: Any]]
        else {
            call.reject("runId and targets are required")
            return
        }
        let payload: [[String: String]] = targets.compactMap { item in
            guard let id = item["id"] as? String, !id.isEmpty,
                  let config = item["config"] as? String, !config.isEmpty
            else { return nil }
            return ["id": id, "fingerprint": item["fingerprint"] as? String ?? "", "config": config]
        }
        guard !payload.isEmpty, let json = try? JSONSerialization.data(withJSONObject: payload),
              let targetsJSON = String(data: json, encoding: .utf8)
        else {
            call.reject("no usable targets")
            return
        }
        // Bound to the physical interface while a tunnel is up; refused rather than risk
        // probes through the tunnel when that interface is unknown (as the desktop does).
        var bind = ""
        var index: UInt32 = 0
        if tunnel.serviceState != "stopped" {
            guard let interface = network.physicalInterface else {
                call.reject("the tunnel has no network interface to test from right now")
                return
            }
            bind = interface.name
            index = UInt32(interface.index)
        }
        let events = ProbeEvents { [weak self] event, data in self?.notifyListeners(event, data: data) }
        let resolver = ProbeResolver(interfaceIndex: index)
        var error: NSError?
        // 0, 0: Go's defaults (6 workers, 6 s per server) are the one place those numbers live.
        guard NexuscoreProbeServersBound(runId, targetsJSON, 0, 0, bind, resolver, events, &error) else {
            call.reject("probe could not start")
            return
        }
        let route = bind.isEmpty ? "" : ", bound"
        CAPLog.print("[nexus] probe run \(runId): \(payload.count) servers\(route)")
        call.resolve(["runId": runId])
    }

    @objc func cancelProbe(_ call: CAPPluginCall) {
        NexuscoreCancelProbe((call.options["runId"] as? NSNumber)?.int64Value ?? 0)
        call.resolve()
    }

    // MARK: - fetch

    /// GET through the running tunnel. On iOS the app's own requests already go through it while
    /// connected, so this is a plain request once the tunnel is up (Android has the core fetch,
    /// its app being outside its VPN). For the once-per-launch subscription retry only.
    @objc func fetchViaTunnel(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http"
        else {
            call.reject("url must be http:// or https://")
            return
        }
        guard tunnel.serviceState == "started" else {
            call.reject("core is not running")
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        if let agent = call.getObject("headers")?["User-Agent"] as? String {
            request.setValue(agent, forHTTPHeaderField: "User-Agent")
        }
        URLSession(configuration: .ephemeral).dataTask(with: request) { data, response, error in
            guard let http = response as? HTTPURLResponse else {
                call.reject(error?.localizedDescription ?? "no answer")
                return
            }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                headers[String(describing: key)] = String(describing: value)
            }
            call.resolve([
                "status": http.statusCode,
                "data": String(decoding: data ?? Data(), as: UTF8.self),
                "headers": headers,
            ])
        }.resume()
    }

    // MARK: - helpers

    /// The running server's identity, to tell a URL-test result for another server.
    private func runningIdentity() -> String? {
        guard let server = tunnel.runningServer() else { return nil }
        let host = server["server"] as? String ?? ""
        let port = server["port"] as? Int ?? 0
        let name = server["name"] as? String ?? ""
        return "\(host):\(port)/\(name)"
    }
}
