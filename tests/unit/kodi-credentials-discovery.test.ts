import { describe, it, expect } from 'vite-plus/test'
import {
  extractKodiWebCredentials,
  kodiGuiSettingsPathCandidates,
} from '../../src/utils/kodi-credentials-discovery.js'

describe('extractKodiWebCredentials', () => {
  it('reads all four web-interface settings from a modern guisettings.xml', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<settings version="2">
  <setting id="services.webserver" default="true">true</setting>
  <setting id="services.webserverport" default="true">8088</setting>
  <setting id="services.webserverusername" default="true">homer</setting>
  <setting id="services.webserverpassword">d0nuts</setting>
  <setting id="services.webserverssl" default="true">false</setting>
</settings>`
    const result = extractKodiWebCredentials(xml)
    expect(result).toEqual({
      enabled: true,
      port: 8088,
      username: 'homer',
      password: 'd0nuts',
    })
  })

  it('defaults to port 8080 and username "kodi" when those settings are omitted', () => {
    // Kodi can leave default-valued settings out of guisettings.xml entirely;
    // we should still treat the source as fully configured.
    const xml = `<settings version="2">
  <setting id="services.webserver">true</setting>
  <setting id="services.webserverpassword">secret</setting>
</settings>`
    const result = extractKodiWebCredentials(xml)
    expect(result).toEqual({
      enabled: true,
      port: 8080,
      username: 'kodi',
      password: 'secret',
    })
  })

  it('flags webserver as disabled when the setting is "false"', () => {
    const xml = `<settings version="2">
  <setting id="services.webserver">false</setting>
  <setting id="services.webserverport">8080</setting>
</settings>`
    const result = extractKodiWebCredentials(xml)
    expect(result?.enabled).toBe(false)
  })

  it('returns null when the file has none of the web-interface settings', () => {
    // Not a Kodi guisettings.xml at all — caller maps this to "parse-error".
    const xml = '<settings version="2"><setting id="audiooutput.volume">100</setting></settings>'
    expect(extractKodiWebCredentials(xml)).toBeNull()
  })
})

describe('kodiGuiSettingsPathCandidates', () => {
  it('returns at least one platform-appropriate path', () => {
    const paths = kodiGuiSettingsPathCandidates()
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      expect(p.endsWith('guisettings.xml')).toBe(true)
      expect(p).toContain('userdata')
    }
  })

  it('on Linux probes both ~/.kodi and the Flatpak data root', () => {
    if (process.platform !== 'linux') {
      return
    }
    const paths = kodiGuiSettingsPathCandidates()
    expect(paths.some((p) => p.includes('.kodi'))).toBe(true)
    expect(paths.some((p) => p.includes('tv.kodi.Kodi'))).toBe(true)
  })
})
