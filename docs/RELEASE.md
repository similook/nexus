# Releasing

Checklist for cutting a public release. Written for v1.0.0, reusable after.

---

## 0. First release only: create the repo

There is no git repository yet, and the working tree contains ~165 MB of things that must not
be committed (`node_modules`, the 20 MB AAR, build output). `.gitignore` at the repo root
already covers them — **check it landed before the first `git add`**, because removing a large
binary from history afterwards means rewriting it.

```bash
cd "C:/app/New folder/Nexus"
git init
git add .gitignore
git status --short | head -40          # sanity-check what is about to be staged
```

Look for `node_modules`, `*.aar`, `*.apk`, `*.jks` or `keystore.properties` in that output. If
any appear, stop and fix `.gitignore` first.

```bash
git add .
git commit -m "Nexus v1.0.0"
git branch -M main
git remote add origin git@github.com:similook/nexus.git
git push -u origin main
```

The links in `.github/ISSUE_TEMPLATE/config.yml` already point at `similook/nexus`. If the
repository is ever renamed or transferred, they need updating with it.

---

## 1. Build the release APK

```bash
cd core && ./scripts/build-android.sh
cd ../clients/web && npm ci && npm run build && npx cap sync android
cd android && ./gradlew clean assembleRelease
```

---

## 2. Verify it is actually signed — do not skip this

`assembleRelease` produces an **unsigned** APK when `keystore.properties` is missing, and the
two files differ by one word in a filename that is easy to miss at 2am.

```bash
ls app/build/outputs/apk/release/
```

| You see | Meaning |
|---|---|
| `app-release.apk` | Signed. Good. |
| `app-release-unsigned.apk` | **No keystore was found.** Do not upload this — it cannot be installed. |

Confirm the signature rather than trusting the filename:

```bash
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

It must print a certificate. If it says "does not verify", the APK is unsigned.

Also confirm what you are shipping:

```bash
"$ANDROID_HOME/build-tools/34.0.0/aapt" dump badging \
  app/build/outputs/apk/release/app-release.apk | grep -E "^package|native-code|launchable"
```

Expect `versionName='1.0.0'`, `native-code: 'arm64-v8a'`, and **exactly one**
`launchable-activity`. Two means two launcher icons on the user's phone.

### Install it on a real device before tagging

A release APK is not a debug APK. It is signed with a different key, so it installs alongside
rather than over your debug build — uninstall that first:

```bash
adb uninstall io.nexus.app
adb install app/build/outputs/apk/release/app-release.apk
```

Then actually connect with it. `minifyEnabled` is off precisely because R8 would strip the
gomobile JNI classes, and that failure only appears in a release build, at connect time.

---

## 3. Checksum

```bash
sha256sum app/build/outputs/apk/release/app-release.apk
```

Put the result in the release notes. Users on a censored network are downloading a
circumvention tool over a network run by the people it circumvents; a checksum is the only way
they can tell whether what arrived is what you built.

---

## 3a. Sign the update manifest

Installed copies learn about a release from `update-android.json`: a manifest (version,
versionCode, ABI, minSdk, the APK's name, size and SHA-256) signed with the update key, ECDSA
P-256. The app checks it once per launch against the public key compiled into it
(`UPDATE_PUBLIC_KEY` in `clients/web/src/core/update.ts`) and ignores anything that does not
verify. HTTPS and GitHub are not what users trust here; the key is.

After renaming the APK (§5):

```bash
cd clients/web
npx tsx scripts/update-manifest.mts sign \
  --key "$HOME/.nexus/update-signing/nexus-update-signing-key.pem" \
  --apk nexus-v1.1.0-arm64.apk --version 1.1.0 --version-code 6 \
  --out update-android.json
