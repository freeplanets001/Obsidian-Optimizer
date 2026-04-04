'use strict';

const { ok, fail, withErrorHandling } = require('../utils/ipc-response');
const { AI_MODELS } = require('../config/ai-models');

// ======================================================
// AI設定・使用量管理ハンドラ
// 依存: config, saveConfig, callLLM (コンテキスト経由で注入)
// ======================================================

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{ getConfig: () => object, saveConfig: (c: object) => void, callLLM: Function }} ctx
 */
function register(ipcMain, ctx) {
    const { getConfig, saveConfig, callLLM } = ctx;

    // AIモデル一覧をrenderer側に返す（唯一の真実ソース）
    ipcMain.handle('get-ai-models', () => {
        const { AI_COST_RATES } = require('../config/ai-models');
        return { models: AI_MODELS, rates: AI_COST_RATES };
    });

    // AI設定の保存
    ipcMain.handle('save-ai-config', withErrorHandling('save-ai-config', (_, { provider, apiKey, model }) => {
        const config = getConfig();
        if (provider) config.aiProvider = provider;
        // APIキーが空文字の場合は既存値を維持（ユーザーが変更しなかった場合）
        if (apiKey && apiKey.trim().length > 0) config.aiApiKey = apiKey;
        if (model) config.aiModel = model;
        saveConfig(config);
        return ok();
    }));

    // AI接続テスト
    ipcMain.handle('test-ai-connection', withErrorHandling('test-ai-connection', async () => {
        const result = await callLLM('「接続成功」と返してください。他の言葉は不要です。', '', '接続テスト');
        return ok({ message: result.trim() });
    }));

    // AI使用量の取得
    ipcMain.handle('get-ai-usage', withErrorHandling('get-ai-usage', () => {
        const config = getConfig();
        const usage = config.aiUsage || {
            totalCalls: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalEstimatedCost: 0,
            history: [],
        };
        return ok({ usage });
    }));

    // AI使用量のリセット
    ipcMain.handle('reset-ai-usage', withErrorHandling('reset-ai-usage', () => {
        const config = getConfig();
        config.aiUsage = {
            totalCalls: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalEstimatedCost: 0,
            history: [],
        };
        saveConfig(config);
        return ok();
    }));
}

module.exports = { register };
