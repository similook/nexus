package io.nexus.plugin

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.system.OsConstants
import io.nexus.libbox.BridgeOptions
import io.nexus.libbox.BridgeSession
import io.nexus.libbox.ConnectionOwner
import io.nexus.libbox.InterfaceUpdateListener
import io.nexus.libbox.LocalDNSTransport
import io.nexus.libbox.NeighborUpdateListener
import io.nexus.libbox.NetworkInterfaceIterator
import io.nexus.libbox.PlatformInterface
import io.nexus.libbox.PlatformUser
import io.nexus.libbox.ShellSession
import io.nexus.libbox.StringIterator
import io.nexus.libbox.WIFIState
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NetworkInterface

/**
 * Kotlin implementation of libbox's PlatformInterface, for sing-box 1.14.
 *
 * The 1.14 surface is much larger than 1.12's: it gained a shell/SSH-server family, a Tailscale
 * family, a bridge family and a neighbour monitor, and it LOST packageNameByUid,
 * uidByPackageName, writeLog and systemCertificates. findConnectionOwner now returns a
 * ConnectionOwner object rather than an int uid.
 *
 * Implemented as an interface with defaults so NexusVpnService picks up the whole surface and
 * overrides only the two methods that need the service instance: openTun and
 * autoDetectInterfaceControl.
 *
 * ======================= READ BEFORE "SIMPLIFYING" ANY OF THIS =======================
 *
 * It is tempting to stub every method to a safe-looking default so the project compiles
 * cleanly. Three of those defaults produce an app that builds, installs, runs — and moves zero
 * bytes, with no error anywhere to tell you why. Each is marked LOAD-BEARING below. If you are
 * pasting a generated skeleton over this file, re-apply those three first.
 *
 * =====================================================================================
 */
internal interface PlatformInterfaceWrapper : PlatformInterface {

    /** Set by NexusVpnService; used by the default implementations below. */
    val platformContext: Context?

    // ===== TUN =========================================================================
    // openTun and autoDetectInterfaceControl are overridden by NexusVpnService — they need
    // VpnService.Builder and VpnService.protect().

    /**
     * LOAD-BEARING. Must be true.
     *
     * True tells the core to call autoDetectInterfaceControl() for every socket it opens, which
     * is where we call VpnService.protect(fd).
     *
     * With ADR-0001 §5.4's `system` TUN stack the core opens REAL kernel sockets on the default
     * network. Unprotected, our own default route captures them and they loop back into the
     * tunnel. The symptom is a tunnel that establishes, shows "Connected", and passes no
     * traffic — which reads like a server or config problem and is not one.
     *
     * A generated skeleton will default this to false. That is the single most expensive
     * wrong default on this interface.
     */
    override fun usePlatformAutoDetectInterfaceControl(): Boolean {
        NexusLog.d(TAG_PLATFORM) { "usePlatformAutoDetectInterfaceControl -> true" }
        return true
    }

    // ===== process / connection ownership ==============================================

    /**
     * LOAD-BEARING. Must be false.
     *
     * True makes the core walk /proc/net/{tcp,tcp6,udp,udp6} to attribute connections: a
     * directory scan plus a linear search PER CONNECTION. That is continuous CPU on a busy
     * device, and CPU is battery — the one thing this product is measured on (ADR-0001 §2).
     *
     * A generated skeleton will often default this to true "because Android". Do not.
     */
    override fun useProcFS(): Boolean = false

    /**
     * Returns null: Nexus does not do process-based routing.
     *
     * This is a design decision, not a gap. ADR-0001 §5.4 rules out `process_name` /
     * `find_process` routing rules because owner lookup per connection is a documented CPU sink
     * (SagerNet/sing-box#3934). With no such rules in our configs the core never needs an owner,
     * so null is never reached in practice.
     *
     * Per-app routing still works — it is enforced by VpnService.Builder's allow/disallow lists
     * in openTun, at the kernel level, which costs nothing per connection.
     *
     * If a future feature genuinely needs this, implement it with
     * ConnectivityManager.getConnectionOwnerUid (API 29+), never with procfs, and measure it in
     * bench/B-04 before shipping.
     */
    override fun findConnectionOwner(
        ipProtocol: Int,
        sourceAddress: String?,
        sourcePort: Int,
        destinationAddress: String?,
        destinationPort: Int,
    ): ConnectionOwner = throw NotSupported.CONNECTION_OWNER

