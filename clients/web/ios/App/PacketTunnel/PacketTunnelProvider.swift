// The start flow (config from the start options, persisted for restarts that pass none) follows
// sing-box for Apple, https://github.com/SagerNet/sing-box-for-apple, commit
// 008f73fc6d576aced976659d6dc52a9a12365c24, Library/Network/ExtensionProvider.swift.
// Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>
// Licensed under the GNU General Public License, version 3 or (at your option) any later version.
// Modified for Nexus, 2026-10-21: runs nexuscore.Service instead of libbox's command server
// directly, uses nexuscore.Setup (libbox v1.14.0 has no RedirectStderr or SetMemoryLimit), and
// maps sleep/wake to nexuscore's power policy.

import Foundation
import NetworkExtension
import Nexus // Nexus.xcframework (gomobile): Libbox* and Nexuscore*
import os

/// The packet-tunnel extension (io.nexus.app.tunnel): runs nexuscore.Service, which is
/// sing-box via libbox, for the app (ios-plan/phase2-design.md §1).
///
/// The app talks to it through libbox's command server on the unix socket in the App Group
/// (AppGroup.basePath/command.sock), the same channel Android uses. Nothing here talks to the UI.
///
/// Logging: lifecycle words only. Never the config, a server name, an address or an error text
/// that may carry one (Logger fields are .private where they could).
final class PacketTunnelProvider: NEPacketTunnelProvider {
    private let log = Logger(subsystem: "io.nexus.app.tunnel", category: "tunnel")
    /// Start, stop, sleep and wake run here, one at a time.
    private let lifecycle = DispatchQueue(label: "io.nexus.app.tunnel.lifecycle", qos: .userInitiated)

    private var service: NexuscoreService?
    private var platform: ExtensionPlatformInterface?

    /// nexuscore.Setup must run exactly once per process (core/nexuscore/nexuscore.go), and the
    /// system can start several tunnels in one extension process.
    private static var didSetup = false

    #if NEXUS_B03
        private var memorySampler: MemorySampler?
    #endif

