import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { createServer } from './server.js'
import { DEFAULT_PORT } from './config.js'
import type { Logger } from './logger.js'
import type { UpdateController, UpdateStatus } from './types.js'

const { autoUpdater } = electronUpdater

const RELEASES_URL = 'https://github.com/myshowsme/myshows-scrobbler/releases/latest'

process.env.NODE_ENV = 'production'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let mainWindow: InstanceType<typeof BrowserWindow> | null = null
let tray: InstanceType<typeof Tray> | null = null
let isQuitting = false
let didRequestQuit = false
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Показать', click: restoreMainWindow },
      { type: 'separator' },
      {
        label: 'Выйти',
        click: () => void requestQuit(),
      },
    ]),
  )
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
 * Language for native (main-process) notifications. Mirrors the renderer's
 * LangSwitch choice; until the window has synced it once, falls back to the
 * OS locale.
 */
let uiLocale: UiLocale | null = null

function getUiLocale(): UiLocale {
  if (uiLocale) {
    return uiLocale
  }
  return app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

/** Pull the renderer's language choice (localStorage 'locale') into uiLocale. */
async function syncUiLocale(): Promise<void> {
  try {
    const stored: unknown = await mainWindow?.webContents.executeJavaScript(
      `localStorage.getItem('locale')`,
    )
    if (stored === 'ru' || stored === 'en') {
      uiLocale = stored
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
    maybeShowTrayNotice()
    mainWindow?.destroy()
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: externalUrl }: { url: string }) => {
    void shell.openExternal(externalUrl)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(url)
}

// ── Auto-update (electron-updater + GitHub releases) ──
//
// Updates are NOT forced: we check in the background and surface availability to
// the UI (a dot on the version + a prompt); the user picks Update or Skip.

let updateStatus: UpdateStatus = { available: false, version: null, downloading: false }

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
  const isMac = process.platform === 'darwin'

  const controller: UpdateController = {
    getStatus: () => ({ ...updateStatus }),
    install: () => {
      if (!updateStatus.version) {
        return
      }
      if (isMac) {
        // Unsigned macOS build can't self-install (Squirrel.Mac needs a
        // signature) — open the release page for a manual download.
        void shell.openExternal(RELEASES_URL)
        return
      }
      updateStatus = { ...updateStatus, downloading: true }
      void autoUpdater.downloadUpdate().catch(() => {
        updateStatus = { ...updateStatus, downloading: false }
      })
    },
    skip: () => {
      if (updateStatus.version) {
        skipped.add(updateStatus.version)
        saveSkippedUpdates(skipped)
      }
      updateStatus = { available: false, version: null, downloading: false }
    },
  }

  const start = (logger: Logger): void => {
    if (!app.isPackaged) {
      return
    }
    autoUpdater.autoDownload = false

    autoUpdater.on('error', (err) => {
      updateStatus = { ...updateStatus, downloading: false }
      logger.warn(`Auto-update error: ${err instanceof Error ? err.message : String(err)}`)
    })
    autoUpdater.on('update-available', (info) => {
      if (skipped.has(info.version)) {
        return
      }
      updateStatus = { available: true, version: info.version, downloading: false }
      logger.info(`Update available: ${info.version}`)
      if (Notification.isSupported()) {
        const note = new Notification({
          title: 'MyShows Scrobbler',
          body: `Доступна новая версия ${info.version}`,
        })
        note.on('click', restoreMainWindow)
        note.show()
      }
    })
    // Win/Linux: once the user opted in and the download finished, install it.
    autoUpdater.on('update-downloaded', () => {
      autoUpdater.quitAndInstall()
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
  await createMainWindow(mainUrl)

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

  if (didRequestQuit) {
    return
  }

  event.preventDefault()
  void requestQuit()
})