    // ===== network monitoring ==========================================================

    override fun startDefaultInterfaceMonitor(listener: InterfaceUpdateListener?) {
        listener ?: return
        DefaultNetworkMonitor.start(listener)
    }

    override fun closeDefaultInterfaceMonitor(listener: InterfaceUpdateListener?) {
        DefaultNetworkMonitor.stop()
    }

    /**
     * Neighbour (ARP/NDP) monitoring — for Tailscale-style peer discovery on a LAN.
     *
     * Not started. It is a periodic scan of the local network, which is a wakeup source, and
     * nothing in our feature set consumes it. Turning it on would cost battery for a feature we
     * do not ship.
     */
    override fun startNeighborMonitor(listener: NeighborUpdateListener?) = Unit

    override fun closeNeighborMonitor(listener: NeighborUpdateListener?) = Unit

    override fun getInterfaces(): NetworkInterfaceIterator? {
        NexusLog.d(TAG_PLATFORM) { "getInterfaces" }
        val interfaces = runCatching {
            NetworkInterface.getNetworkInterfaces().asSequence().map { iface ->
                io.nexus.libbox.NetworkInterface().apply {
                    name = iface.name
                    index = runCatching { iface.index }.getOrDefault(-1)
                    mtu = runCatching { iface.mtu }.getOrDefault(0)
                    // mapNotNull, not map: a single malformed entry must cost us that entry,
                    // not the process. See formatPrefix.
                    addresses = StringArrayIterator(
                        iface.interfaceAddresses.mapNotNull {
                            formatPrefix(it.address, it.networkPrefixLength.toInt())
                        }
                    )
                    flags = buildInterfaceFlags(iface)
                }
            }.toList()
        }.getOrElse { emptyList() }

        return NetworkInterfaceArrayIterator(interfaces)
    }

    /**
     * The core tells us the name of the TUN interface it just created.
     *
     * No-op: we already hold the ParcelFileDescriptor from openTun, which is the only handle we
     * need. Kept as a hook in case per-interface routing ever needs the name.
     */
    override fun registerMyInterface(name: String?) = Unit

    // ===== DNS =========================================================================

    /**
     * Null: the core uses its own DNS client rather than delegating to Android's resolver.
     *
     * Delegating would route DNS through the platform, which on Android means the system
     * resolver's cache and its own network attribution — outside the tunnel's control, and a
     * leak surface. The core's resolver stays inside the tunnel where the routing rules apply.
     */
    /**
     * Null: the core uses its own DNS client rather than delegating to Android's resolver.
     *
     * CANNOT THROW — the Java signature has no `throws`, so null is the only way to say "no",
     * and there is no error channel to use instead. That makes this one of only two places on
     * this interface where we hand Go a nil it must nil-check itself.
     *
     * Evidence it does: the core reached HijackDNSPacket (it was in the FindConnectionOwner
     * crash trace) without dying here first, so libbox guards this one. Verified by behaviour,
     * not by reading upstream — if DNS ever starts aborting the process, this is the first
     * suspect and the fix is to implement a real LocalDNSTransport. gomobile maps a Kotlin null onto a nil Go interface, and
     * if libbox calls a method on it without a nil check the result is a Go nil-pointer panic —
     * which aborts the PROCESS and cannot be caught by any Kotlin try/catch. The upstream
     * sing-box Android client returns a real LocalResolver here rather than null.
     *
     * Logged so the trace shows whether the core asked for it at all before dying.
     */
    override fun localDNSTransport(): LocalDNSTransport? {
        NexusLog.d(TAG_PLATFORM) { "localDNSTransport -> null" }
        return null
    }

    /**
     * No-op. Android exposes no API to flush the system DNS cache, and the core's own cache is
     * reset by the network-change path.
     */
    override fun clearDNSCache() = Unit

    // ===== platform facts ==============================================================

    /** Android has no Network Extension. This drives the Go-side memory budget split. */
    override fun underNetworkExtension(): Boolean = false

