//! Keep the fixed-size main window inside the work area of the monitor it opens on.
//!
//! tauri.conf.json asks for a 460x880 (logical) page in a window that cannot be resized. On a
//! work area shorter than that - 1920x1080 at 125% scaling leaves 816 logical px above the
//! taskbar - Windows only clamps the window to the SCREEN height, so its bottom (the navigation
//! bar, and every bottom sheet's actions) ends up behind the taskbar where nothing can reach it.
//!
//! So at startup the page is shortened to exactly what fits and the window is placed inside the
//! work area. The width, and the window on a screen where it already fits, are left alone. The
//! UI scrolls internally (each view and sheet has its own scroll region), so a shorter page loses
//! nothing. All arithmetic is in physical pixels, which is what both the window and the monitor
//! report, so display scaling needs no special case.

use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Shorten the window to the work area if it does not fit. Returns whether it changed anything.
pub fn fit_to_work_area(window: &WebviewWindow) -> tauri::Result<bool> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(false);
    };
    let work = monitor.work_area();
    let inner = window.inner_size()?;
    let outer = window.outer_size()?;
    let chrome = outer.height.saturating_sub(inner.height);

    let Some(height) = fitted_inner_height(inner.height, chrome, work.size.height) else {
        return Ok(false);
    };
    // The config's minHeight is a resize limit; the window is not user-resizable, and that limit
    // would refuse the one size that fits.
    window.set_min_size(None::<LogicalSize<f64>>)?;
    window.set_size(PhysicalSize::new(inner.width, height))?;

    // Keep the horizontal position (the config centres it) and put the now-fitting window at the
    // top of the work area, which it fills exactly.
    let position = window.outer_position()?;
    window.set_position(PhysicalPosition::new(position.x, work.position.y))?;
    Ok(true)
}

/// The page height that makes the whole window, title bar included, fit `work_height` - or None
/// when it already fits. All values in physical pixels.
fn fitted_inner_height(inner: u32, chrome: u32, work_height: u32) -> Option<u32> {
    let available = work_height.checked_sub(chrome)?;
    (inner > available && available > 0).then_some(available)
}

#[cfg(test)]
mod tests {
    use super::fitted_inner_height;

    #[test]
    fn shortens_only_when_the_window_does_not_fit() {
        // 1920x1080 at 125%, measured: work area 1020, title bar and borders 47, page clamped by
        // Windows to 1055. Fits at 973 (778 logical).
        assert_eq!(fitted_inner_height(1055, 47, 1020), Some(973));
        // 1366x768 at 125%: work area 708 (566 logical), page clamped to 721.
        assert_eq!(fitted_inner_height(721, 47, 708), Some(661));
        // 1920x1080 at 100%: 880 + 38 fits in 1032. Untouched.
        assert_eq!(fitted_inner_height(880, 38, 1032), None);
        // Exactly fitting is fitting.
        assert_eq!(fitted_inner_height(973, 47, 1020), None);
        // Nonsense from the OS changes nothing.
        assert_eq!(fitted_inner_height(1055, 1100, 1020), None);
        assert_eq!(fitted_inner_height(1055, 47, 47), None);
    }
}
