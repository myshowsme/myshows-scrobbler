<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppHeader from './AppHeader.vue'
import ConfigEditor from './ConfigEditor.vue'
import HeroLastScrobble from './HeroLastScrobble.vue'
import SetupHint from './SetupHint.vue'
import SourcesPanel from './SourcesPanel.vue'
import SetupPanel from './SetupPanel.vue'
import EventsPanel from './EventsPanel.vue'

const TesterPanel = import.meta.env.DEV
  ? defineAsyncComponent(() => import('../ui-only/TesterPanel.vue'))
  : null

import type { TokenState } from './ui/TokenWidget.vue'
import type {
  NowPlayingEntry,
  PollingLog,
  ScrobbleEvent,
  SourceConfig,
  SourceType,
} from '../../types'
import { useWebSocket } from '../../composables/useWebSocket'
import { useLiveClock, useLiveSignal } from '../../composables/useLiveSignal'
import { useConfig } from '../../composables/useConfig'
import { useEmbySignIn } from '../../composables/useEmbySignIn'
import { useQuickConnect } from '../../composables/useQuickConnect'
import { useSourceStatuses } from '../../composables/useSourceStatuses'
import { useTokenLookup } from '../../composables/useTokenLookup'
import { useAppUpdate } from '../../composables/useAppUpdate'
import { checkMyShows } from '../../api'
import { isLocalSource, sourceNeedsUrl, hasProbeCredentials } from '../../utils/source-type'

const TOKEN_DEBOUNCE_MS = 600

const wsBus = useWebSocket()
const config = useConfig()
// Per-source flows live in their own composables; all of them read sources
// and patch tokens, so they share the same deps.
const composableDeps = { sources: config.sources, patchSource: config.patchSource }
const tokenLookup = useTokenLookup(composableDeps)
const quickConnect = useQuickConnect(composableDeps)
const embySignIn = useEmbySignIn(composableDeps)
const sourceStatuses = useSourceStatuses()
const { t } = useI18n()

const showConfigEditor = ref(false)

// Config-load errors with a machine-readable code (thrown in api.ts) are
// localized here; anything else is shown as-is.
const configErrorText = computed(() => {
  const raw = config.error.value
  if (!raw) {
    return null
  }
  const backendDown = raw.match(/^backend_unavailable:?(\d*)$/)
  if (backendDown) {
    return t('errors.backendUnavailable', { port: backendDown[1] || '?' })
  }
  return raw
})

async function onConfigSaved() {
  // Re-pull config so the UI reflects whatever the raw editor wrote.
  await config.load()
}

// App update availability + download progress (Electron)
const update = useAppUpdate()
const updateStatus = update.status

// Label on the primary button: idle → "Update", then the live percent, then
// "Installing…" once the download hands off to the installer.
const updateButtonLabel = computed(() => {
  if (updateStatus.value.installing) {
    return t('update.installing')
  }
  if (!updateStatus.value.downloading) {
    return t('update.install')
  }
  const percent = updateStatus.value.percent
  return percent === null
    ? t('update.downloading')
    : t('update.downloadingPercent', { percent: Math.round(percent) })
})

// "осталось 25 с" / "3 min left". Abbreviated units on purpose: they read the
// same for every count, so no locale needs plural forms here. Dropped once the
// download hands off to the installer — nothing left to wait for.
const updateEtaText = computed(() => {
  const eta = update.eta.value
  if (!eta || updateStatus.value.installing) {
    return null
  }
  const key = eta.unit === 'seconds' ? 'update.etaSeconds' : 'update.etaMinutes'
  return t(key, { value: eta.value })
})

onMounted(async () => {
  await config.load()

  for (const source of config.sources.value) {
    if (!source.enabled) {
      continue
    }
    if (hasProbeCredentials(source.type, source.url, source.token)) {
      void sourceStatuses.checkNow(source.type, source.url, source.token)
    }
  }

  // Self-paced poll: slow while idle, once a second while a download runs.
  void update.start()
})

// Latest successful scrobble from the feed, used as the fallback hero when
// nothing is currently playing.
const lastScrobbled = computed<ScrobbleEvent | null>(
  () => wsBus.events.value.find((event) => event.status === 'success') ?? null,
)
const lastScrobbledRef = computed(() => lastScrobbled.value)
const { liveActive, livePercent, liveOffsetMs } = useLiveSignal(lastScrobbledRef, wsBus.nowPlaying)

