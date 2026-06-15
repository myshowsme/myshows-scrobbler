import { describe, it, expect } from 'vitest'
import {
  channelsFromText,
  dubTeamFromTrackTitle,
  languageToIso,
  normalizeAudioCodec,
} from '../../src/utils/audio-track.js'
import { activeAudioFromVlc, videoInfoFromVlc } from '../../src/adapters/vlc-http.js'
import { hdrFromTransfer } from '../../src/adapters/media-info.js'

describe('languageToIso', () => {
  it('passes ISO 639-1 codes through', () => {
    expect(languageToIso('ru')).toBe('ru')
    expect(languageToIso('EN')).toBe('en')
  })

  it('maps ISO 639-2 codes (mpv track lang)', () => {
    expect(languageToIso('rus')).toBe('ru')
    expect(languageToIso('eng')).toBe('en')
    expect(languageToIso('jpn')).toBe('ja')
    expect(languageToIso('ukr')).toBe('uk')
  })

  it('maps localized language names (VLC status.json)', () => {
    expect(languageToIso('Русский')).toBe('ru')
    expect(languageToIso('Украинский')).toBe('uk')
    expect(languageToIso('Английский')).toBe('en')
    expect(languageToIso('English')).toBe('en')
  })

  it('returns null for unknown values', () => {
    expect(languageToIso('Клингонский')).toBeNull()
    expect(languageToIso('xxx')).toBeNull()
    expect(languageToIso(null)).toBeNull()
    expect(languageToIso('')).toBeNull()
  })
})

describe('dubTeamFromTrackTitle', () => {
  it('extracts the studio after a voice-over prefix', () => {
    expect(dubTeamFromTrackTitle('Dub, Велес')).toBe('Велес')
    expect(dubTeamFromTrackTitle('MVO, HDRezka Studio')).toBe('HDRezka Studio')
    expect(dubTeamFromTrackTitle('MVO, DniproFilm / HDRezka Studio')).toBe(
      'DniproFilm / HDRezka Studio',
    )
    expect(dubTeamFromTrackTitle('Закадровый, LostFilm')).toBe('LostFilm')
  })

  it('returns null for unprefixed or bare titles', () => {
    expect(dubTeamFromTrackTitle('Дорожка 7')).toBeNull()
    expect(dubTeamFromTrackTitle('Surround 5.1')).toBeNull()
    expect(dubTeamFromTrackTitle('Dub')).toBeNull()
    expect(dubTeamFromTrackTitle(null)).toBeNull()
  })

  it('does not treat words merely starting with a prefix as a match', () => {
    expect(dubTeamFromTrackTitle('Dubstep Mix')).toBeNull()
    expect(dubTeamFromTrackTitle('Voice of America')).toBeNull()
  })
})

describe('channelsFromText', () => {
  it('parses VLC decoded-channel layouts', () => {
    expect(channelsFromText('3F2M/LFE')).toBe(6)
    expect(channelsFromText('3F2R/LFE')).toBe(6)
    expect(channelsFromText('Stereo')).toBe(2)
    expect(channelsFromText('Mono')).toBe(1)
  })

  it('returns null for unrecognized text', () => {
    expect(channelsFromText('something')).toBeNull()
    expect(channelsFromText(null)).toBeNull()
  })
})

describe('normalizeAudioCodec', () => {
  it('maps VLC fourccs and mpv codec names to converter vocabulary', () => {
    expect(normalizeAudioCodec('a52 ')).toBe('ac3')
    expect(normalizeAudioCodec('mp4a')).toBe('aac')
    expect(normalizeAudioCodec('ac3')).toBe('ac3')
    expect(normalizeAudioCodec('eac3')).toBe('eac3')
    expect(normalizeAudioCodec('vorbis')).toBe('ogg')
    expect(normalizeAudioCodec('pcm_s24le')).toBe('pcm')
    expect(normalizeAudioCodec(null)).toBeNull()
  })
})

