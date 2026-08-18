import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'katex/dist/katex.min.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import { createPinia } from 'pinia'
import router from './router'
import './style.css'
import App from './App.vue'
import { registerFieldServiceWorker } from './offline/pwaRuntime'
import { hydrateRecoveryIdentity } from './offline/recoveryIdentity'

void hydrateRecoveryIdentity()
void registerFieldServiceWorker()

const app = createApp(App)
for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, comp as any)
}
app.use(createPinia())
app.use(ElementPlus)
app.use(router)
app.mount('#app')
