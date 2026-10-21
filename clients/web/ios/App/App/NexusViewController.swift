import Capacitor
import UIKit

/// Capacitor's bridge view controller with the app's own plugin registered. Main.storyboard
/// instantiates this instead of CAPBridgeViewController: a plugin compiled into the app target
/// (Plugin/NexusPlugin.swift) is not discovered automatically under SPM.
class NexusViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(NexusCorePlugin())
        #if DEBUG
            // For CI's Simulator smoke test (NexusRouter below).
            CAPLog.print("[nexus] cwd \(FileManager.default.currentDirectoryPath)")
        #endif
    }

    override open func router() -> Router {
        NexusRouter()
    }
}

/// CapacitorRouter (Capacitor 6.2.2, Router.swift) with one change. It tells a file from an SPA
/// route by URL(fileURLWithPath: path).pathExtension, and the start URL capacitor://localhost
/// has an EMPTY path, which that URL resolves against the process's working directory. With a
/// working directory such as App.app the extension is "app", the route becomes the public folder
/// itself, and the WebView fails with 'The file "public" couldn't be opened' - a blank app, as
/// CI's Simulator launch showed (its cwd line says whether this was the cause). A plain string
/// check never looks at the working directory.
struct NexusRouter: Router {
    var basePath = ""

    func route(for path: String) -> String {
        (path as NSString).pathExtension.isEmpty ? basePath + "/index.html" : basePath + path
    }
}