describe('activeAudioFromVlc', () => {
  /** Trimmed-down real status.json from a RU-локализованный VLC 3.0.23. */
  const ruStatus = {
    state: 'playing',
    information: {
      category: {
        'meta': { filename: 'Беглец.2023.WEB-DL.2160p.mkv' },
        'Поток 0': {
          Тип: 'Видео',
          Кодек: 'MPEG-H Part2/HEVC (H.265) (hevc)',
          Декодированный_формат: 'DX10',
        },
        'Поток 1': {
          Тип: 'Аудио',
          Язык: 'Русский',
          Описание: 'Dub, Велес',
          Кодек: 'A52 Audio (aka AC3) (a52 )',
          Decoded_channels: '3F2M/LFE',
          Decoded_bits_per_sample: '32',
        },
        'Поток 2': {
          Тип: 'Аудио',
          Язык: 'Английский',
          Кодек: 'A/52 B Audio (aka E-AC3) (eac3)',
        },
        'Поток 8': {
          Тип: 'Субтитры',
          Язык: 'Русский',
          Кодек: 'Text subtitles with various tags (subt)',
        },
      },
    },
  }

  it('picks the decoded (active) audio stream, not the first or loudest', () => {
    const audio = activeAudioFromVlc(ruStatus)
    expect(audio).toEqual({
      language: 'Русский',
      description: 'Dub, Велес',
      codec: 'a52',
      channels: 6,
    })
  })

  it('falls back to a lone audio stream when no decoder marker is present', () => {
    const single = {
      information: {
        category: {
          'meta': { filename: 'movie.mkv' },
          'Stream 0': { Type: 'Video', Codec: 'H264 - MPEG-4 AVC (part 10) (h264)' },
          'Stream 1': { Type: 'Audio', Language: 'English', Codec: 'AAC (mp4a)' },
        },
      },
    }
    expect(activeAudioFromVlc(single)).toEqual({
      language: 'English',
      description: null,
      codec: 'mp4a',
      channels: null,
    })
  })

  it('returns null when several audio streams exist and none is marked decoded', () => {
    const ambiguous = {
      information: {
        category: {
          'meta': {},
          'Stream 1': { Type: 'Audio', Codec: 'AAC (mp4a)' },
          'Stream 2': { Type: 'Audio', Codec: 'A52 Audio (aka AC3) (a52 )' },
        },
      },
    }
    expect(activeAudioFromVlc(ambiguous)).toBeNull()
  })

  it('returns null when information is absent (idle VLC)', () => {
    expect(activeAudioFromVlc({})).toBeNull()
  })
})

describe('hdrFromTransfer', () => {
  it('maps PQ spellings from every backend to hdr10', () => {
    expect(hdrFromTransfer('pq')).toBe('hdr10') // mpv video-params/gamma
    expect(hdrFromTransfer('smpte2084')).toBe('hdr10') // ffprobe color_transfer
    expect(hdrFromTransfer('SMPTE ST2084 (PQ)')).toBe('hdr10') // VLC status string
    expect(hdrFromTransfer('PQ')).toBe('hdr10') // mediainfo transfer_characteristics
  })

  it('maps HLG spellings to hlg', () => {
    expect(hdrFromTransfer('hlg')).toBe('hlg')
    expect(hdrFromTransfer('arib-std-b67')).toBe('hlg')
  })

  it('returns null for SDR transfers', () => {
    expect(hdrFromTransfer('bt.1886')).toBeNull()
    expect(hdrFromTransfer('bt709')).toBeNull()
    expect(hdrFromTransfer(null)).toBeNull()
  })
})

describe('videoInfoFromVlc', () => {
  it('extracts resolution and HDR from a RU-localized video stream', () => {
    const status = {
      information: {
        category: {
          'meta': { filename: 'Беглец.2023.WEB-DL.2160p.mkv' },
          'Поток 0': {
            'Тип': 'Видео',
            'Кодек': 'MPEG-H Part2/HEVC (H.265) (hevc)',
            'Разрешение_видео.': '3840x2160',
            'Размеры_буфера': '3840x2160',
            'Функция_переноса_цвета': 'SMPTE ST2084 (PQ)',
          },
          'Поток 1': {
            Тип: 'Аудио',
            Кодек: 'A52 Audio (aka AC3) (a52 )',
          },
        },
      },
    }
    expect(videoInfoFromVlc(status)).toEqual({ width: 3840, height: 2160, hdr: 'hdr10' })
  })

  it('returns null when no stream carries video facts', () => {
    expect(videoInfoFromVlc({})).toBeNull()
    expect(
      videoInfoFromVlc({
        information: { category: { 'meta': {}, 'Stream 1': { Type: 'Audio' } } },
      }),
    ).toBeNull()
  })
})
