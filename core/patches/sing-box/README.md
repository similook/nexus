# Patches on top of the pinned sing-box

`core/go.mod` pins sing-box `v1.14.0` and replaces it with `core/third_party/sing-box`, which
`core/scripts/prepare-sing-box.sh` builds from the verified upstream release plus the patches
here. The copy is gitignored; these `.patch` files are the reviewed change.

## v1.14.0/0001-reality-support-x25519mlkem768.patch

**Problem.** sing-box's REALITY client always strips the `X25519MLKEM768` key share from the
uTLS ClientHello. REALITY servers built on XTLS/REALITY `8cdf7bf` (Xray-core v26.9.8 and
later; the current 3x-ui panel installs v26.10.10) reject any ClientHello that lacks an
`X25519MLKEM768` share placed before the optional `X25519` share, so those nodes fail with
`reality verification failed`.

**Change.** One new REALITY outbound option, `support_x25519mlkem768` (bool, default false).
When true, the strip is skipped and the fingerprint's own key shares are sent unchanged
(for `chrome`: GREASE, `X25519MLKEM768`, `X25519`). When absent or false, the code path is the
upstream one, byte for byte.

**Two more changes (2026-10-22), found on a panel running Xray 26.7.28 that every sing-box
client failed on with `reality verification failed` while Xray clients worked:**
- **The client version.** Upstream reports a fixed `1.8.1`. Xray v26.7.11–v26.7.28 servers
  default an empty `minClientVer` to `26.3.27` (Xray-core `af7eb680`) and refuse it. The patch
  reports `RealityClientVersion` (`26.10.21`), the newest Xray release the REALITY matrix test
  (`nexuscore/vless_encryption_matrix_test.go`) runs against, as Xray clients report their own.
  Servers use the value only for `minClientVer`/`maxClientVer`. Bump it with that test.
- **A fingerprint without the share.** In uTLS v1.8.7 only the Chrome fingerprints carry an
  `X25519MLKEM768` share, so for `firefox`, `safari`, `ios`, `edge`, `android`, `360`, `qq` (and
  often `random`) the opt-in sent nothing new. An opted-in outbound whose Client Hello has no
  such share now falls back to `HelloChrome_Auto`. REALITY servers do not check the fingerprint.

Both are covered by `TestRealityCompatAgainstXray` and the matrix test, run against Xray
26.3.27, 26.7.28, 26.9.9, 26.9.30 and 26.10.21 (all pass; each change reverted fails them).

**What it does not change.**
- The REALITY auth key is still derived from the standalone `X25519` share, which is the share
  both older and newer REALITY servers authenticate with.
- Without the option, every fingerprint sends exactly upstream's ClientHello: the share is
  stripped, and no fingerprint is replaced (the Chrome fallback above applies only when the
  outbound opts in).

**Who sets it.** Never on by default. The link parsers (`clients/web/src/core/subscription.ts`
for Android and iOS, `clients/shared/src/core/subscription.ts` for desktop) set it when a
REALITY link carries `support-x25519mlkem768=true` (3x-ui adds this parameter to its REALITY
share links), and the per-server ML-KEM switch sets it for one server
(`src/core/realityMlkem.ts`, in both clients): by the user, or automatically when a check finds
the server refuses the node without the share and accepts it with the share.

`nexusd` is built from the patched module too (the `replace` covers every Go build in `core/`),
which is why `build-desktop.sh` and the Makefile test targets run the prepare script.

**Dropping it.** If upstream sing-box ships an equivalent option, remove the `replace` line in
`core/go.mod`, delete this directory and the prepare script, and map the parser flag to the
upstream option name.
