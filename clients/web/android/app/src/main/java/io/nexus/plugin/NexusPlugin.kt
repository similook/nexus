package io.nexus.plugin

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.net.VpnService
import android.util.Log
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.nexus.libbox.CommandClient
import io.nexus.libbox.CommandClientHandler
import io.nexus.libbox.CommandClientOptions
import io.nexus.libbox.Libbox
import io.nexus.libbox.OutboundGroupIterator
import io.nexus.libbox.OutboundGroupItemIterator
import io.nexus.libbox.StatusMessage
import io.nexus.libbox.StringIterator
import io.nexus.nexuscore.Nexuscore

/**
 * The Capacitor plugin. Runs in the APP process — the core is in :core.
 *
 * It therefore never touches the Go objects directly. Control goes out as service intents;
 * status comes back over libbox's CommandClient on the unix socket. That is hop ② of
 * core/docs/ipc-boundary.md; this class owns hop ①, the JSON bridge to the WebView, and hop ①
 * is the expensive one because it lands on the main thread.
 *
 * Everything here is shaped by that: small payloads, ≤1 Hz, and nothing at all while the
 * WebView is backgrounded.
 */
@CapacitorPlugin(name = "NexusCore")
class NexusPlugin : Plugin() {

    private var statusClient: CommandClient? = null
    private var groupsClient: CommandClient? = null

    /**
     * Opened only while the Logs screen is mounted. See setLogStreaming.
     *
     * This is the R3-compliant way to get logs: the stream exists for the lifetime of a screen
     * the user is actively looking at, not for the lifetime of the app. Subscribing at app
     * start would be a wakeup per log line, forever, to fill a buffer nobody reads.
     */
    private var logClient: CommandClient? = null

    /**
     * Open only for the few seconds a latency test is in flight. See pingProxy.
     *
     * Same rule as logClient (ipc-boundary.md R3): a stream exists while something is actually
     * reading it, never for the lifetime of the app. The outbounds stream pushes on a timer,
     * so leaving it open would be a wakeup per tick forever to refresh a number the user is
     * not looking at.
     */
    @Volatile
    private var pingClient: CommandClient? = null

    @Volatile
    private var pingTimeout: ScheduledFuture<*>? = null

    /**
     * Status ticks seen, for bounded diagnostic logging.
     *
     * The status path has three places it can die silently — the stream is not subscribed, the
     * callback never fires, or it fires with zeros — and from the UI all three look identical:
     * 0.00 MB/s on a tunnel that is demonstrably carrying traffic. One line per tick tells them
     * apart; logging only the first few and then every 30th keeps it from becoming the 1 Hz
     * wakeup source this design exists to avoid.
     */
    private val statusTicks = AtomicInteger(0)

    /**
     * When the CORE started, in epoch milliseconds, as the core itself reports it.
     *
     * The uptime clock used to be anchored to a timestamp taken in the WebView the moment the
     * UI learned it was connected. That is wrong whenever the UI's lifetime is shorter than the
     * tunnel's — leave the app and come back and the clock restarts from zero, while the tunnel
     * has been up for an hour. The number belongs to the core, so ask the core.
     *
     * 0 means unknown: the RPC failed, or nothing is running.
     */
    @Volatile
    private var coreStartedAt: Long = 0L

    /**
     * Did WE ask for a tunnel and not yet ask for it to stop?
     *
     * This exists because getStatus() cannot otherwise tell "the core is not running" from
     * "our command stream is detached", and it used to conflate them:
     *
     *     val running = statusClient != null
     *
     * handleOnPause disconnects that stream deliberately - a backgrounded WebView holding a
     * 1 Hz subscription is 86,400 wakeups a day - so on EVERY resume getStatus answered
     * "stopped" while the tunnel was up. The UI flashed Disconnected, nulled its uptime
     * anchor, and the timer restarted from 00:00.
     *
     * The core itself lives in the :core process, so a flag over there is invisible from here.
     * What this process does know for certain is its own intent, and intent plus
     * "is the stream attached" covers every case except the core dying unobserved while we
     * were backgrounded - which the status probe discovers and reports.
     */
    @Volatile
    private var intendedRunning: Boolean = false

    /** Cached so a status tick that changed nothing does not cross the bridge at all. */
    private var lastStatusSignature: String? = null

    /**
     * Last status payload, kept so getStatus() can answer without opening a stream.
     *
     * This is what makes getStatus() a RECONCILIATION call rather than a polling endpoint —
     * see the note on the method itself.
     */
    @Volatile
    private var lastStatus: JSObject? = null

