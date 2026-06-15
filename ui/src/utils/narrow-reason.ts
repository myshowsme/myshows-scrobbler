/**
 * Narrow a thrown Error.message to one of the allowed reason codes. The API
 * wrapper puts the backend's `{ error: <reason> }` code into Error.message,
 * so a runtime check is all we have on the client.
 */
export function narrowReason<R extends string>(
  message: string,
  allowed: readonly R[],
): R | 'unknown' {
  return (allowed as readonly string[]).includes(message) ? (message as R) : 'unknown'
}
