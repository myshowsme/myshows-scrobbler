<script setup lang="ts">
export type DotState = 'ok' | 'error' | 'checking' | 'unknown' | 'disabled'

withDefaults(
  defineProps<{
    state?: DotState
    pulse?: boolean
    size?: number
    label?: string
  }>(),
  {
    state: 'unknown',
    pulse: false,
    size: 8,
  },
)
</script>

<template>
  <span
    class="StatusDot"
    :class="[
      `StatusDot--${state}`,
      { 'StatusDot--pulse': pulse && (state === 'ok' || state === 'checking') },
    ]"
    :style="{ '--dot-size': `${size}px` }"
    :aria-label="label"
    role="status"
  />
</template>

<style lang="scss">
.StatusDot {
  --dot-size: 8px;
  display: inline-block;
  width: var(--dot-size);
  height: var(--dot-size);
  border-radius: 50%;
  position: relative;
  flex-shrink: 0;

  &--ok {
    background: #16a34a;
  }
  &--checking {
    background: #9aa3b2;
  }
  &--error {
    background: #dc2626;
  }
  &--unknown {
    background: #6b6b80;
  }
  &--disabled {
    background: #6b6b80;
    opacity: 0.5;
  }

  &--pulse::before {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0;
    animation: status-dot-pulse 2s ease-out infinite;
  }

  &--ok.StatusDot--pulse::before {
    background: #16a34a;
  }
  &--checking.StatusDot--pulse::before {
    background: #9aa3b2;
  }
}

@keyframes status-dot-pulse {
  0% {
    opacity: 0.4;
    transform: scale(1);
  }
  100% {
    opacity: 0;
    transform: scale(2.4);
  }
}
</style>
