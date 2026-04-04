'use strict';

// ======================================================
// AIモデル・コスト定義
// 新モデル追加時はこのファイルだけ変更すればよい
// ======================================================

/** プロバイダーごとの利用可能モデル一覧 */
const AI_MODELS = {
    claude: [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
    ],
    openai: [
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.4-nano',
        'gpt-4o',
    ],
    gemini: [
        'gemini-2.5-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
    ],
};

/**
 * コスト計算レート (USD per 1M tokens: [input, output])
 * 出典: 各プロバイダー公式料金ページ（2025年時点）
 */
const AI_COST_RATES = {
    'claude-opus-4-6':           [15,   75  ],
    'claude-sonnet-4-6':         [3,    15  ],
    'claude-haiku-4-5-20251001': [0.80, 4   ],
    'gpt-5.4':                   [2.50, 10  ],
    'gpt-5.4-mini':              [0.40, 1.60],
    'gpt-5.4-nano':              [0.10, 0.40],
    'gpt-4o':                    [2.50, 10  ],
    'gemini-2.5-flash':          [0.15, 0.60],
    'gemini-2.5-pro':            [1.25, 10  ],
    'gemini-2.0-flash':          [0.10, 0.40],
};

/** プロバイダーのデフォルトモデルを返す */
function getDefaultModel(provider) {
    const models = AI_MODELS[provider];
    if (!models || models.length === 0) return '';
    return models[0];
}

/** モデル名からコストレートを返す（未登録はSonnetレートをフォールバック） */
function getCostRate(model) {
    return AI_COST_RATES[model] ?? AI_COST_RATES['claude-sonnet-4-6'];
}

/** 指定プロバイダーにモデルが存在するか確認 */
function isValidModel(provider, model) {
    return Array.isArray(AI_MODELS[provider]) && AI_MODELS[provider].includes(model);
}

module.exports = { AI_MODELS, AI_COST_RATES, getDefaultModel, getCostRate, isValidModel };
