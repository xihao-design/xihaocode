// This file provides a stable place for the language service to write or read global types.
// It's referenced by "vueCompilerOptions.globalTypesPath" in tsconfig.json.

declare module '*.vue' {
  import { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
