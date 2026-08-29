import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import './style.css'
import App from './App.vue'
import { registerFieldServiceWorker } from './offline/pwaRuntime'
import { hydrateRecoveryIdentity } from './offline/recoveryIdentity'

void hydrateRecoveryIdentity()
void registerFieldServiceWorker()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
