/// <reference types="vite-plus/client" />

/** App version injected at build time from the root package.json (ui/vite.config.ts). */
declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