/**
 * One hero card per active playback session (VLC and QuickTime playing at
 * once produce two NowPlayingEntry rows; render both). When nothing is
 * active, fall back to a single card with the last scrobble. Each slot
 * mirrors the ScrobbleEvent shape so the Hero component renders it as is.
 */
interface HeroSlot {
  key: string
  event: ScrobbleEvent
  isLive: boolean
  livePercent?: number
  liveOffsetMs?: number
}

const LIVE_WINDOW_MS = 15_000

// Ticks once per second so the progress bars in hero cards keep moving
// between server pushes instead of freezing at the last polled percent.
const liveClock = useLiveClock()

function toLiveSlot(entry: NowPlayingEntry, interceptOnly: boolean, nowMs: number): HeroSlot {
  const event: ScrobbleEvent = {
    ...entry.event,
    timestamp: entry.updatedAt,
    status: 'success',
    intercept: interceptOnly,
  }
  const baseOffset = entry.event.viewOffset ?? null
  const duration = entry.event.duration ?? null
  const updated = Date.parse(entry.updatedAt)
  const age = Number.isFinite(updated) ? Math.min(Math.max(0, nowMs - updated), LIVE_WINDOW_MS) : 0
  let projectedOffset: number | undefined
  if (baseOffset != null) {
    const raw = entry.event.state === 'playing' ? baseOffset + age : baseOffset
    projectedOffset = duration != null ? Math.min(raw, duration) : raw
  }
  const projectedPercent =
    duration != null && duration > 0 && projectedOffset != null
      ? Math.max(0, Math.min(100, (projectedOffset / duration) * 100))
      : entry.percent
  return {
    key: entry.key,
    event,
    isLive: Number.isFinite(updated) && nowMs - updated < LIVE_WINDOW_MS,
    livePercent: projectedPercent,
    liveOffsetMs: projectedOffset,
  }
}

const heroSlots = computed<HeroSlot[]>(() => {
  const live = wsBus.nowPlaying.value
  if (live.length > 0) {
    const interceptOnly = config.interceptOnly.value
    const nowMs = liveClock.value
    return [...live]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((entry) => toLiveSlot(entry, interceptOnly, nowMs))
  }
  const fallback = lastScrobbled.value
  if (!fallback) {
    return []
  }
  return [
    {
      key: `last:${fallback.source}:${fallback.sessionId}`,
      event: fallback,
      isLive: liveActive.value,
      livePercent: livePercent.value,
      liveOffsetMs: liveOffsetMs.value,
    },
  ]
})

const hasConfiguredSource = computed(() =>
  config.sources.value.some(
    (source) =>
      source.enabled &&
      (isLocalSource(source.type) ||
        (sourceNeedsUrl(source.type) ? source.url : source.token).trim().length > 0),
  ),
)

const allLogs = computed<PollingLog[]>(() => {
  const byMessage = new Map<string, PollingLog>()

  for (const log of [...wsBus.logs.value, ...config.initialLogs.value]) {
    const key = `${log.level}\n${log.message}`
    const existing = byMessage.get(key)
    if (!existing || Date.parse(log.timestamp) > Date.parse(existing.timestamp)) {
      byMessage.set(key, log)
    }
  }

  const merged = Array.from(byMessage.values())
  merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
  return merged.slice(0, 50)
})

// Flips on the first success event of this session, so old successes from
// the event buffer don't pre-mark wizard step 3 as done.
const setupPlaybackSeen = ref(false)

let lastSeenEventTs: number | null = null
watch(
  () => wsBus.events.value[0],
  (latest) => {
    if (!latest) {
      return
    }
    const ts = Date.parse(latest.timestamp)
    if (!Number.isFinite(ts) || (lastSeenEventTs !== null && ts <= lastSeenEventTs)) {
      return
    }
    lastSeenEventTs = ts
    if (latest.status === 'success') {
      sourceStatuses.markOk(latest.source)
      setupPlaybackSeen.value = true
    }
  },
)

watch(
  () => wsBus.lastSourceError.value,
  (err) => {
    if (!err) {
      return
    }
    sourceStatuses.markError(err.source, err.error, err.code)
  },
)

function getSource(type: SourceType): SourceConfig | undefined {
  return config.sources.value.find((source) => source.type === type)
}

