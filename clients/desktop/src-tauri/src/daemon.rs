//! Running nexusd for the app, and elevating it for a tunnel (Windows).
//!
//! ========================================================================================
//! THE SHAPE OF IT
//!
//! The Windows build ships nexusd.exe beside the app (bundle.externalBin), and the app runs it:
//!
//!   launch    `nexusd serve`, NOT elevated, as a child of this process. Everything that needs
//!             no privileges works at once: server pings, logs, the status stream.
//!   Connect   a TUN needs administrator rights. The page asks (`nexus_elevate`): the plain
//!             daemon is stopped, and Windows' own consent prompt starts nexusd again as
//!             administrator, on the same socket. Declined: the plain daemon comes back, and the
//!             page is told - nothing is reported connected that did not start. The elevated
//!             daemon then serves the app until it exits, so one prompt per app session.
//!   exit      both are started with `-parent <this pid>` and exit when this process does -
//!             quit, crash or Task Manager - through their own shutdown, which stops the
//!             tunnel. The tray's Quit still sends `stop` first (tray.rs).
//!
//! ONE SOCKET PER APP INSTANCE: `%TEMP%\nexusd-<pid>.sock`. A daemon removes its socket file as
//! it exits, so two daemons sharing a path can delete each other's - one still shutting down
//! from the last run would remove the new one's. A path of our own avoids the question, and on
//! it the plain daemon is killed (no graceful removal) before the elevated one binds: at most one
//! daemon is ever alive per path.
//!
//! WHERE THE ELEVATED DAEMON WRITES: `<install dir>\state`, its working directory (sing-box puts
//! cache.db there) and its guard's state dir. In the per-machine install that is under Program
//! Files, where only administrators can write, so nothing unprivileged can plant a link there
//! that redirects an administrator's write - a directory under the user's profile would allow
//! exactly that. The installer creates it (windows/installer-hooks.nsh). The plain daemon cannot
//! write there and never runs a tunnel; its state dir is the app's local data directory.
//!
//! NOT OURS: with NEXUS_SOCKET set, or no nexusd.exe beside the app, the page talks to whatever
//! listens on that socket and nothing here starts, stops or elevates anything - the development
//! setup in README.md.
//!
//! The interim until ADR-0003 Phase 6's service, which ends the per-session prompt.
//! ========================================================================================

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

/// What the page asks before a start (port/tauri.ts).
#[derive(Serialize)]
pub struct DaemonStatus {
    /// This app started the daemon it talks to.
    managed: bool,
    /// That daemon runs as administrator, so a start can create the TUN.
    elevated: bool,
}

/// The daemon this app runs, if it runs one.
#[derive(Default)]
pub struct Daemon(Mutex<Option<imp::Managed>>);

impl Daemon {
    fn lock(&self) -> MutexGuard<'_, Option<imp::Managed>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Where the page's link connects.
    ///
    /// The managed daemon's socket, or - for a daemon this app did not start - `NEXUS_SOCKET`,
    /// else `nexusd.sock` in the temp directory, which is `ipc.DefaultSocketPath()` in
    /// core/desktop/ipc/socket.go (both sides call Win32 GetTempPath underneath).
    pub fn socket(&self) -> PathBuf {
        if let Some(managed) = self.lock().as_ref() {
            return managed.socket();
        }
        std::env::var_os("NEXUS_SOCKET")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("nexusd.sock"))
    }

    /// Start the plain daemon again if the one we ran has exited (a crash, Task Manager), so
    /// the page's reconnect finds a daemon rather than retrying against nothing.
    pub fn revive(&self) {
        if let Some(managed) = self.lock().as_mut() {
            managed.revive();
        }
    }
}

/// Start the managed daemon, unless this run uses one it did not start (see the module doc).
pub fn start(app: &tauri::AppHandle) {
    imp::start(app);
}

#[tauri::command]
pub fn nexus_daemon_status(daemon: tauri::State<'_, Daemon>) -> DaemonStatus {
    match daemon.lock().as_mut() {
        None => DaemonStatus {
            managed: false,
            elevated: false,
        },
        Some(managed) => {
            managed.revive();
            DaemonStatus {
                managed: true,
                elevated: managed.elevated(),
            }
        }
    }
}

