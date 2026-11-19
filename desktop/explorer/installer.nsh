; Uninstalling Cloudy (not updating it) removes the File Explorer badges (src/main/badges-win.ts): the handlers
; registered for this user and the app's copies of the DLL (a copy Explorer still has loaded stays: removing it at the
; next restart needs administrator rights; it is small and unused once Explorer restarts). When the three names are in
; Explorer's list (HKLM: the user allowed it as administrator), Windows asks again to take them out.
; The installer is a 32-bit program: SetRegView 64 and reg.exe /reg:64 reach the registry Explorer reads.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    SetRegView 64
    DeleteRegKey HKCU "Software\Classes\CLSID\{5C2A6D8E-4B1F-4E3A-9C7D-2F8E1A6B3C01}"
    DeleteRegKey HKCU "Software\Classes\CLSID\{5C2A6D8E-4B1F-4E3A-9C7D-2F8E1A6B3C02}"
    DeleteRegKey HKCU "Software\Classes\CLSID\{5C2A6D8E-4B1F-4E3A-9C7D-2F8E1A6B3C03}"
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\  CloudySynced" ""
    SetRegView lastused
    ${if} $0 != ""
      ExecShell "runas" "$SYSDIR\cmd.exe" '/c reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\  CloudySynced" /f /reg:64 & reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\  CloudySyncing" /f /reg:64 & reg delete "HKLM\Software\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\  CloudyError" /f /reg:64' SW_HIDE
    ${endIf}
    RMDir /r "$LOCALAPPDATA\Cloudy\Explorer"
  ${endIf}
!macroend
