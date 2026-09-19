package io.nexus.plugin

import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.IpPrefix
import android.net.ProxyInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import io.nexus.libbox.TunOptions
import io.nexus.nexuscore.Nexuscore
import io.nexus.nexuscore.Service as NexusService
import java.net.InetAddress
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * The tunnel service. Runs in the :core process (see AndroidManifest.xml).
 *
 * Responsibilities, in order of importance:
 *   1. Own the Go [NexusService] lifecycle.
 *   2. Implement the parts of PlatformInterface that need a VpnService: openTun and
 *      autoDetectInterfaceControl.
 *   3. Register PowerReceiver so screen/Doze events reach the Go PowerController with no IPC.
 *   4. Stay alive: foreground service, systemExempted type.
 *
 * It does NOT: parse config, decide policy, compute statistics, or talk to the UI. Status
 * reaches the WebView through libbox's own CommandServer over the unix socket
 * (core/docs/ipc-boundary.md), not through this class.
 */
class NexusVpnService : VpnService(), PlatformInterfaceWrapper {

    private val service = AtomicReference<NexusService?>(null)

    /**
     * Config preparation and core start run here, never on the main thread.
     *
     * ConfigGuard now performs a DNS lookup (see resolveOutboundServers), and Android throws
     * NetworkOnMainThreadException for any network I/O on the main thread - onStartCommand is
     * the main thread. Starting the core was already 0.4-1.2s of main-thread work in the logs,
     * so this is overdue regardless.
     */
    private val starter: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "nexus-start").apply { isDaemon = true }
    }
    private var tunFd: ParcelFileDescriptor? = null

    /** Guards against a double teardown - requestStop() can race onDestroy(). */
    private val stopping = java.util.concurrent.atomic.AtomicBoolean(false)
    private lateinit var notification: TunnelNotification

    private val powerReceiver = PowerReceiver(
        onScreenOn = { on -> service.get()?.setScreenOn(on) },
        onDeviceIdle = { idle -> service.get()?.setDeviceIdle(idle) },
    )

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: android.net.Network) {
            service.get()?.networkChanged()
        }

        override fun onLost(network: android.net.Network) {
            service.get()?.networkChanged()
        }
    }

    override val platformContext: Context get() = this

    // ================================================================================
    // Service lifecycle
    // ================================================================================

    override fun onCreate() {
        super.onCreate()
        instance = this
        notification = TunnelNotification(this)
        DefaultNetworkMonitor.attach(this)

        // libbox.Setup is once-per-process and must precede everything else. filesDir is
        // where the command socket lands; the plugin in the app process reads it from the
        // same path via the app's own filesDir, which resolves to the same directory because
        // :core is the same app.
        runCatching {
            Nexuscore.setup(
                filesDir.absolutePath,
                getExternalFilesDir(null)?.absolutePath ?: filesDir.absolutePath,
                cacheDir.absolutePath,
            )
        }.onFailure { NexusLog.e(TAG, "libbox setup failed", it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Belt and braces. Anything that escapes here is an uncaught exception on the main
        // thread inside a Service callback, which Android turns into the "app has a bug"
        // dialog — the least debuggable possible outcome for a user in the field. A logged
        // failure plus a stopped service is strictly better.
        return try {
            handleCommand(intent)
        } catch (e: Throwable) {
            NexusLog.e(TAG, "onStartCommand failed", e)
            runCatching { notification.showError(e.message ?: e.javaClass.simpleName) }
            stop("onStartCommand-failure")
            START_NOT_STICKY
        }
    }

    private fun handleCommand(intent: Intent?): Int {
        when (intent?.action) {
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG)
                if (config.isNullOrBlank()) {
                    NexusLog.e(TAG, "start without config")
                    stopSelf()
                    return START_NOT_STICKY
                }
                start(config, intent.getStringExtra(EXTRA_NODE_NAME))
            }

            ACTION_STOP -> {
                // requestStop, not stop: this runs on the main thread and the teardown may
                // block on a JNI close.
                requestStop("ACTION_STOP")
                return START_NOT_STICKY
            }

            // Swap config without dropping the tunnel process, the command server, or the
            // UI's status stream. 1.14 made this a first-class operation on a long-lived
            // server (nexuscore.Service.reload -> CommandServer.StartOrReloadService); under
            // the old BoxService model it meant destroying and rebuilding everything.
            //
            // If nothing is running yet, a reload is just a start.
            ACTION_RELOAD -> {
                val config = intent.getStringExtra(EXTRA_CONFIG)
                if (config.isNullOrBlank()) return START_STICKY
                val nodeName = intent.getStringExtra(EXTRA_NODE_NAME)
                val running = service.get()
                if (running == null) {
                    start(config, nodeName)
                } else {
                    val guarded = try {
                        ConfigGuard.enforce(config)
                    } catch (e: Exception) {
                        NexusLog.e(TAG, "reload config rejected", e)
                        notification.showError(e.message ?: "invalid configuration")
                        return START_STICKY
                    }
                    try {
                        running.reload(guarded)
                        // Switching node while connected has to move the notification with
                        // it, or the shade keeps naming the server the user just left.
                        notification.showConnected(serverLabel(nodeName, guarded))
                    } catch (e: Exception) {
                        NexusLog.e(TAG, "reload failed", e)
                        notification.showError(e.message ?: "reload failed")
                    }
                }
                return START_STICKY
            }

            // The one lifecycle signal that legitimately crosses the process boundary: the
            // WebView's visibility is only knowable in the app process. Two events per app
            // session, so a startService intent is cheap enough and avoids keeping a binding
            // alive purely to carry it.
            ACTION_UI_FOREGROUND -> {
                service.get()?.setUIForeground(intent.getBooleanExtra(EXTRA_FOREGROUND, false))
                return START_STICKY
            }
        }
        return START_STICKY
    }

    private fun start(config: String, nodeName: String? = null) {
        // NO EARLY RETURN WHEN A CORE IS ALREADY RUNNING.
        //
        // A second ACTION_START is how a node switch arrives, and bailing out here is what
        // forced the UI to stop the service first and then start it again. That produced a
        // race the core cannot survive: libbox ALWAYS enables the cache file (box.go sets
        // needCacheFile whenever a PlatformLogWriter is present, which libbox always
        // provides), and bbolt opens it with an exclusive flock and a one second timeout.
        // If the outgoing instance has not released that lock, the incoming one dies with
        //
        //     start or reload service: initialize cache-file: timeout
        //
        // leaving the old tun interface open - the UI says disconnected while the system VPN
        // key stays lit. A zombie.
        //
        // The swap now happens INSIDE one service instance, serialised on `starter`, so the
        // old core is fully closed before the new one opens the same file.

        // Foreground BEFORE establishing the tunnel: Android gives us a few seconds after
        // startForegroundService() to call startForeground(), and blowing that deadline is its
        // own crash (ForegroundServiceDidNotStartInTimeException).
        //
        // If every strategy was refused there is no point continuing — the OS will kill this
        // service regardless, and dying quietly with a log beats dying in a crash dialog.
        if (!notification.startForeground(this)) {
            NexusLog.e(TAG, "could not enter foreground; aborting start")
            stopSelf()
            return
        }

        // Everything below touches the network (config pre-resolution) or takes seconds
        // (core start), so it leaves the main thread here. `starter` is single-threaded, which
        // is what makes a swap strictly sequential: a queued start cannot begin until the
        // close that precedes it has returned.
        starter.execute { startCore(config, nodeName) }
    }

    /**
     * Release the core and the tun interface, in that order, and wait for the file lock.
     *
     * MUST be called on [starter]. Closing the core closes its cache file, which is what frees
     * the bbolt flock the next instance needs; doing it anywhere else reintroduces the race
     * this exists to remove.
     */
    private fun closeCore() {
        service.getAndSet(null)?.let { existing ->
            NexusLog.d(TAG) { "closing previous core instance" }
            runCatching { existing.close() }
                .onFailure { NexusLog.w(TAG, "core close failed: ${it.message}") }
        }
        // The tun fd is closed AFTER the core, not before: the core is still reading from it
        // while it shuts down, and pulling the descriptor first turns an orderly close into a
        // stream of read errors.
        tunFd?.let { runCatching { it.close() } }
        tunFd = null
    }

    /**
     * Give up on a start, leaving nothing behind.
     *
     * Every failure path goes through here. The important part is that the tun interface is
     * closed even when the failure happened before it was opened - the system VPN key tracks
     * the interface, not the notification, so a start that dies with a descriptor still open
     * leaves the key lit over a tunnel that carries nothing.
     *
     * STOP_FOREGROUND_DETACH rather than REMOVE: the notification is the only place the user
     * will ever see why it failed, and removing it along with the service would leave them
     * with a VPN that simply stopped for no stated reason.
     */
    private fun failStart(message: String) {
        NexusLog.e(TAG, "start failed: $message")
        closeCore()
        runCatching { notification.showError(message) }
        runCatching { notification.detachForeground(this) }
        stopSelf()
    }

    private fun startCore(config: String, nodeName: String? = null) {
        /*
         * A SWAP IS A RELOAD, NOT A CLOSE FOLLOWED BY A START.
         *
         * Serialising close-then-create on `starter` was not enough, and the reason is in
         * sing-box rather than in Kotlin. Destroying the Service destroys its CommandServer
         * too, and building a new one means a new box opening the same cache.db - so the new
         * bbolt handle races the old one's release, with a one second timeout to lose in.
         *
         * StartOrReloadService does the same swap in Go, correctly:
         *
         *     s.lifecycleAccess.Lock()
         *     oldInstance.Close()          // completes
         *     runtimeDebug.FreeOSMemory()
         *     s.newInstance(...)           // only then
         *
         * One lifecycle lock, one CommandServer, one cache file, no race to win. Reloading is
         * also what the core is designed for - the fd, the notification and the status stream
         * all stay up, so the user sees a reconnect instead of the tunnel disappearing.
         *
         * Falling back to a full restart if reload fails, because a failed reload leaves the
         * old instance closed and nothing running.
         */
        val running = service.get()
        if (running != null) {
            val guardedForReload = try {
                ConfigGuard.enforce(config)
            } catch (e: Exception) {
                failStart(e.message ?: "invalid configuration")
                return
            }

            try {
                running.reload(guardedForReload)
                notification.showConnected(serverLabel(nodeName, guardedForReload))
                rememberForRelaunch(guardedForReload, nodeName)
                NexusLog.i(TAG, "swapped config via reload")
                return
            } catch (e: Exception) {
                NexusLog.w(TAG, "reload failed, falling back to a full restart: ${e.message}")
                // Fall through. closeCore() below tears down whatever state the failed reload
                // left, and the retry loop covers the lock it may still be holding.
            }
        }

        // Serialised on `starter`, so this returns before any queued start proceeds.
        closeCore()

        // ADR-0001 §5.4 is a product decision, so it gets enforced in code rather than left
        // to whoever edits a config template. See ConfigGuard.
        val guarded = try {
            ConfigGuard.enforce(config)
        } catch (e: Exception) {
            failStart(e.message ?: "invalid configuration")
            return
        }

        /*
         * RETRY, BUT ONLY FOR THE CACHE LOCK.
         *
         * closeCore() above already released it, so in the ordinary case the first attempt
         * succeeds and this loop costs nothing. It exists for the cases ordering alone cannot
         * cover: the OS has not finished releasing an flock held by a process it is still
         * reaping, or a previous run was killed hard enough that onDestroy never ran.
         *
         * bbolt's own timeout is one second, so three attempts spaced 400 ms apart bound the
         * worst case at a few seconds rather than an immediate, permanent failure.
         *
         * Deliberately narrow: only "cache-file" AND "timeout" retries. A bad UUID or an
         * unreachable server must fail on the first attempt and say so, not sit in a retry
         * loop making the user think the app has hung.
         */
        var created: NexusService? = null
        var lastError: Exception? = null

        for (attempt in 1..CACHE_LOCK_ATTEMPTS) {
            try {
                val instance = Nexuscore.newService(guarded, this)
                try {
                    instance.start()
                    created = instance
                    break
                } catch (e: Exception) {
                    runCatching { instance.close() }
                    throw e
                }
            } catch (e: Exception) {
                lastError = e
                val message = e.message ?: ""
                val isCacheLock = message.contains("cache-file", true) && message.contains("timeout", true)
                if (!isCacheLock || attempt == CACHE_LOCK_ATTEMPTS) break

                NexusLog.w(TAG, "cache file still locked (attempt $attempt/$CACHE_LOCK_ATTEMPTS); retrying")
                try {
                    Thread.sleep(CACHE_LOCK_BACKOFF_MS)
                } catch (interrupted: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
        }

        if (created == null) {
            failStart(lastError?.message ?: "core failed to start")
            return
        }

        service.set(created)
        stopping.set(false)
        isRunning = true
        rememberForRelaunch(guarded, nodeName)
        notifyTileStateChanged()

        // Register AFTER the core exists — PowerReceiver.register() seeds the initial screen
        // and Doze state immediately, and that seed has to land on a live service. Starting
        // while the screen is already off (always-on VPN, boot) is common.
        powerReceiver.register(this)
        registerNetworkCallback()

        notification.showConnected(serverLabel(nodeName, guarded))
    }

    /**
     * What to call the active server in the notification.
     *
     * Prefers the name the user sees in the list. Falls back to protocol and address read out
     * of the config, because a node imported from a link with no `#fragment` has no name at
     * all - and "Connected" with nothing after it is exactly the notification we are trying
     * to improve on.
     */
    private fun serverLabel(nodeName: String?, guardedConfig: String): String? {
        val name = nodeName?.trim()
        if (!name.isNullOrEmpty()) return name

        return runCatching {
            val outbounds = org.json.JSONObject(guardedConfig).optJSONArray("outbounds")
                ?: return@runCatching null
            for (i in 0 until outbounds.length()) {
                val outbound = outbounds.optJSONObject(i) ?: continue
                if (outbound.optString("tag") != "proxy") continue
                val type = outbound.optString("type", "").uppercase()
                val server = outbound.optString("server", "")
                val port = outbound.optInt("server_port", 0)
                return@runCatching when {
                    server.isEmpty() -> type.ifEmpty { null }
                    port > 0 -> "$type · $server:$port"
                    else -> "$type · $server"
                }
            }
            null
        }.getOrNull()
    }

    /**
     * Remember what to start if something outside the UI asks for a tunnel.
     *
     * The Quick Settings tile runs in Kotlin and cannot see the selected server - that lives in
     * the WebView's localStorage. So the service records what it actually started, and the tile
     * replays it.
     *
     * The GUARDED config is stored, not the one handed in: it is what genuinely worked, already
     * through ConfigGuard.
     *
     * Written only after a successful start, so a config that failed is never replayed.
     *
     * PRIVACY: this puts a proxy URI - and therefore a UUID or password - into app-private
     * SharedPreferences. Same exposure class as the copy already in localStorage, and covered
     * by android:allowBackup="false" plus the data-extraction rules, so `adb backup` cannot
     * reach either.
     *
     * Reuses BootReceiver's store rather than opening a second one. Note that writing
     * KEY_LAST_CONFIG does NOT switch on reconnect-after-boot: BootReceiver is gated on
     * KEY_AUTO_CONNECT, which nothing sets.
     */
    private fun rememberForRelaunch(guardedConfig: String, nodeName: String?) {
        runCatching {
            BootReceiver.preferences(this).edit()
                .putString(BootReceiver.KEY_LAST_CONFIG, guardedConfig)
                .putString(BootReceiver.KEY_LAST_NAME, nodeName ?: "")
                .apply()
        }.onFailure { NexusLog.w(TAG, "could not remember the config: ${it.message}") }
    }

    /**
     * Ask the system to re-read the tile's state.
     *
     * Called on every transition, wherever it came from - the app, the notification, or the
     * tile itself - so the tile never shows a state the tunnel is not in.
     *
     * requestListeningState is a no-op below API 24 and when the tile is not added, so it needs
     * no guard beyond the version check.
     */
    private fun notifyTileStateChanged() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.N) return
        runCatching {
            android.service.quicksettings.TileService.requestListeningState(
                this,
                android.content.ComponentName(this, NexusTileService::class.java),
            )
        }
    }

    /**
     * Tear the tunnel down. Safe to call from any thread and from anywhere.
     *
     * THE PUBLIC ENTRY POINT, used by the notification's Disconnect action and by the Quick
     * Settings tile. Both of those run when the app's UI does not exist, so neither can go
     * through the plugin or the WebView.
     *
     * The work is posted to [starter] rather than done inline. onDestroy() runs on the main
     * thread, and closing the core is a synchronous JNI call into Go that tears down the whole
     * box - blocking the main thread on it is an ANR, and an ANR during teardown is precisely
     * the "tapped Disconnect, nothing happened, VPN key still lit" symptom.
     */
    fun requestStop(source: String = "external") {
        NexusLog.i(TAG, "stop: requested (source=$source)")
        runCatching { starter.execute { stop(source) } }
            .onFailure {
                // Executor already shut down. Do it inline rather than not at all.
                NexusLog.w(TAG, "stop: executor unavailable, tearing down inline")
                stop(source)
            }
    }

    /**
     * @param source for the log only; teardown is identical whoever asked.
     */
    private fun stop(source: String) {
        if (!stopping.compareAndSet(false, true)) {
            NexusLog.d(TAG) { "stop: already in progress (source=$source)" }
            return
        }

        isRunning = false
        notifyTileStateChanged()

        powerReceiver.unregister(this)
        unregisterNetworkCallback()
        DefaultNetworkMonitor.stop()

        /*
         * TUN FIRST, CORE SECOND - the OPPOSITE of closeCore(), deliberately.
         *
         * closeCore() serves a SWAP, where the core keeps running and closing the descriptor
         * out from under it turns an orderly handover into a stream of read errors.
         *
         * This is a FINAL stop. There is nothing to hand over, and the ordering matters for a
         * different reason: the interface is created with setBlocking(true) (a battery
         * decision - see openTun), so the core's reader is parked in a blocking read on this
         * descriptor. Closing the core first means waiting for a goroutine that is waiting for
         * us. Closing the fd first unblocks it.
         *
         * Closing the fd is also what removes the system VPN key, so doing it first means the
         * user sees the tunnel go away immediately rather than after the core has finished.
         */
        tunFd?.let { runCatching { it.close() } }
        tunFd = null
        NexusLog.d(TAG) { "stop: tun closed" }

        /*
         * Bounded. A leaked Go object is strictly better than a tunnel that will not die: the
         * process is going away anyway, and the alternative is hanging here forever with the
         * interface already gone and the notification still up.
         */
        val core = service.getAndSet(null)
        if (core != null) {
            val startedAt = System.currentTimeMillis()
            val closer = Thread({ runCatching { core.close() } }, "nexus-core-close")
            closer.isDaemon = true
            closer.start()
            closer.join(CORE_CLOSE_TIMEOUT_MS)
            if (closer.isAlive) {
                NexusLog.e(TAG, "stop: core close TIMED OUT after ${CORE_CLOSE_TIMEOUT_MS}ms; continuing")
            } else {
                NexusLog.d(TAG) { "stop: core closed in ${System.currentTimeMillis() - startedAt}ms" }
            }
        }

        notification.stopForeground(this)
        NexusLog.i(TAG, "stop: foreground removed")
        stopSelf()
    }

    override fun onLowMemory() {
        super.onLowMemory()
        NexusLog.w(TAG, "system reported low memory")
    }

    override fun onRevoke() {
        // Another VPN app took over, or the user revoked consent in Settings.
        NexusLog.i(TAG, "VPN consent revoked")
        stop("onRevoke")
        super.onRevoke()
    }

    override fun onDestroy() {
        stop("onDestroy")
        instance = null
        super.onDestroy()
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        runCatching { cm.registerDefaultNetworkCallback(networkCallback) }
    }

    private fun unregisterNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        runCatching { cm.unregisterNetworkCallback(networkCallback) }
    }

    // ================================================================================
    // PlatformInterface: the VpnService-dependent half
    // ================================================================================

    /**
     * Build the TUN device and hand its fd to the core.
     *
     * Everything here is driven by [options], which the core derives from the tun inbound in
     * the config. We do not invent values — a divergence between what the core thinks the
     * interface looks like and what we actually built is a class of bug that presents as
     * "some traffic works".
     */
    /**
     * Build the TUN device and hand its fd to the core.
     *
     * EXPLICIT getX() CALLS THROUGHOUT — do not "clean this up" into Kotlin synthetic
     * properties. Kotlin only decapitalises a Java getter when the character after `get` is
     * uppercase and the next is lowercase, so `getMTU()` becomes `.MTU` (not `.mtu`) and
     * `getHTTPProxyServer()` becomes `.HTTPProxyServer`. Half these getters are acronym-led,
     * so property syntax is a coin flip per member. Calling the getters is unambiguous.
     */
    override fun openTun(options: TunOptions): Int {
        // STEP LOGGING, deliberately verbose.
        //
        // openTun runs on a GO-OWNED THREAD, not on the thread that called onStartCommand — so
        // the try/catch around onStartCommand cannot see anything that happens here, and a
        // failure surfaces as a native abort with no Java stack trace. These lines are the only
        // way to tell how far we got. Remove them once the connect path is stable.
        NexusLog.d(TAG) { "openTun: begin" }
        val builder = Builder()
            .setSession(SESSION_NAME)
            .setMtu(options.getMTU())
        NexusLog.d(TAG) { "openTun: mtu=${options.getMTU()} autoRoute=${options.getAutoRoute()} strict=${options.getStrictRoute()}" }

        var inet4Addresses = 0
        var inet6Addresses = 0
        options.getInet4Address().use { while (it.hasNext()) { val p = it.next(); builder.addAddress(p.address(), p.prefix()); inet4Addresses++ } }
        options.getInet6Address().use { while (it.hasNext()) { val p = it.next(); builder.addAddress(p.address(), p.prefix()); inet6Addresses++ } }
        val addressCount = inet4Addresses + inet6Addresses
        NexusLog.d(TAG) { "openTun: $addressCount address(es) (v4=$inet4Addresses v6=$inet6Addresses)" }

        // VpnService.establish() returns null if the interface has no address, and Android
        // gives no other warning. A config whose tun inbound omits `address` therefore fails
        // here with a message that points at consent rather than at the config.
        if (addressCount == 0) {
            throw IllegalStateException(
                "tun inbound has no address; add \"address\": [\"172.19.0.1/30\"] to the config"
            )
        }

        if (options.getAutoRoute()) {
            addDnsServers(builder, options)
            addRoutes(builder, options, inet4Addresses > 0, inet6Addresses > 0)
        }

        applyPerAppRules(builder, options)

        // Metered = false: we are a tunnel over the underlying network, not an independent
        // metered link. Reporting metered here makes apps downgrade behaviour (no prefetch,
        // no sync) even on WiFi, which users read as "the VPN broke my apps".
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false)
        }

        // System HTTP proxy, for apps that honour it but bypass the TUN.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && options.isHTTPProxyEnabled()) {
            val bypass = mutableListOf<String>()
            options.getHTTPProxyBypassDomain().use { while (it.hasNext()) bypass.add(it.next()) }
            builder.setHttpProxy(
                ProxyInfo.buildDirectProxy(
                    options.getHTTPProxyServer(),
                    options.getHTTPProxyServerPort(),
                    bypass,
                )
            )

            // Android's ProxyInfo has an exclusion list but no inclusion list, so a config that
            // sets http proxy MATCH domains cannot be honoured here. Say so rather than drop it
            // silently — a proxy that quietly ignores half its rules is a miserable thing to
            // debug from the other side.
            runCatching {
                var matchCount = 0
                options.getHTTPProxyMatchDomain().use { while (it.hasNext()) { it.next(); matchCount++ } }
                if (matchCount > 0) {
                    NexusLog.w(TAG, "config sets $matchCount http proxy match domain(s); " +
                        "Android ProxyInfo supports exclusions only, so these are ignored")
                }
            }
        }

        // setBlocking(true): reads on the fd block instead of spinning.
        //
        // This is a battery decision, not a correctness one. A non-blocking fd means the
        // reader either busy-polls or wakes on a timer; blocking means the thread parks and
        // the CPU idles until a packet actually arrives. On an idle tunnel — which, per
        // ADR-0001 §2.1, is most of the day — that is the difference between zero wakeups
        // and a continuous stream of them.
        builder.setBlocking(true)

        NexusLog.d(TAG) { "openTun: establishing" }
        val pfd = builder.establish()
            ?: throw IllegalStateException(
                "VpnService.establish() returned null — consent revoked, another VPN is active, " +
                    "or the interface has no usable address/route"
            )

        tunFd = pfd
        NexusLog.i(TAG, "openTun: established fd=${pfd.fd}")
        return pfd.fd
    }

    /**
     * DNS servers for the TUN interface.
     *
     * CHANGED IN 1.14. This was a single `getDNSServerAddress(): StringBox` in 1.12; it is now
     * `StringIterator` and it declares `throws Exception`. Kotlin has no checked exceptions, so
     * the old single-value code compiled against the new signature would have failed at
     * runtime, not build time — hence the explicit iteration and the runCatching.
     *
     * Failing to add a DNS server is not fatal: with auto_route the TUN still captures DNS
     * traffic and the core resolves it internally. Losing the builder-level hint only affects
     * apps that query the system resolver configuration directly. So we log and continue rather
     * than refusing to bring the tunnel up.
     */
    private fun addDnsServers(builder: Builder, options: TunOptions) {
        val added = runCatching {
            var count = 0
            options.getDNSServerAddress().use {
                while (it.hasNext()) {
                    val address = it.next()
                    runCatching { builder.addDnsServer(address) }
                        .onSuccess { count++ }
                        .onFailure { e -> NexusLog.w(TAG, "addDnsServer($address): ${e.message}") }
                }
            }
            count
        }.getOrElse { e ->
            NexusLog.w(TAG, "getDNSServerAddress failed: ${e.message}")
            0
        }

        // New in 1.14. Recorded, not acted on: the mode values are undocumented for us and
        // guessing at them would be worse than ignoring them. If DNS behaviour ever looks wrong
        // on device, this line is the first thing to read.
        // StringBox exposes getValue(), which Kotlin surfaces as the property `.value` —
        // calling it as .value() asks Kotlin to invoke a String, which is the error the
        // compiler reported. gomobile wraps single values in a box precisely so it can carry
        // a Go nil across the binding, so the null-safe call is still required.
        val mode = runCatching { options.getDNSMode()?.value }.getOrNull()
        NexusLog.d(TAG) { "tun dns: $added server(s), mode=${mode ?: "unset"}" }
    }

    /**
     * Install the tunnel's routes.
     *
     * ================== THE DEFAULT ROUTE IS NOT OPTIONAL ==================
     *
     * When auto_route is on and the config names no explicit route_address, the core hands back
     * EMPTY route iterators - it expects the platform to install the default route itself. This
     * function used to add only what the iterators contained, so with an empty list it added
     * nothing at all.
     *
     * The result was a tunnel that looked completely healthy and carried almost nothing:
     *
     *   - DNS worked, because queries go to 172.19.0.1:53, which IS the tun interface address,
     *     so they reach the tunnel without needing any route.
     *   - Everything else went straight out the physical interface, because nothing routed it
     *     into the tunnel. An IP-check site therefore showed the user's real address while the
     *     log showed VLESS happily resolving names through the proxy.
     *
     * That split - DNS through the tunnel, TCP around it - is the signature of this bug.
     *
     * =======================================================================
     *
     * The default route is added per address family: a v6 default on an interface with no v6
     * address would black-hole IPv6 rather than tunnel it.
     */
    private fun addRoutes(builder: Builder, options: TunOptions, hasV4: Boolean, hasV6: Boolean) {
        var v4Routes = 0
        var v6Routes = 0

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // API 33+ supports route exclusion, which lets us route everything EXCEPT a few
            // prefixes rather than enumerating hundreds of included prefixes. Fewer routes is
            // a smaller kernel routing table and a faster establish().
            options.getInet4RouteAddress().use { while (it.hasNext()) { val p = it.next(); builder.addRoute(p.toIpPrefix()); v4Routes++ } }
            options.getInet6RouteAddress().use { while (it.hasNext()) { val p = it.next(); builder.addRoute(p.toIpPrefix()); v6Routes++ } }
            options.getInet4RouteExcludeAddress().use { while (it.hasNext()) { val p = it.next(); builder.excludeRoute(p.toIpPrefix()) } }
            options.getInet6RouteExcludeAddress().use { while (it.hasNext()) { val p = it.next(); builder.excludeRoute(p.toIpPrefix()) } }
        } else {
            // Pre-33 has no excludeRoute; the core pre-computes an inclusive range set.
            options.getInet4RouteRange().use { while (it.hasNext()) { val p = it.next(); builder.addRoute(p.address(), p.prefix()); v4Routes++ } }
            options.getInet6RouteRange().use { while (it.hasNext()) { val p = it.next(); builder.addRoute(p.address(), p.prefix()); v6Routes++ } }
        }

        if (v4Routes == 0 && hasV4) {
            builder.addRoute("0.0.0.0", 0)
            v4Routes++
        }
        if (v6Routes == 0 && hasV6) {
            builder.addRoute("::", 0)
            v6Routes++
        }

        NexusLog.d(TAG) { "openTun: routes applied (v4=$v4Routes v6=$v6Routes)" }
    }

    /**
     * Per-app routing.
     *
     * ALLOW AND DISALLOW ARE MUTUALLY EXCLUSIVE. VpnService.Builder throws
     * UnsupportedOperationException the moment you call addAllowedApplication() after
     * addDisallowedApplication() (or vice versa) - the two lists cannot coexist.
     *
     * The previous version called addDisallowedApplication(ourselves) unconditionally and THEN
     * looped over includePackage. With a config that used include_package, every
     * addAllowedApplication() threw, each throw was swallowed by runCatching, and the tunnel
     * came up routing every app instead of the chosen few - silently, with only a debug line to
     * show for it. Our current configs set neither list, so this never fired; it was a trap
     * waiting for the first user who wanted per-app routing.
     *
     * Allow-list mode simply omits our own package instead of disallowing it, which achieves
     * the same exclusion without mixing the two APIs.
     */
    private fun applyPerAppRules(builder: Builder, options: TunOptions) {
        val include = mutableListOf<String>()
        options.getIncludePackage().use { while (it.hasNext()) include.add(it.next()) }
        val exclude = mutableListOf<String>()
        options.getExcludePackage().use { while (it.hasNext()) exclude.add(it.next()) }

        if (include.isNotEmpty()) {
            var applied = 0
            for (pkg in include) {
                // Never route our own traffic into our own tunnel.
                if (pkg == packageName) continue
                runCatching { builder.addAllowedApplication(pkg); applied++ }
                    .onFailure { e -> NexusLog.w(TAG, "include $pkg: ${e.message}") }
            }
            NexusLog.d(TAG) { "openTun: per-app ALLOW list, $applied of ${include.size} package(s)" }
            if (exclude.isNotEmpty()) {
                NexusLog.w(TAG, "openTun: ${exclude.size} exclude package(s) ignored - Android " +
                    "allows an allow-list OR a deny-list, never both")
            }
            return
        }

        var denied = 0
        runCatching { builder.addDisallowedApplication(packageName); denied++ }
        for (pkg in exclude) {
            runCatching { builder.addDisallowedApplication(pkg); denied++ }
                .onFailure { e -> NexusLog.w(TAG, "exclude $pkg: ${e.message}") }
        }
        NexusLog.d(TAG) { "openTun: per-app DENY list, $denied package(s) (all other apps tunnelled)" }
    }

    /**
     * Keep the core's own sockets out of the tunnel.
     *
     * Load-bearing for the `system` TUN stack (ADR-0001 §5.4): with the system stack the core
     * opens real kernel sockets on the default network, and our own default route would
     * otherwise capture them. Symptom of getting this wrong: tunnel establishes, zero traffic
     * flows.
     */
    override fun autoDetectInterfaceControl(fd: Int) {
        if (!protect(fd)) {
            throw IllegalStateException("protect($fd) failed")
        }
    }

    // findConnectionOwner / packageNameByUid / uidByPackageName were removed here in the
    // 1.14 migration.
    //
    // The first changed shape (it returns a ConnectionOwner object now, not an int uid) and the
    // other two are gone from PlatformInterface entirely. All three are handled in
    // PlatformInterfaceWrapper, which returns null for connection ownership — deliberately, per
    // ADR-0001 §5.4: process-based routing rules are a documented CPU sink
    // (SagerNet/sing-box#3934) and we do not use them.
    //
    // Per-app routing is unaffected. It is enforced by VpnService.Builder's allow/disallow
    // lists in openTun above, at the kernel level, which costs nothing per connection.

    companion object {
        private const val TAG = "NexusVpn"
        private const val SESSION_NAME = "Nexus"

        /**
         * The live service, for callers in the SAME process.
         *
         * NexusStopReceiver and NexusTileService are both declared `android:process=":core"`,
         * which is what makes this work: they share this process, so they can call teardown
         * directly instead of going back out through Android's service APIs - where a
         * background start is refused and stopService() only reaches us via onDestroy() on the
         * main thread.
         *
         * Null whenever the service is not created. Callers must handle that.
         */
        @Volatile
        var instance: NexusVpnService? = null
            private set

        /**
         * Is a tunnel up? Read by the Quick Settings tile.
         *
         * A plain static works ONLY because the tile shares this process. Declared in the
         * default process it would always read false, and the tile would show disconnected
         * over a live tunnel.
         */
        @Volatile
        var isRunning: Boolean = false
            private set

        /**
         * How long to wait for the Go core to close before giving up on it.
         *
         * Generous, because a clean close releases the cache-file lock the next start needs.
         * Bounded, because the tunnel must die even if the core will not.
         */
        private const val CORE_CLOSE_TIMEOUT_MS = 5_000L

        const val ACTION_START = "io.nexus.plugin.START"
        const val ACTION_STOP = "io.nexus.plugin.STOP"
        const val ACTION_RELOAD = "io.nexus.plugin.RELOAD"
        const val ACTION_UI_FOREGROUND = "io.nexus.plugin.UI_FOREGROUND"
        const val EXTRA_CONFIG = "config"

        /**
         * Display name of the node, for the notification body.
         *
         * Passed in rather than derived because the name lives in the UI layer: it comes from
         * the `#fragment` of the subscription link, and the config the core runs has no field
         * for it. Deriving one here would mean re-parsing a URI the service never sees.
         */
        const val EXTRA_NODE_NAME = "nodeName"

        // bbolt opens the cache file with a 1s flock timeout. Three attempts, 400 ms apart,
        // bounds a stale lock at ~2s of retrying instead of a hard failure.
        private const val CACHE_LOCK_ATTEMPTS = 3
        private const val CACHE_LOCK_BACKOFF_MS = 400L
        const val EXTRA_FOREGROUND = "foreground"
    }
}

// ---- small helpers ------------------------------------------------------------------

/** gomobile iterators are not Closeable; this just gives us a `use {}` shape for readability. */
private inline fun <T> T.use(block: (T) -> Unit) = block(this)

@androidx.annotation.RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun io.nexus.libbox.RoutePrefix.toIpPrefix(): IpPrefix =
    IpPrefix(InetAddress.getByName(address()), prefix())
