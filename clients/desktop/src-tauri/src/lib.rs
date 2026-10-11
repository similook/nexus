//! The Nexus desktop host (ADR-0003 Phase 4).
//!
//! This process owns the window and nothing else of consequence. The tunnel lives in `nexusd`,
//! a separate privileged daemon; this host is an unprivileged forwarder between the webview
//! and that daemon's socket. On Windows it also runs that daemon, and asks Windows to elevate
//! it when a tunnel needs it (daemon.rs) - it never runs elevated itself.
//!
//! ========================================================================================
//! IT FORWARDS OPAQUE BYTES (ADR-0003 §4.2)
//!
//! The daemon speaks newline-framed JSON. This host reads a line and emits it to the webview;
//! it is handed a line and writes it. It has no structs for any of it and never parses a
//! frame, so the contract lives in exactly two places — core/desktop/ipc/protocol.go and
//! clients/desktop/src/port/tauri.ts — and this file cannot drift from either, because it
//! holds no opinion about what the bytes mean.
//! ========================================================================================

mod daemon;
mod network;
mod tray;
mod window_fit;

use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(windows)]
use uds_windows::UnixStream;

/// The write half of the link to nexusd, tagged with a generation.
///
/// The generation is what makes teardown safe: a reader thread only clears the link, and only
/// reports it closed, if the link is still the one it was started for. Without it a late EOF
/// from a dead connection could tear down a newer, live one.
#[derive(Default)]
struct Link(Mutex<LinkState>);

#[derive(Default)]
struct LinkState {
    generation: u64,
    stream: Option<UnixStream>,
}

/// Open a fresh connection to nexusd, replacing any existing one.
///
/// Every line the daemon sends is emitted as `nexus://frame`, unparsed. When the connection
/// ends, the link is cleared and `nexus://closed` is emitted; the webview owns reconnection.
///
/// REPLACE, NEVER REUSE. This link lives in the host process and outlives the webview: a
/// reload (HMR, a dev refresh, a re-created window) builds a new page that calls this again
/// while the old socket is still open. The daemon only greets a NEW connection with `hello`,
/// and the page will not drive a daemon that has not greeted it - so reusing the old socket
/// left a reloaded window stuck on "nexusd is not running" against a running daemon (observed
/// end to end). Each page therefore gets its own connection. The old reader thread sees EOF
/// and, because its generation is no longer current, exits without touching the new link.
///
/// Where it connects is daemon.rs's answer: the daemon this app runs, or a developer's.
#[tauri::command]
fn nexus_connect(
    app: AppHandle,
    link: State<'_, Link>,
    daemon: State<'_, daemon::Daemon>,
) -> Result<(), String> {
    daemon.revive();
    let path = daemon.socket();

    let mut state = link
        .0
        .lock()
        .map_err(|_| "link state poisoned".to_string())?;
    if let Some(old) = state.stream.take() {
        let _ = old.shutdown(std::net::Shutdown::Both);
    }

    let stream = UnixStream::connect(&path)
        .map_err(|error| format!("cannot reach nexusd at {}: {error}", path.display()))?;
    let reader = stream
        .try_clone()
        .map_err(|error| format!("cannot clone the nexusd socket: {error}"))?;

    state.generation += 1;
    state.stream = Some(stream);
    let generation = state.generation;
    drop(state);
    log::info!("nexusd link opened (generation {generation})");

    std::thread::Builder::new()
        .name("nexusd-reader".into())
        .spawn(move || {
            for line in BufReader::new(reader).lines() {
                match line {
                    Ok(frame) => {
                        let _ = app.emit("nexus://frame", frame);
                    }
                    Err(_) => break,
                }
            }

            // Only the reader of the CURRENT link may clear it and announce the closure.
            let link = app.state::<Link>();
            let current = match link.0.lock() {
                Ok(mut state) if state.generation == generation => {
                    state.stream = None;
                    true
                }
                _ => false,
            };
            if current {
                let _ = app.emit("nexus://closed", ());
            }
        })
        .map_err(|error| format!("cannot start the nexusd reader: {error}"))?;

    Ok(())
}

