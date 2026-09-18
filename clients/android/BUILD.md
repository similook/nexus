# Android build guide — from source to APK on a device

Everything here is **unbuilt code being compiled for the first time**. No part of this pipeline
has run in the development environment (no Go toolchain, no Android SDK). Expect the first pass
to fail at §1 and §5; both have a dedicated troubleshooting section.

Work in this order. Each phase produces an artifact the next one needs.

---

## 0. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Go | 1.25+ | `go version` |
| Android SDK | platform 34+ | Android Studio → SDK Manager |
| Android NDK | r26+ | SDK Manager → SDK Tools → NDK (Side by side) |
| JDK | 17 | `java -version` |
| Node | 20+ | `node --version` |

```bash
export ANDROID_HOME="$HOME/AppData/Local/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
export PATH="$PATH:$(go env GOPATH)/bin"
```

On Windows use Git Bash for every shell command below. Set the same variables in Android
Studio (File → Settings → Build → Build Tools → Gradle → Gradle JDK = 17).

---

## 1. Build the Go core into an AAR

### 1a. Verify the libbox API before anything else

The Go in `core/nexuscore/` was written against **published 1.12-era libbox docs** while
`go.mod` pins **1.14**. The `SetupOptions` literal in `nexuscore.go` is expected to fail.

```bash
cd "C:/app/New folder/Nexus/core"
go mod tidy
./scripts/verify-api.sh
```

This prints the real `SetupOptions`, `PlatformInterface`, `BoxService` and command types from
the pinned module, then tries `go build ./nexuscore/`. Reconcile `nexuscore.go` against what it
prints. Drift is confined to two places by design: the `SetupOptions` literal, and the `pauser`
interface in `power.go`.

**Do not skip this.** Every later phase depends on the AAR, and a signature mismatch here
surfaces as a confusing Kotlin error three phases downstream.

### 1b. Install gomobile

```bash
go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest
gomobile init
```

`gomobile init` is a no-op on recent versions that use the NDK directly. If it errors about a
missing NDK, `ANDROID_NDK_HOME` is wrong.

### 1c. Build

```bash
cd "C:/app/New folder/Nexus/core"
./scripts/build-android.sh
```

Produces `core/build/android/nexus.aar` (expect 30–60 MB — it contains four ABIs of the Go
runtime plus the whole core).

The script binds `libbox` **and** `nexuscore` in one `gomobile bind` invocation. They must be
bound together: a bound function may only take parameters whose types come from bound packages,
and `NewService` takes a `libbox.PlatformInterface`. Binding them separately produces an AAR
that will not link.

### 1d. Record the generated names

```bash
unzip -o core/build/android/nexus.aar -d /tmp/nexus-aar
javap -classpath /tmp/nexus-aar/classes.jar io.nexus.libbox.PlatformInterface
javap -classpath /tmp/nexus-aar/classes.jar io.nexus.libbox.StatusMessage
javap -classpath /tmp/nexus-aar/classes.jar io.nexus.nexuscore.Service
```

Every `io.nexus.libbox.*` reference in the Kotlin is gomobile's *predicted* mangling of the Go
API (leading capital lowercased, `int32` → `int`, `error` → thrown exception). Reconcile now,
while the errors are in one place.

### If §1 fails

| Symptom | Cause |
|---|---|
| `cannot find package .../experimental/libbox` | `go mod tidy` not run, or the pinned version has no such path |
| `unknown field CommandServerListenPort` | expected — see §1a |
| `gomobile: no NDK found` | `ANDROID_NDK_HOME` unset or pointing at a non-existent version |
| `binding only supports...` on a signature | a bound function uses a type gomobile cannot map; see `core/README.md` "gomobile type restrictions" |

---

## 2. Generate the Capacitor Android project

```bash
cd "C:/app/New folder/Nexus/clients/web"
npm install
npm run build
npx cap add android
npx cap sync android
```

`cap add android` scaffolds `clients/web/android/`. `cap sync` copies `dist/` into
`android/app/src/main/assets/public/` and regenerates `capacitor.plugins.json`.

Re-run **`npm run build && npx cap sync android`** after every web change. `cap sync` alone
copies a stale `dist/`.

---

## 3. Add Kotlin support

Capacitor generates a **Java** project. Adding `.kt` files without this step fails with
`Unresolved reference` on every Kotlin import.

**`android/build.gradle`** — in `buildscript.dependencies`:

```gradle
classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.24'
```

**`android/app/build.gradle`** — directly under the existing `apply plugin` lines:

```gradle
apply plugin: 'com.android.application'
apply plugin: 'kotlin-android'
```

---

## 4. Place the plugin sources

The plugin goes **into the app module**, not a separate Gradle module. Fewer moving parts for a
first build, and Capacitor plugin registration is simpler. (A library module is the better
long-term home; `nexus-plugin/build.gradle.kts` is kept for that migration.)

