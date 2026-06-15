<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusDot, { type DotState } from './ui/StatusDot.vue'
import Toggle, { type ToggleTone } from './ui/Toggle.vue'
import type { SourceType } from '../../types'
import type { SourceStatus } from '../../composables/useSourceStatuses'
import type { EmbySignInState } from '../../composables/useEmbySignIn'
import type { QuickConnectState } from '../../composables/useQuickConnect'
import type { TokenLookupState } from '../../composables/useTokenLookup'
import { isLocalSource } from '../../utils/source-type'

const props = defineProps<{
  type: SourceType
  enabled: boolean
  url: string
  token: string
  status: SourceStatus
  expanded: boolean
  /** Set for sources that support a "Find token" button (currently Plex). */
  tokenLookup?: TokenLookupState
  /** Set for sources that support Quick Connect (Jellyfin). */
  quickConnect?: QuickConnectState
  /** Set for sources that support inline username/password sign-in (Emby). */
  embySignIn?: EmbySignInState
}>()

const emit = defineEmits<{
  'update:enabled': [value: boolean]
  'update:url': [value: string]
  'update:token': [value: string]
  'update:expanded': [value: boolean]
  'find-token': []
  'quick-connect': []
  'quick-connect-cancel': []
  'emby-sign-in-open': []
  'emby-sign-in-cancel': []
  'emby-sign-in-submit': [username: string, password: string]
}>()

const { t } = useI18n()

const tokenRevealed = ref(false)
// Local form state for the inline Emby sign-in panel. Lives here, not in
// the composable, so the password is forgotten as soon as it's submitted.
const embySignInUsername = ref('')
const embySignInPassword = ref('')

function dotState(): DotState {
  if (!props.enabled) {
    return 'disabled'
  }
  return props.status.state
}

// The row toggle doubles as the status indicator: green when connected,
// red when the probe failed, gray while off / still checking.
const toggleTone = computed<ToggleTone>(() => {
  switch (props.status.state) {
    case 'ok':
      return 'ok'
    case 'error':
      return 'error'
    default:
      return 'checking'
  }
})

function dotPulses(): boolean {
  return props.enabled && (props.status.state === 'ok' || props.status.state === 'checking')
}

function onRowClick() {
  emit('update:expanded', !props.expanded)
}

function onUrlInput(e: Event) {
  emit('update:url', (e.target as HTMLInputElement).value)
}

function onTokenInput(e: Event) {
  emit('update:token', (e.target as HTMLInputElement).value)
}

function statusText(): string {
  switch (props.status.state) {
    case 'ok':
      return t('sources.status.ok')
    case 'checking':
      return t('sources.status.checking')
    case 'error':
      // Prefer a friendly message keyed by `code` when the backend gave us
      // one; raw error strings are adapter-internal jargon ("API error: 404").
      return props.status.code
        ? t(`sources.status.errorByCode.${props.status.code}`)
        : t('sources.status.error', { message: props.status.error ?? '' })
    case 'unknown':
    default:
      return t('sources.status.idle')
  }
}

const tokenLookupHint = computed<string | null>(() => {
  const lookup = props.tokenLookup
  if (!lookup) {
    return null
  }
  if (lookup.status === 'looking') {
    return t('sources.findToken.looking')
  }
  if (lookup.status === 'failed') {
    const reason = lookup.reason ?? 'unknown'
    return t(`sources.findToken.failed.${reason}`)
  }
  return null
})

function onFindTokenClick() {
  emit('find-token')
}

function onQuickConnectClick() {
  emit('quick-connect')
}

function onQuickConnectCancel() {
  emit('quick-connect-cancel')
}

const quickConnectFailureHint = computed<string | null>(() => {
  const qc = props.quickConnect
  if (!qc || qc.status !== 'failed') {
    return null
  }
  return t(`sources.quickConnect.failed.${qc.reason ?? 'unknown'}`)
})

const embySignInFailureHint = computed<string | null>(() => {
  const si = props.embySignIn
  if (!si || si.status !== 'failed') {
    return null
  }
  return t(`sources.signIn.failed.${si.reason ?? 'unknown'}`)
})

