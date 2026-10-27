; Macros Tauri inserts into its NSIS installer and uninstaller (bundle.windows.nsis.installerHooks)

; Stop every process running from the install directory before its files are replaced or removed.
; Besides the app, these are its server and the bundled tools the server started (bun, uv, srt-win).
; They outlive the app when it is killed or exits without stopping them, as the updater up to 0.10.0
; does, and a running executable cannot be overwritten. Abort before touching any file if one stays.
!macro StopProcessesInInstallDir
  ; The app first, as Tauri's installer does, so an interactive install asks before closing it
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  System::Store S
  StrCpy $R0 ""
  StrLen $8 "$INSTDIR\"
  System::Call 'kernel32::GetCurrentProcessId() i .r9'
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .r1' ; TH32CS_SNAPPROCESS
  System::Call '*(&l4, i, i, p, i, i, i, i, i, &w260) p .r2' ; PROCESSENTRY32W
  System::Call 'kernel32::Process32FirstW(p r1, p r2) i .r3'
  ${DoWhile} $3 <> 0
    System::Call '*$2(i, i, i .r4)' ; th32ProcessID
    ${If} $4 <> $9
      ; PROCESS_QUERY_LIMITED_INFORMATION. A process this cannot open fails the query.
      System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r4) p .r5'
      System::Call 'kernel32::QueryFullProcessImageNameW(p r5, i 0, w .r6, *i ${NSIS_MAX_STRLEN}) i .r7'
      System::Call 'kernel32::CloseHandle(p r5)'
      StrCpy $0 $6 $8
      ${If} $7 <> 0
      ${AndIf} $0 == "$INSTDIR\"
        DetailPrint "Stopping $6"
        ; PROCESS_TERMINATE | SYNCHRONIZE. A process this cannot open fails the wait.
        System::Call 'kernel32::OpenProcess(i 0x100001, i 0, i r4) p .r5'
        System::Call 'kernel32::TerminateProcess(p r5, i 1)'
        System::Call 'kernel32::WaitForSingleObject(p r5, i 5000) i .r7'
        System::Call 'kernel32::CloseHandle(p r5)'
        ${IfThen} $7 <> 0 ${|} StrCpy $R0 $6 ${|}
      ${EndIf}
    ${EndIf}
    System::Call 'kernel32::Process32NextW(p r1, p r2) i .r3'
  ${Loop}
  System::Free $2
  System::Call 'kernel32::CloseHandle(p r1)'

  ${If} $R0 != ""
    Abort "Could not close $R0. Restart your computer and try again."
  ${EndIf}
  System::Store L
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopProcessesInInstallDir
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopProcessesInInstallDir
!macroend
