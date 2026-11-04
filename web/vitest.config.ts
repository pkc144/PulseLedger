import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so tests load no React/Tailwind plugins: they cover pure modules.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
