; Installer hooks for the Windows build (tauri.windows.conf.json: bundle.windows.nsis.installerHooks).
; Tauri's template inserts each NSIS_HOOK_* macro at a fixed point of its Install and Uninstall
; sections; everything else is the template's own.
;
; NEXUSD.EXE MAY BE RUNNING. The app runs nexusd.exe for as long as it runs itself
; (src/daemon.rs). The template closes a running app just before it copies files, and the daemon
; then exits by itself (-parent) - but may still be stopping a tunnel when the copy reaches it,
; and a running exe can be neither overwritten nor deleted. It can be RENAMED, so the running
; image is moved aside first and an identical, unlocked copy put back in its place: the copy that
; follows always succeeds, and cancelling at the template's "Nexus is running" prompt still
; leaves a working install.
;
; STATE: the elevated daemon's working directory, <install dir>\state (see daemon.rs). Created
; here, inheriting the install directory's permissions - administrators write, users read - so
; nothing unprivileged can plant a link in the one directory an administrator's process writes.

!macro NEXUS_MOVE_DAEMON_ASIDE
  ; Left by an earlier run, if its daemon has exited since.
  Delete "$INSTDIR\nexusd.exe.old"
  ${If} ${FileExists} "$INSTDIR\nexusd.exe"
  ${AndIfNot} ${FileExists} "$INSTDIR\nexusd.exe.old"
    ClearErrors
    Rename "$INSTDIR\nexusd.exe" "$INSTDIR\nexusd.exe.old"
    ${IfNot} ${Errors}
      CopyFiles /SILENT "$INSTDIR\nexusd.exe.old" "$INSTDIR\nexusd.exe"
    ${EndIf}
  ${EndIf}
!macroend

; The moved-aside daemon exits with the app the template has just closed. Wait for that, briefly,
; then remove its file; past 10 s it goes at the next restart instead.
!macro NEXUS_REMOVE_OLD_DAEMON
  Push $R9
  StrCpy $R9 0
  ${DoWhile} ${FileExists} "$INSTDIR\nexusd.exe.old"
    Delete "$INSTDIR\nexusd.exe.old"
    ${IfNot} ${FileExists} "$INSTDIR\nexusd.exe.old"
      ${Break}
    ${EndIf}
    IntOp $R9 $R9 + 1
    ${If} $R9 > 40
      Delete /REBOOTOK "$INSTDIR\nexusd.exe.old"
      ${Break}
    ${EndIf}
    Sleep 250
  ${Loop}
  Pop $R9
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NEXUS_MOVE_DAEMON_ASIDE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\state"
  !insertmacro NEXUS_REMOVE_OLD_DAEMON
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NEXUS_MOVE_DAEMON_ASIDE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro NEXUS_REMOVE_OLD_DAEMON
  ; The daemon's cache.db: nothing the user made, and nothing to keep without the app.
  RMDir /r "$INSTDIR\state"
  ; The template's own RMDir ran while these were still here.
  RMDir "$INSTDIR"
!macroend