function onEmbySignInOpen() {
  embySignInUsername.value = ''
  embySignInPassword.value = ''
  emit('emby-sign-in-open')
}

function onEmbySignInSubmit() {
  emit('emby-sign-in-submit', embySignInUsername.value, embySignInPassword.value)
  // Drop credentials from local state right after handing them off; the
  // composable holds nothing but the resulting token.
  embySignInUsername.value = ''
  embySignInPassword.value = ''
}

function onEmbySignInCancel() {
  embySignInUsername.value = ''
  embySignInPassword.value = ''
  emit('emby-sign-in-cancel')
}

const sourceName = (s: SourceType) => {
  if (s === 'player') {
    return t('sources.name.player')
  }
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function urlPlaceholder(s: SourceType): string {
  // Each backend has its own default HTTP port; hint at the right one
  switch (s) {
    case 'kodi':
      return 'http://192.168.1.100:8080'
    case 'jellyfin':
    case 'emby':
      return 'http://192.168.1.100:8096'
    default:
      return 'http://192.168.1.100:32400'
  }
}

const collapsedSubtitle = (s: SourceType, value: string) => {
  if (isLocalSource(s)) {
    return t('sources.player.subtitle')
  }
  return value || t('sources.notConfigured')
}
</script>

<template>
  <div class="SourceRow" :class="{ 'SourceRow--disabled': !enabled, 'SourceRow--open': expanded }">
    <div class="SourceRow__row" @click="onRowClick">
      <Toggle
        class="SourceRow__toggle"
        :model-value="enabled"
        :tone="toggleTone"
        :aria-label="t('sources.aria.enable', { source: sourceName(type) })"
        @update:model-value="emit('update:enabled', $event)"
      />
      <span class="SourceRow__name">{{ sourceName(type) }}</span>
      <span
        class="SourceRow__url"
        :class="{ 'SourceRow__url--placeholder': isLocalSource(type) || !url }"
        :title="isLocalSource(type) ? '' : url || ''"
      >
        {{ collapsedSubtitle(type, url) }}
      </span>
    </div>

    <div v-if="expanded" class="SourceRow__form">
      <template v-if="isLocalSource(type)">
        <p class="SourceRow__hint">{{ t('sources.player.hint') }}</p>
      </template>
      <template v-else>
        <label class="SourceRow__field">
          <span class="SourceRow__field-label">{{ t('sources.form.url') }}</span>
          <input
            type="text"
            class="SourceRow__input"
            spellcheck="false"
            autocomplete="off"
            :value="url"
            :placeholder="urlPlaceholder(type)"
            @input="onUrlInput"
          />
        </label>

        <label class="SourceRow__field">
          <span class="SourceRow__field-label">{{ t('sources.form.token') }}</span>
          <div class="SourceRow__token-wrap">
            <input
              :type="tokenRevealed ? 'text' : 'password'"
              class="SourceRow__input"
              spellcheck="false"
              autocomplete="off"
              :value="token"
              @input="onTokenInput"
            />
            <button
              type="button"
              class="SourceRow__reveal"
              :title="tokenRevealed ? t('sources.form.hide') : t('sources.form.reveal')"
              :aria-label="tokenRevealed ? t('sources.form.hide') : t('sources.form.reveal')"
              @click="tokenRevealed = !tokenRevealed"
            >
              <!-- Lucide "eye-off" / "eye" -->
              <svg
                v-if="tokenRevealed"
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path
                  d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"
                />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" x2="22" y1="2" y2="22" />
              </svg>
              <svg
                v-else
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </label>

        <div
          v-if="quickConnect && !token && quickConnect.status !== 'pending'"
          class="SourceRow__qc"
        >
          <button
            type="button"
            class="SourceRow__qc-button"
            :disabled="quickConnect.status === 'initiating'"
            @click="onQuickConnectClick"
          >
            {{
              quickConnect.status === 'initiating'
                ? t('sources.quickConnect.initiating')
                : quickConnect.status === 'failed'
                  ? t('sources.quickConnect.retry')
                  : t('sources.quickConnect.button')
            }}
          </button>
          <span
            v-if="quickConnect.status === 'failed' && quickConnectFailureHint"
            class="SourceRow__qc-hint SourceRow__qc-hint--error"
            role="alert"
          >
            {{ quickConnectFailureHint }}
          </span>
        </div>

        <div v-if="quickConnect && quickConnect.status === 'pending'" class="SourceRow__qc-panel">
          <p class="SourceRow__qc-instruction">
            {{ t('sources.quickConnect.instruction', { source: sourceName(type) }) }}
          </p>
          <code class="SourceRow__qc-code">{{ quickConnect.code }}</code>
          <button type="button" class="SourceRow__qc-cancel" @click="onQuickConnectCancel">
            {{ t('sources.quickConnect.cancel') }}
          </button>
        </div>

        <div v-if="embySignIn && !token && embySignIn.status === 'idle'" class="SourceRow__qc">
          <button type="button" class="SourceRow__qc-button" @click="onEmbySignInOpen">
            {{ t('sources.signIn.button', { source: sourceName(type) }) }}
          </button>
        </div>

        <form
          v-if="
            embySignIn &&
            (embySignIn.status === 'form' ||
              embySignIn.status === 'signing-in' ||
              embySignIn.status === 'failed')
          "
          class="SourceRow__signin"
          @submit.prevent="onEmbySignInSubmit"
        >
          <label class="SourceRow__field">
            <span class="SourceRow__field-label">{{ t('sources.signIn.username') }}</span>
            <input
              v-model="embySignInUsername"
              type="text"
              class="SourceRow__input"
              spellcheck="false"
              autocomplete="username"
              :disabled="embySignIn.status === 'signing-in'"
            />
          </label>
          <label class="SourceRow__field">
            <span class="SourceRow__field-label">{{ t('sources.signIn.password') }}</span>
            <input
              v-model="embySignInPassword"
              type="password"
              class="SourceRow__input"
              autocomplete="current-password"
              :disabled="embySignIn.status === 'signing-in'"
            />
          </label>
          <div class="SourceRow__signin-actions">
            <button
              type="submit"
              class="SourceRow__qc-button"
              :disabled="embySignIn.status === 'signing-in' || !embySignInUsername"
            >
              {{
                embySignIn.status === 'signing-in'
                  ? t('sources.signIn.signingIn')
                  : t('sources.signIn.submit')
              }}
            </button>
            <button type="button" class="SourceRow__qc-cancel" @click="onEmbySignInCancel">
              {{ t('sources.signIn.cancel') }}
            </button>
          </div>
          <span
            v-if="embySignIn.status === 'failed' && embySignInFailureHint"
            class="SourceRow__qc-hint SourceRow__qc-hint--error"
            role="alert"
          >
            {{ embySignInFailureHint }}
          </span>
        </form>
      </template>

      <div class="SourceRow__status" :class="`SourceRow__status--${status.state}`">
        <StatusDot :state="dotState()" :pulse="dotPulses()" :size="8" />
        <span>{{ statusText() }}</span>
        <button
          v-if="tokenLookup && !token"
          type="button"
          class="SourceRow__find-token"
          :disabled="tokenLookup.status === 'looking'"
          @click="onFindTokenClick"
        >
          {{
            tokenLookup.status === 'looking'
              ? t('sources.findToken.looking')
              : t('sources.findToken.button')
          }}
        </button>
        <span
          v-if="tokenLookupHint && tokenLookup?.status === 'failed'"
          class="SourceRow__find-token-hint"
          role="alert"
        >
          {{ tokenLookupHint }}
        </span>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.SourceRow {
  &__row {
    display: grid;
    grid-template-columns: auto 50px 1fr;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    cursor: pointer;
    border-radius: var(--v2-radius);
    transition: background-color 0.12s;

    &:hover {
      background: var(--v2-bg-stripe);
    }
  }

  &__name {
    font-size: 14px;
    font-weight: 600;
    color: var(--v2-text);
    letter-spacing: -0.01em;
  }

  &__url {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--v2-text-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &--placeholder {
      font-family: inherit;
      font-style: italic;
      color: var(--v2-text-dim);
    }
  }

  &--disabled .SourceRow__name,
  &--disabled .SourceRow__url {
    opacity: 0.55;
  }

  &--open > .SourceRow__row {
    background: var(--v2-bg-stripe);
  }

  // ── Expanded form ─────────────────────────────────────────────────────
  &__form {
    padding: 8px 16px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--v2-bg-soft);
    border-top: 1px solid var(--v2-border-soft);
    margin-top: 0;
  }

  &__field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__field-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--v2-text-muted);
  }

  &__input {
    font: inherit;
    font-size: 13px;
    background: #fff;
    border: 1px solid var(--v2-border-strong);
    border-radius: var(--v2-radius);
    padding: 8px 10px;
    color: var(--v2-text);
    width: 100%;

    &:focus {
      outline: none;
      border-color: var(--v2-brand);
      box-shadow: 0 0 0 3px var(--v2-brand-soft);
    }
  }

  &__token-wrap {
    position: relative;
  }

  &__token-wrap .SourceRow__input {
    padding-right: 40px;
  }

  &__reveal {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--v2-link);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    opacity: 0.85;
    transition: opacity 0.12s;

    &:hover {
      opacity: 1;
    }
  }

  &__hint {
    margin: 0 0 4px 0;
    font-size: 12px;
    color: var(--v2-text-muted);
    line-height: 1.5;

    code {
      background: var(--v2-bg);
      border: 1px solid var(--v2-border-soft);
      border-radius: 3px;
      padding: 1px 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
    }
  }

  &__status {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--v2-text-muted);
    font-weight: 500;

    &--ok {
      color: var(--v2-success);
    }
    &--error {
      color: var(--v2-error);
    }
    &--checking {
      color: var(--v2-text-muted);
      font-style: italic;
    }
  }

  &__find-token {
    margin-left: 4px;
    background: none;
    border: 1px solid var(--v2-border-strong);
    border-radius: var(--v2-radius);
    padding: 3px 9px;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    color: var(--v2-link);
    cursor: pointer;
    transition: background-color 0.12s;

    &:hover:not(:disabled) {
      background: var(--v2-brand-soft);
    }
    &:disabled {
      cursor: progress;
      opacity: 0.6;
    }
  }

  &__find-token-hint {
    color: var(--v2-text-muted);
    font-style: italic;
    font-size: 11px;
  }

  // ── Quick Connect (Jellyfin / Emby) ───────────────────────────────────
  &__qc {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  &__qc-button {
    background: none;
    border: 1px solid var(--v2-border-strong);
    border-radius: var(--v2-radius);
    padding: 6px 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--v2-link);
    cursor: pointer;
    transition: background-color 0.12s;

    &:hover:not(:disabled) {
      background: var(--v2-brand-soft);
    }
    &:disabled {
      cursor: progress;
      opacity: 0.6;
    }
  }

  &__qc-hint {
    font-size: 11px;
    font-style: italic;
    color: var(--v2-text-muted);

    &--error {
      color: var(--v2-error);
      font-style: normal;
    }
  }

  &__qc-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--v2-brand-soft);
    border: 1px solid var(--v2-brand);
    border-radius: var(--v2-radius);
    align-items: flex-start;
  }

  &__qc-instruction {
    margin: 0;
    font-size: 12px;
    color: var(--v2-text);
    line-height: 1.4;
  }

  &__qc-code {
    align-self: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 0.15em;
    color: var(--v2-brand);
    background: var(--v2-bg);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius);
    padding: 8px 16px;
    user-select: all;
  }

  &__qc-cancel {
    align-self: flex-end;
    background: none;
    border: none;
    color: var(--v2-text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    padding: 4px 6px;

    &:hover {
      color: var(--v2-text);
      text-decoration: underline;
    }
  }

  // ── Emby inline sign-in form ──────────────────────────────────────────
  &__signin {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--v2-bg-stripe);
    border: 1px solid var(--v2-border-soft);
    border-radius: var(--v2-radius);
  }

  &__signin-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }
}
</style>
