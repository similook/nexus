import Foundation
import NetworkExtension

/// The app's handle on the packet-tunnel extension: one NETunnelProviderManager, created on the
/// first Connect (that save is what shows iOS's "Allow VPN configuration" dialog, once).
///
/// iOS twin of Android's NexusVpnService start/stop path. The tunnel itself runs in the
/// extension (PacketTunnel/); this only asks the system to start or stop it and reports the
/// system's view of its state.
final class TunnelManager {
    static let shared = TunnelManager()

    private var manager: NETunnelProviderManager?

    /// The system's state of our VPN configuration, mapped to the plugin's ServiceState.
    var serviceState: String {
        guard let status = manager?.connection.status else { return "stopped" }
        return Self.serviceState(of: status)
    }

    static func serviceState(of status: NEVPNStatus) -> String {
        switch status {
        case .connected: return "started"
        case .connecting, .reasserting: return "starting"
        case .disconnecting, .disconnected, .invalid: return "stopped"
        @unknown default: return "unknown"
        }
    }

    /// Load our configuration if one exists. Called at plugin load so status is right before
    /// the user taps anything (the tunnel may be running from on-demand or a previous launch).
    func load(completion: @escaping (Error?) -> Void) {
        NETunnelProviderManager.loadAllFromPreferences { [weak self] managers, error in
            if let error { completion(error); return }
            self?.manager = managers?.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?
                .providerBundleIdentifier == TunnelOptions.extensionBundleIdentifier }
            completion(nil)
        }
    }

    /// Start the tunnel with this config. Saves the configuration first when there is none.
    func start(config: String, name: String?, completion: @escaping (Error?) -> Void) {
        // Persist before starting: the extension reads it back on an on-demand restart, where no
        // options are passed. The extension also writes it; whichever runs first wins harmlessly.
        do {
            try config.write(to: TunnelOptions.persistedConfigURL, atomically: true, encoding: .utf8)
            try (name ?? "").write(to: TunnelOptions.persistedNameURL, atomically: true, encoding: .utf8)
        } catch {
            completion(error)
            return
        }
        withSavedManager { result in
            switch result {
            case let .failure(error):
                completion(error)
            case let .success(manager):
                do {
                    var options: [String: NSObject] = [TunnelOptions.configKey: config as NSString]
                    if let name { options[TunnelOptions.nameKey] = name as NSString }
                    try manager.connection.startVPNTunnel(options: options)
                    completion(nil)
                } catch {
                    completion(error)
                }
            }
        }
    }

    func stop() {
        manager?.connection.stopVPNTunnel()
    }

    /// One request to the running extension (Shared/AppMessage.swift). Fails when no tunnel
    /// session exists or the extension does not answer; the completion runs on an arbitrary
    /// queue.
    func send(_ message: AppMessage, completion: @escaping (Error?) -> Void) {
        guard let session = manager?.connection as? NETunnelProviderSession,
              session.status != .invalid, session.status != .disconnected
        else {
            completion(TunnelError("the tunnel is not running"))
            return
        }
        do {
            try session.sendProviderMessage(JSONEncoder().encode(message)) { data in
                guard let data, let reply = try? JSONDecoder().decode(AppMessage.Reply.self, from: data) else {
                    completion(TunnelError("the tunnel did not answer"))
                    return
                }
                completion(reply.error.map { TunnelError($0) })
            }
        } catch {
            completion(error)
        }
    }

    /// Waits until the system reports the tunnel down (or `timeout` passes), then calls back on
    /// the main queue. NEVPNStatusDidChange drives it, no polling.
    func whenStopped(timeout: TimeInterval, _ completion: @escaping () -> Void) {
        guard serviceState != "stopped" else {
            DispatchQueue.main.async(execute: completion)
            return
        }
        var observer: NSObjectProtocol?
        var finished = false
        let finish = {
            guard !finished else { return }
            finished = true
            if let observer { NotificationCenter.default.removeObserver(observer) }
            completion()
        }
        observer = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: nil, queue: .main) {
            [weak self] _ in
            if self?.serviceState ?? "stopped" == "stopped" { finish() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: finish)
    }

    /// Our manager, enabled and saved. iOS requires a reload after the first save before a
    /// start succeeds ("configuration is stale"), hence the load after save.
    private func withSavedManager(_ completion: @escaping (Result<NETunnelProviderManager, Error>) -> Void) {
        let manager = self.manager ?? NETunnelProviderManager()
        if manager.protocolConfiguration == nil {
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = TunnelOptions.extensionBundleIdentifier
            // Shown in Settings > VPN. Not a server: the extension decides where to connect.
            proto.serverAddress = "Nexus VPN"
            manager.protocolConfiguration = proto
            manager.localizedDescription = "Nexus VPN"
        }
        manager.isEnabled = true
        manager.saveToPreferences { [weak self] error in
            if let error { completion(.failure(error)); return }
            manager.loadFromPreferences { error in
                if let error { completion(.failure(error)); return }
                self?.manager = manager
                completion(.success(manager))
            }
        }
    }

    /// The server the extension is running, from the config it was started with - never from
    /// the UI's selection (see plugin.ts RunningServer). Nil when nothing was ever started.
    func runningServer() -> [String: Any]? {
        guard
            let data = try? Data(contentsOf: TunnelOptions.persistedConfigURL),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let outbounds = json["outbounds"] as? [[String: Any]],
            let proxy = outbounds.first(where: { $0["tag"] as? String == "proxy" }),
            let server = proxy["server"] as? String,
            let port = proxy["server_port"] as? Int
        else { return nil }
        let name = (try? String(contentsOf: TunnelOptions.persistedNameURL, encoding: .utf8)) ?? ""
        return [
            "server": server,
            "port": port,
            "name": name.isEmpty ? NSNull() : name,
            "protocol": (proxy["type"] as? String) ?? NSNull(),
        ]
    }
}

/// A failure with a message the UI may show as is. Never carries an address or a config.
struct TunnelError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
