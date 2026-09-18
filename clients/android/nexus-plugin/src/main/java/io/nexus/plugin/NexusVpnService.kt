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
import android.util.Log
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
        }.onFailure { Log.e(TAG, "libbox setup failed", it) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Belt and braces. Anything that escapes here is an uncaught exception on the main
        // thread inside a Service callback, which Android turns into the "app has a bug"
        // dialog — the least debuggable possible outcome for a user in the field. A logged
        // failure plus a stopped service is strictly better.
        return try {
            handleCommand(intent)
        } catch (e: Throwable) {
            Log.e(TAG, "onStartCommand failed", e)
            runCatching { notification.showError(e.message ?: e.javaClass.simpleName) }
            stop()
            START_NOT_STICKY
        }
    }

    private fun handleCommand(intent: Intent?): Int {
        when (intent?.action) {
            ACTION_START -> {
                val config = intent.getStringExtra(EXTRA_CONFIG)
                if (config.isNullOrBlank()) {
                    Log.e(TAG, "start without config")
                    stopSelf()
                    return START_NOT_STICKY
                }
                start(config, intent.getStringExtra(EXTRA_NODE_NAME))
            }

            ACTION_STOP -> {
                stop()
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
                        Log.e(TAG, "reload config rejected", e)
                        notification.showError(e.message ?: "invalid configuration")
                        return START_STICKY
                    }
                    try {
                        running.reload(guarded)
                        // Switching node while connected has to move the notification with
                        // it, or the shade keeps naming the server the user just left.
                        notification.showConnected(serverLabel(nodeName, guarded))
                    } catch (e: Exception) {
                        Log.e(TAG, "reload failed", e)
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
        if (service.get() != null) return

        // Foreground BEFORE establishing the tunnel: Android gives us a few seconds after
        // startForegroundService() to call startForeground(), and blowing that deadline is its
        // own crash (ForegroundServiceDidNotStartInTimeException).
        //
        // If every strategy was refused there is no point continuing — the OS will kill this
        // service regardless, and dying quietly with a log beats dying in a crash dialog.
        if (!notification.startForeground(this)) {
            Log.e(TAG, "could not enter foreground; aborting start")
            stopSelf()
            return
        }

        // Everything below touches the network (config pre-resolution) or takes seconds
        // (core start), so it leaves the main thread here.
        starter.execute { startCore(config, nodeName) }
    }

    private fun startCore(config: String, nodeName: String? = null) {
        // ADR-0001 §5.4 is a product decision, so it gets enforced in code rather than left
        // to whoever edits a config template. See ConfigGuard.
        val guarded = try {
            ConfigGuard.enforce(config)
        } catch (e: Exception) {
            Log.e(TAG, "config rejected", e)
            notification.showError(e.message ?: "invalid configuration")
            stopSelf()
            return
        }

        val created = try {
            Nexuscore.newService(guarded, this)
        } catch (e: Exception) {
            Log.e(TAG, "core init failed", e)
            notification.showError(e.message ?: "core failed to start")
            stopSelf()
            return
        }

        try {
            created.start()
        } catch (e: Exception) {
            Log.e(TAG, "core start failed", e)
            runCatching { created.close() }
            notification.showError(e.message ?: "core failed to start")
            stopSelf()
            return
        }

        service.set(created)

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

    private fun stop() {
        powerReceiver.unregister(this)
        unregisterNetworkCallback()
        DefaultNetworkMonitor.stop()

        service.getAndSet(null)?.let { runCatching { it.close() } }
        tunFd?.let { runCatching { it.close() } }
        tunFd = null

        notification.stopForeground(this)
        stopSelf()
    }

    override fun onLowMemory() {
        super.onLowMemory()
        Log.w(TAG, "system reported low memory")
    }

    override fun onRevoke() {
        // Another VPN app took over, or the user revoked consent in Settings.
        Log.i(TAG, "VPN consent revoked")
        stop()
        super.onRevoke()
    }

    override fun onDestroy() {
        stop()
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
        Log.i(TAG, "openTun: begin")
        val builder = Builder()
            .setSession(SESSION_NAME)
            .setMtu(options.getMTU())
        Log.i(TAG, "openTun: mtu=${options.getMTU()} autoRoute=${options.getAutoRoute()} strict=${options.getStrictRoute()}")

        var inet4Addresses = 0
        var inet6Addresses = 0
        options.getInet4Address().use { while (it.hasNext()) { val p = it.next(); builder.addAddress(p.address(), p.prefix()); inet4Addresses++ } }
        options.getInet6Address().use { while (it.hasNext()) { val p = it.next(); builder.addAddress(p.address(), p.prefix()); inet6Addresses++ } }
        val addressCount = inet4Addresses + inet6Addresses
        Log.i(TAG, "openTun: $addressCount address(es) (v4=$inet4Addresses v6=$inet6Addresses)")

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
                    Log.w(TAG, "config sets $matchCount http proxy match domain(s); " +
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

        Log.i(TAG, "openTun: establishing")
        val pfd = builder.establish()
            ?: throw IllegalStateException(
                "VpnService.establish() returned null — consent revoked, another VPN is active, " +
                    "or the interface has no usable address/route"
            )

        tunFd = pfd
        Log.i(TAG, "openTun: established fd=${pfd.fd}")
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
                        .onFailure { e -> Log.w(TAG, "addDnsServer($address): ${e.message}") }
                }
            }
            count
        }.getOrElse { e ->
            Log.w(TAG, "getDNSServerAddress failed: ${e.message}")
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
        Log.i(TAG, "tun dns: $added server(s), mode=${mode ?: "unset"}")
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

        Log.i(TAG, "openTun: routes applied (v4=$v4Routes v6=$v6Routes)")
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
                    .onFailure { e -> Log.w(TAG, "include $pkg: ${e.message}") }
            }
            Log.i(TAG, "openTun: per-app ALLOW list, $applied of ${include.size} package(s)")
            if (exclude.isNotEmpty()) {
                Log.w(TAG, "openTun: ${exclude.size} exclude package(s) ignored - Android " +
                    "allows an allow-list OR a deny-list, never both")
            }
            return
        }

        var denied = 0
        runCatching { builder.addDisallowedApplication(packageName); denied++ }
        for (pkg in exclude) {
            runCatching { builder.addDisallowedApplication(pkg); denied++ }
                .onFailure { e -> Log.w(TAG, "exclude $pkg: ${e.message}") }
        }
        Log.i(TAG, "openTun: per-app DENY list, $denied package(s) (all other apps tunnelled)")
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
        const val EXTRA_FOREGROUND = "foreground"
    }
}

// ---- small helpers ------------------------------------------------------------------

/** gomobile iterators are not Closeable; this just gives us a `use {}` shape for readability. */
private inline fun <T> T.use(block: (T) -> Unit) = block(this)

@androidx.annotation.RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun io.nexus.libbox.RoutePrefix.toIpPrefix(): IpPrefix =
    IpPrefix(InetAddress.getByName(address()), prefix())
