import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
    root: path.resolve(import.meta.dirname, 'src/runners/web/src'),

    plugins: [react()],

    build: {
        outDir: path.resolve(import.meta.dirname, 'src/runners/web/dist'),
        emptyOutDir: true,
        sourcemap: true,
        minify: false
    },
})