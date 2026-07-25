/** Viewer identity in the shape the hidden `user_filter` matches against. */
export interface FilterableUser {
  id?: string
  name?: string
}

/**
 * Hidden per-user filter (config-only `user_filter`). Empty = every viewer counts;
 * otherwise a session counts only if its id or display name matches an entry
 * (trimmed, case-insensitive). A session with no identifiable viewer is dropped
 * when a filter is set.
 */
export function matchesUserFilter(user: FilterableUser | undefined, filter: string[]): boolean {
  const wanted = filter.map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0)
  if (wanted.length === 0) {
    return true
  }
  if (!user) {
    return false
  }
  const id = user.id?.trim().toLowerCase()
  const name = user.name?.trim().toLowerCase()
  return (!!id && wanted.includes(id)) || (!!name && wanted.includes(name))
}

/** Label a viewer for logs: `Alice (u1)`, `u1`, or `unknown`. */
function describeUser(user: FilterableUser): string {
  const name = user.name?.trim()
  const id = user.id?.trim()
  if (name && id) {
    return `${name} (${id})`
  }
  return name || id || 'unknown'
}

/**
 * Split sessions into the ones `user_filter` admits, plus a debug line naming the
 * viewers it turned away. That line matters: the filter has no UI and no validation,
 * so a mistyped entry is otherwise indistinguishable from "nobody is watching".
 */
export function applyUserFilter<T>(
  sessions: T[],
  userOf: (session: T) => FilterableUser,
  filter: string[],
): { admitted: T[]; droppedMessage: string | null } {
  const admitted: T[] = []
  const dropped: string[] = []

  for (const session of sessions) {
    const user = userOf(session)
    if (matchesUserFilter(user, filter)) {
      admitted.push(session)
    } else {
      dropped.push(describeUser(user))
    }
  }

  const droppedMessage =
    dropped.length > 0
      ? `user_filter dropped ${dropped.length} session(s): ${dropped.join(', ')}`
      : null

  return { admitted, droppedMessage }
}
