import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:3000', '/media': 'http://localhost:3000', '/mcp': 'http://localhost:3000', '/.well-known': 'http://localhost:3000', '/oauth/register': 'http://localhost:3000', '/oauth/token': 'http://localhost:3000' },
  },
})
