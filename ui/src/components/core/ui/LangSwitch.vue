<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { setLocale, type Locale } from '../../../i18n'

const { locale, t } = useI18n()

const options: Locale[] = ['ru', 'en']

function pick(next: Locale) {
  if (locale.value === next) {
    return
  }
  setLocale(next)
}
</script>

<template>
  <div class="LangSwitch" role="group" :aria-label="t('header.lang.aria')">
    <button
      v-for="opt in options"
      :key="opt"
      type="button"
      class="LangSwitch__btn"
      :class="{ 'LangSwitch__btn--active': locale === opt }"
      :aria-pressed="locale === opt"
      @click="pick(opt)"
    >
      {{ t(`header.lang.${opt}`) }}
    </button>
  </div>
</template>

<style lang="scss">
.LangSwitch {
  display: inline-flex;
  gap: 2px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  padding: 3px;

  &__btn {
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.7);
    background: transparent;
    border: none;
    padding: 5px 12px;
    cursor: pointer;
    border-radius: 999px;
    transition:
      background-color 0.12s,
      color 0.12s;
    line-height: 1;

    &:hover:not(.LangSwitch__btn--active) {
      color: #fff;
    }

    &--active {
      background: #e63946;
      color: #fff;
    }

    &:focus-visible {
      outline: 2px solid #e63946;
      outline-offset: 2px;
    }
  }
}
</style>
