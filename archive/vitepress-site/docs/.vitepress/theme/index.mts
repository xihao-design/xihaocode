/* .vitepress/theme/index.ts */
import DefaultTheme from 'vitepress/theme'
// VitePress 类型导出可能在不同版本中不可用，这里使用局部类型定义以保证兼容性
type EnhanceAppContext = { app?: any; router?: any }
import MyLayout from './components/MyLayout.vue'
import './style/index.css'
import { watch } from 'vue'

/* .vitepress/theme/index.ts */
// 彩虹背景动画样式
let homePageStyle: HTMLStyleElement | undefined

export default {
  ...DefaultTheme,

  Layout: MyLayout,

  enhanceApp(ctx: EnhanceAppContext) {
    const { app, router } = ctx
    // 彩虹背景动画样式
    if (typeof window !== 'undefined') {
      watch(
        () => router.route.data.relativePath,
        () => updateHomePageStyle(location.pathname === '/'),
        { immediate: true }
      )
    }

  },


}


// 彩虹背景动画样式
function updateHomePageStyle(value: boolean) {
  if (value) {
    if (homePageStyle) return

    homePageStyle = document.createElement('style')
    homePageStyle.innerHTML = `
    :root {
      animation: rainbow 12s linear infinite;
    }`
    document.body.appendChild(homePageStyle)
  } else {
    if (!homePageStyle) return

    homePageStyle.remove()
    homePageStyle = undefined
  }
}

