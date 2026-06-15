<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchSetupActions,
  fetchSetupDiff,
  applySetupAction,
  restoreSetupAction,
  type SetupActionInfo,
  type SetupChange,
} from '../../api'
import type { SourceType } from '../../types'

// AppShell owns the config; the setup card only triggers the side effect of
// enabling/disabling the matching source so the adapter actually starts.
const emit = defineEmits<{
  'source-toggle': [player: SourceType, enabled: boolean]
}>()

const { t } = useI18n()

const actions = ref<SetupActionInfo[]>([])
const loading = ref(true)
/** Per-action transient result message (restart/verified/error). */
const results = ref<Record<string, { kind: 'ok' | 'warn' | 'error'; text: string }>>({})
/** Action id currently mid-request (disables its buttons). */
const busy = ref<string | null>(null)

// Consent modal state.
const modalAction = ref<SetupActionInfo | null>(null)
const modalChanges = ref<SetupChange[]>([])
const modalLoading = ref(false)

async function refresh(): Promise<void> {
  try {
    const res = await fetchSetupActions()
    actions.value = res.actions
  } catch {
    actions.value = []
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

async function openConsent(action: SetupActionInfo): Promise<void> {
  modalAction.value = action
  modalChanges.value = []
  modalLoading.value = true
  try {
    const res = await fetchSetupDiff(action.id)
    modalChanges.value = res.changes
  } catch {
    modalChanges.value = []
  } finally {
    modalLoading.value = false
  }
}

function closeConsent(): void {
  modalAction.value = null
  modalChanges.value = []
}

async function confirmEnable(): Promise<void> {
  const action = modalAction.value
  if (!action) {
    return
  }
  closeConsent()
  busy.value = action.id
  try {
    const res = await applySetupAction(action.id)
    if (res.status !== 'success') {
      results.value[action.id] = { kind: 'error', text: res.reason ?? 'failed' }
      return
    }
    emit('source-toggle', action.player, true)
    results.value[action.id] = res.verified
      ? { kind: 'ok', text: t('setup.result.verified') }
      : { kind: 'warn', text: `${t('setup.result.applied')} ${t('setup.result.restart')}` }
    await refresh()
  } catch (err) {
    results.value[action.id] = {
      kind: 'error',
      text: t('setup.result.error', { message: String(err) }),
    }
  } finally {
    busy.value = null
  }
}

async function disable(action: SetupActionInfo): Promise<void> {
  busy.value = action.id
  try {
    const res = await restoreSetupAction(action.id, action.activeSnapshotId)
    if (res.status !== 'success') {
      results.value[action.id] = { kind: 'error', text: res.reason ?? 'failed' }
      return
    }
    emit('source-toggle', action.player, false)
    // A force-restore means the snapshot was gone and the previous values
    // could not be brought back — say so instead of pretending they were.
    results.value[action.id] =
      res.mode === 'force'
        ? { kind: 'warn', text: t('setup.result.forceRestored') }
        : { kind: 'ok', text: t('setup.result.restored') }
    await refresh()
  } catch (err) {
    results.value[action.id] = {
      kind: 'error',
      text: t('setup.result.error', { message: String(err) }),
    }
  } finally {
    busy.value = null
  }
}

function statusLabel(action: SetupActionInfo): string {
  if (!action.supported) {
    return t('setup.status.unsupported')
  }
  return action.applied ? t('setup.status.enabled') : t('setup.status.disabled')
}

function fmt(value: string | number | null): string {
  return value === null || value === '' ? t('setup.modal.absent') : String(value)
}
</script>

<template>
  <section v-if="loading || actions.length > 0" class="Panel SetupPanel">
    <header class="Panel__header">
      <h3 class="Panel__title">{{ t('setup.title') }}</h3>
      <span class="SetupPanel__subtitle">{{ t('setup.subtitle') }}</span>
    </header>

    <div class="Panel__body">
      <article
        v-for="action in actions"
        :key="action.id"
        class="SetupCard"
        :class="{ 'SetupCard--on': action.applied, 'SetupCard--off': !action.supported }"
      >
        <div class="SetupCard__main">
          <div class="SetupCard__head">
            <span class="SetupCard__name">{{ action.name }}</span>
            <span
              class="SetupCard__badge"
              :class="{
                'is-on': action.applied,
                'is-off': !action.supported,
              }"
            >
              {{ statusLabel(action) }}
            </span>
          </div>
          <p class="SetupCard__desc">{{ action.description }}</p>
          <p
            v-if="results[action.id]"
            class="SetupCard__result"
            :class="`SetupCard__result--${results[action.id].kind}`"
          >
            {{ results[action.id].text }}
          </p>
        </div>

        <div class="SetupCard__actions">
          <button
            v-if="action.applied"
            type="button"
            class="SetupBtn SetupBtn--ghost"
            :disabled="busy === action.id"
            @click="disable(action)"
          >
            {{ busy === action.id ? t('setup.button.working') : t('setup.button.disable') }}
          </button>
          <button
            v-else
            type="button"
            class="SetupBtn"
            :disabled="!action.supported || busy === action.id"
            @click="openConsent(action)"
          >
            {{ busy === action.id ? t('setup.button.working') : t('setup.button.enable') }}
          </button>
        </div>
      </article>
    </div>

    <!-- Consent modal -->
    <div v-if="modalAction" class="SetupModal" role="dialog" aria-modal="true">
      <div class="SetupModal__backdrop" @click="closeConsent" />
      <div class="SetupModal__box">
        <h4 class="SetupModal__title">
          {{ t('setup.modal.title', { name: modalAction.name }) }}
        </h4>
        <p class="SetupModal__intro">{{ t('setup.modal.intro') }}</p>

        <ul v-if="!modalLoading" class="SetupModal__changes">
          <li v-for="(change, i) in modalChanges" :key="i" class="SetupModal__change">
            <code class="SetupModal__target">{{ change.target }}</code>
            <span class="SetupModal__prop">{{ change.property }}</span>
            <span class="SetupModal__diff">
              {{ fmt(change.current) }} <span class="SetupModal__arrow">→</span>
              <strong>{{ fmt(change.next) }}</strong>
            </span>
          </li>
        </ul>

        <div class="SetupModal__buttons">
          <button type="button" class="SetupBtn SetupBtn--ghost" @click="closeConsent">
            {{ t('setup.modal.cancel') }}
          </button>
          <button type="button" class="SetupBtn" :disabled="modalLoading" @click="confirmEnable">
            {{ t('setup.modal.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style lang="scss">
.SetupPanel {
  .Panel__header {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  &__subtitle {
    font-size: 12px;
    color: var(--v2-text-muted);
  }
}

.SetupCard {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--v2-space-md);
  padding: 12px 16px;
  border-radius: var(--v2-radius);

  &:hover {
    background: var(--v2-bg-stripe);
  }

  &--off {
    opacity: 0.55;
  }

  &__main {
    min-width: 0;
  }

  &__head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  &__name {
    font-weight: 600;
    color: var(--v2-text);
  }

  &__badge {
    font-size: 11px;
    color: var(--v2-text-muted);
    border: 1px solid var(--v2-border);
    border-radius: 999px;
    padding: 1px 8px;

    &.is-on {
      color: var(--v2-success);
      border-color: var(--v2-success);
    }

    &.is-off {
      color: var(--v2-text-dim);
    }
  }

  &__desc {
    margin: 4px 0 0 0;
    font-size: 12px;
    color: var(--v2-text-soft);
    line-height: 1.45;
  }

  &__result {
    margin: 6px 0 0 0;
    font-size: 12px;

    &--ok {
      color: var(--v2-success);
    }

    &--warn {
      color: var(--v2-warning);
    }

    &--error {
      color: var(--v2-error);
    }
  }

  &__actions {
    flex-shrink: 0;
  }
}

.SetupBtn {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 6px 16px;
  border-radius: var(--v2-radius);
  border: 1px solid var(--v2-brand);
  background: var(--v2-brand);
  color: #fff;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--v2-brand-dark);
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }

  &--ghost {
    background: transparent;
    color: var(--v2-text-soft);
    border-color: var(--v2-border-strong);

    &:hover:not(:disabled) {
      background: var(--v2-bg-stripe);
    }
  }
}

.SetupModal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;

  &__backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
  }

  &__box {
    position: relative;
    background: var(--v2-bg);
    border-radius: var(--v2-radius-md);
    padding: var(--v2-space-lg);
    width: min(520px, 92vw);
    max-height: 80vh;
    overflow: auto;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  }

  &__title {
    margin: 0 0 6px 0;
    font-size: 16px;
    font-weight: 700;
  }

  &__intro {
    margin: 0 0 14px 0;
    font-size: 13px;
    color: var(--v2-text-soft);
  }

  &__changes {
    list-style: none;
    margin: 0 0 18px 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__change {
    background: var(--v2-bg-inset);
    border-radius: var(--v2-radius);
    padding: 8px 10px;
    font-size: 12px;
  }

  &__target {
    display: block;
    color: var(--v2-text-muted);
    font-size: 11px;
    word-break: break-all;
  }

  &__prop {
    font-weight: 600;
    margin-right: 8px;
  }

  &__arrow {
    color: var(--v2-text-muted);
  }

  &__buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
}
</style>
