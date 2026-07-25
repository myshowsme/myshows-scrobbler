/** Viewer identity in the shape the hidden `user_filter` matches against. */
export interface FilterableUser {
  id?: string
  title?: string
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
  const title = user.title?.trim().toLowerCase()
  return (!!id && wanted.includes(id)) || (!!title && wanted.includes(title))
}
