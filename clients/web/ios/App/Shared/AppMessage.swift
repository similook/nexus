import Foundation

/// One-shot requests from the app to the running extension, over
/// NETunnelProviderSession.sendProviderMessage -> PacketTunnelProvider.handleAppMessage
/// (phase2-design.md §2: the side channel beside the command socket). JSON both ways.
///
/// Only what the command socket cannot carry goes here: libbox's command server has no
/// in-place config swap and no UI-visibility signal, which nexuscore.Service has.
///
/// Never logged: a reload carries the whole config, server credentials included.
struct AppMessage: Codable {
    enum Op: String, Codable {
        /// Swap the running config in place (nexuscore Service.Reload): the tunnel, the command
        /// socket and the app's status stream survive, as on Android's ACTION_RELOAD.
        case reload
        /// The app's UI became visible or hidden (nexuscore Service.SetUIForeground).
        case uiForeground
    }

    var op: Op
    var config: String?
    var name: String?
    var on: Bool?

    static func reload(config: String, name: String?) -> AppMessage {
        AppMessage(op: .reload, config: config, name: name, on: nil)
    }

    static func uiForeground(_ on: Bool) -> AppMessage {
        AppMessage(op: .uiForeground, config: nil, name: nil, on: on)
    }

    /// The extension's answer: nil error means done.
    struct Reply: Codable {
        var error: String?
    }
}
