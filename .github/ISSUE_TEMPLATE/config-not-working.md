---
name: A config does not connect
about: One specific node fails while others work
title: ''
labels: config
assignees: ''
---

<!--
MASK YOUR CREDENTIALS. Replace the UUID or password with zeros before pasting anything:

    vless://00000000-0000-0000-0000-000000000000@example.com:443?type=ws&security=tls#Node

The part after `?` is what matters — that is where the transport and security live, and it is
almost always where the problem is.
-->

## The link, masked

```
paste the masked URI here — keep everything after `?` intact
```

## What the core says

From the Logs tab, or:

```bash
adb logcat -c; adb logcat -v threadtime GoLog:V NexusConfigGuard:V *:S
```

Find the line that names the failure. The common ones and what they mean:

| Message | Usually means |
|---|---|
| `unknown version: 72` | The server answered with HTTP — a transport (`ws`, `httpupgrade`, `tcp` + `headerType=http`) is missing from the config |
| `reality verification failed` | Wrong `pbk`, wrong `sid`, wrong `sni` — or the address resolved to the wrong host |
| `EOF` right after connecting | The server rejected the handshake. Often `flow` on a node with no TLS |
| `DNS returned a private (RFC1918) address` | Your resolver is being intercepted. Try mobile data instead of Wi-Fi, or another node |
| `connection reset by peer` to `1.1.1.1:443` | DNS-over-HTTPS is blocked on your network |

```
paste the relevant lines here
```

## The generated outbound

This one line settles most config problems — it shows exactly what Nexus built from your link,
with the UUID already replaced by `***`:

```
NexusConfigGuard: proxy outbound: {...}
```

```
paste here
```

## Does it work in another client?

- [ ] Works in v2rayNG / another sing-box client
- [ ] Fails there too — likely the node itself
- [ ] Have not tried
