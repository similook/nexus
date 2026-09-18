package io.nexus.plugin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Maps Android's power signals onto the three Go [nexuscore.Service] lifecycle calls.
 *
 * This class is intentionally dumb. It does no debouncing, no state tracking and no policy —
 * all of that lives in Go, in PowerController, so that the Android and Apple clients cannot
 * drift into two subtly different definitions of "idle". Kotlin's job is to translate
 * platform events and forward them.
 *
 * Registered from inside NexusVpnService, which runs in the :core process. That matters:
 * screen events fire many times a day, and routing them through a cross-process hop would
 * mean a binder transaction — and therefore a wakeup — for each one. Registering here keeps
 * the path in-process: broadcast -> JNI -> PowerController.
 *
 * ACTION_SCREEN_ON/OFF cannot be declared in the manifest. The platform refuses to deliver
 * them to manifest receivers specifically so that it does not have to wake every installed
 * app twice per screen toggle. Runtime registration is the only option, and it is also the
 * one we want: the receiver only exists while the tunnel is up.
 */
internal class PowerReceiver(
    private val onScreenOn: (Boolean) -> Unit,
    private val onDeviceIdle: (Boolean) -> Unit,
) : BroadcastReceiver() {

    private var registered = false

    fun register(context: Context) {
        if (registered) return

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            // Doze. This is the signal that actually justifies tearing the tunnel down —
            // the platform has already waited far longer than our own idleGrace before
            // firing it.
            addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED)
            // Battery saver. Not a pause trigger: the user may well have battery saver on
            // all day with the screen on. We forward it as information only; see below.
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        }

        // RECEIVER_NOT_EXPORTED is required from API 33+ for non-system broadcasts and is
        // harmless for the protected system broadcasts we register here. ContextCompat picks
        // the right overload per API level.
        ContextCompat.registerReceiver(
            context,
            this,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        registered = true

        // Seed the initial state. The service can start while the screen is already off
        // (always-on VPN, boot, a restart after a process kill), and without this the Go
        // side would sit in Active until the next screen toggle — which on an idle device
        // could be hours.
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        onScreenOn(power.isInteractive)
        onDeviceIdle(power.isDeviceIdleMode)
    }

    fun unregister(context: Context) {
        if (!registered) return
        runCatching { context.unregisterReceiver(this) }
            .onFailure { Log.w(TAG, "unregister failed", it) }
        registered = false
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_SCREEN_ON -> onScreenOn(true)

            Intent.ACTION_SCREEN_OFF -> onScreenOn(false)

            PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED -> {
                val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                // The broadcast carries no extra — you must re-read the flag.
                onDeviceIdle(power.isDeviceIdleMode)
            }

            PowerManager.ACTION_POWER_SAVE_MODE_CHANGED -> {
                // Deliberately NOT mapped to SetDeviceIdle.
                //
                // Battery saver is a user preference that can stay on for a whole day with
                // the screen on and the user actively browsing. Treating it as "device is
                // idle" would pause the tunnel out from under someone who is using it —
                // a far worse bug than the battery it would save.
                //
                // If we later want saver-specific behaviour (longer QUIC keepalives, say),
                // it belongs in Go as its own input, not folded into the idle signal.
                val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                Log.d(TAG, "power save mode = ${power.isPowerSaveMode} (informational)")
            }
        }
    }

    private companion object {
        const val TAG = "NexusPower"
    }
}
