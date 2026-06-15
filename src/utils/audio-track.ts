/**
 * Helpers for describing the audio track a user actually listens to.
 *
 * Players report the selected track in wildly different shapes: mpv gives ISO
 * 639-2 codes ("rus") and free-form track titles; VLC's status.json gives
 * localized language NAMES ("Русский" / "Russian") and a release-style
 * description ("MVO, HDRezka Studio"). Everything funnels through here into
 * the two values MyShows understands: ISO 639-1 `audio_language` and a
 * `dub_team` string.
 */

/** ISO 639-2 (B and T) → 639-1 for the languages that actually show up in releases. */
const ISO2_TO_ISO1: Record<string, string> = {
  rus: 'ru',
  eng: 'en',
  ukr: 'uk',
  jpn: 'ja',
  kor: 'ko',
  chi: 'zh',
  zho: 'zh',
  deu: 'de',
  ger: 'de',
  fra: 'fr',
  fre: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  tur: 'tr',
  pol: 'pl',
  kaz: 'kk',
  bel: 'be',
}

/**
 * Localized language names → ISO 639-1. VLC localizes the name to its UI
 * language, so both Russian and English spellings are listed. Lowercased keys.
 */
const NAME_TO_ISO1: Record<string, string> = {
  русский: 'ru',
  russian: 'ru',
  английский: 'en',
  english: 'en',
  украинский: 'uk',
  ukrainian: 'uk',
  японский: 'ja',
  japanese: 'ja',
  корейский: 'ko',
  korean: 'ko',
  китайский: 'zh',
  chinese: 'zh',
  немецкий: 'de',
  german: 'de',
  французский: 'fr',
  french: 'fr',
  испанский: 'es',
  spanish: 'es',
  итальянский: 'it',
  italian: 'it',
  португальский: 'pt',
  portuguese: 'pt',
  турецкий: 'tr',
  turkish: 'tr',
  польский: 'pl',
  polish: 'pl',
  казахский: 'kk',
  kazakh: 'kk',
  белорусский: 'be',
  belarusian: 'be',
}

/**
 * Normalize a player-reported language (ISO 639-1/2 code or a localized name)
 * to ISO 639-1. Null when the value is missing or not recognized — better to
 * omit `audio_language` than to send a string the backend can't match.
 */
export function languageToIso(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase()
  if (!raw) {
    return null
  }
  if (/^[a-z]{2}$/.test(raw)) {
    return raw
  }
  if (/^[a-z]{3}$/.test(raw)) {
    return ISO2_TO_ISO1[raw] ?? null
  }
  return NAME_TO_ISO1[raw] ?? null
}

/**
 * Voice-over type prefixes used in release track titles: "Dub, Велес",
 * "MVO, HDRezka Studio", "Закадровый, LostFilm". The studio name after the
 * prefix is the dub team. Titles WITHOUT such a prefix ("Дорожка 7",
 * "Surround 5.1") are deliberately not treated as a team — too noisy.
 */
// NB: no `\b` here — JS word boundaries are ASCII-only and never fire after
// a Cyrillic prefix ("Закадровый,"). The explicit separator lookahead works
// for both alphabets.
const DUB_PREFIX_RE =
  /^(?:dub|dvo|mvo|avo|vo|original|orig|дубляж|дублированный|закадровый|одноголосый|двухголосый|многоголосый|оригинал(?:ьный)?)(?=[\s,.:—–-]|$)[\s,.:—–-]*(.*)$/i

/** Extract the dub team from a selected-track title/description, or null. */
export function dubTeamFromTrackTitle(title: string | null | undefined): string | null {
  const raw = title?.trim()
  if (!raw) {
    return null
  }
  const match = DUB_PREFIX_RE.exec(raw)
  if (!match) {
    return null
  }
  const team = match[1].trim()
  return team || null
}

/**
 * Channel count from a VLC `Decoded_channels` style description:
 * "3F2M/LFE" → 6, "Stereo" → 2, "Mono" → 1. The F/M/R groups are digit
 * counts, LFE adds one. Null when the text doesn't look like a layout.
 */
export function channelsFromText(text: string | null | undefined): number | null {
  const raw = text?.trim().toLowerCase()
  if (!raw) {
    return null
  }
  if (raw === 'mono' || raw === 'моно') {
    return 1
  }
  if (raw === 'stereo' || raw === 'стерео') {
    return 2
  }
  if (!/^\d/.test(raw)) {
    return null
  }
  let count = 0
  for (const digit of raw.match(/\d+/g) ?? []) {
    count += Number.parseInt(digit, 10)
  }
  if (/lfe/.test(raw)) {
    count += 1
  }
  return count > 0 ? count : null
}

/**
 * Normalize a codec id from a player into the vocabulary `mapAudioCodec` in
 * the converter understands ('ac3', 'eac3', 'aac', 'dts', ...). Accepts mpv
 * codec names ("ac3", "pcm_s24le", "vorbis") and VLC fourccs ("a52 ", "mp4a").
 */
export function normalizeAudioCodec(value: string | null | undefined): string | null {
  const raw = value?.trim().toLowerCase()
  if (!raw) {
    return null
  }
  if (raw.startsWith('pcm')) {
    return 'pcm'
  }
  const map: Record<string, string> = {
    'a52': 'ac3',
    'a52 ': 'ac3',
    'eac3': 'eac3',
    'ec-3': 'eac3',
    'mp4a': 'aac',
    'mpga': 'mp3',
    'vorbis': 'ogg',
    'vorb': 'ogg',
    'dca': 'dts',
    'mlp': 'truehd',
    'trhd': 'truehd',
    'araw': 'pcm',
    'wma2': 'wma',
    // mediainfo `Format` spellings.
    'ac-3': 'ac3',
    'e-ac-3': 'eac3',
    'mlp fba': 'truehd',
  }
  return map[raw] ?? raw
}
