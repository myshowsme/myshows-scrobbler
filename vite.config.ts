import { defineConfig } from 'vite-plus'

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: [
    {
      entry: 'src/index.ts',
      outDir: 'dist/server',
      format: 'esm',
    },
    // Electron main process. Bundle every JS dependency into electron.mjs so
    // the packaged app never has to resolve them from node_modules at runtime —
    // electron-builder's pnpm dependency walk is incomplete and silently drops
    // transitive deps (e.g. fast-json-stringify → json-schema-ref-resolver).
    //
    // Three things must stay external instead:
    //   • electron — provided by the Electron runtime; bundling its npm shim
    //     would replace the real API (app/BrowserWindow/…) with a path string.
    //   • koffi, @ffprobe-installer/ffprobe — native: they load platform
    //     binaries (.node / ffprobe) that can't be inlined. electron-builder
    //     ships them in node_modules and unpacks them from the asar
    //     (see build.files + build.asarUnpack in package.json).
    {
      entry: 'src/electron.ts',
      outDir: 'dist/electron',
      format: 'esm',
      deps: {
        alwaysBundle: [/.*/],
        neverBundle: ['electron', 'koffi', '@ffprobe-installer/ffprobe'],
        onlyBundle: false,
      },
    },
  ],
  fmt: {
    ignorePatterns: ['pnpm-lock.yaml'],
    singleQuote: true,
    semi: false,
    quoteProps: 'consistent',
  },
})
