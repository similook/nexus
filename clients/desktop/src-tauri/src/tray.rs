//! The tray icon, and what closing and quitting mean (ADR-0003 §4.3).
//!
//! THE RULE: GUI exit must not strand a tunnel.
//!
//! - Closing the WINDOW hides it to the tray and changes nothing. The tunnel, if any, keeps
//!   running in nexusd; the window comes back from the tray or from a second launch.
//! - QUITTING from the tray disconnects first. The failure to avoid is a user who thinks they
//!   quit and is still tunnelled.
//!
//! The ADR also describes a setting that keeps the tunnel up on quit. There is no settings
//! surface yet, so only the default is implemented.
//!
//! The richer tray menu (connection state, node switching) is Phase 9. This is the minimum a
//! hide-to-tray window needs: a way back, and a way out.

use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// The window tauri.conf.json creates. Tauri's default label, named once here.
pub const MAIN_WINDOW: &str = "main";

/// How long Quit waits for the page to confirm the daemon stopped before exiting anyway.
///
/// Longer than the page's own bound (5 s in port/tauri.ts, plus its 4 s link wait), so this
/// only fires when the page cannot answer at all - crashed, hung, or never loaded.
const QUIT_FALLBACK: Duration = Duration::from_secs(12);

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Nexus", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Nexus", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("nexus")
        .tooltip("Nexus")
        .menu(&menu)
        // Left click restores; the menu is on right click, as Windows users expect.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // The same icon as the window and the executable: one source, branding/icon-full.svg.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    log::info!("tray icon created");
    Ok(())
}

/// Bring the main window back from the tray, the taskbar, or behind other windows.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    report_visibility(app);
}

/// The last visibility reported to the page, so an unchanged state is not sent again.
#[derive(Default)]
pub struct Visibility(std::sync::Mutex<Option<bool>>);

/// Tell the page whether the main window can actually be seen (ADR-0003 §4.1, R1).
///
/// Visible means shown AND not minimised: hidden to the tray and minimised to the taskbar are
/// both "nobody is looking", which is when status streaming must stop. The page drops its link
/// to nexusd on `false` and reconnects on `true`; the daemon keeps running either way.
///
/// Emitted on change only. `Resized` fires for every step of a window drag, and each `true`
/// would otherwise cost the page a reconnect.
pub fn report_visibility(app: &AppHandle) {
    if app.get_webview_window(MAIN_WINDOW).is_none() {
        return;
    }
    let visible = main_window_visible(app);

    let state = app.state::<Visibility>();
    let mut last = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *last == Some(visible) {
        return;
    }
    *last = Some(visible);
    drop(last);

    log::info!(
        "main window {}",
        if visible {
            "visible"
        } else {
            "not visible (hidden or minimised)"
        }
    );
    let _ = app.emit("nexus://visibility", visible);
}

/// Shown and not minimised: the one definition of "someone can see the window" (R1).
pub fn main_window_visible(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW).is_some_and(|window| {
        window.is_visible().unwrap_or(true) && !window.is_minimized().unwrap_or(false)
    })
}

/// Quit, disconnecting the tunnel first.
///
/// The host does not speak the daemon's protocol (ADR-0003 §4.2), so it cannot send `stop`
/// itself. It asks the page, which does: the page stops the tunnel and then calls
/// `nexus_quit`. The fallback exits anyway if the page cannot answer. A daemon this app runs
/// (daemon.rs) then stops its tunnel itself as the app exits; one it did not start
/// (NEXUS_SOCKET, development) may keep it up, which is logged rather than hidden.
pub fn request_quit(app: &AppHandle) {
    log::info!("quit requested from the tray; asking the page to disconnect first");
    let _ = app.emit("nexus://quit-requested", ());

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_FALLBACK);
        log::warn!("the page did not confirm the disconnect; exiting anyway");
        app.exit(0);
    });
}
