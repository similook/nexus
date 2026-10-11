//! The machine's own network, for the Home screen's "Device network" card.
//!
//! WHAT THIS IS, AND WHY IT LIVES IN THE HOST
//!
//! `getNetworkStatus` and the `networkStatus` event describe the DEVICE'S link, not the tunnel
//! (clients/shared/src/core/plugin.ts, NetworkStatusState). That is a property of the machine
//! the window runs on, so this host answers it and nexusd is never asked. None of it is part of
//! the daemon protocol: ADR-0003 §4.2 - the host never parses a daemon frame - still holds.
//!
//! ========================================================================================
//! THE SOURCE: WINDOWS' OWN VERDICT, NOT OURS
//!
//! NCSI (the Network Connectivity Status Indicator behind the taskbar icon), read through WinRT
//! `NetworkInformation`. It is the counterpart of what Android reports (NexusPlugin.kt,
//! NetworkStatusMonitor):
//!
//!   Android NetworkCapabilities     Windows NetworkConnectivityLevel    state
//!   VALIDATED                       InternetAccess                      ok
//!   CAPTIVE_PORTAL                  ConstrainedInternetAccess           captive_portal
//!   connected, not validated        LocalAccess                         unverified
//!   nothing connected               nothing connected                   no_network
//!
//! Both are the operating system's own probe, run for its own reasons. Nothing here sends a
//! packet, opens a socket or starts a timer; readings happen when Windows reports a change and
//! when the page asks. And like Android's, the probe can be blocked on a censored network while
//! the link works - which is exactly what 'unverified' says.
//! ========================================================================================
//!
//! NOT_VPN. Android filters out VPN networks, so the card never describes a tunnel - ours or
//! anyone else's - back to the user. The Windows counterpart is the adapter's HardwareInterface
//! flag: false for software adapters. Verified on the development machine for the Wi-Fi Direct
//! virtual adapters and the WAN miniports; Wintun, which sing-box's TUN uses, is a software
//! adapter too, but that is not yet observed here (an up tunnel needs elevation, Phase 6). The
//! interface TYPE cannot do this job: Wi-Fi Direct's virtual adapter reports 71, like a real
//! Wi-Fi card.
//!
//! LIMITATION, stated rather than guessed around: a PC that dials PPPoE itself reaches the
//! internet over a PPP interface, which is not hardware - and neither is a VPN, so the two cannot
//! be told apart from here. When only non-hardware links are connected the answer is 'unknown'
//! ("Network status unavailable"), never a red "No network" over a line that works.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// One reading, in the shared contract's words (plugin.ts `NetworkStatusEvent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct NetworkStatus {
    state: &'static str,
    transport: &'static str,
}

const UNKNOWN: NetworkStatus = NetworkStatus {
    state: "unknown",
    transport: "unknown",
};

/// The last reading the page holds, so an unchanged one is not sent again. Android deduplicates
/// the same way, before its bridge.
#[derive(Default)]
pub struct LastReading(Mutex<Option<NetworkStatus>>);

/// Record `status` as what the page holds. False if it already held exactly that.
fn remember(app: &AppHandle, status: NetworkStatus) -> bool {
    let state = app.state::<LastReading>();
    let mut last = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *last == Some(status) {
        return false;
    }
    *last = Some(status);
    true
}

/// A one-shot reading: on mount, and when the window is shown again (the page's reconcile).
/// Async so the enumeration runs off the UI thread.
#[tauri::command]
pub async fn nexus_network_status(app: AppHandle) -> NetworkStatus {
    let status = platform::read();
    remember(&app, status);
    status
}

/// Start following Windows' reports. Registered once, for the life of the process.
pub fn start(app: &AppHandle) {
    let handle = app.clone();
    match platform::watch(move || on_change(&handle)) {
        Ok(()) => log::info!("network status: watching the OS connectivity reports"),
        Err(error) => log::warn!("network status: not available ({error})"),
    }
}

fn on_change(app: &AppHandle) {
    let status = platform::read();
    if !remember(app, status) {
        return;
    }
    // R1 (ADR-0003 §4.1): nothing is pushed to a window nobody can see. It asks again when it
    // is shown, and gets the reading remembered here.
    if !crate::tray::main_window_visible(app) {
        return;
    }
    log::info!("network status: {} / {}", status.state, status.transport);
    let _ = app.emit("nexus://network-status", status);
}