    /** Apple-only concept. */
    override fun includeAllNetworks(): Boolean = false

    // ===== WiFi ========================================================================

    /**
     * Only ever called when the loaded config actually routes on SSID/BSSID — the core asks via
     * NeedWIFIState() first. That gate matters: reading WiFi state needs location permission on
     * modern Android, and a VPN app should not prompt for location unless a rule needs it.
     */
    @SuppressLint("MissingPermission")
    override fun readWIFIState(): WIFIState? {
        val context = platformContext ?: return null
        val wifi = context.applicationContext
            .getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
        val info = runCatching { wifi.connectionInfo }.getOrNull() ?: return null

        var ssid = info.ssid ?: return null
        if (ssid.length > 1 && ssid.startsWith("\"") && ssid.endsWith("\"")) {
            ssid = ssid.substring(1, ssid.length - 1)
        }
        if (ssid == "<unknown ssid>") return null

        return WIFIState(ssid, info.bssid ?: "")
    }

    // ===== notifications ===============================================================

    override fun sendNotification(notification: io.nexus.libbox.Notification?) {
        NexusLog.d(TAG_PLATFORM) { "core notification: ${notification?.title}" }
    }

    override fun cancelNotification(identifier: String?, type: Int) = Unit

    // ===== shell / SSH server ==========================================================
    //
    // ALL DISABLED, and this is a security posture rather than laziness.
    //
    // sing-box can act as an SSH server and expose a shell. That is a reasonable feature for a
    // box you administer; it is an unacceptable attack surface inside a consumer VPN client
    // shipped to phones, where a malicious or compromised config would be the thing enabling
    // it. Refuse at the platform boundary so no config can turn it on.
    //
    // If a debugging need ever appears, gate it behind a debug build — never behind config.

    override fun usePlatformShell(): Boolean = false

    override fun checkPlatformShell() = Unit

    override fun openShellSession(
        user: PlatformUser?,
        command: String?,
        environ: StringIterator?,
        term: String?,
        rows: Int,
        cols: Int,
    ): ShellSession = throw NotSupported.SHELL

    override fun lookupUser(username: String?): PlatformUser = throw NotSupported.SHELL

    override fun readSystemSSHHostKey(): String = ""

    override fun lookupSFTPServer(): String = ""

    // ===== bridge / Tailscale ==========================================================

    /** Not used. The bridge is for embedding sing-box inside another transport host. */
    override fun usePlatformBridge(): Boolean = false

    override fun createBridge(options: BridgeOptions?): BridgeSession = throw NotSupported.BRIDGE

    /**
     * Empty: Nexus does not join a Tailscale network.
     *
     * 1.14 vendors Tailscale, which is why this method (and the neighbour monitor) exist. It
     * also explains the size of the dependency tree. We use none of it — but note that it is
     * compiled into the AAR regardless, which is worth remembering when reading bench/B-03.
     */
    override fun tailscaleHostname(): String = ""
}

/**
 * Pre-allocated "not supported" exceptions.
 *
 * WHY THROW AND NOT RETURN NULL
 *
 * gomobile maps a Kotlin null onto a nil Go pointer. libbox does NOT nil-check what
 * PlatformInterface hands back — it dereferenced our null ConnectionOwner and aborted the
 * process:
 *
 *   panic: runtime error: invalid memory address or nil pointer dereference
 *   libbox.(*platformInterfaceWrapper).FindConnectionOwner(...)  service.go:226
 *   route.(*Router).HijackDNSPacket(...)
 *
 * Every method here declares `throws java.lang.Exception`, which means gomobile generated a Go
 * signature returning (T, error). A Kotlin exception therefore becomes an ordinary Go error
 * that libbox handles, instead of a nil it walks off the end of.
 *
 * WHY SINGLETONS WITH NO STACK TRACE
 *
 * findConnectionOwner is called from the DNS hijack path — potentially once per packet. Filling
 * in a stack trace is the expensive part of constructing a Java exception, and doing it per
 * packet on a device whose primary product metric is battery would be a poor trade. The
 * four-argument Throwable constructor lets us disable it; these instances are built once and
 * reused.
 *
 * They carry no per-call detail for the same reason. If you need to know which lookup failed,
 * log at the call site rather than making these expensive again.
 */