```

`--version` and `--version-code` must be the APK's own `versionName` and `versionCode` (the aapt
line in §2). Add `--channels github,play` only once that versionCode is live on Play: a Play
install is sent to Play, and would otherwise be told about an update Play does not have yet.

The tool refuses any key other than the compiled-in one, and opens the result with the app's
own verifier before writing it.

**The private key never enters this repository**, is never printed, and cannot be recovered.
Back it up offline with the keystore. Replacing it strands every installed copy: they reject
anything signed with a new key until the user installs, by hand, a release carrying the new
public key.

---

## 4. Tag

Tag the commit you actually built from, not whatever is on `main` afterwards.

```bash
git tag -a v1.0.0 -m "Nexus v1.0.0"
git push origin v1.0.0
```

`-a` makes an annotated tag — it carries an author, a date and a message, and it is what
`git describe` and GitHub's release UI expect. A lightweight tag is just a moving pointer.

---

## 5. Create the release

GitHub → **Releases** → **Draft a new release**.

- **Tag:** `v1.0.0` (select the existing tag; do not let it create a new one)
- **Title:** `Nexus v1.0.0`
- **Attach:** `app-release.apk` — rename it to `nexus-v1.0.0-arm64.apk` first. A file called
  `app-release.apk` in someone's Downloads folder six months from now is unidentifiable, and the
  ABI in the name saves a support round-trip.
- **Attach:** `update-android.json` (§3a), and keep one on **every** release marked latest,
  desktop-only ones included. The app reads `releases/latest/download/update-android.json`; a
  latest release without it means no installed copy hears about any update.
- **Set as the latest release:** yes. The README links `../../releases/latest`.
- **Pre-release:** no, unless you want it hidden from that link.

---

## 6. Release notes

Keep it short and in the user's terms. They want to know whether to install it, not what you
refactored.

```markdown
First public release.

An Android client for VLESS, VMess, Trojan, Shadowsocks, Hysteria2 and TUIC, built on
sing-box 1.14. Designed around idle battery cost rather than peak throughput.

### What it does

- **Protocols** — VLESS (REALITY, XTLS Vision), VMess, Trojan, Shadowsocks, Hysteria2, TUIC,
  over TCP, WebSocket, gRPC, HTTPUpgrade and QUIC.
- **Import that survives real links** — paste a subscription URL or config links into one
  field; the app works out which. Links glued together with no newlines are split correctly,
  and surrounding text is ignored.
- **QR scanning** for configs and subscription links.
- **Test every node at once** — concurrent native TCP probes that do not touch an active
  tunnel, so you can measure while connected.
- **Per-node details, editing and sharing**, including QR export.

### Privacy

- **FakeIP routing.** No app on the device ever holds a real IP for a hostname, so a poisoned
  DNS cache has nothing to poison.
- **Poisoned answers are refused**, not dialled — an RFC1918 or loopback reply for your server
  is reported instead of silently producing a tunnel that carries nothing.
- **IPv6 cannot leak around the tunnel.** It is routed in and fails closed if the proxy cannot
  carry it.
- **No cloud backup.** Your subscription URL and UUIDs cannot be extracted with `adb backup`.
- **No telemetry.** No analytics, no crash reporting, no advertising ID.

### Known limitations

- Android only, `arm64-v8a` only, Android 5.1+.
- gVisor's CPU cost is not yet measured — no battery figure is claimed.
- v2ray `headerType` obfuscation other than `http` is unsupported; those nodes are refused at
  import with a reason.

### Install

Download the APK below and allow installation from unknown sources.

`SHA-256: <paste>`

Verify before installing:

    sha256sum nexus-v1.0.0-arm64.apk
```

---

## 7. After publishing

- [ ] Download the asset from the release page and check the SHA-256 matches. This catches an
      upload that silently truncated.
- [ ] Check it against the signed manifest too, from `clients/web`:
      `npx tsx scripts/update-manifest.mts verify update-android.json --apk <downloaded apk>`.
      It must say the signature is OK and the APK matches the signed size and SHA-256.
- [ ] Install that downloaded file on a clean device and connect once.
- [ ] Open the two links in `.github/ISSUE_TEMPLATE/config.yml` and confirm they resolve.
- [ ] Enable **Discussions** if you referenced it there.
- [ ] Back the keystore up somewhere that is not this machine. Losing it means the app can never
      be updated under this package name again — not on GitHub, not on Play, not on GetApps.

---

## Subsequent releases

Bump both, in `clients/web/android/app/build.gradle`:

```gradle
versionCode 2          // must increase every release; stores reject a repeat
versionName "1.1.0"
```

`versionCode` is what Android and every store compare to decide "is this an upgrade".
`versionName` is only ever shown to humans. They are independent, and forgetting the first is
the classic way to ship an update nobody can install.
