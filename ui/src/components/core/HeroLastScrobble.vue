<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ScrobbleEvent } from '../../types'

const props = defineProps<{
  event: ScrobbleEvent | null
  liveActive: boolean
  /**
   * Live percent override (driven by useLiveSignal). When undefined,
   * falls back to the event's own viewOffset/duration computed value.
   */
  percent?: number
  /**
   * Live viewOffset in ms (driven by useLiveSignal): ticks forward between
   * polling intervals while playback is active. Falls back to event.viewOffset
   * when undefined.
   */
  liveOffsetMs?: number
}>()

const { t } = useI18n()

const percentValue = computed<number>(() => {
  if (typeof props.percent === 'number') {
    return clamp(props.percent)
  }
  const e = props.event
  if (e?.duration && e?.viewOffset != null) {
    return clamp((e.viewOffset / e.duration) * 100)
  }
  return 0
})

const percentLabel = computed(() => `${percentValue.value.toFixed(1)}%`)

const badge = computed(() => {
  const e = props.event
  if (!e) {
    return '—'
  }
  if (e.type === 'episode' && e.season != null && e.episode != null) {
    return `${e.season}×${e.episode.toString().padStart(2, '0')}`
  }
  if (e.type === 'movie' && e.year != null) {
    return String(e.year)
  }
  return '—'
})

const title = computed(() => {
  const e = props.event
  if (!e) {
    return ''
  }
  if (e.type === 'episode' && e.showTitle) {
    return `${e.showTitle}${e.title ? ` — “${e.title}”` : ''}`
  }
  return e.title
})

// The source is intentionally not repeated here: the meta pill below
// already names it next to the colored dot.
const subtitle = computed(() => {
  const e = props.event
  if (!e) {
    return ''
  }
  if (e.type === 'episode') {
    const parts: string[] = []
    if (e.season != null) {
      parts.push(t('hero.subtitle.season', { n: e.season }))
    }
    if (e.episode != null) {
      parts.push(t('hero.subtitle.episodeN', { n: e.episode }))
    }
    // No season/episode numbers to show — fall back to the type label.
    if (parts.length === 0) {
      parts.push(t('hero.subtitle.episode'))
    }
    return parts.join(' · ')
  }
  const parts = [t('hero.subtitle.movie')]
  if (e.year != null) {
    parts.push(String(e.year))
  }
  return parts.join(' · ')
})

const timeMeta = computed(() => {
  const e = props.event
  if (!e?.duration) {
    return null
  }
  const offset = typeof props.liveOffsetMs === 'number' ? props.liveOffsetMs : e.viewOffset
  if (offset == null) {
    return null
  }
  return `${formatTime(offset)} / ${formatTime(e.duration)}`
})

