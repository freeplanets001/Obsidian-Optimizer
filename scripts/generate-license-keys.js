#!/usr/bin/env node
/**
 * Obsidian Optimizer ライセンスキー生成ツール
 *
 * 使い方:
 *   node scripts/generate-license-keys.js          → 1個生成
 *   node scripts/generate-license-keys.js 10       → 10個生成
 *   node scripts/generate-license-keys.js 50 csv   → 50個生成してCSV出力
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET = 'ObsidianOptimizer2026CraftLab';

function generateLicenseKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let prefix = 'OPT';
    for (let i = 0; i < 3; i++) {
        prefix += '-';
        for (let j = 0; j < 4; j++) {
            prefix += chars[crypto.randomInt(chars.length)];
        }
    }
    const hash = crypto.createHmac('sha256', SECRET)
        .update(prefix)
        .digest('hex')
        .slice(0, 4)
        .toUpperCase();
    return prefix + '-' + hash;
}

// 引数解析
const count = parseInt(process.argv[2]) || 1;
const format = process.argv[3] || 'text';

const keys = [];
for (let i = 0; i < count; i++) {
    keys.push(generateLicenseKey());
}

if (format === 'csv') {
    // CSV出力
    const dateStr = new Date().toISOString().split('T')[0];
    const csvPath = path.join(__dirname, `license-keys-${dateStr}.csv`);
    const csvContent = 'No,ライセンスキー,発行日,状態\n'
        + keys.map((k, i) => `${i + 1},${k},${dateStr},未使用`).join('\n');
    fs.writeFileSync(csvPath, csvContent, 'utf-8');
    console.log(`✅ ${count}個のライセンスキーを生成しました`);
    console.log(`📄 CSVファイル: ${csvPath}`);
} else {
    // テキスト出力
    console.log(`\n🔑 Obsidian Optimizer ライセンスキー（${count}個）\n`);
    console.log('─'.repeat(30));
    keys.forEach((k, i) => {
        console.log(`  ${String(i + 1).padStart(3)}. ${k}`);
    });
    console.log('─'.repeat(30));
    console.log(`\n📋 noteの購入者に1つずつ配布してください`);
}
