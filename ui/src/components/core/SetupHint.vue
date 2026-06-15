<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  tokenDone: boolean
  sourceDone: boolean
  playbackDone: boolean
}>()

const { t } = useI18n()

const MYSHOWS_TOKEN_URL = 'https://myshows.me/profile/watch-history/'
</script>

<template>
  <section class="SetupHint" role="status">
    <h2 class="SetupHint__title">{{ t('hero.setup.title') }}</h2>
    <ol class="SetupHint__steps">
      <li class="SetupHint__step" :class="{ 'SetupHint__step--done': tokenDone }">
        <span class="SetupHint__check" aria-hidden="true">{{ tokenDone ? '✓' : '1' }}</span>
        <div class="SetupHint__step-body">
          <span class="SetupHint__step-title">{{ t('hero.setup.steps.token.title') }}</span>
          <a
            v-if="!tokenDone"
            class="SetupHint__step-link"
            :href="MYSHOWS_TOKEN_URL"
            target="_blank"
            rel="noopener"
          >
            {{ t('hero.setup.steps.token.where') }}
          </a>
        </div>
      </li>
      <li class="SetupHint__step" :class="{ 'SetupHint__step--done': sourceDone }">
        <span class="SetupHint__check" aria-hidden="true">{{ sourceDone ? '✓' : '2' }}</span>
        <div class="SetupHint__step-body">
          <span class="SetupHint__step-title">{{ t('hero.setup.steps.source.title') }}</span>
          <span v-if="!sourceDone" class="SetupHint__step-hint">
            {{ t('hero.setup.steps.source.hint') }}
          </span>
        </div>
      </li>
      <li class="SetupHint__step" :class="{ 'SetupHint__step--done': playbackDone }">
        <span class="SetupHint__check" aria-hidden="true">{{ playbackDone ? '✓' : '3' }}</span>
        <div class="SetupHint__step-body">
          <span class="SetupHint__step-title">{{ t('hero.setup.steps.playback.title') }}</span>
        </div>
      </li>
    </ol>
  </section>
</template>

<style lang="scss">
.SetupHint {
  background: var(--v2-bg-warn);
  border: 1px solid #f1d57a;
  border-left: 4px solid var(--v2-warning);
  border-radius: var(--v2-radius-md);
  padding: var(--v2-space-lg) var(--v2-space-xl);

  &__title {
    margin: 0 0 var(--v2-space-md) 0;
    font-size: 17px;
    font-weight: 700;
    color: var(--v2-text);
    letter-spacing: -0.01em;
  }

  &__steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__step {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 12px;
    align-items: center;
    transition: opacity 0.18s;

    &--done {
      opacity: 0.55;
    }
  }

  &__check {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #fff;
    border: 1.5px solid var(--v2-warning);
    color: var(--v2-warning);
    font-weight: 700;
    font-size: 12px;
    line-height: 19px;
    text-align: center;
    flex-shrink: 0;
    transition:
      background-color 0.18s,
      border-color 0.18s,
      color 0.18s;

    .SetupHint__step--done & {
      background: var(--v2-success);
      border-color: var(--v2-success);
      color: #fff;
      font-size: 13px;
    }
  }

  &__step-body {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }

  &__step-title {
    color: var(--v2-text);
    font-size: 14px;
    font-weight: 500;

    .SetupHint__step--done & {
      text-decoration: line-through;
    }
  }

  &__step-link {
    color: var(--v2-link, var(--v2-warning));
    font-size: 12px;
    text-decoration: underline;

    &:hover {
      text-decoration: none;
    }
  }

  &__step-hint {
    color: var(--v2-text-muted);
    font-size: 12px;
    font-style: italic;
  }
}
</style>
