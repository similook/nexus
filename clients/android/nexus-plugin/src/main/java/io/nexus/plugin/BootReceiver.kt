package io.nexus.plugin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.VpnService
import android.util.Log

/**
 * Reconnects after boot or app update — but only if the user explicitly asked for it.
 *
 * Off by default and gated on a stored config. Auto-starting a tunnel the user did not ask
 * for is both a trust problem and a battery problem: it puts the core in memory for people
 * who may not open the app for days.
 *
 * Android 15+ restricts which foreground service types a BOOT_COMPLETED receiver may start.
 * systemExempted is permitted, but confirm on the target API — a silent failure here looks
 * exactly like "always-on stopped working after the update".
 */
internal class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> Unit
            else -> return
        }

        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_AUTO_CONNECT, false)) return

        val config = prefs.getString(KEY_LAST_CONFIG, null)
        if (config.isNullOrBlank()) {
            Log.w(TAG, "auto-connect enabled but no stored config")
            return
        }

        // Consent can be revoked while we were not running (another VPN app, or the user in
        // Settings). We cannot show the consent dialog from a receiver, so give up quietly —
        // the user will be prompted the next time they open the app.
        if (VpnService.prepare(context) != null) {
            Log.i(TAG, "VPN consent not granted; skipping auto-connect")
            return
        }

        runCatching {
            context.startForegroundService(
                Intent(context, NexusVpnService::class.java)
                    .setAction(NexusVpnService.ACTION_START)
                    .putExtra(NexusVpnService.EXTRA_CONFIG, config)
            )
        }.onFailure { Log.e(TAG, "auto-connect failed", it) }
    }

    companion object {
        private const val TAG = "NexusBoot"
        const val PREFS = "nexus.prefs"
        const val KEY_AUTO_CONNECT = "auto_connect"
        const val KEY_LAST_CONFIG = "last_config"

        fun preferences(context: Context): SharedPreferences =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }
}
