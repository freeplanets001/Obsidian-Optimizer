'use strict';

// ======================================================
// Markdownユーティリティ（純粋関数 — 外部依存なし）
// テスト可能なロジックをここに集約する
// ======================================================

/**
 * frontmatter（---で囲まれた部分）をパースする
 * @param {string} content - Markdownファイル全文
 * @returns {{ exists: boolean, fields: Record<string,string>, raw: string, bodyStart: number }}
 */
function parseFrontmatter(content) {
    const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
    const match = content.match(FM_REGEX);
    if (!match) return { exists: false, fields: {}, raw: '', bodyStart: 0 };
    const raw = match[1];
    const fields = {};
    for (const line of raw.split(/\r?\n/)) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)/);
        if (kv) fields[kv[1]] = kv[2].trim();
    }
    return { exists: true, fields, raw, bodyStart: match[0].length };
}

/**
 * レーベンシュタイン距離を計算する
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b[i - 1] === a[j - 1]
                ? matrix[i - 1][j - 1]
                : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
        }
    }
    return matrix[b.length][a.length];
}

/**
 * LLMレスポンスからJSONを安全に抽出する
 * @param {string} text
 * @returns {unknown|null}
 */
function extractJsonFromLLM(text) {
    if (!text) return null;

    // markdownコードブロック（閉じタグなしにも対応）
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
    if (codeBlock) {
        const inner = codeBlock[1].trim();
        if (inner.startsWith('[') || inner.startsWith('{')) {
            try { return JSON.parse(inner); } catch (_) {}
        }
    }

    // テキスト中の JSON 配列
    const arrMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrMatch) {
        try { return JSON.parse(arrMatch[0]); } catch (_) {
            let fixed = arrMatch[0];
            const lastComplete = fixed.lastIndexOf('}');
            if (lastComplete > 0) {
                fixed = fixed.slice(0, lastComplete + 1) + ']';
                try { return JSON.parse(fixed); } catch (_2) {}
            }
        }
    }

    const simpleArr = text.match(/\[[\s\S]*\]/);
    if (simpleArr) { try { return JSON.parse(simpleArr[0]); } catch (_) {} }

    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) { try { return JSON.parse(objMatch[0]); } catch (_) {} }

    return null;
}

module.exports = { parseFrontmatter, levenshtein, extractJsonFromLLM };
