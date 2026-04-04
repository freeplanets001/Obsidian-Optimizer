/**
 * src/renderer/main.js — renderer.js 移行エントリポイント
 *
 * 段階移行戦略:
 *   1. 新機能は必ずここに import して追加する
 *   2. renderer.js の既存コードは機能単位で順次こちらに移植する
 *   3. 移植完了した機能は renderer.js から削除する
 *   4. 最終的に renderer.js の全内容をここに取り込み、renderer.js を廃止する
 *
 * ビルド方法:
 *   npm run build:renderer        # 本番
 *   npm run build:renderer:dev    # 開発 (sourcemap 付き)
 *
 * 出力: renderer.dist.js
 * index.html での使用: <script src="renderer.dist.js"></script>
 */

// ---- 移行済みモジュール ----
export * from './modules/ai-cost.js';
export * from './modules/toast.js';
