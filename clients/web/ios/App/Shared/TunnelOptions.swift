import Foundation

/// What the app hands the extension to start a tunnel, and what the extension keeps so that an
/// on-demand or system restart (no options passed) runs the same server.
///
/// The config is the JSON clients/web generates (singboxConfig.ts) - the same string Android's
/// NexusVpnService receives. Never logged: it carries server addresses and credentials.
enum TunnelOptions {
    /// NETunnelProviderSession.startTunnel(options:) keys.
    static let configKey = "configContent"
    static let nameKey = "serverName"

    /// The last started config, inside the App Group, readable by the extension only through
    /// the container. Overwritten on every start; deleted never (a restart needs it).
    static var persistedConfigURL: URL { AppGroup.containerURL.appendingPathComponent("tunnel-config.json") }
    static var persistedNameURL: URL { AppGroup.containerURL.appendingPathComponent("tunnel-name.txt") }

    /// The extension's memory samples for bench/B-03 stage 2 (device), one line per sample:
    /// "<unix ms> <os_proc_available_memory bytes> <go-held bytes>". Bounded by the writer.
    static var memoryLogURL: URL { AppGroup.containerURL.appendingPathComponent("b03-extension-memory.log") }

    /// NETunnelProviderProtocol.providerBundleIdentifier.
    static let extensionBundleIdentifier = "io.nexus.app.tunnel"
}
