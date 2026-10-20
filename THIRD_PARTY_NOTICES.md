# Third-party notices

Nexus is licensed under the GNU General Public License, version 3 or later (LICENSE). Code
adapted from the projects below keeps their notices in the files themselves.

## sing-box for Apple

- https://github.com/SagerNet/sing-box-for-apple (commit 008f73fc6d576aced976659d6dc52a9a12365c24)
- Copyright (C) 2022 by nekohasekai <contact-sagernet@sekai.icu>
- License: GNU General Public License, version 3 or (at your option) any later version.
- Portions adapted in `clients/web/ios/App/PacketTunnel/ExtensionPlatformInterface.swift`
  (openTun network settings, tun file-descriptor lookup, default-interface monitor,
  clearDNSCache) and `PacketTunnelProvider.swift` (start-option persistence for on-demand
  restarts). Modified for Nexus, 2026-10-21.

## Xray-core

- `core/patches/sing-box/v1.14.0/0002-vless-encryption.patch` ports Xray-core's VLESS
  Encryption (MPL-2.0); see `core/patches/sing-box/README.md` for the attribution.
