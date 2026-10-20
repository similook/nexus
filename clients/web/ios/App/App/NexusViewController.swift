import Capacitor
import UIKit

/// Capacitor's bridge view controller with the app's own plugin registered. Main.storyboard
/// instantiates this instead of CAPBridgeViewController: a plugin compiled into the app target
/// (Plugin/NexusPlugin.swift) is not discovered automatically under SPM.
class NexusViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NexusCorePlugin())
    }
}