/// Replace the plain daemon with an elevated one, through Windows' consent prompt.
///
/// Resolves once the elevated daemon answers on the socket, so the page can link at once.
/// Rejects with a message starting "declined" when the prompt was refused; either way a
/// rejection leaves the plain daemon running again.
#[tauri::command]
pub async fn nexus_elevate(app: tauri::AppHandle) -> Result<(), String> {
    imp::elevate(app).await
}

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Manager};
    use uds_windows::UnixStream;
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, HANDLE, HWND, WAIT_TIMEOUT};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::Threading::WaitForSingleObject;
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    use super::Daemon;
    use crate::tray;

    /// No console window for the plain daemon, which is a console program.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// How long an approved daemon gets to start answering. Seconds in practice; this bounds
    /// a daemon that started and then hung.
    const READY_TIMEOUT: Duration = Duration::from_secs(10);

    pub struct Managed {
        /// nexusd.exe beside this executable, where bundle.externalBin installs it.
        exe: PathBuf,
        socket: PathBuf,
        /// The plain daemon's state and working directory: the app's local data dir.
        user_state: PathBuf,
        /// The elevated daemon's: `<install dir>\state`. See the module doc.
        admin_state: PathBuf,
        running: Running,
    }

    enum Running {
        None,
        Plain(Child),
        /// The consent prompt is up. Nothing listens on the socket until it is answered.
        Elevating,
        Elevated(Process),
    }

    impl Managed {
        pub fn socket(&self) -> PathBuf {
            self.socket.clone()
        }

        pub fn elevated(&self) -> bool {
            matches!(self.running, Running::Elevated(_))
        }

        fn spawn_plain(&mut self) {
            let spawned = std::fs::create_dir_all(&self.user_state).and_then(|()| {
                Command::new(&self.exe)
                    .arg("serve")
                    .arg("-s")
                    .arg(&self.socket)
                    .arg("-state")
                    .arg(&self.user_state)
                    .arg("-parent")
                    .arg(std::process::id().to_string())
                    .current_dir(&self.user_state)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
            });
            self.running = match spawned {
                Ok(child) => {
                    log::info!("nexusd started, not elevated (pid {})", child.id());
                    Running::Plain(child)
                }
                Err(error) => {
                    log::error!("cannot start {}: {error}", self.exe.display());
                    Running::None
                }
            };
        }

        pub fn revive(&mut self) {
            let exited = match &mut self.running {
                Running::None => true,
                Running::Plain(child) => !matches!(child.try_wait(), Ok(None)),
                Running::Elevating => false,
                Running::Elevated(process) => !process.alive(),
            };
            if exited {
                log::warn!("nexusd is not running; starting it again");
                self.spawn_plain();
            }
        }
    }

    pub fn start(app: &AppHandle) {
        if std::env::var_os("NEXUS_SOCKET").is_some() {
            log::info!("NEXUS_SOCKET is set: using the daemon there, starting none");
            return;
        }
        let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
        else {
            return;
        };
        let exe = dir.join("nexusd.exe");
        if !exe.is_file() {
            log::warn!("no nexusd.exe beside the app: expecting a daemon on the default socket");
            return;
        }
        let user_state = app
            .path()
            .app_local_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("nexusd");

        let mut managed = Managed {
            exe,
            socket: std::env::temp_dir().join(format!("nexusd-{}.sock", std::process::id())),
            user_state,
            admin_state: dir.join("state"),
            running: Running::None,
        };
        managed.spawn_plain();
        *app.state::<Daemon>().lock() = Some(managed);
    }

    enum Outcome {
        /// Elevated and answering.
        Ready(Process),
        /// Elevated, running, and not answering. Kept: replacing it would put two daemons on
        /// one socket, which is the one thing this module exists to prevent.
        Silent(Process),
        Declined,
        Failed(String),
    }

    pub async fn elevate(app: AppHandle) -> Result<(), String> {
        let (exe, socket, state_dir) = {
            let daemon = app.state::<Daemon>();
            let mut guard = daemon.lock();
            let managed = guard
                .as_mut()
                .ok_or("this app did not start nexusd, so it cannot elevate it")?;
            match &mut managed.running {
                Running::Elevated(process) if process.alive() => return Ok(()),
                Running::Elevating => return Err("already waiting for the Windows prompt".into()),
                // Killed, not asked to exit. A graceful exit removes the socket file, and that
                // removal could land after the elevated daemon has bound the same path. Nothing
                // is lost: the plain daemon cannot hold a tunnel.
                Running::Plain(child) => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                _ => {}
            }
            managed.running = Running::Elevating;
            (
                managed.exe.clone(),
                managed.socket.clone(),
                managed.admin_state.clone(),
            )
        };

        // The prompt belongs to the window, so it comes up in front of it rather than flashing
        // in the taskbar. HWND is a pointer; it crosses to the blocking thread as a number.
        let owner = app
            .get_webview_window(tray::MAIN_WINDOW)
            .and_then(|window| window.hwnd().ok())
            .map_or(0, |hwnd| hwnd.0 as isize);

        // Blocking, and for as long as the user takes to answer: off the async runtime.
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            run_elevated(&exe, &socket, &state_dir, owner)
        })
        .await
        .unwrap_or_else(|error| Outcome::Failed(format!("the elevation thread failed: {error}")));

        let daemon = app.state::<Daemon>();
        let mut guard = daemon.lock();
        let Some(managed) = guard.as_mut() else {
            return Err("nexusd is no longer managed".into());
        };
        match outcome {
            Outcome::Ready(process) => {
                log::info!("nexusd running as administrator");
                managed.running = Running::Elevated(process);
                Ok(())
            }
            Outcome::Silent(process) => {
                managed.running = Running::Elevated(process);
                Err("nexusd started as administrator but is not answering".into())
            }
            Outcome::Declined => {
                log::info!("administrator prompt declined");
                managed.spawn_plain();
                Err("declined: the Windows administrator prompt was not approved".into())
            }
            Outcome::Failed(reason) => {
                log::error!("elevation failed: {reason}");
                managed.spawn_plain();
                Err(reason)
            }
        }
    }

    fn run_elevated(exe: &Path, socket: &Path, state_dir: &Path, owner: isize) -> Outcome {
        // Installed, the installer made this and we could not; in development it is ours.
        let _ = std::fs::create_dir_all(state_dir);

        let file = HSTRING::from(exe);
        let parameters = HSTRING::from(format!(
            "serve -s {} -state {} -parent {}",
            quote(socket),
            quote(state_dir),
            std::process::id()
        ));
        let directory = HSTRING::from(state_dir);

        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            hwnd: HWND(owner as *mut core::ffi::c_void),
            lpVerb: w!("runas"),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(parameters.as_ptr()),
            lpDirectory: PCWSTR(directory.as_ptr()),
            nShow: SW_HIDE.0,
            ..Default::default()
        };

        // ShellExecuteEx can hand a verb to shell extensions over COM; Microsoft's guidance is an
        // apartment-threaded COM with OLE1 DDE off on the calling thread.
        let com =
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        let launched = unsafe { ShellExecuteExW(&mut info) };
        if com.is_ok() {
            unsafe { CoUninitialize() };
        }

        if let Err(error) = launched {
            if error.code() == ERROR_CANCELLED.to_hresult() {
                return Outcome::Declined;
            }
            return Outcome::Failed(format!(
                "Windows could not start nexusd as administrator: {}",
                error.message()
            ));
        }
        if info.hProcess.is_invalid() {
            return Outcome::Failed("Windows started nexusd but returned no process".into());
        }
        let process = Process(info.hProcess.0 as isize);

        // Ready means answering on the socket - not merely running - so the page's link, made
        // the moment this returns, finds it.
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if UnixStream::connect(socket).is_ok() {
                return Outcome::Ready(process);
            }
            if !process.alive() {
                return Outcome::Failed(
                    "nexusd exited as soon as it started as administrator".into(),
                );
            }
            if Instant::now() >= deadline {
                return Outcome::Silent(process);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// A path as one argument on a Windows command line. A path cannot contain `"`, so the only
    /// hazard is trailing backslashes, which would escape the closing quote: double them.
    fn quote(path: &Path) -> String {
        let text = path.to_string_lossy();
        let trailing = text.len() - text.trim_end_matches('\\').len();
        format!("\"{text}{}\"", "\\".repeat(trailing))
    }

    /// A process handle from ShellExecuteEx, closed on drop. Held as a number so the state
    /// that owns it can cross threads.
    struct Process(isize);

    impl Process {
        fn alive(&self) -> bool {
            unsafe {
                WaitForSingleObject(HANDLE(self.0 as *mut core::ffi::c_void), 0) == WAIT_TIMEOUT
            }
        }
    }

    impl Drop for Process {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(HANDLE(self.0 as *mut core::ffi::c_void)) };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::quote;
        use std::path::Path;

        #[test]
        fn quote_survives_spaces_and_trailing_backslashes() {
            assert_eq!(
                quote(Path::new(r"C:\Program Files\Nexus\state")),
                r#""C:\Program Files\Nexus\state""#
            );
            assert_eq!(quote(Path::new(r"C:\a b\")), r#""C:\a b\\""#);
        }
    }
}

/// Elsewhere the daemon is not the app's to run: Linux and macOS will have systemd and
/// launchd for that (ADR-0003 Phases 5 and 7).
#[cfg(not(windows))]
mod imp {
    use std::path::PathBuf;

    pub enum Managed {}

    impl Managed {
        pub fn socket(&self) -> PathBuf {
            match *self {}
        }
        pub fn elevated(&self) -> bool {
            match *self {}
        }
        pub fn revive(&mut self) {
            match *self {}
        }
    }

    pub fn start(_app: &tauri::AppHandle) {}

    pub async fn elevate(_app: tauri::AppHandle) -> Result<(), String> {
        Err("this platform has no managed daemon to elevate".into())
    }
}
