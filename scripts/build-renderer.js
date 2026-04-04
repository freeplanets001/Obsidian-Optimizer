'use strict';

/**
 * renderer.js ビルドスクリプト
 *
 * 使い方:
 *   npm run build:renderer        # 本番ビルド（minify）
 *   npm run build:renderer:dev    # 開発ビルド（sourcemap）
 *
 * 現在の移行戦略:
 *   src/renderer/main.js をエントリポイントとして esbuild でバンドルし、
 *   renderer.dist.js に出力する。
 *
 *   移行フェーズ:
 *   1. src/renderer/ に新規モジュールを作成 (import/export ESM 形式)
 *   2. src/renderer/main.js でインポート
 *   3. npm run build:renderer で renderer.dist.js を生成
 *   4. index.html のスクリプトタグを renderer.dist.js に切り替え
 *   5. renderer.js の対応箇所を削除
 *
 *   今後は renderer.js への直接追記を避け、必ず src/renderer/ に追加する。
 */

const { build } = require('esbuild');
const path = require('path');

const isDev = process.argv.includes('--dev');
const projectRoot = path.join(__dirname, '..');

build({
    entryPoints: [path.join(projectRoot, 'src/renderer/main.js')],
    bundle: true,
    outfile: path.join(projectRoot, 'renderer.dist.js'),
    platform: 'browser',
    target: ['chrome120'], // Electron 40 は Chromium 128+ を使用
    format: 'iife',        // ブラウザのグローバルスコープに展開（renderer.js と互換）
    globalName: 'RendererModules',
    minify: !isDev,
    sourcemap: isDev ? 'inline' : false,
    logLevel: 'info',
}).then(() => {
    console.log(`✅ renderer.dist.js をビルドしました (${isDev ? 'dev' : 'prod'} モード)`);
}).catch((err) => {
    console.error('❌ ビルドに失敗しました:', err.message);
    process.exit(1);
});