private object NotSupported {
    val CONNECTION_OWNER: Exception = NoTrace("nexus: process lookup is disabled (ADR-0001 §5.4)")
    val SHELL: Exception = NoTrace("nexus: shell and SSH server are disabled on mobile")
    val BRIDGE: Exception = NoTrace("nexus: platform bridge is not used")

    private class NoTrace(message: String) :
        Exception(message, null, false, /* writableStackTrace = */ false)
}

private const val TAG_PLATFORM = "NexusPlatform"

/**
 * Format one address as "ip/prefix" for the Go core, or null if it cannot be represented.
 *
 * ===================== WHY THE ZONE HAS TO GO =====================
 *
 * Android's InetAddress.getHostAddress() returns IPv6 link-local addresses WITH a scope/zone
 * id: `fe80::c6f:82ff:fe23:2ee8%dummy0`. Go's net/netip rejects a zone inside a prefix, and
 * libbox parses these with MustParsePrefix — the Must variant, which panics instead of
 * returning an error:
 *
 *   panic: netip.ParsePrefix("fe80::c6f:82ff:fe23:2ee8%dummy0/64"):
 *          IPv6 zones cannot be present in a prefix
 *   libbox.(*platformInterfaceWrapper).NetworkInterfaces(...)
 *
 * A Go panic aborts the whole process, and it happens on a Go thread, so nothing on the Kotlin
 * side can catch it. Every Android device has at least one link-local IPv6 address, so this
 * fired the instant the core enumerated interfaces — immediately after openTun succeeded.
 *
 * Stripping the zone is correct, not just expedient: the zone disambiguates which interface a
 * link-local address belongs to, and the core already knows that from the interface name and
 * index it is being handed alongside.
 *
 * ==================================================================
 *
 * The other validation here exists for the same reason. libbox uses the panicking parser on
 * host-supplied strings, so ANY formatting quirk we pass through is a process abort rather
 * than an error. That makes filtering on our side the correct posture regardless of this one
 * bug: never hand the core a string it might refuse.
 */
private fun formatPrefix(address: InetAddress?, prefixLength: Int): String? {
    val host = address?.hostAddress ?: return null

    // Strip the zone: everything from '%' onward.
    val bare = host.substringBefore('%')
    if (bare.isEmpty()) return null

    // A prefix length outside the family's range would also fail to parse.
    val max = if (address is Inet6Address) 128 else 32
    if (prefixLength < 0 || prefixLength > max) {
        NexusLog.w(TAG_PLATFORM, "dropping $bare: prefix length $prefixLength out of range for /$max")
        return null
    }

    return "$bare/$prefixLength"
}

private fun buildInterfaceFlags(iface: NetworkInterface): Int {
    var flags = 0
    runCatching { if (iface.isUp) flags = flags or OsConstants.IFF_UP }
    runCatching { if (iface.isLoopback) flags = flags or OsConstants.IFF_LOOPBACK }
    runCatching { if (iface.isPointToPoint) flags = flags or OsConstants.IFF_POINTOPOINT }
    return flags
}

/** gomobile iterators are pull-based; these adapt Kotlin collections onto that shape. */
internal class StringArrayIterator(private val values: List<String>) : StringIterator {
    private var cursor = 0
    override fun len(): Int = values.size
    override fun hasNext(): Boolean = cursor < values.size
    override fun next(): String = values[cursor++]
}

internal class NetworkInterfaceArrayIterator(
    private val values: List<io.nexus.libbox.NetworkInterface>,
) : NetworkInterfaceIterator {
    private var cursor = 0
    override fun hasNext(): Boolean = cursor < values.size
    override fun next(): io.nexus.libbox.NetworkInterface = values[cursor++]
}

/**
 * Default-network monitor.
 *
 * One ConnectivityManager callback for the whole process. The core is told about changes; it
 * does not poll. Same principle as the Go-side coalescer — an event source the platform already
 * maintains costs us nothing, a poller costs a wakeup per interval.
 */
internal object DefaultNetworkMonitor {

