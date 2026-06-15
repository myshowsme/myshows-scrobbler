# MyShows Scrobbler

[Русская версия](README.md)

[![Release](https://img.shields.io/github/v/release/myshowsme/myshows-scrobbler)](https://github.com/myshowsme/myshows-scrobbler/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Watch the way you always do, in Plex, Jellyfin, Emby, Kodi or a plain desktop player. Don't worry about check-ins: your watch progress and date go to your [MyShows.me](https://myshows.me) profile automatically.

The scrobbler runs locally: it tracks playback, and once you pass the watch threshold (80% by default) it checks the episode in on MyShows. Abandoned episodes don't count. No telemetry — data only goes to MyShows and your own media servers.

<!-- TODO: add screenshot — ![MyShows Scrobbler](assets/screenshot.png) -->

## Installation

Grab a build from the [Releases](https://github.com/myshowsme/myshows-scrobbler/releases) page:

| Platform              | File                                    | Notes                                                              |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| Windows               | `MyShows Scrobbler Setup <version>.exe` |                                                                    |
| macOS (Apple Silicon) | `*.dmg`                                 | The build is not notarized. On first launch use right-click → Open |
| Linux                 | `*.AppImage`                            | Experimental                                                       |

The app lives in the tray and keeps scrobbling with the window closed. Updates come from GitHub Releases; the app asks before installing one.

## Quick start

1. **MyShows token.** Get the token from your [profile](https://en.myshows.me/profile/watch-history/) and paste it into the field at the top; it is verified immediately.
2. **Enable a source.** If Plex or Kodi run on the same machine, the token and URL are filled in automatically. Jellyfin offers Quick Connect (a code on screen, confirmed on the server), Emby offers username/password sign-in. No media server? Enable "Local player".
3. **Play something.** A "Now playing" card shows up in the app, which means your watch progress is being sent to MyShows.

## Sources

| Source                        | Setup                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plex**                      | Token is discovered automatically from a local Plex Media Server. For a remote server, paste the `X-Plex-Token` manually                                                   |
| **Jellyfin**                  | Quick Connect or an API key                                                                                                                                                |
| **Emby**                      | Username/password sign-in or an API key                                                                                                                                    |
| **Kodi**                      | Web interface username, password and port are discovered automatically, or set by hand                                                                                     |
| **VLC, mpv, MPC-HC/BE, IINA** | One click in the Setup panel: the app can edit the player config itself (HTTP interface for VLC and MPC, IPC for mpv and IINA) and starts reading exact position and state |
| **Local player**              | Zero config: process scanning plus system media APIs (SMTC on Windows, AppleScript on macOS). Also catches players that have no dedicated adapter                          |

### Features

- Tracks your watch progress and saves it for you automatically.
- Shows and movies are recognized and matched automatically on the MyShows side.
- Rewatches are recorded too.

### Local player limitations

- The scrobbler must run on the same machine as the player. Host processes are not visible from Docker.
- Players wired through the Setup panel report an exact position via their API. For everything else, progress is estimated from process uptime, so pauses and seeking are invisible in that mode.
- Title, season and episode are extracted from the file name automatically: [guessit-js](https://github.com/wuestholz/guessit-js).

## Without the desktop app

The same server runs headless, on a NAS, a home server, or just in a terminal. Local players won't work from Docker; media servers work fine.

### Docker

```bash
docker compose up -d
```

Web UI on `http://localhost:3000`, config in the `./data/config.json` volume. (The Docker image sets the port to `3000`; the app's own default is `5172`.)

### Node.js

Requires Node.js 24+ and [pnpm](https://pnpm.io/) 11+ (`corepack enable`).

```bash
pnpm install
pnpm build:all
pnpm start:ui        # server + web UI on :5172
```

Or in one go: [start.sh](start.sh) (Linux/macOS) and [start.bat](start.bat) (Windows) check Node, install dependencies and start the server.

The `--ui` flag serves the web UI. The `CONFIG_PATH` env var sets the config location (default `./data/config.json`, `/data/config.json` in Docker).

## Configuration

Everything is configurable from the UI, or by hand in `data/config.json`:

```json
{
  "myshows_token": "your_bearer_token_from_myshows.me",
  "scrobble_percent": 80,
  "log_level": "info",
  "sources": [
    {
      "type": "plex",
      "enabled": true,
      "url": "http://localhost:32400",
      "token": "plex_x_token",
      "poll_interval": 5000
    }
  ]
}
```

- `scrobble_percent`: the "watched" threshold, in percent.
- `poll_interval`: source polling period, ms.

## Scrobble API

The scrobbler talks to MyShows over a simple HTTP API (`POST /start`, `/pause`, `/stop`, `GET /check`) with `Authorization: Bearer <token>` auth. The payload format is a superset of the Trakt and Simkl scrobble APIs. The full DTO lives in [src/scrobblers/scrobble-dto.ts](src/scrobblers/scrobble-dto.ts).

## Development

The toolchain is [Vite+](https://viteplus.dev/): build, lint, formatting and tests under one command.

```bash
pnpm dev             # headless server with auto-reload
pnpm dev:all         # server + Vue UI dev server (:5173)
pnpm check           # format + lint + typecheck
pnpm test            # unit tests
pnpm test:e2e        # playwright (builds the project first)
```

### Adding a source

1. Subclass [`BaseAdapter`](src/adapters/base.ts): `name`, `checkConnection`, `poll()`. The base class runs the polling timer; the adapter calls `emitScrobble(event)`.
2. Add the type to the `SourceType` union in [src/types.ts](src/types.ts). Sources without a URL/token belong in `LOCAL_SOURCE_TYPES`.
3. `registerAdapter(...)` in [src/server.ts](src/server.ts) and the type in `VALID_SOURCE_TYPES` in [src/routes/api.ts](src/routes/api.ts).
4. `pnpm generate:ui-types`.

Anti-spam, the threshold and retries live in the shared pipeline (`handleScrobble`); adapters don't deal with them.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to send PRs and report bugs.

## License

MIT
