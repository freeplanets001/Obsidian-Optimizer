import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Node環境（Electron main processのロジックをテスト）
        environment: 'node',
        // テストファイルのパターン
        include: ['tests/**/*.test.js'],
        // カバレッジ対象
        coverage: {
            provider: 'v8',
            include: ['src/**/*.js'],
            exclude: ['src/config/**'],
        },
    },
});