function onSourceUpdate(
  type: SourceType,
  patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
) {
  const isToggleOnly = 'enabled' in patch && !('url' in patch) && !('token' in patch)
  config.patchSource(type, patch, !isToggleOnly)

  const next = getSource(type)
  if (!next) {
    return
  }

  if ('enabled' in patch) {
    if (patch.enabled) {
      if (type === 'plex' && !next.token) {
        // Run the same discovery as the "Find token" button, so enabling a
        // local Plex goes green in one click.
        void onFindToken(type)
      } else if (hasProbeCredentials(type, next.url, next.token)) {
        void sourceStatuses.checkNow(type, next.url, next.token)
      }
    } else {
      sourceStatuses.reset(type)
    }
    return
  }

  if (next.enabled) {
    sourceStatuses.scheduleCheck(type, next.url, next.token)
  }
}

function onSetupSourceToggle(player: SourceType, enabled: boolean) {
  // The Setup panel enabled/disabled a player's local API; mirror that into the
  // matching source config so its adapter actually starts/stops.
  onSourceUpdate(player, { enabled })
}

// "Find token" handlers by source type
const TOKEN_LOOKUP_BY_TYPE: Partial<Record<SourceType, () => Promise<boolean>>> = {
  plex: tokenLookup.findPlexToken,
  kodi: tokenLookup.findKodiCredentials,
}

async function onFindToken(type: SourceType) {
  const lookup = TOKEN_LOOKUP_BY_TYPE[type]
  if (!lookup) {
    return
  }
  if (!(await lookup())) {
    return
  }
  // Probe right away so the status dot goes green without waiting for the
  // next poll cycle.
  probeSourceIfReady(type)
}

async function onQuickConnect(type: SourceType) {
  if (type !== 'jellyfin') {
    return
  }
  if (await quickConnect.startQuickConnect(type)) {
    probeSourceIfReady(type)
  }
}

function onQuickConnectCancel(type: SourceType) {
  quickConnect.cancelQuickConnect(type)
}

function onEmbySignInOpen(type: SourceType) {
  embySignIn.openEmbySignInForm(type)
}

function onEmbySignInCancel(type: SourceType) {
  embySignIn.closeEmbySignInForm(type)
}

async function onEmbySignInSubmit(type: SourceType, username: string, password: string) {
  if (await embySignIn.submitEmbySignIn(type, username, password)) {
    probeSourceIfReady(type)
  }
}

/** Check the connection once a source is enabled and has the creds it needs. */
function probeSourceIfReady(type: SourceType) {
  const next = getSource(type)
  if (next && next.enabled && hasProbeCredentials(type, next.url, next.token)) {
    void sourceStatuses.checkNow(type, next.url, next.token)
  }
}

function onInterceptOnlyChange(value: boolean) {
  if (config.interceptOnlyLocked.value) {
    return
  }
  config.patchConfig({ interceptOnly: value }, false)
}

const tokenState = ref<TokenState>('empty')
const tokenMasked = computed(() => config.myshowsToken.value)

let tokenCheckTimer: ReturnType<typeof setTimeout> | null = null
let tokenCheckSeq = 0

function scheduleTokenCheck(token: string, delayMs: number) {
  if (tokenCheckTimer) {
    clearTimeout(tokenCheckTimer)
  }

  if (!token) {
    tokenState.value = 'empty'
    return
  }

  tokenState.value = 'checking'
  const mySeq = ++tokenCheckSeq
  tokenCheckTimer = setTimeout(async () => {
    try {
      const result = await checkMyShows(token)
      if (mySeq !== tokenCheckSeq) {
        return
      }
      tokenState.value = result.ok ? 'valid' : 'invalid'
    } catch {
      if (mySeq !== tokenCheckSeq) {
        return
      }
      tokenState.value = 'invalid'
    }
  }, delayMs)
}

watch(
  () => config.myshowsToken.value,
  (token) => {
    scheduleTokenCheck(token, 0)
  },
  { immediate: true },
)

// Setup wizard: three pre-flight steps the user has to complete before the
// scrobbler can do anything useful. Derived from existing state so they tick
// off automatically as the user makes progress.
const setupTokenDone = computed(
  () => config.myshowsToken.value.trim().length > 0 && tokenState.value === 'valid',
)
const setupSourceDone = hasConfiguredSource
const setupPlaybackDone = computed(
  () => wsBus.nowPlaying.value.length > 0 || setupPlaybackSeen.value,
)
const showSetupWizard = computed(
  () => !setupTokenDone.value || !setupSourceDone.value || !setupPlaybackDone.value,
)

function onTokenEdit(value: string) {
  config.patchConfig({ myshowsToken: value }, true)
  scheduleTokenCheck(value, TOKEN_DEBOUNCE_MS)
}
</script>

