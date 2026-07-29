# Plex: finding your token and server URL

Normally the token and URL fill themselves in: the **"Find token"** button reads `Preferences.xml` out of the local Plex Media Server's data directory. If it reports "no local Plex Media Server found", that file isn't where the scrobbler looks. Three usual causes:

- **The Plex data directory was moved** to another drive (common with a large library) — the path is in the registry, under `LocalAppDataPath`.
- **Plex runs under a different Windows account** — installed as a service, or under an admin account. Its settings then sit in that user's profile, not yours.
- **Settings live in the registry only**, with no `Preferences.xml` on disk at all.

In all three cases the token goes in by hand — here is every way to get it.

> **The token is a credential for your Plex account.** It grants full access to the server and library. Don't paste it into issues, logs or screenshots.

---

## Option 1. Windows: the registry (fastest)

Plex on Windows mirrors `PlexOnlineToken` into the current user's registry hive.

**PowerShell** — open Start, type `PowerShell`, paste one line:

```powershell
(Get-ItemProperty "HKCU:\Software\Plex, Inc.\Plex Media Server").PlexOnlineToken
```

It prints a 20-character string — that's the token.

**Or via regedit:** `Win + R` → `regedit` → navigate to

```
HKEY_CURRENT_USER\Software\Plex, Inc.\Plex Media Server
```

and read the **`PlexOnlineToken`** value (right-click → Modify → copy the string).

> If PowerShell returns nothing, or the key is missing, Plex Media Server runs under a **different Windows account** (common when it's installed as a service or under an admin account). The token then sits in that user's hive. Use option 2 instead — it's less trouble.

**Other operating systems:**

| OS                  | Where `PlexOnlineToken` lives                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Windows**         | `%LOCALAPPDATA%\Plex Media Server\Preferences.xml`, plus a copy in the registry: `HKCU\Software\Plex, Inc.\Plex Media Server` |
| **macOS**           | `~/Library/Preferences/com.plexapp.plexmediaserver.plist`                                                                     |
| **Linux (package)** | `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml`                                      |
| **Docker / NAS**    | `<config volume>/Library/Application Support/Plex Media Server/Preferences.xml`                                               |

**If the Plex data directory was moved,** its root is recorded in the same registry key:

```powershell
(Get-ItemProperty "HKCU:\Software\Plex, Inc.\Plex Media Server").LocalAppDataPath
```

The token file then lives at `<that path>\Plex Media Server\Preferences.xml`.

---

## Option 2. Plex Web: "View XML" (works everywhere)

Plex's own documented method. Independent of the OS and of which account runs the server.

1. Open Plex Web — [app.plex.tv](https://app.plex.tv) or `http://127.0.0.1:32400/web` — and sign in.
2. Open **any** movie or episode in your library.
3. Click **⋯** (three dots) → **Get Info**.
4. At the bottom of the info dialog click **View XML** — a new tab opens.
5. Look at that tab's **address bar**. It ends with:

   ```
   ...?checkFiles=1&...&X-Plex-Token=xxxxxxxxxxxxxxxxxxxx
   ```

   Copy whatever follows `X-Plex-Token=` — 20 characters, up to the end of the URL or the next `&`.

---

## Option 3. Account token from the browser

If Plex Web is already open, the token can be read out of page storage.

1. On the [app.plex.tv](https://app.plex.tv) tab press `F12` (DevTools) → **Console**.
2. Run:

   ```js
   localStorage.getItem('myPlexAccessToken')
   ```

3. Copy the string from between the quotes.

This is the account token — it works against any of your servers.

---

## Finding the server URL

The scrobbler's **URL** field wants the Plex API address. The default port is **32400**.

| Where Plex runs                     | What to enter                                                         |
| ----------------------------------- | --------------------------------------------------------------------- |
| **Same machine** as the scrobbler   | `http://127.0.0.1:32400` (the default — leave it alone)               |
| **Another machine/NAS on your LAN** | `http://192.168.x.x:32400` — the local IP of the Plex box             |
| Over the internet                   | `https://<your-hash>.plex.direct:32400` — from Plex Web's address bar |

**To find the Plex machine's local IP:** Plex Web → **Settings** (wrench) → your server → **Remote Access** shows the address and port the server is reachable on. Or **Settings → Network**, the "List of IP addresses and networks" field.

**To verify a URL without a token,** open in a browser:

```
http://127.0.0.1:32400/identity
```

A live Plex answers with XML:

```xml
<MediaContainer size="0" apiVersion="1.2.2" claimed="1"
  machineIdentifier="1216627cc55263373ac8faa5d1946979c6ba5242"
  version="1.43.3.10828-00f62d37d" />
```

If the page doesn't load, the problem is the address, the port or a firewall — not the token.

---

## Verifying URL + token together

Open this in a browser, substituting your own values:

```
http://127.0.0.1:32400/status/sessions?X-Plex-Token=YOUR_TOKEN
```

- **XML with a session list** (an empty `<MediaContainer size="0">` if nothing is playing) — correct; put the same values into the scrobbler.
- **`401 Unauthorized`** — the token is wrong or was copied only partially.

---

## Common problems

**"no local Plex Media Server found" on Windows.**
The scrobbler didn't find `Preferences.xml` in the standard data directory. The causes and what to check are at the top of this page; grab the token via option 1 or 2 and paste it in.

**`Invalid Plex token (401)` in the event log.**
The token field is empty, has stray whitespace, or holds a truncated string. Tokens are exactly 20 characters. Check the pair with the link above.

**`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.**
Something other than the Plex API answers at that address — a web page. Make sure the URL field has no `/web` or extra path, just `http://127.0.0.1:32400`.

**Everything connects but nothing scrobbles.**
The token must belong to the **server owner**. A managed user's or guest's token can't see other people's sessions in `/status/sessions`.
