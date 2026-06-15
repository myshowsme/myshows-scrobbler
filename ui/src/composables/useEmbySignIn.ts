import { ref, type Ref } from 'vue'
import { signInToEmby as fetchEmbySignIn, type EmbySignInErrorReason } from '../api'
import type { SourceConfig, SourceType } from '../types'
import { narrowReason } from '../utils/narrow-reason'

/** UI state for the Emby username/password sign-in inline form. */
export interface EmbySignInState {
  status: 'idle' | 'form' | 'signing-in' | 'failed'
  /** Failure reason / i18n key tail while `status === 'failed'`. */
  reason?: EmbySignInErrorReason | 'no-url'
}

const EMBY_SIGN_IN_FAILURE_REASONS = ['unreachable', 'invalid-credentials'] as const

export interface EmbySignInDeps {
  sources: Ref<SourceConfig[]>
  patchSource: (
    type: SourceType,
    patch: Partial<Pick<SourceConfig, 'enabled' | 'url' | 'token'>>,
    debounce?: boolean,
  ) => void
}

/**
 * Inline username/password sign-in for Emby. Form input lives in SourceRow's
 * local state; only the flow status is shared so AppShell can react. POSTs
 * to /api/emby/sign-in and patches the source token on success.
 */
export function useEmbySignIn({ sources, patchSource }: EmbySignInDeps) {
  const embySignIn = ref<Partial<Record<SourceType, EmbySignInState>>>({})

  function openEmbySignInForm(type: SourceType): void {
    embySignIn.value = { ...embySignIn.value, [type]: { status: 'form' } }
  }

  function closeEmbySignInForm(type: SourceType): void {
    embySignIn.value = { ...embySignIn.value, [type]: { status: 'idle' } }
  }

  async function submitEmbySignIn(
    type: SourceType,
    username: string,
    password: string,
  ): Promise<boolean> {
    const current = sources.value.find((s) => s.type === type)
    const url = current?.url.trim() ?? ''
    if (!url) {
      embySignIn.value = { ...embySignIn.value, [type]: { status: 'failed', reason: 'no-url' } }
      return false
    }
    embySignIn.value = { ...embySignIn.value, [type]: { status: 'signing-in' } }
    try {
      const result = await fetchEmbySignIn(url, username, password)
      patchSource(type, { token: result.accessToken })
      embySignIn.value = { ...embySignIn.value, [type]: { status: 'idle' } }
      return true
    } catch (e) {
      const reason = narrowReason(e instanceof Error ? e.message : '', EMBY_SIGN_IN_FAILURE_REASONS)
      embySignIn.value = { ...embySignIn.value, [type]: { status: 'failed', reason } }
      return false
    }
  }

  return {
    embySignIn,
    openEmbySignInForm,
    closeEmbySignInForm,
    submitEmbySignIn,
  }
}
