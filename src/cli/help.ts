export function versionText(version: string): string {
  return `myshows-scrobbler ${version}`
}

export const HELP_TEXT = `MyShows Scrobbler

Usage:
  myshows-scrobbler [options]

Server:
  --host <host>                 Listen host (default: 0.0.0.0)
  --port <port>                 Listen port (env: PORT, default: 5172)
  --ui, --with-ui               Serve the built Vue UI
  --no-ui                       Force headless mode
  --config <path>               Config file path (env: CONFIG_PATH)

Runtime:
  --intercept-only, --dry-run   Log events without sending to MyShows
  --log-level <level>           debug, info, warn, or error
  --myshows-token <token>       Override MyShows bearer token
  --myshows-url <url>           Override MyShows API URL
  --scrobble-percent <percent>  Stop threshold, 0..100

Sources:
  --source <type>               Enable/add source: plex, jellyfin, emby, kodi
  --poll-interval <ms>          Override polling interval
  --plex-url <url>              Override Plex URL
  --plex-token <token>          Override Plex token
  --jellyfin-url <url>          Override Jellyfin URL
  --jellyfin-token <token>      Override Jellyfin token
  --emby-url <url>              Override Emby URL
  --emby-token <token>          Override Emby token
  --kodi-url <url>              Override Kodi URL
  --kodi-token <token>          Override Kodi token/basic auth value

Checks:
  --check-config                Validate config and exit
  --check-source <type>         Check one configured source and exit

One-click setup (enable a player's web interface / IPC, reversibly):
  --list-setup                  List available setup actions and exit
  --run-setup <id>              Apply a setup action (e.g. mpc-hc-web-interface) and exit
  --undo-setup <snapshot-id>    Restore a previously applied setup action and exit

Info:
  -h, --help                    Show this help
  -v, --version                 Show version`
