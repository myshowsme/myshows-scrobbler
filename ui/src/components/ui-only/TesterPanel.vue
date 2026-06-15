<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import TesterFixtureRow from './TesterFixtureRow.vue'
import {
  fetchFixtures,
  sendScrobbleTest,
  type FixtureEntry,
  type ScrobbleTestResult,
} from '../../api'

// Dev-only: tree-shaken from production via App.vue's `import.meta.env.DEV` gate.

type CategoryKey = 'movie' | 'episode' | 'anime-movie' | 'anime-episode'
const CATEGORIES: CategoryKey[] = ['movie', 'episode', 'anime-movie', 'anime-episode']

const { t } = useI18n()

const fixtures = ref<FixtureEntry[]>([])
const loading = ref(false)
const loadError = ref('')

const activeTab = ref<CategoryKey>('episode')
const expandedPath = ref<string | null>(null)
const lastResults = ref<Record<string, ScrobbleTestResult>>({})

const grouped = computed<Record<CategoryKey, FixtureEntry[]>>(() => {
  const out: Record<CategoryKey, FixtureEntry[]> = {
    'movie': [],
    'episode': [],
    'anime-movie': [],
    'anime-episode': [],
  }
  for (const f of fixtures.value) {
    const cat = f.category as CategoryKey
    if (CATEGORIES.includes(cat)) {
      out[cat].push(f)
    }
  }
  return out
})

const visibleFixtures = computed<FixtureEntry[]>(() => grouped.value[activeTab.value] ?? [])

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const r = await fetchFixtures()
    fixtures.value = r.fixtures
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function selectTab(cat: CategoryKey) {
  activeTab.value = cat
  expandedPath.value = null
}

function toggleExpand(path: string) {
  expandedPath.value = expandedPath.value === path ? null : path
}

async function onSend(fixture: FixtureEntry, endpoint: string, payload: unknown) {
  try {
    const result = await sendScrobbleTest(endpoint, payload)
    lastResults.value = { ...lastResults.value, [fixture.path]: result }
  } catch (err) {
    lastResults.value = {
      ...lastResults.value,
      [fixture.path]: {
        status: 0,
        ok: false,
        body: null,
        error: err instanceof Error ? err.message : String(err),
      },
    }
  }
}

onMounted(load)
</script>

<template>
  <section class="Panel TesterPanel">
    <header class="Panel__header">
      <h3 class="Panel__title">
        {{ t('tester.title') }}
        <span class="TesterPanel__dev-tag">{{ t('tester.devOnly') }}</span>
      </h3>
      <button type="button" class="TesterPanel__reload" :disabled="loading" @click="load">
        ↻ {{ t('tester.reload') }}
      </button>
    </header>

    <div class="TesterPanel__tabs">
      <button
        v-for="cat in CATEGORIES"
        :key="cat"
        type="button"
        class="TesterPanel__tab"
        :class="{ 'TesterPanel__tab--active': activeTab === cat }"
        @click="selectTab(cat)"
      >
        {{ t(`tester.category.${cat}`) }}
        <span class="TesterPanel__tab-count">{{ grouped[cat].length }}</span>
      </button>
    </div>

    <div class="TesterPanel__list">
      <p v-if="loadError" class="TesterPanel__error">{{ loadError }}</p>
      <p v-else-if="loading && !fixtures.length" class="TesterPanel__muted">
        {{ t('tester.loading') }}
      </p>
      <p v-else-if="visibleFixtures.length === 0" class="TesterPanel__muted">
        {{ t('tester.emptyCategory') }}
      </p>
      <TesterFixtureRow
        v-for="f in visibleFixtures"
        :key="f.path"
        :fixture="f"
        :expanded="expandedPath === f.path"
        :last-result="lastResults[f.path] ?? null"
        @toggle-expand="toggleExpand(f.path)"
        @send="(endpoint, payload) => onSend(f, endpoint, payload)"
      />
    </div>
  </section>
</template>

<style lang="scss">
.TesterPanel {
  &__dev-tag {
    margin-left: 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: var(--v2-bg-warn);
    color: var(--v2-warning);
    padding: 2px 8px;
    border-radius: 999px;
    vertical-align: middle;
  }

  &__reload {
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    color: var(--v2-text-muted);
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    padding: 4px 10px;
    border-radius: 999px;
    transition:
      background-color 0.12s,
      color 0.12s;

    &:hover {
      background: var(--v2-bg-stripe);
      color: var(--v2-text);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  &__tabs {
    display: flex;
    gap: 4px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--v2-border-soft);
    background: var(--v2-bg-soft);
    flex-wrap: wrap;
  }

  &__tab {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--v2-text-muted);
    background: transparent;
    border: none;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 999px;
    transition:
      background-color 0.12s,
      color 0.12s;
    display: inline-flex;
    align-items: center;
    gap: 6px;

    &:hover {
      color: var(--v2-text);
      background: var(--v2-bg-stripe);
    }

    &--active {
      background: var(--v2-brand);
      color: #fff;

      &:hover {
        background: var(--v2-brand);
        color: #fff;
      }
    }
  }

  &__tab-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    opacity: 0.7;
  }

  &__list {
    max-height: 600px;
    overflow-y: auto;
  }

  &__muted {
    padding: 24px 16px;
    text-align: center;
    color: var(--v2-text-muted);
    font-size: 13px;
  }

  &__error {
    padding: 16px;
    color: var(--v2-error);
    font-size: 13px;
    font-weight: 500;
  }
}
</style>
