<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MergedItem } from '../../composables/useEvents'

const props = defineProps<{
  item: MergedItem
  expanded: boolean
}>()

const emit = defineEmits<{
  'toggle-expand': []
}>()

const { t } = useI18n()

type RowKind = 'ok' | 'err' | 'warn' | 'skipped' | 'info'

const kind = computed<RowKind>(() => {
  if (props.item.kind === 'scrobble') {
    if (props.item.data.status === 'success') {
      return 'ok'
    }
    if (props.item.data.status === 'error') {
      return 'err'
    }
    return 'skipped'
  }
  const lvl = props.item.data.level.toLowerCase()
  if (lvl === 'error') {
    return 'err'
  }
  if (lvl === 'warn') {
    return 'warn'
  }
  return 'info'
})

const expandable = computed(() => kind.value === 'err' || kind.value === 'warn')

const typePill = computed(() =>
  props.item.kind === 'scrobble' ? t('events.type.scr') : t('events.type.log'),
)

const time = computed(() => {
  const d = new Date(props.item.ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
})

const title = computed(() => {
  const item = props.item
  if (item.kind === 'scrobble') {
    const e = item.data
    if (e.status === 'skipped') {
      return t('events.skipped')
    }
    if (e.type === 'episode' && e.showTitle) {
      const sxe = e.season != null && e.episode != null ? ` — ${e.season}×${pad(e.episode)}` : ''
      return `${e.showTitle}${sxe}`
    }
    return e.title
  }
  const repeat =
    item.data.repeatCount && item.data.repeatCount > 1 ? ` x${item.data.repeatCount}` : ''
  return `${item.data.message}${repeat}`
})

const sourceTag = computed(() => {
  if (props.item.kind === 'scrobble') {
    return props.item.data.source
  }
  return null
})

const interceptBadge = computed(
  () => props.item.kind === 'scrobble' && props.item.data.intercept === true,
)

const detailText = computed(() => {
  const item = props.item
  if (item.kind === 'scrobble') {
    return item.data.error ?? ''
  }
  return item.data.message
})

function onClick() {
  if (expandable.value) {
    emit('toggle-expand')
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}
</script>

<template>
  <div
    class="EventRow"
    :class="[
      `EventRow--${kind}`,
      { 'EventRow--clickable': expandable, 'EventRow--open': expanded },
    ]"
    @click="onClick"
  >
    <div class="EventRow__main">
      <span class="EventRow__time">{{ time }}</span>
      <span class="EventRow__type" :class="`EventRow__type--${kind}`" :title="kind">{{
        typePill
      }}</span>
      <span class="EventRow__title">{{ title }}</span>
      <span v-if="sourceTag" class="EventRow__source" :class="`EventRow__source--${sourceTag}`">
        {{ sourceTag }}
      </span>
      <span v-if="interceptBadge" class="EventRow__intercept">{{ t('hero.intercept') }}</span>
    </div>
    <div v-if="expanded && expandable && detailText" class="EventRow__detail">{{ detailText }}</div>
  </div>
</template>

<style lang="scss">
.EventRow {
  border-radius: var(--v2-radius);
  transition: background-color 0.12s;

  &:nth-child(odd) {
    background: var(--v2-bg-stripe);
  }
  &:hover {
    background: rgba(0, 0, 0, 0.03);
  }

  &--clickable {
    cursor: pointer;
  }

  &__main {
    display: grid;
    grid-template-columns: 56px auto 1fr auto auto;
    align-items: center;
    gap: 12px;
    padding: 9px 16px;
  }

  &__time {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    font-weight: 500;
    color: var(--v2-text-muted);
    font-variant-numeric: tabular-nums;
  }

  &__type {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    text-align: center;
    padding: 3px 8px;
    border-radius: 3px;
    letter-spacing: 0.06em;
    text-transform: uppercase;

    &--ok {
      background: rgba(22, 163, 74, 0.14);
      color: var(--v2-success);
    }
    &--err {
      background: rgba(220, 38, 38, 0.14);
      color: var(--v2-error);
    }
    &--warn {
      background: rgba(217, 119, 6, 0.14);
      color: var(--v2-warning);
    }
    &--skipped {
      background: rgba(118, 118, 126, 0.12);
      color: var(--v2-text-dim);
    }
    &--info {
      background: rgba(42, 126, 198, 0.14);
      color: var(--v2-link);
    }
  }

  &__title {
    color: var(--v2-text);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__source {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 3px 8px;
    border-radius: 3px;

    &--plex {
      background: rgba(204, 122, 22, 0.14);
      color: #8a5210;
    }
    &--emby {
      background: rgba(46, 155, 63, 0.14);
      color: #1e6f2c;
    }
    &--jellyfin {
      background: rgba(30, 125, 163, 0.14);
      color: #155e7a;
    }
    &--kodi {
      background: rgba(47, 95, 198, 0.14);
      color: #1f3f87;
    }
  }

  &__intercept {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 3px 8px;
    border-radius: 3px;
    background: rgba(217, 119, 6, 0.18);
    color: #b25a00;
  }

  &__detail {
    margin: 0 16px 12px 96px;
    padding: 8px 12px;
    background: var(--v2-bg-inset);
    border-left: 3px solid currentColor;
    border-radius: 0 var(--v2-radius) var(--v2-radius) 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--v2-text-soft);
    white-space: pre-wrap;
    word-break: break-word;
  }

  &--err .EventRow__detail {
    color: var(--v2-error);
  }
  &--warn .EventRow__detail {
    color: var(--v2-warning);
  }
}
</style>
