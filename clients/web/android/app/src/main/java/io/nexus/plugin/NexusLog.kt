package io.nexus.plugin

import android.util.Log
import io.nexus.app.BuildConfig

/**
 * Logging with one rule: a release build must not record which server the user connects to.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * logcat is readable over ADB and by any app holding READ_LOGS. For an ordinary app that is a
 * support convenience. For a censorship-circumvention client it is a disclosure: the lines that
 * name a proxy host, its SNI and its transport tie a device to a specific server, and the
 * association survives in a bug report, a crash dump or a forensic pull long after the session.
 *
 * So the split is by SENSITIVITY and by USEFULNESS, not by habit:
 *
 *   d()  detail. Per-step traces, tile chatter, and anything naming the user's server.
 *        Gated on BuildConfig.DEBUG, so a release build never emits it.
 *   i()  outcomes. "the tunnel stopped", "the config was accepted" - enough to follow what
 *        happened without saying what it happened to.
 *   w()  something was wrong but recoverable.
 *   e()  something failed. Always emitted: a failure nobody can see is a failure nobody can fix.
 *
 * WHAT THIS DOES NOT TAKE AWAY
 *
 * The in-app Logs tab is unaffected. It reads the CORE's own stream over the command socket
 * into LogBuffer, not Android Log, so the GoLog output that has diagnosed nearly every bug in
 * this project still reaches users on a release build. That remains the first thing to ask for
 * in a bug report.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
internal object NexusLog {

    /**
     * Debug-only detail.
     *
     * WHY THE MESSAGE IS A LAMBDA AND THE FUNCTION IS `inline`
     *
     * A plain `d(tag, message: String)` would still BUILD the message on a release build. The
     * argument is evaluated at the call site, before the function that decides to discard it
     * ever runs - so the privacy goal is met (nothing is written) but the work is not saved.
     *
     * That is not academic here. `ConfigGuard` passes `redact(JSONObject(outbound.toString()))`,
     * a full JSON parse plus a deep rewrite, and it would run on every connect to produce a
     * string that goes nowhere. `PlatformInterfaceWrapper.getInterfaces` is on the core's hot
     * path. The per-second status tick is another.
     *
     * Inline + lambda moves the evaluation inside the branch: on a release build
     * `BuildConfig.DEBUG` is a compile-time `false`, the inlined `if` is dead, and neither the
     * string nor anything that feeds it is ever constructed. Nothing to discard, and nothing
     * to recover from a heap dump.
     */
    inline fun d(tag: String, message: () -> String) {
        if (BuildConfig.DEBUG) Log.d(tag, message())
    }

    fun i(tag: String, message: String) = Log.i(tag, message)

    fun w(tag: String, message: String) = Log.w(tag, message)

    fun w(tag: String, message: String, throwable: Throwable) = Log.w(tag, message, throwable)

    fun e(tag: String, message: String) = Log.e(tag, message)

    fun e(tag: String, message: String, throwable: Throwable) = Log.e(tag, message, throwable)
}
