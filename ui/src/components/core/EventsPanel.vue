<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import EventRow from './EventRow.vue'
import Toggle from './ui/Toggle.vue'
import { useEvents } from '../../composables/useEvents'
import type { PollingLog, ScrobbleEvent } from '../../types'

const props = defineProps<{
  events: ScrobbleEvent[]
  logs: PollingLog[]
}>()

const { t } = useI18n()

// Persistent toggles via localStorage
const verbose = ref<boolean>(loadBool('events.verbose', false))
const follow = ref<boolean>(loadBool('events.follow', true))

watch(verbose, (v) => saveBool('events.verbose', v))
watch(follow, (v) => saveBool('events.follow', v))

const eventsRef = computed(() => props.events)
const logsRef = computed(() => props.logs)
const { merged } = useEvents(eventsRef, logsRef, verbose)

// Track expanded row by key (only one open at a time)
const expandedKey = ref<string | null>(null)
function toggleExpand(key: string) {
  expandedKey.value = expandedKey.value === key ? null : key
}

// Auto-scroll to top (newest) when follow=on
const listEl = useTemplateRef<HTMLElement>('list')
async function scrollToTop() {
  await nextTick()
  if (listEl.value) {
    listEl.value.scrollTop = 0
  }
}
watch(
  merged,
  () => {
    if (follow.value) {
      void scrollToTop()
    }
  },
  { deep: false },
)

onMounted(() => {
  if (follow.value) {
    void scrollToTop()
  }
})

function loadBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === '1' || v === 'true') {
      return true
    }
    if (v === '0' || v === 'false') {
      return false
    }
    return def
  } catch {
    return def
  }
}
function saveBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <section class="Panel EventsPanel">
    <header class="Panel__header">
      <h3 class="Panel__title">{{ t('events.title') }}</h3>
      <div class="EventsPanel__controls">
        <label class="EventsPanel__ctl">
          <span>{{ t('events.verbose') }}</span>
          <Toggle v-model="verbose" :aria-label="t('events.verbose')" />
        </label>
        <label class="EventsPanel__ctl">
          <span>{{ t('events.follow') }}</span>
          <Toggle v-model="follow" :aria-label="t('events.follow')" />
        </label>
      </div>
    </header>

    <div ref="list" class="EventsPanel__list">
      <p v-if="merged.length === 0" class="EventsPanel__empty">{{ t('events.empty') }}</p>
      <EventRow
        v-for="item in merged"
        :key="item.key"
        :item="item"
        :expanded="expandedKey === item.key"
        @toggle-expand="toggleExpand(item.key)"
      />
    </div>
  </section>
</template>

<style lang="scss">
.EventsPanel {
  &__controls {
    display: inline-flex;
    align-items: center;
    gap: 16px;
  }

  &__ctl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--v2-text-muted);
    cursor: pointer;
    user-select: none;
  }

  &__list {
    max-height: 480px;
    overflow-y: auto;
    padding: 4px 8px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  &__empty {
    padding: 36px 16px;
    text-align: center;
    color: var(--v2-text-muted);
    font-size: 13px;
  }
}
</style>
