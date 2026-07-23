import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { createServer } from './server.js'
import { DEFAULT_PORT } from './config.js'
import type { Logger } from './logger.js'
import { IDLE_UPDATE_STATUS } from './types.js'
import type { UpdateController, UpdateStatus } from './types.js'
import {
  AUTOSTART_ARGS,
  isWindowsAutostartActive,
  shouldRepairWindowsAutostart,
  type LoginItemSnapshot,
} from './utils/autostart.js'

const { autoUpdater } = electronUpdater

process.env.NODE_ENV = 'production'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: InstanceType<typeof BrowserWindow> | null = null
let tray: InstanceType<typeof Tray> | null = null
let isQuitting = false
let didRequestQuit = false
// Set while an auto-update install is shutting the app down. electron-updater's
// quitAndInstall() spawns the installer and then calls app.quit(); our
// `before-quit` handler normally preventDefault()s that to route quits through
// requestQuit(). This flag tells before-quit to let the quit through so the
// installer isn't left waiting forever (the Windows "Update does nothing" bug).
let installingUpdate = false
let mainUrl = ''
let stopServer: (() => Promise<void>) | null = null

/**
 * Resolve a bundled icon asset by filename. Packaged builds ship these PNGs
 * into Resources via `build.extraResources`; in dev they live in the repo.
 * For tray-icon.png the matching `@2x` variant next to it is picked up
 * automatically by nativeImage on retina displays.
 */
function iconPath(file: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(__dirname, '..', '..', 'assets', 'tray', file)
}

function restoreMainWindow(): void {
  if (process.platform === 'darwin') {
    void app.dock?.show()
  }

  // The window is destroyed (not hidden) while parked in the tray to free its
  // renderer process, so reopening recreates it from scratch.
  if (!mainWindow) {
    if (mainUrl) {
      void createMainWindow(mainUrl)
    }
    return
  }

  mainWindow.show()
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.focus()
}

// ── Autostart at login ──
//
// macOS and Windows go through Electron's login-item API (SMAppService /
// registry Run key). Linux has no Electron support for login items, so we
// write an XDG autostart .desktop entry pointing at the AppImage instead.
//
// The user's choice is also mirrored to a file in userData. Windows updates
// reinstall the app rather than patch it, so the Run entry can end up pointing
// at a path that no longer exists; the stored preference is what lets us
// notice and put it back (see repairAutostart).

function linuxAutostartFile(): string {
  const configDir = process.env.XDG_CONFIG_HOME ?? path.join(app.getPath('home'), '.config')
  return path.join(configDir, 'autostart', 'myshows-scrobbler.desktop')
}

function autostartPrefPath(): string {
  return path.join(app.getPath('userData'), 'autostart.json')
}

/** The remembered choice, or null when the user never touched the toggle. */
function readAutostartPref(): boolean | null {
  try {
    const raw = JSON.parse(fs.readFileSync(autostartPrefPath(), 'utf8')) as { enabled?: unknown }
    return typeof raw.enabled === 'boolean' ? raw.enabled : null
  } catch {
    return null
  }
}

function writeAutostartPref(enabled: boolean): void {
  try {
    fs.writeFileSync(autostartPrefPath(), JSON.stringify({ enabled }))
  } catch (err) {
    console.error(err)
  }
}

function windowsLoginItems(): LoginItemSnapshot {
  // Ask with the same args we registered with — Windows matches the whole
  // command line, so a bare call reports openAtLogin: false for our entry.
  return app.getLoginItemSettings({ args: AUTOSTART_ARGS })
}

function isAutostartEnabled(): boolean {
  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartFile())
  }
  if (process.platform === 'win32') {
    return isWindowsAutostartActive(windowsLoginItems())
  }
  return app.getLoginItemSettings().openAtLogin
}

function setAutostart(enabled: boolean): void {
  writeAutostartPref(enabled)

  if (process.platform === 'linux') {
    const file = linuxAutostartFile()
    try {
      if (enabled) {
        // Packaged Linux builds run from an AppImage; APPIMAGE holds its real
        // path (process.execPath points inside the extracted squashfs mount).
        const exec = process.env.APPIMAGE ?? process.execPath
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(
          file,
          [
            '[Desktop Entry]',
            'Type=Application',
            'Name=MyShows Scrobbler',
            `Exec="${exec}" --hidden`,
            'X-GNOME-Autostart-enabled=true',
            '',
          ].join('\n'),
        )
      } else {
        fs.rmSync(file, { force: true })
      }
    } catch (err) {
      console.error(err)
    }
    return
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Windows only: launch parked in the tray (see shouldStartHidden). macOS
    // login items get no custom args — detected via wasOpenedAtLogin instead.
    args: AUTOSTART_ARGS,
  })
}

