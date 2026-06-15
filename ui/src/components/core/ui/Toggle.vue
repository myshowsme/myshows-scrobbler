<script setup lang="ts">
/**
 * Visual tone of the "on" state. The default brand red is for plain
 * settings; source rows use the toggle as a status indicator instead of a
 * separate dot: green when connected, red when failed, gray while checking.
 */
export type ToggleTone = 'brand' | 'ok' | 'error' | 'checking'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    disabled?: boolean
    ariaLabel?: string
    tone?: ToggleTone
  }>(),
  { disabled: false, tone: 'brand' },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

function onClick(e: MouseEvent) {
  e.stopPropagation()
  if (props.disabled) {
    return
  }
  emit('update:modelValue', !props.modelValue)
}
</script>

<template>
  <button
    type="button"
    class="Toggle"
    :class="[`Toggle--tone-${tone}`, { 'Toggle--on': modelValue, 'Toggle--disabled': disabled }]"
    :disabled="disabled"
    :aria-pressed="modelValue"
    :aria-label="ariaLabel"
    @click="onClick"
  >
    <span class="Toggle__knob" />
  </button>
</template>

<style lang="scss">
.Toggle {
  --tg-w: 36px;
  --tg-h: 20px;
  --tg-pad: 2px;
  width: var(--tg-w);
  height: var(--tg-h);
  border: none;
  border-radius: 999px;
  background: #cfcfd4;
  position: relative;
  cursor: pointer;
  padding: 0;
  transition: background-color 0.18s;

  &:focus-visible {
    outline: 2px solid var(--v2-brand, #e63946);
    outline-offset: 2px;
  }

  &__knob {
    position: absolute;
    top: var(--tg-pad);
    left: var(--tg-pad);
    width: calc(var(--tg-h) - var(--tg-pad) * 2);
    height: calc(var(--tg-h) - var(--tg-pad) * 2);
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    transition: transform 0.18s;
  }

  &--on {
    background: var(--v2-brand, #e63946);

    &.Toggle--tone-ok {
      background: var(--v2-success, #16a34a);
    }
    &.Toggle--tone-error {
      background: var(--v2-error, #dc2626);
    }
    &.Toggle--tone-checking {
      background: #9aa3b2;
    }
  }

  &--on .Toggle__knob {
    transform: translateX(calc(var(--tg-w) - var(--tg-h)));
  }

  &--disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
}
</style>
