package io.nexus.plugin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles the notification's Disconnect action.
 *
 * WHY A RECEIVER AND NOT PendingIntent.getService
 *
 * The action used to be a `getService` PendingIntent pointing straight at NexusVpnService, and
 * it worked — right up until the user swiped the app away. From Android 12 onwards, starting a
 * service from the background is refused (`BackgroundServiceStartNotAllowedException`), and a
 * PendingIntent fired from the notification shade with no live activity is a background start.
 * The tap did nothing, silently, with the tunnel still up.
 *
 * Broadcasts carry no such restriction. The receiver is reached whether or not any UI exists,
 * and it does not need the service to be startable — only stoppable, which it always is.
 *
 * DELIBERATELY INDEPENDENT OF THE WEBVIEW. Nothing here touches Capacitor, the bridge, or any
 * JavaScript. "Disconnect" on a VPN has to work when the app's UI has been killed, which is
 * exactly when the user is least able to do anything about it if it does not.
 *
 * Declared in the manifest with `android:process=":core"`, so handling it does not resurrect
 * the UI process just to stop a tunnel running in another one.
 */
class NexusStopReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DISCONNECT) return

        NexusLog.i(TAG, "disconnect requested from the notification")

        /*
         * CALL THE SERVICE DIRECTLY.
         *
         * This receiver is declared `android:process=":core"`, the same process the service
         * runs in, so the live instance is simply a static away. That removes every Android
         * restriction from the path at once: no background service start to be refused, and
         * no dependence on stopService() reaching us through onDestroy() on the main thread.
         *
         * The previous version went through stopService(), which is delivered - but lands in
         * onDestroy(), where the teardown blocked on a synchronous JNI close. The tap "did
         * nothing" because the teardown could not finish, not because it never arrived.
         */
        val live = NexusVpnService.instance
        if (live != null) {
            live.requestStop("notification")
            return
        }

        // No live instance in this process. The service may still exist after a process
        // restart we did not observe, so ask Android to stop it the ordinary way.
        NexusLog.i(TAG, "no live service instance; falling back to stopService")
        runCatching {
            context.stopService(Intent(context, NexusVpnService::class.java))
        }.onFailure {
            NexusLog.w(TAG, "stopService failed: ${it.message}")
        }
    }

    companion object {
        private const val TAG = "NexusStopReceiver"

        /** Internal only. Not exported, so nothing outside the app can stop the tunnel. */
        const val ACTION_DISCONNECT = "io.nexus.plugin.DISCONNECT"
    }
}