/// Close the link to nexusd deliberately.
///
/// R1 (ADR-0003 §4.1): status streaming stops while nobody is looking, so the page calls this
/// when the window is hidden or minimised. It is not a failure, so it is not reported as one:
/// bumping the generation makes the old reader thread exit silently instead of emitting
/// `nexus://closed`. The daemon, and any tunnel it holds, carries on without us.
#[tauri::command]
fn nexus_disconnect(link: State<'_, Link>) -> Result<(), String> {
    let mut state = link
        .0
        .lock()
        .map_err(|_| "link state poisoned".to_string())?;
    state.generation += 1;
    if let Some(stream) = state.stream.take() {
        let _ = stream.shutdown(std::net::Shutdown::Both);
        log::info!("nexusd link closed by the page (window not visible)");
    }
    Ok(())
}

/// Write one frame to nexusd.
///
/// The frame is opaque, with one exception checked here: it must not contain a line break.
/// The framing is one line per document, so an embedded newline would let one call inject a
/// second frame. JSON.stringify never produces one; refusing it costs nothing.
#[tauri::command]
fn nexus_send(frame: String, link: State<'_, Link>) -> Result<(), String> {
    if frame.contains('\n') || frame.contains('\r') {
        return Err("refused a frame containing a line break".into());
    }

    let mut state = link
        .0
        .lock()
        .map_err(|_| "link state poisoned".to_string())?;
    let stream = state
        .stream
        .as_mut()
        .ok_or_else(|| "not connected to nexusd".to_string())?;

    stream
        .write_all(frame.as_bytes())
        .and_then(|()| stream.write_all(b"\n"))
        .and_then(|()| stream.flush())
        .map_err(|error| format!("write to nexusd failed: {error}"))
}

/// Exit the application. Called by the page once it has disconnected the tunnel in answer to
/// `nexus://quit-requested` (see tray.rs).
#[tauri::command]
fn nexus_quit(app: AppHandle) {
    log::info!("quitting");
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // FIRST, before anything that creates a window, a tray icon or a daemon connection: a
        // second launch exits here and hands the first instance its window back instead of
        // starting a duplicate UI with its own link to nexusd.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            log::info!("second launch; restoring the existing window");
            tray::show_main(app);
        }))
        // Subscription URLs (port/tauri.ts `http`). Its scope is in capabilities/default.json.
        .plugin(tauri_plugin_http::init())
        .manage(Link::default())
        .manage(daemon::Daemon::default())
        .manage(tray::Visibility::default())
        .manage(network::LastReading::default())
        .invoke_handler(tauri::generate_handler![
            nexus_connect,
            nexus_send,
            nexus_disconnect,
            nexus_quit,
            daemon::nexus_daemon_status,
            daemon::nexus_elevate,
            network::nexus_network_status
        ])
        .on_window_event(|window, event| {
            if window.label() != tray::MAIN_WINDOW {
                return;
            }
            match event {
                // Closing the window hides it to the tray and changes nothing (ADR-0003 §4.3).
                // The tunnel belongs to nexusd, not to this window; Quit in the tray is the
                // way out.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    tray::report_visibility(window.app_handle());
                }
                // Minimise and restore arrive as resizes.
                WindowEvent::Resized(_) => tray::report_visibility(window.app_handle()),
                _ => {}
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // The fixed-size window must fit the monitor's work area, or its bottom is behind
            // the taskbar (window_fit.rs). Before anything else draws into it.
            if let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) {
                if let Err(error) = window_fit::fit_to_work_area(&window) {
                    log::warn!("could not fit the window to the work area: {error}");
                }
            }
            // After single-instance (a second launch never gets here, so never starts a
            // daemon of its own) and before the page's first nexus_connect.
            daemon::start(app.handle());
            tray::create(app.handle())?;
            network::start(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
