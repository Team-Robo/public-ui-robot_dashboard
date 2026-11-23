import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend is built once and served by the FastAPI backend as static files
// (see dashboard/main.py) - `npm run dev` here is only for local iteration,
// proxying API calls to a dashboard_server already running on 8080.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8080', ws: true },
    },
  },
})
