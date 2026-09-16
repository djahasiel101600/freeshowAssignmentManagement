import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Receiver server (server/app.py) - variables sync + command queue
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log('receiver proxy error', err);
          });
        }
      },
      // Semaphore API
      '/semaphore': {
        target: 'https://api.semaphore.co/api/v4',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/semaphore/, ''),
      },
      // N8N Webhook - Fixed the rewrite path
      '/webhook': {
        target: 'https://n8n.jdp-homelab.space',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/webhook/, '/webhook/a94af661-17a6-43a7-8540-21f510d19946'),
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log('N8N proxy error:', err);
          });
          proxy.on('proxyReq', (proxyReq) => {
            console.log('N8N Request:', proxyReq.method, proxyReq.path);
          });
          proxy.on('proxyRes', (proxyRes) => {
            console.log('N8N Response:', proxyRes.statusCode, proxyRes.url);
          });
        }
      },
    },
  }
})