    /**
     * Reports the UNDERLYING physical network to the core - never our own VPN.
     *
     * ========================= WHY THE VPN MUST BE FILTERED =========================
     *
     * Once VpnService.establish() succeeds, Android makes the VPN the system default network.
     * registerDefaultNetworkCallback() then hands us tun0, and if we forward that to the core
     * the log reads:
     *
     *   network: updated default interface rmnet4, index 19, type wifi     <- correct
     *   network: updated default interface tun0, index 393, type wifi      <- our own tunnel
     *   router: process DNS packet: ...: dial UDP connection: no available network interface
     *
     * sing-box is behaving correctly there: it refuses to dial out through the interface it is
     * serving, because that is a routing loop. Told the tunnel is the only network, it is left
     * with nowhere to go and every packet fails. The tunnel looks up, DNS looks alive, and not
     * one byte leaves the device.
     *
     * So we register a request that requires NET_CAPABILITY_NOT_VPN. Android then only ever
     * tells us about physical networks, and the VPN coming up cannot displace them.
     *
     * ===============================================================================
     */
    private var manager: ConnectivityManager? = null
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var listenerRef: InterfaceUpdateListener? = null

    fun attach(context: Context) {
        manager = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    }

    fun start(listener: InterfaceUpdateListener) {
        val cm = manager ?: return
        stop()
        listenerRef = listener

        // NOT_VPN is the whole fix. INTERNET keeps us off transport-only links that cannot
        // carry traffic.
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) = publish(cm, listener)
            override fun onLost(network: android.net.Network) = publish(cm, listener)
            override fun onCapabilitiesChanged(
                network: android.net.Network,
                caps: NetworkCapabilities,
            ) = publish(cm, listener)
        }
        callback = cb

        runCatching { cm.registerNetworkCallback(request, cb) }
            .onFailure { NexusLog.w(TAG_NETWORK, "registerNetworkCallback failed", it) }

        // Publish once immediately: callbacks only fire on CHANGES, and the physical network
        // is usually already up by the time the tunnel starts.
        publish(cm, listener)
    }

    /**
     * Choose the best non-VPN network and hand it to the core.
     *
     * Preference order is deliberate: a validated network (one Android has confirmed reaches
     * the internet) beats a merely-connected one, because dialling out over a captive portal
     * or a dead link fails in ways that look like a broken tunnel.
     */
    private fun publish(cm: ConnectivityManager, listener: InterfaceUpdateListener) {
        val best = pickUnderlying(cm)
        if (best == null) {
            NexusLog.i(TAG_NETWORK, "no non-VPN network available")
            listener.updateDefaultInterface("", -1, false, false)
            return
        }

        val link = cm.getLinkProperties(best)
        val caps = cm.getNetworkCapabilities(best)
        val name = link?.interfaceName
        if (name.isNullOrEmpty()) return

        val index = runCatching { NetworkInterface.getByName(name)?.index ?: -1 }.getOrDefault(-1)

        val expensive = caps != null &&
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        // Always false, and deliberately explicit about it. This previously derived from
        // NOT_VPN, which was meaningless even then and is now guaranteed false because the
        // request already filters VPNs out. Android 15's real "constrained network" capability
        // is a different constant; wire it up when we target that API, rather than passing a
        // value that looks computed but is not.
        val constrained = false

        NexusLog.d(TAG_NETWORK) { "default -> $name (index $index, expensive=$expensive)" }
        listener.updateDefaultInterface(name, index, expensive, constrained)
    }

    /** The best physical network, or null if the device genuinely has none. */
    private fun pickUnderlying(cm: ConnectivityManager): android.net.Network? {
        val candidates = runCatching { cm.allNetworks.toList() }.getOrDefault(emptyList())
            .filter { n ->
                val caps = cm.getNetworkCapabilities(n) ?: return@filter false
                !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }

        return candidates.firstOrNull { n ->
            cm.getNetworkCapabilities(n)
                ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        } ?: candidates.firstOrNull()
    }

    fun stop() {
        val cm = manager ?: return
        callback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
        callback = null
        listenerRef = null
    }
}

private const val TAG_NETWORK = "NexusNetwork"