    /**
     * Off-main-thread work for the command channel.
     *
     * CommandClient.connect() is a blocking gRPC dial with a deadline; the failing case took
     * seconds in the logs. handleOnResume was calling it on the main thread, which is an ANR
     * waiting for a slow device.
     */
    private val io: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "nexus-command").apply { isDaemon = true }
    }

    /**
     * Submit to [io], tolerating a shut-down executor.
     *
     * NOT defensive noise - this is a crash fix. Some of these submissions originate on a
     * libbox CALLBACK thread (PingHandler.writeOutbounds), and an exception thrown there is
     * not inside any Kotlin try block: it unwinds into native code and takes the process with
     * it. Once handleOnDestroy has shut the executor down, a bare io.execute throws
     * RejectedExecutionException and does exactly that.
     *
     * Reported as: disconnect, reconnect, disconnect - then the app dies.
     */
    private fun post(task: () -> Unit) {
        runCatching { io.execute { runCatching(task) } }
    }

    private var probe: ScheduledFuture<*>? = null

    // ================================================================================
    // Lifecycle
    // ================================================================================

    /**
     * libbox.Setup() must run in THIS process too.
     *
     * Setup stores BasePath and friends in Go package-level globals, and Go globals are
     * per-process. NexusVpnService declares android:process=":core", so its Setup call
     * initialises the CORE process — this one, which hosts the WebView and every CommandClient,
     * was left with an empty BasePath.
     *
     * The symptom is unmistakable once you know it: CommandClient dials a RELATIVE path.
     *
     *   dial unix command.sock: connect: no such file or directory
     *            ^^^^^^^^^^^^ no directory — BasePath was ""
     *
     * The tunnel itself comes up fine (the core has its own correct Setup), so the VPN key
     * appears and traffic could flow, while the UI sits on "Establishing tunnel…" forever
     * because the status stream it is waiting for can never connect.
     *
     * Paths must match NexusVpnService.onCreate() exactly — they name the same socket. filesDir
     * and cacheDir resolve to the same directories in both processes, so passing the same
     * expressions is enough.
     *
     * This is the cost of the :core process split (ipc-boundary.md §1). Worth paying, but it
     * has to be paid in both processes.
     */
    override fun load() {
        super.load()
        runCatching {
            Nexuscore.setup(
                context.filesDir.absolutePath,
                context.getExternalFilesDir(null)?.absolutePath ?: context.filesDir.absolutePath,
                context.cacheDir.absolutePath,
            )
            Log.i(TAG, "libbox setup (app process), basePath=${context.filesDir.absolutePath}")
        }.onFailure { Log.e(TAG, "libbox setup failed in app process", it) }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val config = call.getString("config")
        if (config.isNullOrBlank()) {
            call.reject("config is required")
            return
        }

        // VpnService.prepare returns an Intent the first time, or after the user revokes
        // consent or another VPN takes over. It must be launched from an Activity, which is
        // why this lives in the plugin and not the service.
        val prepare = VpnService.prepare(context)
        if (prepare != null) {
            call.setKeepAlive(true)
            startActivityForResult(call, prepare, "onVpnConsent")
            return
        }
        launchService(config, call.getString("name"))
        call.resolve()
    }

    @ActivityCallback
    private fun onVpnConsent(call: PluginCall?, result: androidx.activity.result.ActivityResult) {
        if (call == null) return
        call.setKeepAlive(false)
        if (result.resultCode != Activity.RESULT_OK) {
            call.reject("VPN permission denied")
            return
        }
        val config = call.getString("config")
        if (config.isNullOrBlank()) {
            call.reject("config is required")
            return
        }
        launchService(config, call.getString("name"))
        call.resolve()
    }

    /**
     * Ask for POST_NOTIFICATIONS if we do not have it.
     *
     * Declaring the permission in the manifest is not enough on Android 13+; it is a runtime
     * permission. Without it the foreground service still starts, but its notification is
     * never shown — which is exactly the "the VPN notification never appears" symptom, and it
     * looks like a broken notification builder rather than a missing grant.
     *
     * Fire-and-forget on purpose: the tunnel must not wait on a permission dialog, and a user
     * who declines should still get a working VPN. Worst case they see no notification.
     */
    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) return

        runCatching {
            activity?.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 9501)
        }.onFailure { Log.w(TAG, "could not request POST_NOTIFICATIONS: ${it.message}") }
    }

    private fun launchService(config: String, nodeName: String? = null) {
        ensureNotificationPermission()
        val intent = Intent(context, NexusVpnService::class.java)
            .setAction(NexusVpnService.ACTION_START)
            .putExtra(NexusVpnService.EXTRA_CONFIG, config)
            .putExtra(NexusVpnService.EXTRA_NODE_NAME, nodeName)
        intendedRunning = true
        context.startForegroundService(intent)

        // The socket does not exist yet; this waits for it.
        scheduleStatusProbe()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        intendedRunning = false
        disconnectClients()
        context.startService(
            Intent(context, NexusVpnService::class.java)
                .setAction(NexusVpnService.ACTION_STOP)
        )
        call.resolve()
    }

    /**
     * Swap the active config in place.
     *
     * Previously this just re-sent ACTION_START, which the service ignores when it is already
     * running — so switching node while connected silently did nothing. It now sends
     * ACTION_RELOAD, which calls through to the Go Service.reload().
     *
     * The tunnel process, the command socket and the UI's status subscription all survive, so
     * the user sees a brief reconnect rather than a full teardown.
     */
    @PluginMethod
    fun reload(call: PluginCall) {
        val config = call.getString("config")
        if (config.isNullOrBlank()) {
            call.reject("config is required")
            return
        }
        context.startService(
            Intent(context, NexusVpnService::class.java)
                .setAction(NexusVpnService.ACTION_RELOAD)
                .putExtra(NexusVpnService.EXTRA_CONFIG, config)
                // Carried on reload too: switching node while connected must move the
                // notification with it.
                .putExtra(NexusVpnService.EXTRA_NODE_NAME, call.getString("name"))
        )
        call.resolve()
    }

    // ================================================================================
    // Control — one-shot, no streaming
    // ================================================================================

    @PluginMethod
    fun selectOutbound(call: PluginCall) = withStatusClient(call) { client ->
        client.selectOutbound(
            call.getString("group") ?: return@withStatusClient call.reject("group is required"),
            call.getString("outbound") ?: return@withStatusClient call.reject("outbound is required"),
        )
        call.resolve()
    }

    @PluginMethod
    fun urlTest(call: PluginCall) = withStatusClient(call) { client ->
        client.urlTest(call.getString("group") ?: "")
        call.resolve()
    }

    /**
     * Measure the live latency of the running proxy outbound.
     *
     * WHAT THIS CAN AND CANNOT DO
     *
     * It tests the outbound the core is CURRENTLY RUNNING, and only while it is running. It is
     * not "ping all": the config contains exactly one proxy outbound, so there is nothing else
     * to measure. Testing every node in the list would mean generating a config that declares
     * all of them plus a urltest group - a different feature with a real battery cost, since
     * the group would then health-check on a timer.
     *
     * CommandClient.urlTest takes a tag that may be a group OR a plain outbound. daemon's
     * StartedService.URLTest branches: not a group, so it falls through to
     * `urltest.URLTest(ctx, "", outbound)` and stores the result in urlTestHistoryStorage.
     * That store is what the Outbounds stream reports, which is why this opens one.
     *
     * The call returns as soon as the test is DISPATCHED. The number arrives later on the
     * "proxyDelay" event, because the measurement happens on the core's own goroutine.
     */
    @PluginMethod
    fun pingProxy(call: PluginCall) {
        val client = statusClient
        if (client == null) {
            call.reject("core is not running")
            return
        }
        post {
            try {
                connectPingClient()
                client.urlTest(PROXY_TAG)
                Log.i(TAG, "url test dispatched for outbound \"$PROXY_TAG\"")
                call.resolve()
            } catch (e: Exception) {
                disconnectPingClient()
                call.reject(e.message ?: "url test failed")
            }
        }
    }

    /**
     * Measure TCP handshake latency to a batch of proxy endpoints.
     *
     * WHY THIS EXISTS ALONGSIDE pingProxy
     *
     * pingProxy measures the tunnel that is RUNNING, which is the honest number but only
     * available for one node at a time and only while connected. Users need latency for every
     * node in the list, before choosing one, without tearing down a working tunnel to test
     * each candidate. That is what standard clients call "ping", and it is a TCP connect timed
     * to the server's own address and port - not ICMP, which most proxy hosts drop anyway.
     *
     * WHY THE SOCKETS ARE NOT TUNNELLED, AND WHY THAT IS CORRECT
     *
     * These run in the APP process, and NexusVpnService puts our own package on the VpnService
     * deny list (openTun: per-app DENY list). So they leave over the underlying network even
     * while the tunnel is up. That is exactly what is wanted: the question is "can I reach
     * this server from here", and routing the probe through the current proxy would answer a
     * different question and disturb the live connection.
     *
     * WHAT IT DOES NOT TELL YOU: that the credentials work. A reachable host with a wrong UUID
     * answers the handshake and fails later. Reachability is still the useful first filter, and
     * pingProxy covers the rest for the active node.
     *
     * BATTERY: bounded and user-initiated - a fixed pool, a short timeout, one round per tap.
     * It must never be put on a timer; that is the wakeup pattern ADR-0001 section 5.2 exists
     * to remove.
     */
    @PluginMethod
    fun tcpPing(call: PluginCall) {
        val targets = call.getArray("targets")
        if (targets == null || targets.length() == 0) {
            call.reject("targets is required")
            return
        }

        data class Target(val id: String, val server: String, val port: Int)

        val parsed = ArrayList<Target>(targets.length())
        for (i in 0 until targets.length()) {
            val item = runCatching { targets.getJSONObject(i) }.getOrNull() ?: continue
            val id = item.optString("id", "")
            val server = item.optString("server", "")
            val port = item.optInt("port", 0)
            if (id.isNotEmpty() && server.isNotEmpty() && port in 1..65535) {
                parsed.add(Target(id, server, port))
            }
        }
        if (parsed.isEmpty()) {
            call.reject("no usable targets")
            return
        }

        val pool = Executors.newFixedThreadPool(minOf(PING_FANOUT, parsed.size)) { r ->
            Thread(r, "nexus-tcpping").apply { isDaemon = true }
        }

        // The whole batch runs off the caller's thread: this is a bridge call on the main
        // thread, and a fan-out of blocking connects is the last thing that belongs there.
        post {
            val results = JSArray()
            try {
                val futures = parsed.map { target ->
                    pool.submit<Pair<String, Int>> { target.id to measure(target.server, target.port) }
                }
                futures.forEachIndexed { index, future ->
                    val (id, ms) = runCatching {
                        future.get(TCP_PING_TIMEOUT_MS + 1_000L, TimeUnit.MILLISECONDS)
                    }.getOrElse { parsed[index].id to -1 }
                    results.put(JSObject().put("id", id).put("ms", ms))
                }
            } finally {
                pool.shutdownNow()
            }
            call.resolve(JSObject().put("results", results))
        }
    }

    /** Milliseconds to complete a TCP handshake, or -1 if it did not complete. */
    private fun measure(server: String, port: Int): Int {
        val startedAt = System.nanoTime()
        return try {
            // Socket(), not SocketChannel: we want the OS to resolve and connect exactly the
            // way the core will, and connect() with a timeout covers both phases.
            Socket().use { socket ->
                socket.tcpNoDelay = true
                socket.connect(InetSocketAddress(server, port), TCP_PING_TIMEOUT_MS.toInt())
            }
            ((System.nanoTime() - startedAt) / 1_000_000L).toInt().coerceAtLeast(1)
        } catch (e: Exception) {
            // Refused, timed out, unresolvable - all the same answer to the user: unreachable.
            -1
        }
    }

    /** MUST run on [io] - connect() is a blocking dial. */
    private fun connectPingClient() {
        pingTimeout?.cancel(false)

        if (pingClient == null) {
            val options = CommandClientOptions().apply {
                addCommand(Libbox.CommandOutbounds)
            }
            val client = CommandClient(PingHandler(), options)
            client.connect()
            pingClient = client
        }

        // Close the stream whether or not an answer arrived. A failed test deletes its history
        // entry rather than writing a zero, so "no event" is the failure signal - and without
        // this the stream would stay open forever on exactly the nodes that do not work.
        pingTimeout = runCatching {
            io.schedule({
                runCatching {
                    if (pingClient != null) {
                        Log.w(TAG, "url test produced no result within ${PING_TIMEOUT_MS}ms")
                        notifyListeners("proxyDelay", JSObject().put("delayMs", 0).put("ok", false))
                        disconnectPingClient()
                    }
                }
            }, PING_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        }.getOrNull()
    }

    private fun disconnectPingClient() {
        pingTimeout?.cancel(false)
        pingTimeout = null
        pingClient?.let { runCatching { it.disconnect() } }
        pingClient = null
    }

    @PluginMethod
    fun setClashMode(call: PluginCall) = withStatusClient(call) { client ->
        client.setClashMode(
            call.getString("mode") ?: return@withStatusClient call.reject("mode is required")
        )
        call.resolve()
    }

    @PluginMethod
    fun closeConnections(call: PluginCall) = withStatusClient(call) { client ->
        client.closeConnections()
        call.resolve()
    }

    /**
     * One-shot snapshot of core state.
     *
     * THIS IS NOT A POLLING ENDPOINT. Calling it on a timer re-creates, above the bridge,
     * exactly the wakeup pattern the whole design exists to remove — and worse than the
     * stream, because each call is a main-thread bridge crossing with no source-side throttle.
     *
     * It has exactly two legitimate uses:
     *   1. Initial state on mount, before the first status event arrives.
     *   2. Reconciliation on resume, because handleOnPause() disconnected the stream and the
     *      UI's last known values are stale by however long the app was backgrounded.
     *
     * Live values come from the "status" listener. See useNexusCore.ts.
     */
    @PluginMethod
    fun getStatus(call: PluginCall) {
        // Do not dial here - connect() blocks on a gRPC deadline and this is a bridge call on
        // the main thread. The probe owns (re)connection; we report what is currently true.
        // Three outcomes, not two. "unknown" is the honest answer while the stream is
        // reattaching after a resume: we asked for a tunnel, nobody asked to stop it, and we
        // cannot yet confirm either way. The UI must hold its current state rather than
        // treating an unconfirmed reading as a disconnect.
        val state = when {
            statusClient != null -> "started"
            intendedRunning -> "unknown"
            else -> "stopped"
        }
        val result = JSObject()
            .put("state", state)
            // Epoch millis from the core. The UI anchors its uptime clock to this so that
            // backgrounding the app does not restart the count.
            .put("coreStartedAt", coreStartedAt)

        lastStatus?.let { status ->
            for (key in status.keys()) {
                result.put(key, status.get(key))
            }
        }
        call.resolve(result)
    }

    /**
     * Logs are PULLED, never streamed (ipc-boundary.md R3). The core keeps a bounded ring
     * (LogMaxLines = 512); we read it when a log screen opens.
     */
    @PluginMethod
    fun readLogs(call: PluginCall) {
        // Reads the ring the log client accumulated. A live tail is a debug-build feature and
        // is deliberately not exposed here.
        val lines = JSArray()
        LogBuffer.snapshot(call.getInt("limit") ?: 200).forEach { lines.put(it) }
        call.resolve(JSObject().put("lines", lines))
    }

    /**
     * Clear the host-side log ring.
     *
     * Only ours. libbox's CommandClient exposes no host->core clear, so the core keeps its own
     * 512-line ring until it rolls over naturally. That is fine — this is what a user means by
     * "clear the log view" — but do not describe it to them as wiping the core's memory.
     */
    @PluginMethod
    fun clearLogs(call: PluginCall) {
        LogBuffer.clear()
        call.resolve()
    }

    private inline fun withStatusClient(call: PluginCall, block: (CommandClient) -> Unit) {
        val client = statusClient
        if (client == null) {
            call.reject("core is not running")
            return
        }
        try {
            block(client)
        } catch (e: Exception) {
            call.reject(e.message ?: "command failed")
        }
    }

    // ================================================================================
    // Status streaming — R1 and R4
    // ================================================================================

    override fun handleOnResume() {
        super.handleOnResume()
        setUIForeground(true)
        if (intendedRunning) {
            // Retry until the socket answers. A single attempt that loses the race would
            // leave the UI in "unknown" with nothing scheduled to resolve it.
            post { if (!connectStatusClient()) scheduleStatusProbe() }
        } else {
            post { connectStatusClient() }
        }
    }

    override fun handleOnPause() {
        super.handleOnPause()
        cancelStatusProbe()
        // Not a throttle, not a filter: we DISCONNECT. A backgrounded WebView that keeps a
        // 1 Hz subscription open is 86,400 wakeups a day to update a view nobody is looking
        // at. This is the same policy as the Go-side coalescer, applied to the UI channel.
        disconnectClients()
        setUIForeground(false)
    }

    override fun handleOnDestroy() {
        disconnectClients()
        // shutdown(), not shutdownNow(): disconnectClients just queued the actual closes on
        // [io], and shutdownNow would interrupt them mid-RPC. The executor is daemon-threaded,
        // so a pending task cannot hold the process open either way.
        runCatching { io.shutdown() }
        super.handleOnDestroy()
    }

    private fun setUIForeground(foreground: Boolean) {
        runCatching {
            context.startService(
                Intent(context, NexusVpnService::class.java)
                    .setAction(NexusVpnService.ACTION_UI_FOREGROUND)
                    .putExtra(NexusVpnService.EXTRA_FOREGROUND, foreground)
            )
        }
    }

    /**
     * Try once to attach the status stream. Returns true if we are now connected.
     *
     * MUST run on [io], never on the main thread.
     */
    private fun connectStatusClient(): Boolean {
        if (statusClient != null) return true

        val options = CommandClientOptions().apply {
            // Nanoseconds — a Go duration crossing the binding.
            //
            // Setting it here means the CORE throttles to 1 Hz. The alternative (subscribe
            // fast, drop in Kotlin) would pay the serialisation and the socket traffic and
            // then throw the result away. Throttle at the source, always.
            statusInterval = 1_000_000_000L

            // CHANGED IN 1.14: there is no `command` field and no `isMainClient`. A client now
            // subscribes to N streams via addCommand(). That is strictly better for us — R2 in
            // ipc-boundary.md says subscribe to exactly what the mounted screen needs, and this
            // makes that expressible on one connection instead of one client per stream.
            //
            // We add ONLY status. Not logs (R3: pulled, not streamed) and not connection events
            // (R2: unbounded, debug screens only).
            addCommand(Libbox.CommandStatus)
        }

        // CHANGED IN 1.14: a real constructor, not Libbox.newCommandClient().
        val client = CommandClient(StatusHandler(), options)
        return try {
            client.connect()
            statusClient = client

            // Safe here and nowhere else: this method already runs on [io], and getStartedAt is
            // a blocking RPC. Cached rather than fetched per getStatus() call, because that one
            // is a main-thread bridge crossing.
            coreStartedAt = runCatching { client.startedAt }.getOrElse {
                Log.d(TAG, "started-at unavailable: ${it.message}")
                0L
            }

            Log.i(TAG, "status client connected (core started at $coreStartedAt)")
            true
        } catch (e: Exception) {
            // Expected whenever the core is not running — the socket simply is not there.
            Log.d(TAG, "status client not connected: ${e.message}")
            false
        }
    }

    /**
     * Keep trying to attach the status stream until the core socket appears.
     *
     * WHY THIS EXISTS
     *
     * The command socket is created by the CORE, in the :core process, some time after we send
     * the start intent. Until now connectStatusClient() ran only on resume and on getStatus(),
     * and neither happens after tapping Connect. So the tunnel came up, the VPN key appeared,
     * traffic could flow, and the UI sat on "Establishing tunnel" forever because nothing ever
     * re-probed the socket.
     *
     * BATTERY NOTE: this is a bounded, user-initiated retry, not a background poller. It starts
     * only on an explicit connect, stops the instant it succeeds, and gives up at the ceiling
     * below. It must never be repurposed into a keepalive - that is exactly the wakeup pattern
     * ADR-0001 section 5.2 exists to remove.
     */
    private fun scheduleStatusProbe() {
        cancelStatusProbe()
        val attempts = AtomicInteger(0)

        probe = io.scheduleWithFixedDelay({
            if (statusClient != null || connectStatusClient()) {
                cancelStatusProbe()
                return@scheduleWithFixedDelay
            }
            if (attempts.incrementAndGet() >= PROBE_MAX_ATTEMPTS) {
                Log.w(TAG, "giving up on the command socket after $PROBE_MAX_ATTEMPTS attempts")
                intendedRunning = false
                // Tell the UI rather than leaving it on "Establishing tunnel" indefinitely.
                notifyListeners(
                    "serviceState",
                    JSObject().put("state", "stopped")
                        .put("reason", "Could not reach the core. Check the logs."),
                )
                cancelStatusProbe()
            }
        }, PROBE_INITIAL_MS, PROBE_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun cancelStatusProbe() {
        probe?.cancel(false)
        probe = null
    }

    /**
     * Tear every command stream down.
     *
     * THE DISCONNECTS RUN ON [io], NOT HERE. CommandClient.disconnect() is a blocking gRPC
     * call and this is reached from stop() on the main thread; worse, the ping timeout can
     * fire on [io] at the same moment, so two threads would race to close the same gomobile
     * proxy object. Detaching the references synchronously and closing them on [io] makes the
     * teardown single-threaded and keeps the bridge call cheap.
     */
    private fun disconnectClients() {
        cancelStatusProbe()

        val doomed = listOf(statusClient, groupsClient, logClient, pingClient)
        statusClient = null
        groupsClient = null
        logClient = null
        pingClient = null
        pingTimeout?.cancel(false)
        pingTimeout = null
        lastStatusSignature = null
        coreStartedAt = 0L
        statusTicks.set(0)

        post { doomed.forEach { client -> client?.let { runCatching { it.disconnect() } } } }
    }

    /**
     * Handles the status stream.
     *
     * Callbacks arrive on the client's own thread, not the main thread. notifyListeners
     * marshals to the bridge itself, so we do not hop threads here — but we also do as little
     * as possible before calling it, because any work in this method happens once a second
     * for as long as the app is open.
     */
    private inner class StatusHandler : CommandClientHandler {

        override fun connected() {
            notifyListeners("serviceState", JSObject().put("state", "started"))
        }

        override fun disconnected(message: String?) {
            lastStatusSignature = null
            notifyListeners(
                "serviceState",
                JSObject().put("state", "stopped").put("reason", message ?: "")
            )
        }

        override fun writeStatus(message: StatusMessage) {
            // R4: nothing crosses hop ① unless it actually changed. An idle tunnel produces
            // an identical status every second; forwarding it is a main-thread JSON
            // serialisation and a WebView wakeup for zero information.
            // NEW IN 1.14: trafficAvailable. False means the core is not producing traffic
            // counters at all (it depends on the with_clash_api build tag), in which case the
            // zeros below are "unknown", not "idle". Forward it so the UI can tell the
            // difference instead of rendering a permanently-still 0.00 MB/s as if it were real.
            val trafficAvailable = runCatching { message.trafficAvailable }.getOrDefault(true)

            val signature = "${message.uplink}:${message.downlink}:" +
                "${message.connectionsIn}:${message.connectionsOut}:$trafficAvailable"
            val payload = JSObject()
                .put("uplink", message.uplink)
                .put("downlink", message.downlink)
                .put("uplinkTotal", message.uplinkTotal)
                .put("downlinkTotal", message.downlinkTotal)
                .put("connectionsIn", message.connectionsIn)
                .put("connectionsOut", message.connectionsOut)
                .put("memory", message.memory)
                .put("goroutines", message.goroutines)
                .put("trafficAvailable", trafficAvailable)
                // Carried on EVERY tick, not just in getStatus().
                //
                // getStatus() races the reconnect: handleOnPause disconnects and zeroes this,
                // handleOnResume queues connectStatusClient on [io], and the UI's resume
                // reconcile calls getStatus on the main thread before that lands - reading 0
                // and skipping the anchor. The uptime clock then restarted from zero on every
                // return to the app. The stream cannot race itself, so the value rides along.
                .put("coreStartedAt", coreStartedAt)

            val tick = statusTicks.incrementAndGet()
            if (tick <= 3 || tick % 30 == 0) {
                Log.i(
                    TAG,
                    "status #$tick up=${message.uplink} down=${message.downlink} " +
                        "upTotal=${message.uplinkTotal} downTotal=${message.downlinkTotal} " +
                        "connIn=${message.connectionsIn} connOut=${message.connectionsOut} " +
                        "trafficAvailable=$trafficAvailable",
                )
            }

            // Cached even when deduped, so getStatus() on resume returns the true last value
            // rather than whatever happened to differ.
            lastStatus = payload

            if (signature == lastStatusSignature) return
            lastStatusSignature = signature

            notifyListeners("status", payload)
        }

        override fun writeGroups(groups: OutboundGroupIterator?) {
            // Only delivered to a client that subscribed to the groups stream. Ours did not, so
            // this should not fire — if it does, something subscribed to more than it needed.
        }

        /**
         * NEW IN 1.14. Per-outbound detail, a finer-grained companion to writeGroups.
         *
         * Not forwarded: same reasoning as writeGroups, and this one scales with the number of
         * outbounds, so a large subscription would push a sizeable payload across hop (1) on
         * every tick.
         */
        override fun writeOutbounds(outbounds: OutboundGroupItemIterator?) = Unit

        /**
         * R2, and it changed shape in 1.14: writeConnections(Connections) became
         * writeConnectionEvents(ConnectionEvents).
         *
         * Still never forwarded from here. It is the unbounded stream — on a busy device
         * thousands of records, serialised, crossing two process boundaries, every interval.
         * A connections screen opens its own short-lived client and closes it on unmount.
         */
        override fun writeConnectionEvents(events: io.nexus.libbox.ConnectionEvents?) = Unit

        /**
         * Never fires on the status client — it did not subscribe to CommandLog. The log
         * stream is handled by LogHandler on a separate, screen-scoped client.
         */
        override fun writeLogs(messages: io.nexus.libbox.LogIterator?) = Unit

        override fun clearLogs() = LogBuffer.clear()

        /**
         * NEW IN 1.14. The core tells us its effective log level.
         *
         * Recorded only. It is informational, and reacting to it by changing what we subscribe
         * to would make our IPC behaviour depend on a config field — exactly the kind of
         * indirect coupling ipc-boundary.md exists to prevent.
         */
        override fun setDefaultLogLevel(level: Int) {
            Log.d(TAG, "core default log level = $level")
        }

        override fun initializeClashMode(modes: StringIterator?, current: String?) {
            val list = JSArray()
            while (modes?.hasNext() == true) list.put(modes.next())
            notifyListeners(
                "clashMode",
                JSObject().put("modes", list).put("current", current ?: "")
            )
        }

        override fun updateClashMode(mode: String?) {
            notifyListeners("clashMode", JSObject().put("current", mode ?: ""))
        }

        // openURL(String) was removed from CommandClientHandler in 1.14.
    }

    // ================================================================================
    // Log stream — screen-scoped, never app-scoped
    // ================================================================================

    /**
     * Opens or closes the log subscription. Called by LogsView on mount and unmount.
     *
     * R3 says logs are pulled, not pushed, and that still holds for the UI: the WebView reads a
     * bounded ring via readLogs(). What this adds is the ring's *source* — a CommandLog
     * subscription whose lifetime is bounded by a screen the user is actually looking at,
     * rather than by the app. Nothing streams across hop (1); lines land in LogBuffer and the
     * UI fetches them.
     */
    @PluginMethod
    fun setLogStreaming(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        if (enabled) connectLogClient() else disconnectLogClient()
        call.resolve()
    }

    private fun connectLogClient() {
        if (logClient != null) return

        val options = CommandClientOptions().apply {
            addCommand(Libbox.CommandLog)
        }
        val client = CommandClient(LogHandler(), options)
        try {
            client.connect()
            logClient = client
        } catch (e: Exception) {
            Log.d(TAG, "log client not connected: ${e.message}")
        }
    }

    private fun disconnectLogClient() {
        logClient?.let { runCatching { it.disconnect() } }
        logClient = null
    }

    /**
     * Handles the log stream only.
     *
     * A separate class from StatusHandler on purpose: StatusHandler emits serviceState events
     * on connected()/disconnected(), and a second client reporting those would make the UI
     * think the tunnel went down whenever the Logs screen closed.
     */
    /**
     * Receives the outbounds stream for the duration of one latency test.
     *
     * Every callback but writeOutbounds is deliberately inert: this client subscribes to
     * CommandOutbounds only, and emitting serviceState from a second client would make the UI
     * flap between two sources of truth.
     */
    private inner class PingHandler : CommandClientHandler {

        override fun writeOutbounds(outbounds: io.nexus.libbox.OutboundGroupItemIterator?) {
            outbounds ?: return
            while (outbounds.hasNext()) {
                val item = outbounds.next() ?: continue
                if (item.tag != PROXY_TAG) continue

                // 0 means "no history entry", which is what a FAILED test leaves behind -
                // urltest deletes the entry rather than storing a zero. Ignore it and let the
                // timeout report the failure, otherwise the first tick after dispatch (before
                // the measurement finishes) would be reported as a failure every time.
                val delay = item.urlTestDelay
                Log.i(TAG, "outbounds tick: tag=${item.tag} type=${item.type} delay=$delay")
                if (delay <= 0) continue

                notifyListeners("proxyDelay", JSObject().put("delayMs", delay).put("ok", true))
                // Hop to [io] rather than closing from this callback: disconnect() is a
                // blocking RPC, and tearing a client down from inside its own callback is a
                // reentrancy hazard on the gomobile side.
                post { disconnectPingClient() }
                return
            }
        }

        override fun connected() = Unit
        override fun disconnected(message: String?) = Unit
        override fun writeLogs(messages: io.nexus.libbox.LogIterator?) = Unit
        override fun clearLogs() = Unit
        override fun writeStatus(message: io.nexus.libbox.StatusMessage?) = Unit
        override fun writeGroups(groups: io.nexus.libbox.OutboundGroupIterator?) = Unit
        override fun writeConnectionEvents(events: io.nexus.libbox.ConnectionEvents?) = Unit
        override fun initializeClashMode(modes: StringIterator?, current: String?) = Unit
        override fun updateClashMode(mode: String?) = Unit
        override fun setDefaultLogLevel(level: Int) = Unit
    }

    private inner class LogHandler : CommandClientHandler {

        override fun writeLogs(messages: io.nexus.libbox.LogIterator?) {
            messages ?: return
            while (messages.hasNext()) {
                val entry = messages.next() ?: continue
                // LogEntry carries no timestamp, so we stamp arrival. For a live stream that is
                // within milliseconds of emission, and it is what the UI's parser expects.
                val stamp = timeFormat.format(java.util.Date())
                LogBuffer.append("$stamp [${levelName(entry.level)}] ${entry.message}")
            }
        }

        override fun clearLogs() = LogBuffer.clear()

        // Everything else belongs to the status client. Silent no-ops here: this client
        // subscribed to CommandLog only, so none of these should ever arrive.
        override fun connected() = Unit
        override fun disconnected(message: String?) = Unit
        override fun writeStatus(message: StatusMessage) = Unit
        override fun writeGroups(groups: OutboundGroupIterator?) = Unit
        override fun writeOutbounds(outbounds: OutboundGroupItemIterator?) = Unit
        override fun writeConnectionEvents(events: io.nexus.libbox.ConnectionEvents?) = Unit
        override fun setDefaultLogLevel(level: Int) = Unit
        override fun initializeClashMode(modes: StringIterator?, current: String?) = Unit
        override fun updateClashMode(mode: String?) = Unit
    }

    private companion object {
        const val TAG = "NexusPlugin"

        // ~12s of retries: long enough for a slow cold start, short enough that a genuinely
        // broken core reports failure while the user is still looking at the screen.
        const val PROBE_INITIAL_MS = 300L
        const val PROBE_INTERVAL_MS = 400L
        const val PROBE_MAX_ATTEMPTS = 30

        /** The tag singboxConfig.ts gives the one proxy outbound. */
        const val PROXY_TAG = "proxy"

        // urltest's own dial deadline is shorter than this; the margin covers a slow relay
        // plus one stream tick, so a node that is merely slow is not reported as broken.
        const val PING_TIMEOUT_MS = 12_000L

        // Per-endpoint TCP handshake budget. Above ~3s a node is unusable in practice, and a
        // longer wait only makes the whole batch feel broken.
        const val TCP_PING_TIMEOUT_MS = 3_000L

        // Concurrency for a batch test. Enough that a 30-node subscription finishes in a
        // couple of seconds; low enough not to open thirty sockets at once on a phone radio.
        const val PING_FANOUT = 8

        val timeFormat = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)

        /**
         * LogEntry.level is an int. The mapping below follows the conventional Go logging
         * ordering (panic..trace). It is UNVERIFIED against sing-box's own constants — if the
         * Logs screen shows everything as one level, or the colours look inverted, this is the
         * table to check. Unknown values degrade to "info" rather than being dropped.
         */
        fun levelName(level: Int): String = when (level) {
            0 -> "panic"
            1 -> "fatal"
            2 -> "error"
            3 -> "warn"
            4 -> "info"
            5 -> "debug"
            6 -> "trace"
            else -> "info"
        }
    }
}

/**
 * Bounded in-process log ring for the app side.
 *
 * The core keeps its own capped ring (LogMaxLines = 512, set in nexuscore.Setup) so that the
 * :core process memory stays bounded; this is the app-process mirror, and it is capped for
 * the same reason. Neither is allowed to grow with uptime.
 */
internal object LogBuffer {
    private const val CAPACITY = 512
    private val lines = ArrayDeque<String>(CAPACITY)

    @Synchronized
    fun append(line: String) {
        if (lines.size >= CAPACITY) lines.removeFirst()
        lines.addLast(line)
    }

    @Synchronized
    fun snapshot(limit: Int): List<String> =
        lines.toList().takeLast(limit.coerceIn(1, CAPACITY))

    @Synchronized
    fun clear() = lines.clear()
}
