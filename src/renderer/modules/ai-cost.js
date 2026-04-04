/**
 * AIコスト表示モジュール
 * renderer.js の Feature 15 から移植
 *
 * 依存:
 *   - window.api.getAiUsage() (preload.js経由)
 *   - esc() / $() (renderer.js のグローバル関数)
 *   - AI_PRICING_PER_1M (renderer.js のグローバル変数)
 *
 * TODO: 移行完了後、renderer.js の Feature 15 セクションを削除する
 */

export const AI_COST_STORAGE_KEY = 'obsidian-optimizer-ai-cost-history';
export const JPY_RATE = 150;

/**
 * AIコスト履歴をlocalStorageから取得する
 * @returns {Array}
 */
export function getAiCostHistory() {
    try {
        const raw = localStorage.getItem(AI_COST_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

/**
 * コストエントリを保存する
 * @param {string} feature
 * @param {string} model
 * @param {number} inputTokensEstimate
 * @param {number} outputTokensEstimate
 * @param {Record<string, {input: number, output: number}>} pricingTable
 */
export function saveAiCostEntry(feature, model, inputTokensEstimate, outputTokensEstimate, pricingTable) {
    const history = getAiCostHistory();
    const pricing = (pricingTable && pricingTable[model]) || { input: 1, output: 5 };
    const costUsd = (inputTokensEstimate / 1_000_000 * pricing.input) + (outputTokensEstimate / 1_000_000 * pricing.output);
    const costJpy = Math.round(costUsd * JPY_RATE * 100) / 100;

    history.push({
        date: new Date().toISOString(),
        feature,
        model,
        inputTokens: inputTokensEstimate,
        outputTokens: outputTokensEstimate,
        costUsd: Math.round(costUsd * 10000) / 10000,
        costJpy,
    });

    if (history.length > 1000) history.splice(0, history.length - 1000);
    localStorage.setItem(AI_COST_STORAGE_KEY, JSON.stringify(history));
}

/**
 * AIコスト表示を描画する
 * @param {Record<string, {input: number, output: number}>} pricingTable - AI_PRICING_PER_1M
 */
export async function renderAiCostDisplay(pricingTable) {
    // DOM ヘルパーはグローバル参照（renderer.js との共存期間中）
    const $ = id => document.getElementById(id);
    const esc = str => str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') : '';

    const container = $('ai-cost-display');
    if (!container) return;

    let usage;
    try {
        const res = await window.api.getAiUsage();
        if (!res.success || !res.usage) {
            container.innerHTML = '<p class="muted-hint">AI利用データを取得できませんでした</p>';
            return;
        }
        usage = res.usage;
    } catch (e) {
        container.innerHTML = `<p class="muted-hint">エラー: ${esc(e.message)}</p>`;
        return;
    }

    const history = usage.history || [];
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthEntries = history.filter(h => h.date?.startsWith(thisMonth));
    const totalCalls = monthEntries.length;
    const totalCostJpy = monthEntries.reduce((sum, h) => sum + ((h.cost || 0) * JPY_RATE), 0);

    const featureCosts = {};
    monthEntries.forEach(h => {
        const key = h.feature || '不明';
        featureCosts[key] = (featureCosts[key] || 0) + ((h.cost || 0) * JPY_RATE);
    });

    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">';
    html += `<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center"><div style="font-size:1.2rem;font-weight:700">${totalCalls}</div><div style="font-size:.72rem;opacity:.5">今月のAPI呼び出し</div></div>`;
    html += `<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center"><div style="font-size:1.2rem;font-weight:700">¥${Math.round(totalCostJpy)}</div><div style="font-size:.72rem;opacity:.5">今月の推定コスト</div></div>`;
    html += '</div>';

    if (Object.keys(featureCosts).length > 0) {
        html += '<div style="margin-bottom:12px"><strong style="font-size:.82rem">機能別コスト内訳</strong>';
        const sorted = Object.entries(featureCosts).sort((a, b) => b[1] - a[1]);
        const maxCost = sorted[0]?.[1] || 1;
        sorted.forEach(([name, cost]) => {
            const pct = Math.round(cost / maxCost * 100);
            html += `<div style="display:flex;align-items:center;gap:8px;margin-top:6px"><span style="font-size:.78rem;min-width:100px">${esc(name)}</span><div style="flex:1;height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent);border-radius:4px"></div></div><span style="font-size:.72rem;opacity:.6">¥${Math.round(cost)}</span></div>`;
        });
        html += '</div>';
    }

    const last10 = history.slice(-10).reverse();
    if (last10.length > 0) {
        html += '<div style="margin-bottom:12px"><strong style="font-size:.82rem">直近のAPI呼び出し</strong><div style="margin-top:6px;max-height:200px;overflow:auto">';
        last10.forEach(h => {
            const d = new Date(h.date);
            const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
            html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.75rem;border-bottom:1px solid rgba(255,255,255,.04)"><span style="opacity:.5;min-width:70px">${dateStr}</span><span style="flex:1">${esc(h.feature)}</span><span style="opacity:.5">${esc(h.model || '')}</span><span style="min-width:50px;text-align:right">¥${((h.cost || 0) * JPY_RATE).toFixed(2)}</span></div>`;
        });
        html += '</div></div>';
    }

    if (pricingTable) {
        html += '<details style="margin-top:8px"><summary style="font-size:.78rem;cursor:pointer;opacity:.6">💰 プロバイダー料金一覧（1Mトークンあたり）</summary><div style="margin-top:8px;overflow-x:auto"><table style="width:100%;font-size:.72rem;border-collapse:collapse"><tr style="border-bottom:1px solid rgba(255,255,255,.1)"><th style="text-align:left;padding:4px">モデル</th><th style="text-align:right;padding:4px">入力($)</th><th style="text-align:right;padding:4px">出力($)</th><th style="text-align:right;padding:4px">入力(¥)</th><th style="text-align:right;padding:4px">出力(¥)</th></tr>';
        Object.entries(pricingTable).forEach(([model, rate]) => {
            html += `<tr style="border-bottom:1px solid rgba(255,255,255,.04)"><td style="padding:3px 4px">${esc(model)}</td><td style="text-align:right;padding:3px 4px">$${rate.input}</td><td style="text-align:right;padding:3px 4px">$${rate.output}</td><td style="text-align:right;padding:3px 4px">¥${Math.round(rate.input * JPY_RATE)}</td><td style="text-align:right;padding:3px 4px">¥${Math.round(rate.output * JPY_RATE)}</td></tr>`;
        });
        html += '</table></div></details>';
    }

    container.innerHTML = html;
}
