import { defineConfig } from 'vite';

export default defineConfig({
  // 상대경로로 빌드해야 Pages 하위경로나 웹뷰에서 그대로 열립니다.
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
});
