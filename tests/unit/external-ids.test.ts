import { describe, expect, it } from 'vite-plus/test'
import {
  idsFromKodiUniqueIds,
  idsFromPrefixedGuids,
  idsFromProviderIds,
  legacyIdFields,
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