<template>
  <div class="AppShell">
    <AppHeader
      :connected="wsBus.connected.value"
      :token-state="tokenState"
      :token-masked="tokenMasked"
      :update-available="updateStatus.available"
      @token-edit="onTokenEdit"
      @open-config="showConfigEditor = true"
    />

    <ConfigEditor
      :open="showConfigEditor"
      @close="showConfigEditor = false"
      @saved="onConfigSaved"
    />

    <div v-if="updateStatus.available" class="AppShell__update">
      <div class="AppShell__update-row">
        <span class="AppShell__update-text">
          {{ t('update.available', { version: updateStatus.version }) }}
        </span>
        <div class="AppShell__update-actions">
          <button
            type="button"
            class="AppShell__update-btn AppShell__update-btn--primary"
            :disabled="update.isBusy.value"
            @click="update.install()"
          >
            {{ updateButtonLabel }}
          </button>
          <button
            type="button"
            class="AppShell__update-btn"
            :disabled="update.isBusy.value"
            @click="update.skip()"
          >
            {{ t('update.skip') }}
          </button>
        </div>
      </div>

      <div v-if="update.isBusy.value" class="AppShell__update-progress">
        <div
          class="AppShell__update-bar"
          role="progressbar"
          :aria-valuenow="
            updateStatus.percent === null ? undefined : Math.round(updateStatus.percent)
          "
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="t('update.progressLabel')"
        >
          <!-- No percent yet (the transfer hasn't reported in): run an
               indeterminate sweep instead of a bar frozen at zero. -->
          <div
            class="AppShell__update-fill"
            :class="{ 'AppShell__update-fill--pending': updateStatus.percent === null }"
            :style="{ width: `${updateStatus.percent ?? 100}%` }"
          />
        </div>
        <span v-if="update.progressText.value" class="AppShell__update-meta">
          {{ update.progressText.value
          }}<template v-if="updateEtaText"> · {{ updateEtaText }}</template>
        </span>
      </div>

      <span v-if="updateStatus.error" class="AppShell__update-error">
        {{ t('update.failed', { reason: updateStatus.error }) }}
      </span>
    </div>

    <main class="AppShell__main">
      <div v-if="configErrorText" class="AppShell__banner AppShell__banner--error" role="alert">
        {{ configErrorText }}
      </div>

      <SetupHint
        v-if="showSetupWizard"
        :token-done="setupTokenDone"
        :source-done="setupSourceDone"
        :playback-done="setupPlaybackDone"
      />
      <div v-else-if="heroSlots.length > 0" class="AppShell__heroes">
        <HeroLastScrobble
          v-for="slot in heroSlots"
          :key="slot.key"
          :event="slot.event"
          :live-active="slot.isLive"
          :percent="slot.livePercent"
          :live-offset-ms="slot.liveOffsetMs"
        />
      </div>

      <div class="AppShell__grid">
        <SourcesPanel
          :sources="config.sources.value"
          :statuses="sourceStatuses.statuses"
          :has-active-source="hasConfiguredSource"
          :intercept-only="config.interceptOnly.value"
          :intercept-only-locked="config.interceptOnlyLocked.value"
          :token-lookup="tokenLookup.tokenLookup.value"
          :quick-connect="quickConnect.quickConnect.value"
          :emby-sign-in="embySignIn.embySignIn.value"
          @update:source="onSourceUpdate"
          @update:intercept-only="onInterceptOnlyChange"
          @find-token="onFindToken"
          @quick-connect="onQuickConnect"
          @quick-connect-cancel="onQuickConnectCancel"
          @emby-sign-in-open="onEmbySignInOpen"
          @emby-sign-in-cancel="onEmbySignInCancel"
          @emby-sign-in-submit="onEmbySignInSubmit"
        />
        <EventsPanel :events="wsBus.events.value" :logs="allLogs" />
      </div>

      <SetupPanel @source-toggle="onSetupSourceToggle" />

      <component :is="TesterPanel" v-if="TesterPanel" />
    </main>
  </div>
</template>

<style lang="scss">
.AppShell {
  --v2-brand: #e63946;
  --v2-brand-dark: #c62731;
  --v2-brand-soft: #fce8ea;

  --v2-bg: #ffffff;
  --v2-bg-page: #f4f4f5;
  --v2-bg-stripe: #f7f7f8;
  --v2-bg-soft: #fafafa;
  --v2-bg-inset: #f6f7f8;
  --v2-bg-warn: #fff7d6;

  --v2-bg-header: #1c1c1f;
  --v2-bg-hero: #232327;

  --v2-text: #1a1a1d;
  --v2-text-soft: #3a3a40;
  --v2-text-muted: #76767e;
  --v2-text-dim: #a8a8b0;

  --v2-link: #2a7ec6;
  --v2-link-hover: #1d5d97;

  --v2-success: #16a34a;
  --v2-error: #dc2626;
  --v2-warning: #d97706;

  --v2-border: #e3e3e6;
  --v2-border-soft: #ededf0;
  --v2-border-strong: #cfcfd4;

  --v2-space-xs: 4px;
  --v2-space-sm: 8px;
  --v2-space-md: 16px;
  --v2-space-lg: 24px;
  --v2-space-xl: 36px;

  --v2-radius-sm: 3px;
  --v2-radius: 4px;
  --v2-radius-md: 6px;

  min-height: 100vh;
  background: var(--v2-bg-page);
  color: var(--v2-text);
  font-family:
    'Roboto',
    system-ui,
    -apple-system,
    sans-serif;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;

  &__main {
    max-width: 1280px;
    margin: 0 auto;
    padding: var(--v2-space-lg);
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-lg);
    min-height: calc(100vh - 56px);
  }

  &__grid {
    display: grid;
    grid-template-columns: 360px 1fr;
    gap: var(--v2-space-lg);
    align-items: start;

    @media (max-width: 1024px) {
      grid-template-columns: 1fr;
    }
  }

  // Stack of active "now playing" hero cards, one per session, the most
  // recently updated on top.
  &__heroes {
    display: flex;
    flex-direction: column;
    gap: var(--v2-space-md);
  }

  &__placeholder {
    color: var(--v2-text-muted);
    font-size: 14px;
    padding: var(--v2-space-xl);
    text-align: center;
  }

  &__banner {
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 500;

    &--error {
      background: #fbe1e1;
      border-left: 3px solid var(--v2-error);
      color: var(--v2-error);
    }
  }

  &__update {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    background: var(--v2-bg-soft, #f4f6f8);
    border-bottom: 1px solid var(--v2-border-soft);
    font-size: 13px;
  }

  &__update-row {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 12px;
  }

  &__update-progress {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    max-width: 460px;
  }

  &__update-bar {
    flex: 1;
    height: 5px;
    border-radius: 3px;
    background: var(--v2-border-soft, #e3e4e8);
    overflow: hidden;
  }

  &__update-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--v2-brand, #e63946);
    // Progress arrives once a second; ease between samples so the bar creeps
    // instead of stepping.
    transition: width 0.9s linear;

    &--pending {
      animation: AppShell-update-pending 1.1s ease-in-out infinite;
      transition: none;
    }
  }

  &__update-meta {
    color: var(--v2-text-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  &__update-error {
    color: var(--v2-error);
    font-size: 12px;
  }

  &__update-text {
    font-weight: 600;
    color: var(--v2-text);
  }

  &__update-actions {
    display: flex;
    gap: 8px;
  }

  &__update-btn {
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    padding: 5px 12px;
    border-radius: 7px;
    border: 1px solid var(--v2-border-strong, #cfcfd4);
    background: var(--v2-bg, #fff);
    // Fallback guards against the global `button { color: var(--color-text) }`
    // reset (white) leaking in if the custom property fails to resolve.
    color: var(--v2-text, #1a1a1d);
    cursor: pointer;
    transition:
      background-color 0.12s,
      border-color 0.12s;

    // Always restate color on hover so the dark text can never fall back to the
    // global white default — that was making the label invisible.
    &:hover:not(:disabled) {
      background: var(--v2-bg-stripe, #f7f7f8);
      border-color: var(--v2-border-strong, #cfcfd4);
      color: var(--v2-text, #1a1a1d);
    }
    &:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    &--primary {
      background: var(--v2-brand, #e63946);
      border-color: var(--v2-brand, #e63946);
      color: #fff;

      // Darken on hover (white text stays high-contrast) instead of a faint
      // brightness filter that washed the button out.
      &:hover:not(:disabled) {
        background: var(--v2-brand-dark, #c62731);
        border-color: var(--v2-brand-dark, #c62731);
        color: #fff;
      }
    }
  }
}

// Indeterminate sweep for the stretch between "download started" and the first
// progress report from electron-updater.
@keyframes AppShell-update-pending {
  0% {
    opacity: 0.25;
  }
  50% {
    opacity: 0.7;
  }
  100% {
    opacity: 0.25;
  }
}
</style>