const scrobbledAgo = computed(() => {
  const e = props.event
  if (!e?.timestamp) {
    return null
  }
  return relativeAgo(e.timestamp, t)
})

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`
}

function relativeAgo(iso: string, tFn: typeof t): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) {
    return tFn('common.now')
  }
  if (s < 3600) {
    return tFn('common.minAgo', { n: Math.floor(s / 60) })
  }
  if (s < 86400) {
    return tFn('common.hourAgo', { n: Math.floor(s / 3600) })
  }
  return tFn('common.dayAgo', { n: Math.floor(s / 86400) })
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n))
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
</script>

<template>
  <section v-if="event" class="Hero" :data-source="event.source">
    <div class="Hero__badge">
      <span class="Hero__badge-num">{{ badge }}</span>
      <span v-if="scrobbledAgo" class="Hero__badge-label">{{ scrobbledAgo }}</span>
    </div>

    <div class="Hero__main">
      <div class="Hero__title-row">
        <h2 class="Hero__title">{{ title }}</h2>
        <span
          v-if="event.intercept"
          class="Hero__intercept"
          :title="t('sources.interceptOnly.hint')"
        >
          {{ t('hero.intercept') }}
        </span>
      </div>
      <div class="Hero__subtitle">{{ subtitle }}</div>
      <div class="Hero__meta">
        <span
          class="Hero__source-dot"
          :class="`Hero__source-dot--${event.source}`"
          aria-hidden="true"
        ></span>
        <span class="Hero__source-name">{{ capitalize(event.source) }}</span>
        <template v-if="timeMeta">
          <span class="Hero__sep">|</span>
          <span>{{ timeMeta }}</span>
        </template>
        <template v-if="event.status === 'error'">
          <span class="Hero__sep">|</span>
          <span class="Hero__status-error">⚠ {{ event.error || t('hero.failed') }}</span>
        </template>
      </div>
    </div>

    <div class="Hero__stats">
      <div class="Hero__percent">{{ percentLabel }}</div>
      <div class="Hero__percent-label">{{ t('hero.progressLabel') }}</div>
    </div>

    <div class="Hero__progress">
      <div
        class="Hero__progress-fill"
        :class="{ 'Hero__progress-fill--live': liveActive }"
        :style="{ width: `${percentValue}%` }"
      ></div>
    </div>
  </section>
</template>

<style lang="scss">
.Hero {
  // Background tint follows the source's base color (same palette as the
  // source dots below); brand red is the fallback for unknown sources.
  --hero-tint: 230, 57, 70;
  background:
    radial-gradient(60% 80% at 100% 0%, rgba(var(--hero-tint), 0.18) 0%, transparent 60%),
    linear-gradient(135deg, #1c1d22 0%, #2b2c33 100%);

  &[data-source='plex'] {
    --hero-tint: 204, 122, 22;
  }
  &[data-source='emby'] {
    --hero-tint: 46, 155, 63;
  }
  &[data-source='jellyfin'] {
    --hero-tint: 30, 125, 163;
  }
  &[data-source='kodi'] {
    --hero-tint: 47, 95, 198;
  }
  &[data-source='player'] {
    --hero-tint: 139, 92, 246;
  }
  color: #fff;
  border-radius: var(--v2-radius-md);
  padding: var(--v2-space-xl);
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: var(--v2-space-xl);
  align-items: center;
  min-height: 180px;
  position: relative;
  overflow: hidden;
  border-bottom: 2px solid var(--v2-brand);

  &__badge {
    background: var(--v2-brand);
    border-radius: var(--v2-radius);
    padding: 12px 16px;
    text-align: center;
    font-weight: 700;
    line-height: 1;
    min-width: 84px;
  }

  &__badge-num {
    font-size: 28px;
    letter-spacing: -0.02em;
    display: block;
  }

  &__badge-label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-top: 6px;
    font-weight: 500;
    opacity: 0.9;
  }

  &__main {
    min-width: 0;
  }

  &__title-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__title {
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.015em;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__intercept {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 3px 8px;
    border-radius: 3px;
    background: rgba(217, 119, 6, 0.2);
    color: #fbbf24;
  }

  &__subtitle {
    margin-top: 4px;
    color: #a8aebd;
    font-size: 14px;
  }

  &__meta {
    margin-top: 12px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #a8aebd;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 6px 12px;
    border-radius: 999px;
    flex-wrap: wrap;
  }

  &__sep {
    color: rgba(255, 255, 255, 0.18);
  }
  &__source-name {
    color: #fff;
    font-weight: 600;
  }

  &__source-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;

    &--plex {
      background: #cc7a16;
    }
    &--emby {
      background: #2e9b3f;
    }
    &--jellyfin {
      background: #1e7da3;
    }
    &--kodi {
      background: #2f5fc6;
    }
    &--player {
      background: #8b5cf6;
    }
  }

  &__status-error {
    color: #f87171;
    font-weight: 600;
  }

  &__stats {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  &__percent {
    font-size: 44px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: #fff;
    line-height: 1;
    text-align: right;
  }

  &__percent-label {
    font-size: 11px;
    color: #a8aebd;
    margin-top: 8px;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    text-align: right;
  }

  &__progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.06);
  }

  &__progress-fill {
    height: 100%;
    background: var(--v2-brand);
    transition: width 0.3s ease-out;

    &--live {
      animation: hero-progress-glow 1.6s ease-in-out infinite;
    }
  }
}

@keyframes hero-progress-glow {
  0%,
  100% {
    box-shadow: 0 0 0 rgba(230, 57, 70, 0);
    filter: brightness(1);
  }
  50% {
    box-shadow: 0 0 12px rgba(230, 57, 70, 0.6);
    filter: brightness(1.3);
  }
}
</style>
