<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusDot, { type DotState } from './StatusDot.vue'

export type TokenState = 'empty' | 'invalid' | 'valid' | 'checking'

const props = defineProps<{
  connected?: boolean
  state: TokenState
  masked?: string
}>()

const emit = defineEmits<{
  edit: [value: string]
}>()

const { t } = useI18n()

const editing = ref(false)
const inputRef = useTemplateRef<HTMLInputElement>('input')
const inputValue = ref(props.masked ?? '')

const dotState = computed<DotState>(() => {
  switch (props.state) {
    case 'valid':
      return 'ok'
    case 'invalid':
      return 'error'
    case 'checking':
      return 'checking'
    default:
      return 'unknown'
  }
})

const dotPulse = computed(() => props.state === 'checking')

watch(
  () => props.masked,
  (masked) => {
    if (!editing.value) {
      inputValue.value = masked ?? ''
    }
  },
)

function shouldShowInput(): boolean {
  return props.state !== 'valid' || editing.value
}

async function startEditing() {
  editing.value = true
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}

function onBlur() {
  if (props.state === 'valid' && inputValue.value === (props.masked ?? '')) {
    editing.value = false
  }
}

function onInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  inputValue.value = value
  emit('edit', value)
}
</script>

<template>
  <div
    class="TokenWidget"
    :class="[`TokenWidget--${state}`, { 'TokenWidget--connected': connected }]"
  >
    <button v-if="!shouldShowInput()" type="button" class="TokenWidget__pill" @click="startEditing">
      <StatusDot :state="dotState" :pulse="dotPulse" :size="9" />
      <span class="TokenWidget__text">
        {{ t('header.status.connected') }}
      </span>
    </button>

    <div v-else class="TokenWidget__field">
      <StatusDot :state="dotState" :pulse="dotPulse" :size="9" />
      <input
        ref="input"
        type="password"
        class="TokenWidget__input"
        :placeholder="t('header.token.placeholder')"
        :value="inputValue"
        autocomplete="off"
        spellcheck="false"
        @input="onInput"
        @blur="onBlur"
      />
    </div>
  </div>
</template>

<style lang="scss">
.TokenWidget {
  --tw-h: 32px;
  display: inline-flex;
  align-items: center;
  height: var(--tw-h);

  &__pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: var(--tw-h);
    padding: 6px 12px;
    border-radius: 999px;
    border: none;
    background: rgba(255, 255, 255, 0.06);
    color: #fff;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.12s;

    &:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    &:focus-visible {
      outline: 2px solid #e63946;
      outline-offset: 2px;
    }
  }

  &__field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: var(--tw-h);
    padding: 0 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid transparent;
    transition:
      border-color 0.12s,
      background-color 0.12s;

    &:focus-within {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.2);
    }
  }

  &--invalid .TokenWidget__field {
    border-color: rgba(220, 38, 38, 0.6);
  }
  &--checking .TokenWidget__field {
    border-color: rgba(154, 163, 178, 0.4);
  }

  &__input {
    background: transparent;
    border: none;
    outline: none;
    color: #fff;
    font: inherit;
    font-size: 13px;
    width: 200px;
    letter-spacing: 0.04em;

    &::placeholder {
      color: rgba(255, 255, 255, 0.45);
    }
  }
}
</style>