/**
 * Reconcile the remembered autostart choice with what the OS actually has,
 * once per launch. Two jobs:
 *
 *  - First run after this shipped (no preference file): adopt whatever is
 *    registered, so a choice made in an earlier version is remembered too.
 *  - Windows: if the preference says "on" but no Run entry points at this
 *    executable, put it back. An NSIS update reinstalls the app, and any
 *    reinstall that changes the install path orphans the old entry — the
 *    toggle then reads as off and the app quietly stops starting at login.
 *
 * Never turns autostart on by itself: with no stored preference, or one that
 * says off, this does nothing. An entry the user disabled in Task Manager is
 * left alone too (see shouldRepairWindowsAutostart).
 */
function repairAutostart(logger: Logger): void {
  if (!app.isPackaged) {
    return
  }

  const preference = readAutostartPref()
  if (preference === null) {
    writeAutostartPref(isAutostartEnabled())
    return
  }

  if (process.platform !== 'win32') {
    return
  }
  if (!shouldRepairWindowsAutostart(preference, windowsLoginItems(), process.execPath)) {
    return
  }

  logger.info('Autostart entry is missing — restoring it from the saved preference')
  setAutostart(true)
  updateTrayMenu()
}

/**
 * True when this launch came from the login autostart — such launches go
 * straight to the tray without opening the window. Windows and Linux pass
 * --hidden (we control the registry args / .desktop Exec line); macOS login
 * items launch without custom args, so ask the system instead.
 */
function shouldStartHidden(): boolean {
  if (process.argv.includes('--hidden')) {
    return true
  }
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}

function createTray(): void {
  if (tray) {
    return
  }

  // macOS menu bar expects a monochrome template image that the system tints
  // to match light/dark mode (the "Template" filename suffix flags it). Other
  // platforms have no auto-tinting, so use the colored brand icon there.
  const isMac = process.platform === 'darwin'
  let image = nativeImage.createFromPath(iconPath(isMac ? 'trayTemplate.png' : 'tray-icon.png'))
  if (image.isEmpty()) {
    image = nativeImage.createFromNamedImage('NSStatusAvailable')
  }
  if (isMac) {
    image.setTemplateImage(true)
  }

  tray = new Tray(image)
  tray.setToolTip('MyShows Scrobbler')
  updateTrayMenu()
  tray.on('click', restoreMainWindow)
}

async function requestQuit(): Promise<void> {
  if (didRequestQuit) {
    return
  }
  didRequestQuit = true
  isQuitting = true

  try {
    await stopServer?.()
  } catch (err) {
    console.error(err)
  } finally {
    app.quit()
  }
}

type UiLocale = 'ru' | 'en'

/**
 * Language for native (main-process) notifications and the tray menu. Mirrors
 * the renderer's LangSwitch choice; until the window has synced it once, falls
 * back to the OS locale.
 */
let uiLocale: UiLocale | null = null