Package is `io.nexus.plugin`; the app id is `io.nexus.app`. They are different packages in the
same module — that is fine and intentional.

```
Nexus/clients/web/android/
├── settings.gradle
├── build.gradle                          ← §3: kotlin-gradle-plugin classpath
├── variables.gradle                      ← §6: minSdk / compileSdk
├── capacitor.settings.gradle
└── app/
    ├── build.gradle                      ← §3 kotlin-android, §5 AAR fileTree, §6 deps
    ├── libs/
    │   └── nexus.aar                     ← copy from core/build/android/
    └── src/main/
        ├── AndroidManifest.xml           ← §7: merge permissions + service + receiver
        ├── assets/public/                ← generated by cap sync, do not edit
        └── java/
            ├── io/nexus/app/
            │   └── MainActivity.java     ← generated; §8 replace with MainActivity.kt
            └── io/nexus/plugin/          ← CREATE THIS DIRECTORY
                ├── NexusPlugin.kt
                ├── NexusVpnService.kt
                ├── PlatformInterfaceWrapper.kt
                ├── PowerReceiver.kt
                ├── ConfigGuard.kt
                ├── TunnelNotification.kt
                └── BootReceiver.kt
```

```bash
cd "C:/app/New folder/Nexus"
mkdir -p clients/web/android/app/libs
cp core/build/android/nexus.aar clients/web/android/app/libs/

mkdir -p clients/web/android/app/src/main/java/io/nexus/plugin
cp clients/android/nexus-plugin/src/main/java/io/nexus/plugin/*.kt \
   clients/web/android/app/src/main/java/io/nexus/plugin/
```

All seven files are required. `PlatformInterfaceWrapper.kt`, `TunnelNotification.kt` and
`BootReceiver.kt` are not optional — `NexusVpnService` implements the first and instantiates
the second, and the manifest declares the third.

---

## 5. Link the AAR

**`android/app/build.gradle`** — Capacitor generates `fileTree` for `*.jar` only. Add `*.aar`:

```gradle
dependencies {
    implementation fileTree(include: ['*.jar', '*.aar'], dir: 'libs')
    // ... Capacitor's existing entries stay
}
```

### If the AAR does not resolve

| Symptom | Cause |
|---|---|
| `Unresolved reference: libbox` | `*.aar` missing from the `fileTree` include list |
| `UnsatisfiedLinkError: libgojni.so` | AAR built for an ABI the device does not have, or `minSdk` below the `-androidapi` used in `build-android.sh` (21) |
| `Duplicate class io.nexus.libbox...` | the AAR was copied twice, or a stale copy is in another module's `libs/` |

---

## 6. Gradle config

**`android/variables.gradle`** — Capacitor 6 defaults are close; confirm:

```gradle
minSdkVersion = 22      // must be >= the -androidapi in build-android.sh (21)
compileSdkVersion = 34  // required: FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED is API 34
targetSdkVersion = 34
```

**`android/app/build.gradle`** — add the AndroidX artifacts the Kotlin uses:

```gradle
dependencies {
    implementation fileTree(include: ['*.jar', '*.aar'], dir: 'libs')
    implementation "androidx.core:core-ktx:1.13.1"
    implementation "androidx.activity:activity-ktx:1.9.0"
}

android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = '17' }
}
```

`core-ktx` supplies `ContextCompat.registerReceiver` and `ServiceCompat.startForeground`, both
load-bearing: the first for the API-33+ receiver export flag, the second for the three-argument
`startForeground` that carries the foreground-service type.

---

## 7. Merge the manifest

Capacitor generates its own `android/app/src/main/AndroidManifest.xml`. **Do not overwrite it** —
it contains the `MainActivity` declaration and the Capacitor file provider. Merge the blocks
from `clients/android/nexus-plugin/src/main/AndroidManifest.xml` into it:

- every `<uses-permission>`, above `<application>`
- the `<queries>` block, above `<application>`
- the `<service>` and `<receiver>` elements, inside `<application>`

Two things not to "clean up":

- **`android:process=":core"`** on the service puts the core in its own process. Deliberate —
  it matches the topology iOS forces on us, so an IPC bug cannot hide on Android.
- **There is no manifest receiver for `ACTION_SCREEN_ON`/`OFF`.** The platform refuses to
  deliver those to manifest receivers. `PowerReceiver` registers at runtime from inside the
  service. Adding a manifest entry does nothing.

---

## 8. Register the plugin

Capacitor auto-registers plugins that arrive as npm packages. Ours lives in the app module, so
it must be registered by hand.

Delete the generated `MainActivity.java` and create
`android/app/src/main/java/io/nexus/app/MainActivity.kt`:

