import { describe, expect, it } from 'vite-plus/test'
import {
  idsFromKodiUniqueIds,
  idsFromPrefixedGuids,
  idsFromProviderIds,
  legacyIdFields,
  normalizeGuid,
} from '../../src/adapters/external-ids.js'
import { toScrobbleRequest } from '../../src/scrobblers/converter.js'
import type { NormalizedEvent } from '../../src/types.js'

describe('external id extraction', () => {
  it('extracts the extended id set from Plex-style prefixed GUIDs', () => {
    const ids = idsFromPrefixedGuids([
      { id: 'imdb://tt1234567' },
      { id: 'tmdb://123' },
      { id: 'tvdb://456' },
      { id: 'anidb://17709' },
      { id: 'myanimelist://52991' },
      { id: 'kinopoisk://404900' },
      { id: 'simkl://37088' },
    ])

    expect(ids).toEqual({
      imdb: 'tt1234567',
      tmdb: '123',
      tvdb: '456',
      anidb: 17709,
      mal: 52991,
      kinopoisk: 404900,
      simkl: 37088,
    })
    expect(legacyIdFields(ids)).toEqual({
      imdbId: 'tt1234567',
      tmdbId: '123',
      tvdbId: '456',
    })
  })

  it('extracts extended Jellyfin/Emby ProviderIds aliases', () => {
    expect(
      idsFromProviderIds({
        Imdb: 'tt0903747',
        Tmdb: '1396',
        Tvdb: '81189',
        AniDb: '17709',
        MyAnimeList: '52991',
        AniList: '154587',
        Kitsu: '45678',
        Shikimori: '52991',
      }),
    ).toEqual({
      imdb: 'tt0903747',
      tmdb: '1396',
      tvdb: '81189',
      anidb: 17709,
      mal: 52991,
      anilist: 154587,
      kitsu: 45678,
      shikimori: 52991,
    })
  })

  it('extracts extended Kodi uniqueid values and imdbnumber fallback', () => {
    expect(
      idsFromKodiUniqueIds(
        {
          tmdb: '467905',
          tvdb: '349232',
          mal: '21',
          anidb: '69',
        },
        'tt4357198',
      ),
    ).toEqual({
      imdb: 'tt4357198',
      tmdb: '467905',
      tvdb: '349232',
      mal: 21,
      anidb: 69,
    })
  })
})

