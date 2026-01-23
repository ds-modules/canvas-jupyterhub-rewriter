import { defineConfig } from 'vite';

export default defineConfig({
  // 'base: "./"' ensures assets are linked relatively, 
  // so it works on https://user.github.io/repo/ without hardcoding the repo name.
  base: './',
});