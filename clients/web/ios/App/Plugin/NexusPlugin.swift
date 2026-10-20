import Capacitor
import Foundation
import Nexus
import NetworkExtension

/// The NexusCore Capacitor plugin on iOS: hop 1 of core/docs/ipc-boundary.md, the JSON bridge
/// between the WebView and native code. Mirrors clients/web/src/core/plugin.ts and Android's
/// NexusPlugin.kt; a method missing here fails at runtime, not at build time.
///
/// PHASE 2 (ios-plan/IOS-PLAN.md): start, stop, reload, status and service-state events, logs,
/// network status. The rest answer "unimplemented" until phase 3 - the UI already treats a
/// rejected call as "no result", as it does for any failed native call.
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
        // Phase 3:
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
    private var lastStatus: [String: Any] = [:]
    private var vpnObserver: NSObjectProtocol?

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

        vpnObserver = NotificationCenter.default.addObserver(
            forName: .NEVPNStatusDidChange, object: nil, queue: .main
        ) { [weak self] _ in self?.serviceStateChanged() }

        tunnel.load { [weak self] _ in
            DispatchQueue.main.async { self?.serviceStateChanged() }
        }
    }

    deinit {
        if let vpnObserver { NotificationCenter.default.removeObserver(vpnObserver) }
        network.stop()
        clients.disconnect()
    }

    private func serviceStateChanged() {
        let state = tunnel.serviceState
        if state == "started" {
            clients.connect()
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

    /// Phase 2: a stop and a start. The core's in-place Reload (keeping the command socket) needs
    /// an app-to-extension message, which phase 3 adds.
    @objc func reload(_ call: CAPPluginCall) {
        guard let config = call.getString("config"), !config.isEmpty else {
            call.reject("config is required")
            return
        }
        tunnel.stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.tunnel.start(config: config, name: call.getString("name")) { error in
                if let error { call.reject(error.localizedDescription) } else { call.resolve() }
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

    // MARK: - phase 3

    @objc func selectOutbound(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
    @objc func urlTest(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
    @objc func pingProxy(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
    @objc func tcpPing(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
    @objc func probeServers(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
    @objc func cancelProbe(_ call: CAPPluginCall) { call.resolve() }
    @objc func fetchViaTunnel(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
    @objc func setClashMode(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
    @objc func closeConnections(_ call: CAPPluginCall) { call.unimplemented("Not yet on iOS") }
}
