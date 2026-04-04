'use strict';

const path = require('path');
const fs = require('fs');

// ======================================================
// ゴミファイル判定ロジック（純粋ロジック部分を分離）
// ======================================================

const DEFAULT_JUNK_RULES = {
    minChars: 20,
    minBytes: 5,
    keywords: ['untitled', '無題'],
};

/**
 * ファイルがゴミ（空・無題・コンテンツなし）かを判定する
 * @param {string} filePath - 絶対パス
 * @param {string} content - ファイル全文
 * @param {object} [junkRules] - ルール（省略時はデフォルト）
 * @returns {{ junk: boolean, reason?: string }}
 */
function isJunkFile(filePath, content, junkRules) {
    const rules = { ...DEFAULT_JUNK_RULES, ...(junkRules || {}) };
    const { minBytes, minChars, keywords } = rules;

    let size;
    try { size = fs.statSync(filePath).size; }
    catch (_) { return { junk: false }; }

    if (size < minBytes) return { junk: true, reason: '空ファイル' };

    const lowerName = path.basename(filePath).toLowerCase();
    for (const kw of keywords) {
        if (lowerName.includes(kw.toLowerCase())) return { junk: true, reason: `無題 (${kw})` };
    }

    // フロントマターと HTML コメントを除いた本文長チェック
    const clean = content
        .replace(/^\s*---\n[\s\S]*?\n---/, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    if (clean.length < minChars) return { junk: true, reason: 'コンテンツなし' };

    return { junk: false };
}

/**
 * isJunkFile のテスト用（fs.statSync をモック可能な形に分離した版）
 * @param {string} fileName - ファイル名のみ（パス不要）
 * @param {number} fileSize - バイトサイズ
 * @param {string} content - 本文
 * @param {object} [junkRules]
 * @returns {{ junk: boolean, reason?: string }}
 */
function isJunkContent(fileName, fileSize, content, junkRules) {
    const rules = { ...DEFAULT_JUNK_RULES, ...(junkRules || {}) };
    const { minBytes, minChars, keywords } = rules;

    if (fileSize < minBytes) return { junk: true, reason: '空ファイル' };

    const lowerName = fileName.toLowerCase();
    for (const kw of keywords) {
        if (lowerName.includes(kw.toLowerCase())) return { junk: true, reason: `無題 (${kw})` };
    }

    const clean = content
        .replace(/^\s*---\n[\s\S]*?\n---/, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
    if (clean.length < minChars) return { junk: true, reason: 'コンテンツなし' };

    return { junk: false };
}

module.exports = { isJunkFile, isJunkContent, DEFAULT_JUNK_RULES };
