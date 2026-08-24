; 海芯 AI 平台 — Windows 桌面版安装器（小包 / 免管理员 / 不装系统服务）
; 由 packaging/windows/build-exe.mjs 用 makensis 编译，命令行注入以下 /D 宏：
;   STAGE_DIR   已组装的程序目录树（packaging/build/out/win-x64）
;   OUT_FILE    产物 exe 路径
;   APP_VERSION 版本串（写进卸载信息）
; 设计：
;   * 只铺应用码，安装时用 File /r 排除 runtime\ 与 node_modules\（这两块 240MB 首启联网下载）。
;   * 装到用户目录 $LOCALAPPDATA\Programs\HaixinAI，RequestExecutionLevel user——不需管理员、不弹 UAC。
;   * 不注册系统服务：桌面/开始菜单放"海芯 AI"(haixin.cmd start) 与"退出海芯"(haixin.cmd stop) 快捷方式。
;   * 数据目录 $LOCALAPPDATA\HaixinAI 由 launcher 首次启动时创建，升级/卸载可保留。

Unicode true
ManifestDPIAware true

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "HaixinAI-Setup.exe"
!endif

!define APP_NAME "HaixinAI"
!define DISPLAY_NAME "海芯 AI 平台"
!define PUBLISHER "Haixin"
!define REG_UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
!define HAIXIN_CMD "$INSTDIR\packaging\windows\haixin.cmd"

Name "${DISPLAY_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
RequestExecutionLevel user      ; 用户级安装：不需管理员，不弹 UAC
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUnInstDetails show
BrandingText "${DISPLAY_NAME} ${APP_VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
; 完成页：勾选后启动海芯（首次会联网下载运行环境并自动打开浏览器）
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "立即启动海芯 AI（首次需联网下载运行环境，约 82MB）"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function LaunchApp
  ; 用 explorer 起 cmd，避免以安装器的提权上下文运行（保持普通用户身份）
  ExecShell "open" "${HAIXIN_CMD}" "start"
FunctionEnd

Section "海芯 AI 平台" SecMain
  SectionIn RO

  SetOutPath "$INSTDIR"
  SetOverwrite on
  ; 只铺应用码：排除 240MB 运行环境（runtime / node_modules，首启联网下载）。
  File /r /x runtime /x node_modules "${STAGE_DIR}\*.*"

  ; ---- 卸载信息 + 卸载器（HKCU，用户级）----
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${REG_UNINST}" "DisplayName" "${DISPLAY_NAME}"
  WriteRegStr HKCU "${REG_UNINST}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${REG_UNINST}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${REG_UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REG_UNINST}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REG_UNINST}" "DisplayIcon" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "${REG_UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${REG_UNINST}" "NoRepair" 1

  ; ---- 快捷方式（当前用户桌面 + 开始菜单）----
  ; "海芯 AI" = 启动（首次会触发下载）；"退出海芯" = 停止后台。
  CreateDirectory "$SMPROGRAMS\${DISPLAY_NAME}"
  CreateShortcut "$SMPROGRAMS\${DISPLAY_NAME}\海芯 AI.lnk" "${HAIXIN_CMD}" "start" "" "" SW_SHOWNORMAL "" "启动海芯 AI 控制台"
  CreateShortcut "$SMPROGRAMS\${DISPLAY_NAME}\退出海芯 AI.lnk" "${HAIXIN_CMD}" "stop" "" "" SW_SHOWNORMAL "" "停止海芯 AI 后台"
  CreateShortcut "$SMPROGRAMS\${DISPLAY_NAME}\卸载海芯 AI.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\海芯 AI.lnk" "${HAIXIN_CMD}" "start" "" "" SW_SHOWNORMAL "" "启动海芯 AI 控制台"
  CreateShortcut "$DESKTOP\退出海芯 AI.lnk" "${HAIXIN_CMD}" "stop" "" "" SW_SHOWNORMAL "" "停止海芯 AI 后台"

  DetailPrint "安装完成。双击桌面「海芯 AI」启动（首次会联网下载运行环境）。"
SectionEnd

; ---- 卸载 ----
Var KeepData

Function un.onInit
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否保留业务数据？$\r$\n$\r$\n选择「是」：保留数据库与配置（$LOCALAPPDATA\${APP_NAME}），便于重装复用。$\r$\n选择「否」：彻底删除全部数据（含已下载的运行环境，不可恢复）。" \
    IDYES keep IDNO wipe
  keep:
    StrCpy $KeepData "1"
    Goto done
  wipe:
    StrCpy $KeepData "0"
  done:
FunctionEnd

Section "Uninstall"
  ; 先停掉可能在后台运行的海芯
  DetailPrint "停止海芯 AI 后台（如在运行）…"
  IfFileExists "${HAIXIN_CMD}" 0 +3
    nsExec::ExecToLog '"$INSTDIR\packaging\windows\haixin.cmd" stop'
    Pop $0
  Sleep 1500

  ; 删除程序目录
  RMDir /r "$INSTDIR"

  ; 数据目录按用户选择处理（含首启下载的 runtime / node_modules）
  ${If} $KeepData == "0"
    DetailPrint "删除数据目录…"
    RMDir /r "$LOCALAPPDATA\${APP_NAME}"
  ${Else}
    DetailPrint "保留数据目录：$LOCALAPPDATA\${APP_NAME}"
  ${EndIf}

  Delete "$SMPROGRAMS\${DISPLAY_NAME}\海芯 AI.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\退出海芯 AI.lnk"
  Delete "$SMPROGRAMS\${DISPLAY_NAME}\卸载海芯 AI.lnk"
  RMDir "$SMPROGRAMS\${DISPLAY_NAME}"
  Delete "$DESKTOP\海芯 AI.lnk"
  Delete "$DESKTOP\退出海芯 AI.lnk"
  DeleteRegKey HKCU "${REG_UNINST}"
SectionEnd
