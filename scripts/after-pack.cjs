const { execFileSync } = require('node:child_process')
const path = require('node:path')

/**
 * Ad-hoc code-sign the macOS app after packing.
 *
 * The build has no Apple Developer ID, and electron-builder with
 * `mac.identity: null` skips signing entirely — leaving the bundle with
 * Electron's stale signature (resources not sealed, Identifier=Electron).
 * macOS flags such a bundle as **"damaged"** when it's downloaded (quarantined)
 * — and that error offers no "Open Anyway".
 *
 * A proper ad-hoc signature (`codesign -s -`, sealing all resources) turns it
 * into a normal *unidentified developer* app: the user can still open it via
 * right-click → Open or System Settings → Privacy & Security → Open Anyway.
 *
 * Zero-friction distribution (no warning at all) + macOS auto-update still need
 * a paid Developer ID certificate + notarization.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }
  // When a real Developer ID cert is provided (CI), electron-builder signs the
  // bundle itself with the hardened runtime + entitlements and then notarizes.
  // A pre-emptive ad-hoc signature here is pointless (it gets overwritten) and
  // would only muddy the logs, so leave signing to electron-builder.
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    return
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // Sign inside-out is what electron-builder normally does; for a plain ad-hoc
  // pass `--deep` is sufficient to seal the nested helpers/framework.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
}