    // MARK: - Start

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        lifecycle.async { [self] in
            do {
                let config = try resolveConfig(options)
                try AppGroup.prepareDirectories()
                try setupOnce()

                // Order matters (phase2-design.md §2.4): Setup first, then NewService, which sets
                // the 40 MiB GOMEMLIMIT for the extension (runtime.go). Nothing may call libbox's
                // ReloadSetupOptions afterwards, or the limit goes back to unlimited.
                let platform = ExtensionPlatformInterface(provider: self)
                let guarded = try Self.guarded(config)
                var error: NSError?
                guard let service = NexuscoreNewService(guarded, platform, &error) else {
                    throw error ?? PlatformError("the core could not be created")
                }
                // Held before start(), so a start that fails is still closed by stopCore below.
                self.platform = platform
                self.service = service
                // openTun runs inside start(), on this queue's thread.
                try service.start()
                platform.service = service

                #if NEXUS_B03
                    let sampler = MemorySampler(url: TunnelOptions.memoryLogURL)
                    sampler.start()
                    memorySampler = sampler
                #endif

                log.info("tunnel started")
                completionHandler(nil)
            } catch {
                log.error("tunnel start failed: \(Self.redacted(error), privacy: .private)")
                stopCore()
                completionHandler(PlatformError(Self.redacted(error)))
            }
        }
    }

    /// The config to run: from the start options (the app's Connect), or the copy persisted by
    /// the last start (an on-demand or system restart passes no options).
    private func resolveConfig(_ options: [String: NSObject]?) throws -> String {
        if let config = options?[TunnelOptions.configKey] as? String, !config.isEmpty {
            try persist(config, name: options?[TunnelOptions.nameKey] as? String)
            return config
        }
        guard let data = try? Data(contentsOf: TunnelOptions.persistedConfigURL),
              let config = String(data: data, encoding: .utf8),
              !config.isEmpty
        else {
            throw PlatformError("no server is configured")
        }
        return config
    }

    private func persist(_ config: String, name: String?) throws {
        // Readable after the first unlock, so an on-demand start after a reboot can use it.
        let protection: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        try Data(config.utf8).write(to: TunnelOptions.persistedConfigURL, options: protection)
        if let name, !name.isEmpty {
            try Data(name.utf8).write(to: TunnelOptions.persistedNameURL, options: protection)
        } else {
            try? FileManager.default.removeItem(at: TunnelOptions.persistedNameURL)
        }
    }

    /// ConfigGuard (nexuscore/config_guard.go): the policy rewrites, and the proxy server's
    /// hostname resolved here, checked and pinned - the core alone would look it up over DoH,
    /// which the networks this client is for reset. Runs before every NewService and Reload,
    /// as ConfigGuard.kt does on Android.
    private static func guarded(_ config: String) throws -> String {
        var error: NSError?
        let guarded = NexuscoreGuardConfig(config, &error)
        if let error { throw error }
        return guarded
    }

    private func setupOnce() throws {
        guard !Self.didSetup else { return }
        var error: NSError?
        if !NexuscoreSetup(AppGroup.basePath, AppGroup.workingPath, AppGroup.tempPath, &error) {
            throw error ?? PlatformError("core setup failed")
        }
        Self.didSetup = true
    }

    // MARK: - Stop

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        lifecycle.async { [self] in
            log.info("tunnel stopping, reason \(reason.rawValue, privacy: .public)")
            stopCore()
            completionHandler()
        }
    }

    /// Closes the core and everything started with it. Safe to call twice. Runs on `lifecycle`.
    private func stopCore() {
        #if NEXUS_B03
            memorySampler?.stop()
            memorySampler = nil
        #endif
        if let service {
            // Close waits for the core to release cache.db (service.go), so the next start
            // does not race the file lock.
            do {
                try service.close()
            } catch {
                log.error("core close failed: \(Self.redacted(error), privacy: .private)")
            }
        }
        service = nil
        platform?.service = nil
        platform?.closeMonitors()
        platform = nil
    }

    // MARK: - Power

    /// The device is going to sleep. The extension gets no screen signal on iOS, so this alone
    /// drives the idle side of nexuscore's power policy (ipc-boundary.md §6).
    override func sleep(completionHandler: @escaping () -> Void) {
        lifecycle.async { [self] in
            service?.setDeviceIdle(true)
            completionHandler()
        }
    }

    override func wake() {
        lifecycle.async { [self] in
            service?.setDeviceIdle(false)
        }
    }

    // MARK: - App messages

    /// Shared/AppMessage.swift. Status, logs and URL tests go through the command socket; this
    /// carries only what that socket cannot.
    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        lifecycle.async { [self] in
            var reply = AppMessage.Reply()
            do {
                let message = try JSONDecoder().decode(AppMessage.self, from: messageData)
                switch message.op {
                case .reload:
                    guard let config = message.config, !config.isEmpty else {
                        throw PlatformError("config is required")
                    }
                    guard let service else { throw PlatformError("the tunnel is not running") }
                    try service.reload(Self.guarded(config))
                    // What an on-demand or system restart runs from now on.
                    try persist(config, name: message.name)
                    log.info("config reloaded")
                case .uiForeground:
                    service?.setUIForeground(message.on ?? false)
                }
            } catch {
                log.error("app message failed: \(Self.redacted(error), privacy: .private)")
                reply.error = Self.redacted(error)
            }
            completionHandler?(try? JSONEncoder().encode(reply))
        }
    }

    // MARK: - Errors

    /// An error's text with addresses masked, for the system's "could not connect" path and the
    /// log. Go errors can name the server ("dial tcp <ip>:<port>: …").
    private static func redacted(_ error: Error) -> String {
        var text = error.localizedDescription
        let patterns = [
            #"\[[0-9A-Fa-f:.%]+\](:\d+)?"#,                       // [IPv6]:port
            #"\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b"#,                  // IPv4[:port]
            #"\b([A-Za-z0-9-]+\.)+[A-Za-z]{2,}(:\d+)?\b"#,         // host.name[:port]
        ]
        for pattern in patterns {
            text = text.replacingOccurrences(of: pattern, with: "[redacted]", options: .regularExpression)
        }
        return text
    }
}