describe('legacy Plex agent GUIDs', () => {
  it('strips the agent prefix and leaves alias resolution to setKnownId', () => {
    // `themoviedb`/`thetvdb` are already aliases in the provider switch, so normalizeGuid
    // only has to remove the prefix that stopped them from matching.
    expect(normalizeGuid('com.plexapp.agents.imdb://tt29768334?lang=en')).toBe('imdb://tt29768334')
    expect(normalizeGuid('com.plexapp.agents.themoviedb://1241983?lang=en')).toBe(
      'themoviedb://1241983',
    )
    expect(normalizeGuid('com.plexapp.agents.thetvdb://468006?lang=en')).toBe('thetvdb://468006')

    // …and end to end those land on the canonical fields.
    expect(
      idsFromPrefixedGuids([{ id: 'com.plexapp.agents.themoviedb://1241983?lang=en' }]),
    ).toEqual({ tmdb: '1241983' })
  })

  it('leaves modern GUIDs untouched', () => {
    for (const guid of ['tvdb://456', 'imdb://tt0959621', 'tmdb://62085', 'anidb://17709']) {
      expect(normalizeGuid(guid)).toBe(guid)
    }
  })

  it('refuses season/episode GUIDs so a show id can never be sent as an episode id', () => {
    // `thetvdb://468006/1/1` is show 468006 S01E01 — the number is the *show*, not the episode.
    expect(normalizeGuid('com.plexapp.agents.thetvdb://468006/1?lang=en')).toBeNull()
    expect(normalizeGuid('com.plexapp.agents.thetvdb://468006/1/1?lang=en')).toBeNull()
    expect(
      idsFromPrefixedGuids([{ id: 'com.plexapp.agents.thetvdb://468006/1/1?lang=en' }]),
    ).toEqual({})
  })

  it('unwraps HAMA sub-providers and drops the season-mapping digit', () => {
    expect(normalizeGuid('com.plexapp.agents.hama://tvdb-371310?lang=en')).toBe('tvdb://371310')
    for (const variant of ['tvdb2', 'tvdb3', 'tvdb4', 'tvdb5']) {
      expect(normalizeGuid(`com.plexapp.agents.hama://${variant}-315500`)).toBe('tvdb://315500')
    }
    for (const variant of ['anidb', 'anidb2', 'anidb3', 'anidb4']) {
      expect(normalizeGuid(`com.plexapp.agents.hama://${variant}-11905`)).toBe('anidb://11905')
    }
    // `tsdb` is a typo inside HAMA itself.
    expect(normalizeGuid('com.plexapp.agents.hama://tsdb-69346')).toBe('tmdb://69346')
  })

  it('restores the tt prefix HAMA strips, without doubling it elsewhere', () => {
    expect(normalizeGuid('com.plexapp.agents.hama://imdb-6455986')).toBe('imdb://tt6455986')
    expect(normalizeGuid('com.plexapp.agents.imdb://tt29768334?lang=en')).toBe('imdb://tt29768334')
  })

  it('degrades to no id rather than a wrong one', () => {
    expect(idsFromPrefixedGuids([{ id: 'com.plexapp.agents.hama://foo-123' }])).toEqual({})
    expect(idsFromPrefixedGuids([{ id: 'com.plexapp.agents.hama://tvdb-' }])).toEqual({})
    expect(normalizeGuid('nonsense')).toBeNull()
    expect(normalizeGuid('')).toBeNull()
    expect(normalizeGuid(undefined)).toBeNull()
  })

  it('is idempotent', () => {
    const once = normalizeGuid('com.plexapp.agents.hama://tvdb2-315500')
    expect(normalizeGuid(once)).toBe(once)
  })

  it('extracts ids end to end and ignores Plex-internal GUIDs', () => {
    expect(idsFromPrefixedGuids([{ id: 'com.plexapp.agents.thetvdb://468006?lang=en' }])).toEqual({
      tvdb: '468006',
    })
    expect(idsFromPrefixedGuids([{ id: 'com.plexapp.agents.hama://imdb-6455986' }])).toEqual({
      imdb: 'tt6455986',
    })
    expect(idsFromPrefixedGuids([{ id: 'com.plexapp.agents.hama://anidb2-11905' }])).toEqual({
      anidb: 11905,
    })
    // HAMA episodes and seasons are `local://`; trailers are `iva://`. Neither carries an id.
    expect(idsFromPrefixedGuids([{ id: 'local://60293' }])).toEqual({})
    expect(
      idsFromPrefixedGuids([{ id: 'iva://api.internetvideoarchive.com/2.0/x?lang=en' }]),
    ).toEqual({})
  })
})

describe('external ids in scrobble conversion', () => {
  it('passes extended ids into the unified DTO', () => {
    const event: NormalizedEvent = {
      type: 'episode',
      sessionId: 'session-1',
      ids: {
        imdb: 'tt0388629',
        tvdb: '81797',
        simkl: 37088,
        mal: 21,
        anidb: 69,
        kinopoisk: 1047156,
      },
      imdbId: 'tt0388629',
      tmdbId: null,
      tvdbId: '81797',
      episodeIds: {
        tvdb: '9727084',
        tmdb: '4673183',
      },
      episodeImdbId: null,
      episodeTmdbId: '4673183',
      episodeTvdbId: '9727084',
      title: 'Episode',
      originalTitle: null,
      year: 1999,
      showTitle: 'One Piece',
      showOriginalTitle: null,
      season: 1,
      episode: 1050,
      userRating: null,
      contentRating: null,
      runtimeMinutes: 24,
      duration: 1440000,
      viewOffset: 1400000,
      source: 'plex',
      action: 'stopped',
      state: 'playing',
      appVersion: null,
      media: null,
      dubTeam: null,
    }

    expect(toScrobbleRequest(event, 97)).toMatchObject({
      show: {
        ids: {
          imdb: 'tt0388629',
          tvdb: '81797',
          simkl: 37088,
          mal: 21,
          anidb: 69,
          kinopoisk: 1047156,
        },
      },
      episode: {
        ids: {
          tvdb: '9727084',
          tmdb: '4673183',
        },
      },
    })
  })
})
