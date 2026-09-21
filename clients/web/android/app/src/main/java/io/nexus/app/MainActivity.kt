package io.nexus.app

import android.os.Bundle
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
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

        // Below API 31 there is no system splash, and androidx's compat implementation only
        // takes over if this is called - before super.onCreate(), because it has to replace
        // the activity's theme before the first frame is drawn.
        //
        // On API 31+ the platform has already drawn its own splash from the theme by the time
        // this runs; calling it there is what installs postSplashScreenTheme, so the activity
        // does not keep the launch theme for the rest of its life.
        installSplashScreen()

        super.onCreate(savedInstanceState)
    }
}