function getUiLocale(): UiLocale {
  if (uiLocale) {
    return uiLocale
  }
  return app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

/**
 * Pull the renderer's language choice (localStorage 'locale') into uiLocale
 * and rebuild the tray menu when it changed.
 */
async function syncUiLocale(): Promise<void> {
  try {
    const stored: unknown = await mainWindow?.webContents.executeJavaScript(
      `localStorage.getItem('locale')`,
    )
    if ((stored === 'ru' || stored === 'en') && stored !== uiLocale) {
      uiLocale = stored
      updateTrayMenu()
    }
  } catch {
    // Window already gone — keep the last known value.
  }
}

/**
 * One-time heads-up that closing the window doesn't quit the app. Without it
 * the first close looks like the app silently died — on Windows the tray icon
 * usually hides behind the taskbar chevron, so the user has no clue it's
 * still scrobbling. Flag file in userData keeps it to a single showing.
 */
function trayNoticePath(): string {
  return path.join(app.getPath('userData'), 'tray-notice-shown')
}

const TRAY_NOTICE_BODY: Record<UiLocale, string> = {
  ru: 'Приложение продолжает работать в трее и отмечает просмотры. Выйти можно через меню иконки в трее.',
  en: 'The app keeps running in the tray and keeps scrobbling. Use the tray icon menu to quit.',
}

const UPDATE_AVAILABLE_BODY: Record<UiLocale, (version: string) => string> = {
  ru: (version) => `Доступна новая версия ${version}`,
  en: (version) => `A new version ${version} is available`,
}

const TRAY_MENU_LABELS: Record<UiLocale, { show: string; autostart: string; quit: string }> = {
  ru: { show: 'Показать', autostart: 'Запускать при старте системы', quit: 'Выйти' },
  en: { show: 'Show', autostart: 'Launch at login', quit: 'Quit' },
}

/**
 * (Re)build the tray context menu in the current UI language. Re-reads the
 * autostart state too, so a change made externally (System Settings, registry)
 * is picked up on the next rebuild.
 */
function updateTrayMenu(): void {
  if (!tray) {
    return
  }
  const labels = TRAY_MENU_LABELS[getUiLocale()]
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: restoreMainWindow },
      { type: 'separator' },
      {
        label: labels.autostart,
        type: 'checkbox',
        checked: isAutostartEnabled(),
        // In dev process.execPath is the bare Electron binary from
        // node_modules — registering it in autostart would launch a blank
        // Electron shell, so the toggle only makes sense in packaged builds.
        enabled: app.isPackaged,
        // Rebuild after toggling so the tick reflects what the OS ended up
        // with, not what the click assumed (a registry write can fail).
        click: (item) => {
          setAutostart(item.checked)
          updateTrayMenu()
        },
      },
      { type: 'separator' },
      { label: labels.quit, click: () => void requestQuit() },
    ]),
  )
}

function maybeShowTrayNotice(): void {
  if (!Notification.isSupported() || fs.existsSync(trayNoticePath())) {
    return
  }
  try {
    fs.writeFileSync(trayNoticePath(), '1')
  } catch {
    // best-effort; worst case the notice shows again next time
  }
  new Notification({
    title: 'MyShows Scrobbler',
    body: TRAY_NOTICE_BODY[getUiLocale()],
  }).show()
}

async function createMainWindow(url: string): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'MyShows Scrobbler',
    // On macOS the window/Dock icon comes from the .app bundle (build/icon.icns);
    // Windows and Linux need it set explicitly for the title bar / taskbar.
    ...(process.platform === 'darwin' ? {} : { icon: iconPath('app-icon.png') }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return
    }

    // Destroy (not hide) the window when sent to the tray: that releases its
    // renderer process (~125 MB). The GPU/main processes stay, so it's not the
    // whole footprint, but it's the biggest freeable chunk. The server and
    // adapters keep running in the main process, so scrobbling is unaffected;
    // reopening from the tray recreates the window and re-syncs from the server.
    event.preventDefault()
    // Refresh the notification language from the renderer while the window is
    // still alive (the tray notice reads getUiLocale), then tear it down. The
    // destroy is deferred to .finally so it runs even if the sync fails.
    void syncUiLocale().finally(() => {
      maybeShowTrayNotice()
      mainWindow?.destroy()
      if (process.platform === 'darwin') {
        app.dock?.hide()
      }
    })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: externalUrl }: { url: string }) => {
    void shell.openExternal(externalUrl)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(url)

  // Reopening the window mid-download gives us a fresh taskbar button, which
  // starts out with no progress bar — put it back.
  if (updateStatus.downloading) {
    setNativeUpdateProgress(updateStatus.percent)
  }

  // Pick up the renderer's stored language right away so the tray menu and
  // notifications match the in-app choice (it's re-synced on window close and
  // before update notices).
  void syncUiLocale()
}

// ── Auto-update (electron-updater + GitHub releases) ──
//
// Updates are NOT forced: we check in the background and surface availability to
// the UI (a dot on the version + a prompt); the user picks Update or Skip.

let updateStatus: UpdateStatus = { ...IDLE_UPDATE_STATUS }

/**
 * Grace period between "downloaded" and shutting the server down, so the UI's
 * 1s progress poll picks up the `installing` flag before the backend goes away.
 */
const INSTALL_HANDOFF_DELAY_MS = 1200

const TRAY_DOWNLOAD_TOOLTIP: Record<UiLocale, (percent: number) => string> = {
  ru: (percent) => `MyShows Scrobbler — загрузка обновления ${percent}%`,
  en: (percent) => `MyShows Scrobbler — downloading update ${percent}%`,
}

/**
 * Mirror the download onto the OS chrome: the taskbar button on Windows, the
 * Dock icon on macOS, the launcher on Unity. Electron ships no update UI of
 * its own, but this native progress bar is free — and it is the only progress
 * a user sees while the app window is closed. `-1` clears it.
 *
 * The tray tooltip carries the same number, since the window (and with it the
 * taskbar button) is destroyed whenever the app is parked in the tray.
 */