#[cfg(windows)]
mod platform {
    use super::{NetworkStatus, UNKNOWN};
    use windows::core::GUID;
    use windows::Networking::Connectivity::{
        NetworkConnectivityLevel, NetworkInformation, NetworkStatusChangedEventHandler,
    };
    use windows::Win32::Foundation::NO_ERROR;
    use windows::Win32::NetworkManagement::IpHelper::{
        ConvertInterfaceGuidToLuid, GetIfEntry2, MIB_IF_ROW2,
    };

    /// IANA ifType values (the same numbers MIB_IF_ROW2.Type uses).
    const IF_TYPE_ETHERNET: u32 = 6;
    const IF_TYPE_WIFI: u32 = 71;
    const IF_TYPE_WWAN_PP: u32 = 243;
    const IF_TYPE_WWAN_PP2: u32 = 244;

    /// MIB_IF_ROW2.InterfaceAndOperStatusFlags, bit 0.
    const HARDWARE_INTERFACE: u8 = 0x01;

    pub fn read() -> NetworkStatus {
        read_profiles().unwrap_or_else(|error| {
            log::warn!("network status: cannot read the connection profiles ({error})");
            UNKNOWN
        })
    }

    fn read_profiles() -> windows::core::Result<NetworkStatus> {
        let mut best: Option<(NetworkConnectivityLevel, &'static str)> = None;
        let mut software_link = false;

        for profile in NetworkInformation::GetConnectionProfiles()? {
            let Ok(level) = profile.GetNetworkConnectivityLevel() else {
                continue;
            };
            if level == NetworkConnectivityLevel::None {
                continue;
            }
            // Saved profiles that are not connected have no adapter.
            let Ok(adapter) = profile.NetworkAdapter() else {
                continue;
            };
            let Ok(id) = adapter.NetworkAdapterId() else {
                continue;
            };
            if !is_hardware(&id) {
                software_link = true;
                continue;
            }
            let transport = match adapter.IanaInterfaceType().unwrap_or(0) {
                IF_TYPE_WIFI => "wifi",
                IF_TYPE_WWAN_PP | IF_TYPE_WWAN_PP2 => "cellular",
                IF_TYPE_ETHERNET => "ethernet",
                _ => "unknown",
            };
            // The best-connected link wins, as Android prefers a validated network: with Wi-Fi
            // and Ethernet both up, the one with internet access is the one carrying traffic.
            if best.map_or(true, |(held, _)| level.0 > held.0) {
                best = Some((level, transport));
            }
        }

        Ok(match best {
            Some((level, transport)) => NetworkStatus {
                state: match level {
                    NetworkConnectivityLevel::InternetAccess => "ok",
                    NetworkConnectivityLevel::ConstrainedInternetAccess => "captive_portal",
                    _ => "unverified",
                },
                transport,
            },
            // See LIMITATION in the module comment: a VPN or a PPPoE dial-up, and no way to tell.
            None if software_link => UNKNOWN,
            None => NetworkStatus {
                state: "no_network",
                transport: "unknown",
            },
        })
    }

    /// True if the adapter is physical hardware; false for software adapters and on any failure.
    fn is_hardware(id: &GUID) -> bool {
        let mut row = MIB_IF_ROW2::default();
        // SAFETY: both calls write only into `row`, which outlives them. GetIfEntry2 looks the
        // interface up by InterfaceLuid, which the first call has just filled in.
        unsafe {
            if ConvertInterfaceGuidToLuid(id, &mut row.InterfaceLuid) != NO_ERROR
                || GetIfEntry2(&mut row) != NO_ERROR
            {
                return false;
            }
        }
        row.InterfaceAndOperStatusFlags._bitfield & HARDWARE_INTERFACE != 0
    }

    /// Call `on_change` whenever Windows re-evaluates a connection. It runs on a thread-pool
    /// thread. Never unregistered: it lives exactly as long as the process.
    pub fn watch(on_change: impl Fn() + Send + 'static) -> Result<(), String> {
        let handler = NetworkStatusChangedEventHandler::new(move |_| {
            on_change();
            Ok(())
        });
        NetworkInformation::NetworkStatusChanged(&handler)
            .map(|_token| ())
            .map_err(|error| error.to_string())
    }
}

/// Linux and macOS have no source yet (their shells are Phase 5 and later). 'unknown' is the
/// honest answer, and the card says "Network status unavailable".
#[cfg(not(windows))]
mod platform {
    use super::{NetworkStatus, UNKNOWN};

    pub fn read() -> NetworkStatus {
        UNKNOWN
    }

    pub fn watch(_on_change: impl Fn() + Send + 'static) -> Result<(), String> {
        Err("no network-status source on this platform yet".into())
    }
}
