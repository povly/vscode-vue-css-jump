/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        lib: {
            entry: 'src/extension.ts',
            formats: ['cjs'],
            fileName: () => 'extension.js',
        },
        outDir: 'dist',
        target: 'node20',
        minify: false,
        sourcemap: false,
        rollupOptions: {
            external: ['vscode'],
        },
    },
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
