---
name: Bug report
about: Something does not work
title: ''
labels: bug
assignees: ''
---

<!--
BEFORE YOU PASTE ANYTHING: a config link contains your credentials.

A `vless://` / `vmess://` / `trojan://` URI carries a UUID or password that is a bearer token —
anyone reading this issue can use your account with it. A subscription URL is worse: it is the
credential for every node you have.

Mask them. Replace the UUID with zeros and the hostname with `example.com`:

    vless://00000000-0000-0000-0000-000000000000@example.com:443?type=ws&security=tls&sni=a.com#Node

The part after `?` is what actually helps — that is where transport and security live.
-->

## What happened

<!-- One or two sentences. What you did, what you expected, what happened instead. -->

## Does it happen on every node, or one?

- [ ] Every node in my subscription
- [ ] One specific node (others work)
- [ ] Only after switching servers while connected
- [ ] Only after backgrounding and returning to the app

## The node

Fill in what you know. If you built the app yourself, the `proxy outbound:` log line below
has all of it — on a release build from the Releases page it is not printed, by design.

| | |
|---|---|
| **Protocol** | <!-- VLESS / VMess / Trojan / Shadowsocks / Hysteria2 / TUIC --> |
| **Transport** | <!-- tcp / ws / grpc / httpupgrade / tcp+http header / quic --> |
| **Security** | <!-- none / tls / reality --> |
| **Port** | <!-- 443, 8880, … --> |
| **Query string** | <!-- everything after `?`, with the UUID removed --> |

## Environment

| | |
|---|---|
| **Nexus version** | <!-- from the Releases page, e.g. v1.0.0 --> |
| **Android version** | <!-- e.g. 13 --> |
| **Device** | <!-- e.g. Xiaomi Redmi Note 12 --> |
| **Network** | <!-- mobile data / Wi-Fi, and which carrier or ISP --> |
| **Country** | <!-- filtering differs a lot by country and by ISP --> |

## Does the same config work elsewhere?

Trying it in v2rayNG or another sing-box client separates "Nexus is broken" from "this node is
down", and it usually takes a minute.

- [ ] Works in another client
- [ ] Fails in another client too
- [ ] Have not tried

## Logs

Two are useful, and they are different.

**1. The Logs tab in the app.** Start here — it is the core's own output, it is the same on a
release build as on a debug one, and it needs no computer. Copy from there.

If you have a cable and want the surrounding Android detail too:

```bash
adb logcat -c; adb logcat -v threadtime NexusVpn:V NexusPlugin:V NexusConfigGuard:V GoLog:V *:S
```

<details>
<summary>If you built the app yourself, one more line is worth having</summary>

A debug build prints exactly what is handed to the core, with the UUID already masked as `***`:

```
NexusConfigGuard: proxy outbound: {"type":"vless","tag":"proxy",...}
```

**Release builds do not print it.** That line names your server, its SNI and its transport, and
logcat is readable by anything on the device holding `READ_LOGS` — so it, along with the other
per-step detail, is compiled out of the builds on the Releases page. Nothing is missing from the
Logs tab as a result; only from `adb logcat`.

</details>

**2. A crash, if the app closed by itself:**

```bash
adb logcat -c; adb logcat -v threadtime AndroidRuntime:E libc:F DEBUG:V *:S
```

<details>
<summary>Log output</summary>

```
paste here
```

</details>

<!--
Before submitting: re-read your paste and check there is no real UUID, password, private key or
subscription URL in it. Editing it out after the fact does not help — the original is in the
edit history and in everyone's notification email.
-->