function setNativeUpdateProgress(percent: number | null): void {
  mainWindow?.setProgressBar(percent === null ? -1 : percent / 100)
  tray?.setToolTip(
    percent === null
      ? 'MyShows Scrobbler'
      : TRAY_DOWNLOAD_TOOLTIP[getUiLocale()](Math.round(percent)),
  )
}

function skippedUpdatesPath(): string {
  return path.join(app.getPath('userData'), 'skipped-updates.json')
}
function loadSkippedUpdates(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(skippedUpdatesPath(), 'utf8')) as unknown
    return new Set(Array.isArray(raw) ? raw.map(String) : [])
  } catch {
    return new Set()
  }
}
function saveSkippedUpdates(skipped: Set<string>): void {
  try {
    fs.writeFileSync(skippedUpdatesPath(), JSON.stringify([...skipped]))
  } catch {
    // best-effort
  }
}

/**
 * Build the update controller (passed to the server so the UI can drive it) and
 * a `start(logger)` that wires electron-updater — split because the logger only
 * exists after the server starts. `start` is a no-op in dev (no manifest).
 */
function createUpdateController(): {
  controller: UpdateController
  start: (logger: Logger) => void
} {
  const skipped = loadSkippedUpdates()
  // Captured once start(logger) runs. Without it, a rejected downloadUpdate()
  // is swallowed silently — which looks exactly like "clicking Update does
  // nothing" with no trace to debug from.
  let updateLogger: Logger | null = null

  const controller: UpdateController = {
    getStatus: () => ({ ...updateStatus }),
    install: () => {
      if (!updateStatus.version) {
        updateLogger?.warn('Update install requested but no version is available')
        return
      }
      // A second click while the transfer is running would start a parallel
      // download and reset the progress the UI is drawing.
      if (updateStatus.downloading || updateStatus.installing) {
        return
      }
      // All platforms self-install: download the update, then quitAndInstall on
      // `update-downloaded`. macOS works too because release builds are signed
      // + notarized (Squirrel.Mac requires a valid signature) and ship a `zip`
      // target alongside the dmg.
      updateLogger?.info(`Downloading update ${updateStatus.version}...`)
      updateStatus = {
        ...updateStatus,
        downloading: true,
        percent: 0,
        transferred: 0,
        total: null,
        bytesPerSecond: null,
        error: null,
      }
      void autoUpdater.downloadUpdate().catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        updateStatus = { ...updateStatus, downloading: false, error: message }
        updateLogger?.warn(`Update download failed: ${message}`)
      })
    },
    skip: () => {
      if (updateStatus.version) {
        skipped.add(updateStatus.version)
        saveSkippedUpdates(skipped)
      }
      updateStatus = { ...IDLE_UPDATE_STATUS }
    },
  }

  const start = (logger: Logger): void => {
    updateLogger = logger
    if (!app.isPackaged) {
      return
    }
    autoUpdater.autoDownload = false

    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err)
      // Only surface failures for a transfer the user started — the banner is
      // the only place `error` shows, and a failed background check (offline,
      // GitHub hiccup) has nothing on screen it would explain.
      const userInitiated = updateStatus.downloading || updateStatus.installing
      updateStatus = {
        ...updateStatus,
        downloading: false,
        installing: false,
        bytesPerSecond: null,
        error: userInitiated ? message : updateStatus.error,
      }
      setNativeUpdateProgress(null)
      logger.warn(`Auto-update error: ${message}`)
    })
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.max(0, Math.min(100, progress.percent))
      updateStatus = {
        ...updateStatus,
        downloading: true,
        percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      }
      setNativeUpdateProgress(percent)
    })
    autoUpdater.on('update-available', (info) => {
      if (skipped.has(info.version)) {
        return
      }
      // The 6h re-check re-announces the same version; don't let it wipe the
      // progress of a download already in flight.
      if (updateStatus.downloading || updateStatus.installing) {
        return
      }
      updateStatus = { ...IDLE_UPDATE_STATUS, available: true, version: info.version }
      logger.info(`Update available: ${info.version}`)
      // Only nudge with a native popup when the window is hidden (parked in the
      // tray / minimized). If it's open, the in-app dot + banner already show the
      // update, so a popup would be redundant. The 6h re-check keeps re-firing
      // this event, so a tray user gets a quiet reminder every 6h until they act
      // (Install downloads; Skip adds the version to `skipped` above).
      const windowHidden = !mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()
      if (Notification.isSupported() && windowHidden) {
        // Refresh the language from the renderer first (if the window is still
        // alive) so the notice matches the in-app choice, not just the OS locale.
        void syncUiLocale().finally(() => {
          const note = new Notification({
            title: 'MyShows Scrobbler',
            body: UPDATE_AVAILABLE_BODY[getUiLocale()](info.version),
            // Silent: the app lives in the tray long-term, so an update is a
            // low-urgency heads-up — a soundless nudge, not an alert.
            silent: true,
          })
          note.on('click', restoreMainWindow)
          note.show()
        })
      }
    })
    // Once the download finishes, install it. We drive the shutdown ourselves:
    // quitAndInstall() spawns the installer and then calls app.quit(), but this
    // app's `before-quit` handler preventDefault()s quits to route them through
    // requestQuit() (graceful tray shutdown). That preventDefault cancels
    // electron-updater's quit, leaving the Windows installer waiting for an exit
    // that never comes — the "clicking Update does nothing" bug. Setting
    // `installingUpdate` lets before-quit pass the quit through; we stop the
    // server first, then hand off to electron-updater.
    autoUpdater.on('update-downloaded', () => {
      logger.info('Update downloaded — stopping server and installing')
      installingUpdate = true
      isQuitting = true
      updateStatus = { ...updateStatus, downloading: false, installing: true, percent: 100 }
      void (async () => {
        // Let the UI poll once more so the banner says "installing" before the
        // window goes away — otherwise it vanishes mid-progress-bar and the
        // relaunch looks like a crash.
        await new Promise((resolve) => setTimeout(resolve, INSTALL_HANDOFF_DELAY_MS))
        try {
          await stopServer?.()
        } catch (err) {
          logger.warn(
            `Server stop before update install failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        } finally {
          autoUpdater.quitAndInstall()
        }
      })()
    })

    const check = (): void => {
      void autoUpdater.checkForUpdates().catch((err) => {
        logger.warn(`Update check failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
    check()
    // Re-check periodically — the app is long-running in the tray.
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000
    setInterval(check, SIX_HOURS_MS)
  }

  return { controller, start }
}

async function main(): Promise<void> {
  // CONFIG_PATH lets the user point at an existing config (their dev tree's
  // data/config.json, a shared file on a NAS mount, etc.) without copying
  // it into Electron's userData dir. Falls back to userData — the same
  // place the packaged installer creates an empty config on first launch.
  const configPath = process.env.CONFIG_PATH ?? path.join(app.getPath('userData'), 'config.json')
  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) || DEFAULT_PORT : 0

  const updates = createUpdateController()

  const { logger, start, stop } = await createServer({
    ui: true,
    configPath,
    port,
    updates: updates.controller,
  })
  stopServer = stop

  const address = await start()
  mainUrl = address.replace('0.0.0.0', '127.0.0.1')
  logger.info(`Electron UI: ${mainUrl}`)

  createTray()
  repairAutostart(logger)
  if (shouldStartHidden()) {
    // Launched by the login autostart: park in the tray, don't pop the window
    // on every boot. restoreMainWindow creates it on demand from mainUrl.
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }
  } else {
    await createMainWindow(mainUrl)
  }

  updates.start(logger)
}

// Single-instance lock. A second launch (common on Windows: re-running the
// installer shortcut, double-click) would fight over the server port and
// double-scrobble. Refuse the second instance and surface the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    restoreMainWindow()
  })

  void app.whenReady().then(() => {
    main().catch((err) => {
      console.error(err)
      app.quit()
    })
  })
}

// Stay alive in the tray after the window is destroyed (we destroy it, rather
// than hide, to free its renderer memory). Without this, Electron's default
// quits the app once the last window closes. Quitting goes through the tray
// "Выйти" item / `requestQuit` instead.
app.on('window-all-closed', () => {
  // Intentionally empty — overrides the default quit-on-last-window.
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainUrl) {
    void createMainWindow(mainUrl)
    return
  }

  restoreMainWindow()
})

app.on('before-quit', (event) => {
  isQuitting = true

  // Already shutting down via requestQuit(), or electron-updater is installing
  // an update (it stopped the server and now needs the app to actually quit so
  // the installer can run) — let the quit proceed.
  if (didRequestQuit || installingUpdate) {
    return
  }

  event.preventDefault()
  void requestQuit()
})
