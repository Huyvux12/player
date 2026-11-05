// The SDK as a library: ES modules, one file per entry (the core, and the optional tracking / voice / body / png / vrm),
// shared code in chunks. The runtime is the site's own (../src/runtime): one source, built here, never copied. three
// and three-vrm are the page's (optional peer dependencies), imported by vrm.js only.
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    lib: {
      entry: { index: 'src/index.ts', tracking: 'src/tracking.ts', voice: 'src/voice.ts', body: 'src/body.ts', png: 'src/png.ts', vrm: 'src/vrm.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@mediapipe/tasks-vision', 'three', /^three\//, '@pixiv/three-vrm'],
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
})
