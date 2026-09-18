package io.nexus.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import io.nexus.plugin.NexusPlugin

class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // registerPlugin MUST precede super.onCreate().
        //
        // The Capacitor bridge is constructed inside super.onCreate(); a plugin registered
        // afterwards is invisible to the WebView, and every call from JS rejects with
        // "NexusCore does not have an implementation" — which reads like a build problem and
        // is not one.
        //
        // Capacitor auto-registers plugins that arrive as npm packages. Ours lives in the app
        // module, so it has to be registered by hand.
        registerPlugin(NexusPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
