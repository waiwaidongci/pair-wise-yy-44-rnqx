import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './App.vue'
import router from './router'
import './styles.css'

async function bootstrap() {
  if (import.meta.env.DEV) {
    const { worker } = await import('./api/browser')
    await worker.start({ onUnhandledRequest: 'bypass' })
  }

  createApp(App)
    .use(createPinia())
    .use(router)
    .use(VueQueryPlugin)
    .use(ElementPlus)
    .mount('#app')
}

bootstrap()
