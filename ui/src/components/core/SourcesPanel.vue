<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import SourceRow from './SourceRow.vue'
import InterceptOnlyRow from './InterceptOnlyRow.vue'
import { SOURCE_TYPES, type SourceConfig, type SourceType } from '../../types'
import type { SourceStatus } from '../../composables/useSourceStatuses'
import type { EmbySignInState } from '../../composables/useEmbySignIn'
import type { QuickConnectState } from '../../composables/useQuickConnect'
import type { TokenLookupState } from '../../composables/useTokenLookup'

// Players that are managed through the dedicated Setup panel (web-interface /
// IPC enablement) are not shown as plain configurable rows here.
const SETUP_MANAGED: readonly SourceType[] = ['mpc', 'mpv', 'iina', 'vlc']
// "Local player" goes first: it's the zero-config option, and the row order
// doubles as our recommendation for users who don't know what to pick.
const CLASSIC_SOURCE_TYPES = SOURCE_TYPES.filter((t) => !SETUP_MANAGED.includes(t)).sort(
  (a, b) => Number(b === 'player') - Number(a === 'player'),
)

const props = defineProps<{
  sources: SourceConfig[]
  statuses: Record<SourceType, SourceStatus>
  hasActiveSource: boolean
  interceptOnly: boolean
  interceptOnlyLocked?: boolean
  /** Per-source UI state for the "Find token" button (currently only Plex). */
  tokenLookup?: Partial<Record<SourceType, TokenLookupState>>
  /** Per-source UI state for the Quick Connect flow (Jellyfin). */
  quickConnect?: Partial<Record<SourceType, QuickConnectState>>
  /** Per-source UI state for the inline Emby sign-in form. */
  embySignIn?: Partial<Record<SourceType, EmbySignInState>>
}>()

const emit = defineEmits<{
  'update:source': [
    type: SourceType,
    patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
  ]
  'update:interceptOnly': [value: boolean]
  'find-token': [type: SourceType]
  'quick-connect': [type: SourceType]
  'quick-connect-cancel': [type: SourceType]
  'emby-sign-in-open': [type: SourceType]
  'emby-sign-in-cancel': [type: SourceType]
  'emby-sign-in-submit': [type: SourceType, username: string, password: string]
}>()

/**
 * Sources where the row shows a "Find token" button: a known-installed,
 * locally-discoverable backend that we have a probe for. Today Plex
 * (via Preferences.xml) and Kodi (via guisettings.xml).
 */
const TOKEN_LOOKUP_SOURCES: ReadonlySet<SourceType> = new Set<SourceType>(['plex', 'kodi'])

/**
 * Sources that expose the Jellyfin Quick Connect handshake. Emby in
 * practice doesn't ship it on community installs (the feature is reserved
 * for Premiere subscribers), so leave that one to manual API keys.
 */
const QUICK_CONNECT_SOURCES: ReadonlySet<SourceType> = new Set<SourceType>(['jellyfin'])

/**
 * Sources that offer an inline username/password sign-in form (we POST
 * `/Users/AuthenticateByName` on the user's behalf). Emby community
 * installs don't have Quick Connect, so this is the next-best UX.
 */
const EMBY_SIGN_IN_SOURCES: ReadonlySet<SourceType> = new Set<SourceType>(['emby'])

/**
 * "Intercept only" is a debugging lever most users would be confused by.
 * Show it only in dev builds, or when the user has already opted in (config
 * or CLI flag) so they keep the way out.
 */
const showInterceptOnly = computed(
  () => import.meta.env.DEV || props.interceptOnly || props.interceptOnlyLocked === true,
)

const { t } = useI18n()
const DEFAULT_SOURCE_POLL_INTERVAL = 15000

const expanded = reactive<Partial<Record<SourceType, boolean>>>({})

function getSource(sources: SourceConfig[], type: SourceType): SourceConfig {
  const found = sources.find((s) => s.type === type)
  if (found) {
    return found
  }
  return {
    type,
    enabled: false,
    url: '',
    token: '',
    pollInterval: DEFAULT_SOURCE_POLL_INTERVAL,
    userFilter: [],
  }
}
</script>

<template>
  <section class="Panel SourcesPanel">
    <header class="Panel__header">
      <h3 class="Panel__title">{{ t('sources.title') }}</h3>
    </header>

    <div class="Panel__body">
      <SourceRow
        v-for="type in CLASSIC_SOURCE_TYPES"
        :key="type"
        :type="type"
        :enabled="getSource(sources, type).enabled"
        :url="getSource(sources, type).url"
        :token="getSource(sources, type).token"
        :status="statuses[type]"
        :expanded="expanded[type] ?? false"
        :token-lookup="
          TOKEN_LOOKUP_SOURCES.has(type) ? (tokenLookup?.[type] ?? { status: 'idle' }) : undefined
        "
        :quick-connect="
          QUICK_CONNECT_SOURCES.has(type) ? (quickConnect?.[type] ?? { status: 'idle' }) : undefined
        "
        :emby-sign-in="
          EMBY_SIGN_IN_SOURCES.has(type) ? (embySignIn?.[type] ?? { status: 'idle' }) : undefined
        "
        @update:enabled="emit('update:source', type, { enabled: $event })"
        @update:url="emit('update:source', type, { url: $event })"
        @update:token="emit('update:source', type, { token: $event })"
        @update:expanded="expanded[type] = $event"
        @find-token="emit('find-token', type)"
        @quick-connect="emit('quick-connect', type)"
        @quick-connect-cancel="emit('quick-connect-cancel', type)"
        @emby-sign-in-open="emit('emby-sign-in-open', type)"
        @emby-sign-in-cancel="emit('emby-sign-in-cancel', type)"
        @emby-sign-in-submit="(u, p) => emit('emby-sign-in-submit', type, u, p)"
      />

      <template v-if="hasActiveSource && showInterceptOnly">
        <hr class="SourcesPanel__divider" />

        <InterceptOnlyRow
          :model-value="interceptOnly"
          :cli-locked="interceptOnlyLocked"
          @update:model-value="emit('update:interceptOnly', $event)"
        />
      </template>
    </div>
  </section>
</template>

<style lang="scss">
.Panel {
  background: var(--v2-bg);
  border: 1px solid var(--v2-border);
  border-radius: var(--v2-radius-md);
  overflow: hidden;

  &__header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--v2-border-soft);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__title {
    font-size: 15px;
    font-weight: 700;
    color: var(--v2-text);
    letter-spacing: -0.015em;
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: 10px;

    &::before {
      content: '';
      width: 4px;
      height: 16px;
      background: var(--v2-brand);
      border-radius: 1px;
    }
  }

  &__body {
    padding: 8px 8px 8px 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
}

.SourcesPanel__divider {
  border: none;
  border-top: 1px solid var(--v2-border-soft);
  margin: 8px 16px 0 16px;
}
</style>
