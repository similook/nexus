# Nexus VPN — Privacy Policy

**Effective date:** 18 October 2026
**Publisher:** SNACK VPN APP LIMITED ("we", "us")
**Contact:** open an issue at https://github.com/similook/nexus/issues

Nexus VPN is a client app. It connects your phone to proxy and VPN servers **that you add
yourself**, from a subscription link or a configuration you paste or scan. We do not run those
servers, we do not sell VPN service, and we never see your traffic.

This policy explains what the app stores, what it sends and to whom, and what you can do about
it. It covers the Android app "Nexus VPN" (package `io.nexus.app`), version 1.3.3 and later.

## 1. The short version

- **No account and no sign-up.** The app never asks for your name, email or phone number.
- **No analytics and no crash reporting.** The app contains no tracking or telemetry SDK.
- **Your servers, your traffic.** While connected, your internet traffic goes to the server you
  chose. Its operator, not us, can see what it carries. Choose servers you trust.
- **Everything the app stores stays on your phone,** in storage that only this app can read.
  Uninstalling the app, or clearing its data, deletes all of it.
- **Ads** (in versions that show them) are served by Google AdMob, under Google's policies. See
  section 5.

## 2. What the app stores on your phone

Everything below lives in the app's private storage. It is never uploaded to us.

| Data | Why |
|---|---|
| Server configurations and subscription links you add, including the credentials inside them (for example user IDs, passwords and server keys) | To connect to your servers. They are protected by Android's app sandbox, not by additional encryption. |
| The server you selected, and per-server settings you change (for example the ML-KEM switch) | To remember your choices between launches. |
| A local DNS table that maps the names of websites you visit through the VPN to temporary internal addresses | So that apps keep working after the VPN reconnects or switches server. This means **the phone keeps a list of website names visited through the VPN**. It never leaves the phone, and clearing the app's data deletes it. |
| A short connection log (the most recent few hundred lines), shown on the Logs screen | Troubleshooting. It lists the websites and servers connected to, is kept only while the app runs, and is never sent anywhere. If you use **Copy** on the Logs screen, what you copy is yours to share. |
| Subscription usage figures sent by your provider (data used, quota, expiry) | To show them on the Servers screen. |
| In versions with ads: the time the last ad was shown | To show an ad at most once every 3 minutes. |

## 3. Connections the app makes itself

Apart from the traffic you send through the VPN, the app connects to:

| Destination | When | What it sees |
|---|---|---|
| **The servers you added** | When you connect, and when you test servers (TCP test and Delay test) | Your IP address, and the credentials your configuration contains, as with any VPN client. |
| **Your subscription provider** (the link you added) | When you add or refresh a subscription, automatically about once per app launch | Your IP address and a client identifier (`Nexus/0.1 (sing-box)`). |
| **Google** (`www.gstatic.com`), through your server | During the Delay test and the connection check | A small test request, sent through each server to measure whether it works. Google sees your server's address, not yours. |
| **Cloudflare DNS** (`1.1.1.1`, over HTTPS) and your phone's own DNS | To find the address of your server | The name of your server. |
| **Google Public DNS** (`8.8.8.8`, over HTTPS), through the VPN | For some uncommon DNS query types while connected | The names being looked up, from your server's address. |
| **GitHub** (`github.com`) | Only if you installed the app from GitHub: one update check per launch | Your IP address. Installs from an app store (such as Xiaomi GetApps) never make this check; the store updates the app. |
| **Google AdMob** | Only in versions that show ads (section 5) | See section 5. |

The app's own connections listed above are **not** sent through the VPN, so these services see
your real IP address. Your other apps' traffic goes through the VPN while it is connected.

## 4. Permissions

| Permission | Why |
|---|---|
| VPN service (`BIND_VPN_SERVICE`, foreground service) | To route your traffic through the server you chose, which is the app's purpose. |
| Camera | Only to scan QR codes of server links, when you open the scanner. Images are processed on the phone, never saved, and never sent. |
| Notifications | To show the connection status while the VPN is on, as Android requires. |
| Start at boot | Only if you turn on auto-connect. Off by default. |
| Internet and network state | To connect and to notice network changes. |
| Advertising ID (`AD_ID`) and Android's ad-services permissions | Only in versions that show ads: Google's advertising SDK declares them, and they are used only by Google AdMob, as described in section 5. Versions without ads, such as 1.3.3, do not contain the SDK and do not request them. |

## 5. Advertising

Versions of Nexus VPN that show ads display ads from **Google AdMob**, a service of Google LLC /
Google Ireland Limited. **Version 1.3.3 shows no ads**: it does not contain Google's advertising
SDK and makes no connection to AdMob. If a later version adds ads, its release notes say so, and
this section describes how they work.

- **When an ad appears:** one full-screen ad, only after you tap **Disconnect** inside the app, at
  most once every 3 minutes. Never when the app opens, never when you connect, and never when you
  stop the VPN from the notification or the Quick Settings tile. Disconnecting never waits for an
  ad. Ads never appear in notifications and never imitate system messages. Google decides when
  the ad's close button appears.
- **Consent first:** each time the app starts, it asks Google's consent service (UMP) whether
  consent is needed, before the advertising SDK starts. Where the law requires it (the EEA, the UK
  and Switzerland), Google's consent form is shown. No ad is requested while consent is required
  but not given, or if the consent check fails. You can change your choice at any time with
  **Ad privacy settings** on the Home screen.
- **What Google collects:** Google may collect your device's advertising ID (where permitted), IP
  address, device and app information, and how you interact with ads, to show, measure and
  personalise ads and to prevent fraud. This is governed by Google's privacy policy:
  https://policies.google.com/privacy and https://policies.google.com/technologies/partner-sites
- **Ad requests are not sent through the VPN.** They come from the app itself, so Google sees your
  real IP address, as it would for any app. In regions Google does not serve, the consent check
  fails and no ad is requested.
- **What the app stores:** only the time the last ad was shown, on your phone, to enforce the
  3-minute limit.
- **Your choices:** besides Ad privacy settings, you can reset or delete your advertising ID, or
  opt out of ad personalisation, in Android **Settings → Google → Ads** (wording varies by phone).

## 6. Children

Nexus VPN is not directed at children and is rated 12+. We do not knowingly collect any data from
children, and the app itself collects no personal data. The app does not mark its ad requests as
directed at children.

## 7. Your rights

We do not hold personal data about you. Everything the app keeps is on your phone, and you control
it:

- **Delete a server or subscription** in the Servers screen.
- **Delete everything** with Android **Settings → Apps → Nexus VPN → Storage → Clear data**, or by
  uninstalling the app.

For data that Google (AdMob), Cloudflare, GitHub or your server and subscription providers hold,
contact them directly. If you have a question about this policy, open an issue at
https://github.com/similook/nexus/issues. If you are in the EEA or the UK, you may also complain to your local data protection
authority.

## 8. Security

Your configurations are protected by Android's app sandbox. Subscription links that use plain
`http://` are marked as insecure in the app, because they can be read or altered on the way.
Links using `https://` are fetched over an encrypted connection.

## 9. Changes

If this policy changes, the new version is published at this address with a new effective date.
Significant changes are also mentioned in the release notes.

## 10. Contact

SNACK VPN APP LIMITED — https://github.com/similook/nexus/issues
