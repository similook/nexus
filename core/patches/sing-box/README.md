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

**What it does not change.**
- The advertised REALITY client version stays `1.8.1`. Servers whose `minClientVer` is above
  that (or Xray v26.7.11–v26.7.28, which apply a built-in 26.3.27 minimum when it is empty)
  still refuse the client. That is deliberate and out of scope.
- The REALITY auth key is still derived from the standalone `X25519` share, which is the share
  both older and newer REALITY servers authenticate with.
- Fingerprints without an `X25519MLKEM768` share in uTLS v1.8.7 (`firefox`, `safari`, `ios`,
  `edge`, `android`, `360`, `qq`) send the same ClientHello either way.

**Who sets it.** The Nexus link parser sets it only when a REALITY link carries
`support-x25519mlkem768=true` (3x-ui adds this parameter to its REALITY share links). It is
never enabled by default.

**Dropping it.** If upstream sing-box ships an equivalent option, remove the `replace` line in
`core/go.mod`, delete this directory and the prepare script, and map the parser flag to the
upstream option name.
