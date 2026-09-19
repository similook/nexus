package io.nexus.plugin

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.annotation.RequiresApi
import org.json.JSONObject

/**
 * Quick Settings tile: connect and disconnect without opening the app.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS RUNS IN THE :core PROCESS
 *
 * The manifest declares `android:process=":core"`, the same process as NexusVpnService, and
 * that is load-bearing in two ways:
 *
 *   1. Reading state. `NexusVpnService.isRunning` is a plain static. In the default process it
 *      would always read false and the tile would show "off" over a live tunnel.
 *   2. Stopping. The tile calls `NexusVpnService.instance?.requestStop()` directly, so there is
 *      no service start to be refused and no dependence on onDestroy() timing.
 *
 * WHAT THIS TILE CAN AND CANNOT START
 *
 * It cannot read the server selected in the app - that lives in the WebView's localStorage,
 * which Kotlin has no access to. Instead the service records each config it successfully
 * starts (NexusVpnService.rememberForRelaunch), and the tile replays the most recent one.
 *
 * The consequence, which is deliberate: pick a new server in the app but never connect to it,
 * and the tile still starts the previous one. Making the tile follow the selection would mean
 * writing credentials to native storage every time the user scrolled the server list.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
@RequiresApi(Build.VERSION_CODES.N)
class NexusTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        render(NexusVpnService.isRunning)
    }

    override fun onTileAdded() {
        super.onTileAdded()
        render(NexusVpnService.isRunning)
    }

    override fun onClick() {
        super.onClick()

        if (NexusVpnService.isRunning) {
            NexusLog.d(TAG) { "tile: disconnect" }
            // Optimistic, then corrected by the service's own requestListeningState callback.
            // A tile that does not move until teardown finishes reads as an unresponsive tap.
            render(false)

            val live = NexusVpnService.instance
            if (live != null) {
                live.requestStop("tile")
            } else {
                // Flag said running but the instance is gone - the process was recycled under
                // us. Fall back rather than leaving a tunnel nobody can reach.
                runCatching { stopService(Intent(this, NexusVpnService::class.java)) }
            }
            return
        }

        val config = storedConfig()
        if (config == null) {
            // Nothing usable to replay. Opening the app is the only useful thing a tile can do
            // here - silently failing would read as a broken tile.
            NexusLog.d(TAG) { "tile: no usable stored config, opening the app" }
            openApp()
            return
        }

        // Consent can be revoked at any time (another VPN app, or Settings), and a tile cannot
        // show the system consent dialog - only an Activity can. Hand over to the app.
        if (VpnService.prepare(this) != null) {
            NexusLog.d(TAG) { "tile: VPN consent not granted, opening the app" }
            openApp()
            return
        }

        NexusLog.d(TAG) { "tile: connect" }
        render(true)

        // Cosmetic only - it names the node in the notification. Same ClassCastException risk
        // as the config read, and not worth failing a connect over.
        val name = runCatching {
            BootReceiver.preferences(this).getString(BootReceiver.KEY_LAST_NAME, null)
        }.getOrNull()

        runCatching {
            startForegroundService(
                Intent(this, NexusVpnService::class.java)
                    .setAction(NexusVpnService.ACTION_START)
                    .putExtra(NexusVpnService.EXTRA_CONFIG, config)
                    .putExtra(NexusVpnService.EXTRA_NODE_NAME, name),
            )
        }.onFailure {
            NexusLog.e(TAG, "tile: could not start the service", it)
            render(false)
        }
    }

    /**
     * The last config the service started, or null if there is nothing safe to replay.
     *
     * Three failure modes, all of which used to end the same way - a tile that flashes ACTIVE,
     * hands the service something it cannot use, and settles back to INACTIVE a second later
     * with no explanation:
     *
     *   1. `getString` THROWS. SharedPreferences is not typed at the key, so if anything ever
     *      writes a non-string under this name the read is a ClassCastException, not a null.
     *   2. The value is blank.
     *   3. The value is present but not a config. A truncated write, or a value left behind by
     *      an older build whose format has since changed.
     *
     * The shape check is deliberately shallow - `{`, parses, has outbounds. ConfigGuard does
     * the real validation in the service, and duplicating it here would be a second copy to
     * keep in step. This only has to catch "this is not a config at all".
     *
     * A bad value is DELETED rather than left in place, because it would fail identically on
     * every future tap. Losing it costs one trip through the app; keeping it costs a tile that
     * never works again.
     */
    private fun storedConfig(): String? {
        val prefs = BootReceiver.preferences(this)

        val raw = runCatching { prefs.getString(BootReceiver.KEY_LAST_CONFIG, null) }
            .getOrElse {
                NexusLog.w(TAG, "tile: stored config unreadable: ${it.message}")
                null
            }

        if (raw.isNullOrBlank()) return null

        val usable = runCatching {
            val trimmed = raw.trim()
            trimmed.startsWith("{") &&
                (JSONObject(trimmed).optJSONArray("outbounds")?.length() ?: 0) > 0
        }.getOrDefault(false)

        if (!usable) {
            NexusLog.w(TAG, "tile: stored config is not a usable config; discarding it")
            runCatching { prefs.edit().remove(BootReceiver.KEY_LAST_CONFIG).apply() }
            return null
        }

        return raw
    }

    private fun render(active: Boolean) {
        val tile: Tile = qsTile ?: return
        tile.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = LABEL
        tile.icon = Icon.createWithResource(this, io.nexus.app.R.drawable.ic_stat_nexus)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = if (active) "Connected" else "Disconnected"
        }
        tile.updateTile()
    }

    /**
     * Open the app and collapse the shade.
     *
     * The PendingIntent overload, not the Intent one: the latter is deprecated from API 31 and
     * THROWS on API 34+, so the Intent form would crash the tile on any current device.
     */
    private fun openApp() {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        val pending = PendingIntent.getActivity(
            this,
            REQUEST_OPEN,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(launch)
        }
    }

    private companion object {
        const val TAG = "NexusTile"
        const val LABEL = "Nexus"
        const val REQUEST_OPEN = 200
    }
}
