'use strict';

// ======================================================
// IPCレスポンス統一ヘルパー
// 全IPCハンドラは必ずこの関数を使い、{ success, error } の形式を統一する
// ======================================================

/**
 * 成功レスポンスを生成する
 * @param {object} [data] - 任意のペイロード
 * @returns {{ success: true } & object}
 */
function ok(data = {}) {
    return { success: true, ...data };
}

/**
 * エラーレスポンスを生成する（コンソールにもログを出す）
 * @param {unknown} err - Error オブジェクトまたはメッセージ文字列
 * @param {string} [context] - どのハンドラで発生したかの説明（デバッグ用）
 * @returns {{ success: false, error: string }}
 */
function fail(err, context = '') {
    // execFileAsync のエラーは err.stderr / err.stdout に詳細が入る
    let message;
    if (err instanceof Error) {
        const parts = [err.stderr, err.stdout, err.message].filter(s => s && String(s).trim());
        message = parts.join('\n').trim() || err.message;
    } else {
        message = String(err);
    }
    if (context) {
        console.error(`[IPC:${context}]`, err);
    } else {
        console.error('[IPC]', err);
    }
    return { success: false, error: message };
}

/**
 * 非同期ハンドラをtry/catchでラップするユーティリティ
 * 使用例:
 *   ipcMain.handle('my-channel', withErrorHandling('my-channel', async (_, arg) => {
 *       // ここでエラーが起きても自動的に { success: false, error } を返す
 *       return ok({ result: await doSomething(arg) });
 *   }));
 *
 * @param {string} channel - IPCチャンネル名（ログ用）
 * @param {Function} handler - async (event, ...args) => any
 * @returns {Function}
 */
function withErrorHandling(channel, handler) {
    return async (event, ...args) => {
        try {
            return await handler(event, ...args);
        } catch (err) {
            return fail(err, channel);
        }
    };
}

module.exports = { ok, fail, withErrorHandling };
