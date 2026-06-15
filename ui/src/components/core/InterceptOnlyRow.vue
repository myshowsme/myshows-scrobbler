<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Toggle from './ui/Toggle.vue'

const props = defineProps<{
  modelValue: boolean
  /** When true, toggle is locked because the process started with --intercept-only */
  cliLocked?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const { t } = useI18n()

function onToggle(value: boolean) {
  if (props.cliLocked) {
    return
  }
  emit('update:modelValue', value)
}
</script>

<template>
  <div
    class="InterceptOnly"
    :class="{ 'InterceptOnly--active': modelValue, 'InterceptOnly--locked': cliLocked }"
  >
    <Toggle
      :model-value="modelValue"
      :disabled="cliLocked"
      :aria-label="t('sources.interceptOnly.label')"
      @update:model-value="onToggle"
    />
    <div class="InterceptOnly__text">
      <span class="InterceptOnly__label">{{ t('sources.interceptOnly.label') }}</span>
      <span class="InterceptOnly__hint">
        {{ cliLocked ? t('sources.interceptOnly.lockedHint') : t('sources.interceptOnly.hint') }}
      </span>
    </div>
  </div>
</template>

<style lang="scss">
.InterceptOnly {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-left: 3px solid transparent;
  transition:
    background-color 0.12s,
    border-color 0.12s;

  &--active {
    border-left-color: var(--v2-warning);
    background: var(--v2-bg-warn);
  }

  &--locked .InterceptOnly__hint {
    color: var(--v2-warning);
    font-style: italic;
  }

  &__text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  &__label {
    font-size: 14px;
    font-weight: 600;
    color: var(--v2-text);
    letter-spacing: -0.01em;
  }

  &__hint {
    font-size: 12px;
    color: var(--v2-text-muted);
  }
}
</style>
