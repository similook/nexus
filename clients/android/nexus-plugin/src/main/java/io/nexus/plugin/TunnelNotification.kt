package io.nexus.plugin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * The persistent foreground notification.
 *
 * THE RULE: this notification shows CONNECTION STATE and nothing else. It is updated on state
 * change, never on a timer.
 *
 * Live throughput in the notification shade is the single most common battery mistake in VPN
 * clients, and it is invisible in a throughput benchmark. Each update is a binder transaction
 * to NotificationManager plus a SystemUI re-layout — a full wakeup, at 1 Hz, forever, to
 * animate a number nobody is looking at while the screen is off. The competitors we are
 * measuring against all do it.
 *
 * If a user wants live stats they open the app, where the WebView is already awake and the
 * data is already flowing over the command socket (core/docs/ipc-boundary.md R1/R4).
 */
internal class TunnelNotification(context: Context) {

    private val manager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private val appContext = context.applicationContext

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "VPN status",
                // LOW, not DEFAULT: no sound, no vibration, no heads-up. This notification is
                // a legal/UX requirement for a foreground service, not a message.
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shows whether the Nexus tunnel is running"
                setShowBadge(false)
                enableVibration(false)
                enableLights(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            manager.createNotificationChannel(channel)
        }
    }

    /**
     * Enter the foreground. Returns false if the platform refused every strategy.
     *
     * WHY THIS IS A CASCADE AND NOT ONE CALL
     *
     * On Android 14+, startForeground() with a declared type throws
     * ForegroundServiceTypeNotAllowedException when the system decides the app is not eligible
     * for that type — and eligibility is evaluated at runtime, not from the manifest. For
     * FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED the system's notion of "this is a VPN app" is
     * narrower than "this app has a VpnService class", and we are calling this BEFORE
     * establish() has run, so we are not yet the active VPN.
     *
     * That exception is thrown on the main thread out of onStartCommand, so it is an instant
     * uncaught crash — the "Nexus closed because this app has a bug" dialog — and the tunnel
     * never starts.
     *
     * So: try systemExempted, fall back to specialUse (which the manifest also declares, with
     * the required PROPERTY_SPECIAL_USE_FGS_SUBTYPE justification), then fall back to the
     * untyped form for pre-34 devices. Report failure to the caller rather than throwing.
     *
     * Do not collapse this back into a single call because one of them worked on your device.
     */
    fun startForeground(service: Service): Boolean {
        val notification = try {
            build(STATE_CONNECTING, null)
        } catch (e: Exception) {
            // A notification that cannot even be built is fatal for a foreground service, and
            // the exception text is the only clue anyone will get.
            NexusLog.e(TAG, "notification build failed", e)
            return false
        }

        val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            listOf(
                "systemExempted" to ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED,
                "specialUse" to ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                "none" to 0,
            )
        } else {
            listOf("none" to 0)
        }

        for ((name, type) in types) {
            try {
                ServiceCompat.startForeground(service, NOTIFICATION_ID, notification, type)
                NexusLog.i(TAG, "foreground service started (type=$name)")
                return true
            } catch (e: Exception) {
                NexusLog.w(TAG, "startForeground(type=$name) refused: ${e.javaClass.simpleName}: ${e.message}")
            }
        }

        NexusLog.e(TAG, "every startForeground strategy was refused — the OS will kill this service")
        return false
    }

    /**
     * @param serverLabel what the user calls the active node, e.g. "Germany 01 Reality".
     *   Shown as the notification's body text so the shade answers "connected to what",
     *   which is the question a user actually has when they pull it down.
     *
     *   Null when the caller has no name for it - the plugin derives a fallback from the
     *   config itself (protocol and address) rather than leaving the line blank.
     */
    fun showConnected(serverLabel: String? = null) =
        update(build(STATE_CONNECTED, serverLabel))

    fun showError(message: String) = update(build(STATE_ERROR, message))

    /**
     * Leave the foreground but keep the notification on screen.
     *
     * Used on a failed start. STOP_FOREGROUND_REMOVE would take the error message away with
     * the service, and the user would be left with a VPN that stopped for no stated reason -
     * the notification is the only place they will ever see "initialize cache-file: timeout".
     */
    fun detachForeground(service: Service) {
        ServiceCompat.stopForeground(service, ServiceCompat.STOP_FOREGROUND_DETACH)
    }

    fun stopForeground(service: Service) {
        ServiceCompat.stopForeground(service, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    private fun update(notification: Notification) {
        // May throw if POST_NOTIFICATIONS was denied on API 33+. The tunnel keeps running —
        // the foreground service itself does not require the permission, only the visible
        // notification does — so this must never be fatal.
        runCatching { manager.notify(NOTIFICATION_ID, notification) }
    }

    private fun build(state: String, detail: String?): Notification {
        val builder = NotificationCompat.Builder(appContext, CHANNEL_ID)
            // android.R.drawable.stat_sys_vpn_ic is a @hide framework resource — it exists
            // at runtime but is not part of the public SDK, so it does not compile. Ship our
            // own silhouette instead (res/drawable/ic_notification_nexus.xml).
            //
            // This was ic_stat_nexus, a generic shield-with-keyhole glyph carrying no Nexus
            // branding. It is now the Nexus emblem, drawn from the same paths as the launcher
            // icon and the Quick Settings tile. A DEDICATED drawable rather than the tile's:
            // Android squeezes a status-bar icon smaller than a tile renders it, so the mark
            // is simplified for the size - the core dot dropped, the nodes shrunk, the strokes
            // heavier. See the comment in that file.
            //
            // It must stay a flat silhouette. Android repaints every non-transparent pixel in
            // the system tint, so a full-colour launcher icon here comes out as a solid blob.
            //
            // R here resolves to io.nexus.app.R because the plugin currently lives in the app
            // module. If it is ever extracted into a library module the drawable moves with it
            // and this keeps working against the library's own R.
            .setSmallIcon(io.nexus.app.R.drawable.ic_notification_nexus)
            .setContentTitle(state)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // No timestamp: it would make an unchanging notification look like it is updating,
            // and "when" churn is exactly what we are avoiding.
            .setShowWhen(false)
            // Belt and braces — even if something calls update() repeatedly, the user is not
            // alerted more than once.
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent())

        detail?.let { builder.setContentText(it) }

        builder.addAction(
            NotificationCompat.Action(
                0,
                "Disconnect",
                // getBroadcast, NOT getService. From Android 12 a service cannot be started
                // from the background, and a notification tap with no live activity is a
                // background start - so this action silently did nothing once the user had
                // swiped the app away, which is precisely when they need it. See
                // NexusStopReceiver.
                PendingIntent.getBroadcast(
                    appContext,
                    REQUEST_STOP,
                    Intent(appContext, NexusStopReceiver::class.java)
                        .setAction(NexusStopReceiver.ACTION_DISCONNECT)
                        // Explicit package: an implicit broadcast with a custom action would
                        // be delivered nowhere on modern Android.
                        .setPackage(appContext.packageName),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
        )

        return builder.build()
    }

    private fun openAppIntent(): PendingIntent? {
        val launch = appContext.packageManager
            .getLaunchIntentForPackage(appContext.packageName) ?: return null
        return PendingIntent.getActivity(
            appContext,
            REQUEST_OPEN,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private companion object {
        const val TAG = "NexusNotification"
        const val CHANNEL_ID = "nexus.tunnel"
        const val NOTIFICATION_ID = 1
        const val REQUEST_OPEN = 100
        const val REQUEST_STOP = 101

        const val STATE_CONNECTING = "Connecting…"
        const val STATE_CONNECTED = "Connected"
        const val STATE_ERROR = "Disconnected"
    }
}
