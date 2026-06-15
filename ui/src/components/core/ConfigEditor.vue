<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fetchConfig, saveConfig } from '../../api'
import type { AppConfig } from '../../types'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const { t } = useI18n()

const text = ref('')
const error = ref('')
const loading = ref(false)
const saving = ref(false)
/** On-disk path of the config file — shown so the user knows what to back up. */
const configPath = ref('')

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      return
    }
    error.value = ''
    loading.value = true
    try {
      const cfg = await fetchConfig()
      // Drop runtime-only fields that aren't part of the persisted config.
      const { cliInterceptOnlyLocked: _runtimeOnly, configPath: cfgPath, ...editable } = cfg
      configPath.value = cfgPath ?? ''
      text.value = JSON.stringify(editable, null, 2)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

async function save() {
  error.value = ''
  let parsed: AppConfig
  try {
    parsed = JSON.parse(text.value) as AppConfig
  } catch (err) {
    error.value = `${t('config.editor.invalidJson')}: ${err instanceof Error ? err.message : String(err)}`
    return
  }
  if (!Array.isArray(parsed.sources)) {
    error.value = t('config.editor.sourcesRequired')
    return
  }
  saving.value = true
  try {
    const res = await saveConfig(parsed)
    if (res.status !== 'success') {
      error.value = res.reason ?? t('config.editor.saveFailed')
      return
    }
    emit('saved')
    emit('close')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="open" class="ConfigEditor" @click.self="emit('close')">
    <div class="ConfigEditor__modal" role="dialog" aria-modal="true">
      <header class="ConfigEditor__head">
        <h3 class="ConfigEditor__title">{{ t('config.editor.title') }}</h3>
        <button
          type="button"
          class="ConfigEditor__close"
          :aria-label="t('config.editor.cancel')"
          @click="emit('close')"
        >
          ✕
        </button>
      </header>

      <p class="ConfigEditor__hint">{{ t('config.editor.hint') }}</p>
      <p v-if="configPath" class="ConfigEditor__path">
        {{ t('config.editor.fileLabel') }} <code>{{ configPath }}</code>
      </p>

      <textarea
        v-model="text"
        class="ConfigEditor__textarea"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        :disabled="loading || saving"
      ></textarea>

      <p v-if="error" class="ConfigEditor__error" role="alert">{{ error }}</p>

      <footer class="ConfigEditor__foot">
        <button type="button" class="ConfigEditor__btn" @click="emit('close')">
          {{ t('config.editor.cancel') }}
        </button>
        <button
          type="button"
          class="ConfigEditor__btn ConfigEditor__btn--primary"
          :disabled="loading || saving"
          @click="save"
        >
          {{ saving ? t('config.editor.saving') : t('config.editor.save') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style lang="scss">
.ConfigEditor {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--v2-space-lg);
  background: rgba(0, 0, 0, 0.5);

  &__modal {
    width: min(760px, 100%);
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    background: var(--v2-bg-card, #fff);
    border-radius: 10px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--v2-border-soft);
  }

  &__title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
    color: var(--v2-text);
  }

  &__close {
    font: inherit;
    font-size: 15px;
    line-height: 1;
    color: var(--v2-text-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;

    &:hover {
      background: var(--v2-bg-stripe);
      color: var(--v2-text);
    }
  }

  &__hint {
    margin: 0;
    padding: 10px 16px;
    font-size: 12px;
    color: var(--v2-text-muted);
  }

  &__path {
    margin: 0;
    padding: 0 16px 10px;
    font-size: 12px;
    color: var(--v2-text-muted);

    code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      user-select: all;
    }
  }

  &__textarea {
    flex: 1;
    min-height: 320px;
    margin: 0 16px;
    padding: 12px;
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--v2-text);
    background: var(--v2-bg-soft);
    border: 1px solid var(--v2-border-soft);
    border-radius: 8px;
    resize: vertical;
    white-space: pre;
    overflow: auto;

    &:focus-visible {
      outline: 2px solid var(--v2-brand);
      outline-offset: -1px;
    }
  }

  &__error {
    margin: 10px 16px 0;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--v2-error);
    white-space: pre-wrap;
  }

  &__foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 16px;
  }

  &__btn {
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    padding: 8px 16px;
    border-radius: 8px;
    border: 1px solid var(--v2-border-soft);
    background: transparent;
    color: var(--v2-text);
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--v2-bg-stripe);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    &--primary {
      background: var(--v2-brand);
      border-color: var(--v2-brand);
      color: #fff;

      &:hover:not(:disabled) {
        background: var(--v2-brand);
        filter: brightness(1.06);
      }
    }
  }
}
</style>