```kotlin
package io.nexus.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import io.nexus.plugin.NexusPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // MUST precede super.onCreate() — the bridge is constructed there, and a plugin
        // registered afterwards is invisible to the WebView. Symptom: every plugin call
        // rejects with "NexusCore does not have an implementation".
        registerPlugin(NexusPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
```

---

## 9. Supply a real config — the tunnel will not start without one

`src/data/servers.ts` ships `config: '{}'` placeholders. That parses, passes `ConfigGuard`, and
then fails inside sing-box with no inbound and no outbound. The UI will show "Connection
failed".

Replace the placeholder with a complete config. Template for VLESS + REALITY:

```json
{
  "log": { "level": "info" },
  "inbounds": [
    {
      "type": "tun",
      "tag": "tun-in",
      "address": ["172.19.0.1/30"],
      "mtu": 9000,
      "auto_route": true,
      "strict_route": true,
      "stack": "system"
    }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "proxy",
      "server": "YOUR_SERVER",
      "server_port": 443,
      "uuid": "YOUR_UUID",
      "flow": "xtls-rprx-vision",
      "tls": {
        "enabled": true,
        "server_name": "YOUR_SNI",
        "utls": { "enabled": true, "fingerprint": "chrome" },
        "reality": { "enabled": true, "public_key": "YOUR_PUBKEY", "short_id": "YOUR_SHORTID" }
      }
    },
    { "type": "direct", "tag": "direct" }
  ],
  "route": { "auto_detect_interface": true, "final": "proxy" }
}
```

**`"stack": "system"` is mandatory.** `ConfigGuard.enforceTunStack` rejects anything else
outright rather than rewriting it (ADR-0001 §5.4), and the rejection surfaces as
"config rejected" in logcat.

This template is written from the sing-box schema as documented and **has not been validated
against the pinned 1.14 build**. Schema details move between releases — `sniff` became a route
action in 1.11, tun `address` replaced `inet4_address` in 1.12. Validate before flashing:

```bash
sing-box check -c your-config.json
```

Embedding JSON in a `.ts` string: keep it as a single-quoted TS string with the JSON inside, or
`import config from './frankfurt.json'` and `JSON.stringify(config)`. The UI must pass it
through untouched — never synthesise or rewrite config in JS (ADR-0002 §2).

---

## 10. Build and install

```bash
cd "C:/app/New folder/Nexus/clients/web"
npm run build && npx cap sync android
npx cap open android
```

In Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)**, then drag the APK onto
the device, or:

```bash
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## 11. First-run checklist on the device

1. Launch. The amber **WEB STUB** banner must be **absent** — if it shows, `MainActivity` did
   not register the plugin and you are still on `plugin.web.ts` (§8).
2. Tap Connect → system VPN consent dialog → Allow.
3. A key icon appears in the status bar; the notification reads **Connected**.
4. The notification must **never** show live throughput. If it does, something re-added timer
   updates — that is the single most common battery mistake in VPN clients.
5. Verify traffic actually routes:
   ```bash
   adb shell dumpsys connectivity | grep -i vpn
   ```
   Then load a page in a browser and confirm the Home view's counters move.
6. `adb logcat -s NexusVpn NexusPlugin NexusPower NexusConfigGuard`

### Expected first-run failures

| Symptom | Cause |
|---|---|
| "NexusCore does not have an implementation" | `registerPlugin` after `super.onCreate` (§8) |
| Tunnel establishes, **zero traffic** | `protect(fd)` failing in `autoDetectInterfaceControl` — the loop guard the `system` stack depends on |
| `MissingForegroundServiceTypeException` | manifest `foregroundServiceType` and the `startForeground` constant disagree (§7) |
| `ForegroundServiceTypeNotAllowedException` | the system rejected `systemExempted`; confirm the service really is a `VpnService` |
| "config rejected" in logcat | `ConfigGuard` — stack is not `system`, or the JSON is malformed (§9) |
| `establish()` returned null | consent revoked, or another VPN app holds the slot |

---

## 12. Battery measurement — the actual point

Per [bench/README.md](../../bench/README.md), no perf claim enters this repo without a run.
B-01 is the one that decides whether the thesis is true.

```bash
adb shell dumpsys batterystats --reset
# disconnect USB, screen off, cellular only (Wi-Fi changes the radio term), leave 8h
adb shell dumpsys batterystats > b01-nexus-reality.txt
```

Report **wakeups/hour alongside mAh/hour**. Wakeup count is the leading indicator — it moves
before mAh does, and it is what the design can actually be optimised against.

Run the arms in `bench/README.md` §B-01. The arm that matters most is #4 — Hysteria2 with the
policy layer **off** — because it isolates how much of the win comes from our work rather than
from protocol choice. Without it, a good result proves nothing about the architecture.

To watch the power state machine live while testing:

```bash
adb shell dumpsys deviceidle force-idle     # force Doze -> expect PowerStateSuspended
adb shell dumpsys deviceidle unforce
adb logcat -s NexusPower
```
