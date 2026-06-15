export function isAsciiToken(token: string): boolean {
  for (let index = 0; index < token.length; index += 1) {
    if (token.charCodeAt(index) > 0x7f) {
      return false
    }
  }

  return true
}
