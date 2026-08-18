import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      // 前端 /api/* 转发到本地后端(3001)，省去跨域配置
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
