<script setup lang="ts">
import { computed, nextTick, ref, watch, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import type { FixtureEntry, ScrobbleTestResult } from '../../api'

const props = defineProps<{
  fixture: FixtureEntry
  expanded: boolean
  lastResult: ScrobbleTestResult | null
}>()

const emit = defineEmits<{
  'toggle-expand': []
  'send': [endpoint: string, payload: unknown]
}>()

const { t } = useI18n()

const ENDPOINTS = ['/scrobble/start', '/scrobble/pause', '/scrobble/stop'] as const

const endpoint = ref<string>(props.fixture.endpoint ?? '/scrobble/stop')
const editingJson = ref(false)
const editedJson = ref<string>(JSON.stringify(props.fixture.payload, null, 2))
const sending = ref(false)

const editorRef = useTemplateRef<HTMLTextAreaElement>('editor')

const jsonValid = computed<boolean>(() => {
  if (!editingJson.value) {
    return true
  }
  try {
    JSON.parse(editedJson.value)
    return true
  } catch {
    return false
  }
})

watch(
  () => props.fixture,
  (f) => {
    editedJson.value = JSON.stringify(f.payload, null, 2)
    endpoint.value = f.endpoint ?? '/scrobble/stop'
  },
)

function onRowClick() {
  emit('toggle-expand')
}

async function toggleEdit(e: Event) {
  e.stopPropagation()
  editingJson.value = !editingJson.value
  if (editingJson.value) {
    await nextTick()
    editorRef.value?.focus()
  }
}

async function onSend(e: Event) {
  e.stopPropagation()
  if (!jsonValid.value || sending.value) {
    return
  }
  let payload: unknown = props.fixture.payload
  if (editingJson.value) {
    try {
      payload = JSON.parse(editedJson.value)
    } catch {
      return
    }
  }
  sending.value = true
  try {
    emit('send', endpoint.value, payload)
  } finally {
    // sending flag is reset when parent updates lastResult,
    // but we also reset it after a tick as a safety net
    setTimeout(() => {
      sending.value = false
    }, 0)
  }
}

const lastBadgeText = computed(() => {
  if (!props.lastResult) {
    return ''
  }
  if (props.lastResult.error) {
    return 'ERR'
  }
  return String(props.lastResult.status)
})

const lastBadgeKind = computed<'ok' | 'err' | null>(() => {
  if (!props.lastResult) {
    return null
  }
  if (props.lastResult.error) {
    return 'err'
  }
  return props.lastResult.ok ? 'ok' : 'err'
})
</script>

<template>
  <div class="TesterRow" :class="{ 'TesterRow--open': expanded }">
    <div class="TesterRow__head" @click="onRowClick">
      <span class="TesterRow__chev" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <div class="TesterRow__info">
        <span class="TesterRow__name">{{ fixture.name }}</span>
        <span v-if="fixture.description" class="TesterRow__desc">{{ fixture.description }}</span>
      </div>
      <span class="TesterRow__endpoint">{{ fixture.endpoint ?? '/scrobble/stop' }}</span>
      <span
        v-if="lastBadgeKind"
        class="TesterRow__badge"
        :class="`TesterRow__badge--${lastBadgeKind}`"
        >{{ lastBadgeText }}</span
      >
    </div>

    <div v-if="expanded" class="TesterRow__form" @click.stop>
      <div class="TesterRow__controls">
        <label class="TesterRow__label">
          <span>{{ t('tester.endpointLabel') }}</span>
          <select v-model="endpoint" class="TesterRow__select">
            <option v-for="ep in ENDPOINTS" :key="ep" :value="ep">{{ ep }}</option>
          </select>
        </label>
        <button type="button" class="TesterRow__btn" @click="toggleEdit">
          {{ editingJson ? t('tester.buttons.close') : t('tester.buttons.editJson') }}
        </button>
        <button
          type="button"
          class="TesterRow__btn TesterRow__btn--accent"
          :disabled="!jsonValid || sending"
          @click="onSend"
        >
          {{ t('tester.buttons.send') }}
        </button>
      </div>

      <textarea
        v-if="editingJson"
        ref="editor"
        v-model="editedJson"
        class="TesterRow__editor"
        spellcheck="false"
        rows="14"
      />
      <pre v-else class="TesterRow__preview">{{ editedJson }}</pre>

      <p v-if="editingJson && !jsonValid" class="TesterRow__error">
        {{ t('tester.errors.invalidJson') }}
      </p>

      <div v-if="lastResult" class="TesterRow__result">
        <span
          class="TesterRow__result-pill"
          :class="
            lastResult.error
              ? 'TesterRow__result-pill--err'
              : lastResult.ok
                ? 'TesterRow__result-pill--ok'
                : 'TesterRow__result-pill--err'
          "
          >{{ lastResult.error ? 'ERR' : lastResult.status }}</span
        >
        <pre class="TesterRow__response">{{
          lastResult.error ? lastResult.error : JSON.stringify(lastResult.body, null, 2)
        }}</pre>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
.TesterRow {
  border-bottom: 1px solid var(--v2-border-soft);

  &:last-child {
    border-bottom: none;
  }

  &__head {
    display: grid;
    grid-template-columns: 16px 1fr auto auto;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    cursor: pointer;
    transition: background-color 0.12s;

    &:hover {
      background: var(--v2-bg-stripe);
    }
  }

  &__chev {
    color: var(--v2-text-muted);
    font-size: 11px;
    text-align: center;
  }

  &__info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  &__name {
    font-size: 13px;
    font-weight: 600;
    color: var(--v2-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__desc {
    font-size: 12px;
    color: var(--v2-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__endpoint {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--v2-text-muted);
    background: var(--v2-bg-stripe);
    padding: 3px 8px;
    border-radius: 3px;
  }

  &__badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 3px;

    &--ok {
      background: #e1f1e3;
      color: var(--v2-success);
    }
    &--err {
      background: #fbe1e1;
      color: var(--v2-error);
    }
  }

  &__form {
    padding: 8px 16px 16px 36px;
    background: var(--v2-bg-soft);
    border-top: 1px solid var(--v2-border-soft);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__controls {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  &__label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--v2-text-muted);
    font-weight: 500;
  }

  &__select {
    font: inherit;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    border: 1px solid var(--v2-border-strong);
    border-radius: var(--v2-radius);
    padding: 5px 8px;
    background: #fff;
    color: var(--v2-text);
  }

  &__btn {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 14px;
    border: 1px solid var(--v2-border-strong);
    background: #fff;
    color: var(--v2-text);
    border-radius: 999px;
    cursor: pointer;
    transition: background-color 0.12s;

    &:hover {
      background: var(--v2-bg-stripe);
    }

    &--accent {
      background: var(--v2-brand);
      border-color: var(--v2-brand);
      color: #fff;

      &:hover {
        background: var(--v2-brand-dark);
        border-color: var(--v2-brand-dark);
      }
      &:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    }
  }

  &__editor,
  &__preview {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    line-height: 1.55;
    background: var(--v2-bg-inset);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius);
    padding: 10px 12px;
    color: var(--v2-text);
    white-space: pre;
    overflow-x: auto;
    margin: 0;
  }

  &__editor {
    width: 100%;
    resize: vertical;
    min-height: 120px;
    tab-size: 2;

    &:focus {
      outline: none;
      border-color: var(--v2-brand);
      box-shadow: 0 0 0 3px var(--v2-brand-soft);
    }
  }

  &__error {
    color: var(--v2-error);
    font-size: 12px;
    font-weight: 500;
  }

  &__result {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  &__result-pill {
    align-self: flex-start;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: 999px;

    &--ok {
      background: #e1f1e3;
      color: var(--v2-success);
    }
    &--err {
      background: #fbe1e1;
      color: var(--v2-error);
    }
  }

  &__response {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    background: var(--v2-bg-dark, #0a0b10);
    color: #d4d8e0;
    border-radius: var(--v2-radius);
    padding: 10px 12px;
    line-height: 1.55;
    overflow-x: auto;
    max-height: 240px;
    overflow-y: auto;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
}
</style>
