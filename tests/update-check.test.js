import { describe, it, expect } from 'vitest';

// ======================================================
// バージョン比較・更新チェックロジックのテスト
// main.js の compareVersions をインライン定義
// ======================================================

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

// renderer.js の renderReleaseNotes をインライン定義（簡易版テスト）
function renderReleaseNotes(md) {
    if (!md) return '';
    const lines = md.split('\n');
    let html = '';
    let inList = false;
    for (const raw of lines) {
        const line = raw.trimEnd();
        if (/^\|/.test(line) || /^[\s|:-]+$/.test(line)) continue; // テーブル行スキップ
        if (/^## /.test(line)) {
            if (inList) { html += '</ul>'; inList = false; }
            html += `<p>${line.slice(3)}</p>`;
            continue;
        }
        if (/^(\s*[-*] )/.test(line)) {
            if (!inList) { html += '<ul>'; inList = true; }
            const text = line.replace(/^\s*[-*] /, '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            html += `<li>${text}</li>`;
            continue;
        }
        if (line === '') { if (inList) { html += '</ul>'; inList = false; } continue; }
        if (inList) { html += '</ul>'; inList = false; }
        html += `<p>${line}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
}

// ======================================================
// compareVersions テスト
// ======================================================
describe('compareVersions', () => {
    it('同じバージョン → 0', () => {
        expect(compareVersions('5.3.0', '5.3.0')).toBe(0);
    });

    it('a が b より新しい → 正数', () => {
        expect(compareVersions('5.3.1', '5.3.0')).toBeGreaterThan(0);
    });

    it('a が b より古い → 負数', () => {
        expect(compareVersions('5.2.9', '5.3.0')).toBeLessThan(0);
    });

    it('マイナーバージョンの比較', () => {
        expect(compareVersions('5.4.0', '5.3.9')).toBeGreaterThan(0);
    });

    it('メジャーバージョンの比較', () => {
        expect(compareVersions('6.0.0', '5.9.9')).toBeGreaterThan(0);
    });

    it('桁数が異なる場合（5.3 vs 5.3.0）→ 等しい', () => {
        expect(compareVersions('5.3', '5.3.0')).toBe(0);
    });

    it('updateAvailable の判定: 5.3.1 > 5.3.0 → 更新あり', () => {
        const updateAvailable = compareVersions('5.3.1', '5.3.0') > 0;
        expect(updateAvailable).toBe(true);
    });

    it('updateAvailable の判定: 5.3.0 === 5.3.0 → 更新なし', () => {
        const updateAvailable = compareVersions('5.3.0', '5.3.0') > 0;
        expect(updateAvailable).toBe(false);
    });

    it('updateAvailable の判定: 5.2.9 < 5.3.0 → 更新なし（ダウングレード）', () => {
        const updateAvailable = compareVersions('5.2.9', '5.3.0') > 0;
        expect(updateAvailable).toBe(false);
    });
});

// ======================================================
// renderReleaseNotes テスト
// ======================================================
describe('renderReleaseNotes', () => {
    it('空文字列 → 空文字列を返す', () => {
        expect(renderReleaseNotes('')).toBe('');
    });

    it('null/undefined → 空文字列を返す', () => {
        expect(renderReleaseNotes(null)).toBe('');
        expect(renderReleaseNotes(undefined)).toBe('');
    });

    it('## 見出しが <p> タグに変換される', () => {
        const result = renderReleaseNotes('## 修正内容');
        expect(result).toContain('<p>修正内容</p>');
        expect(result).not.toContain('##');
    });

    it('- リスト項目が <ul><li> に変換される', () => {
        const result = renderReleaseNotes('- 項目A\n- 項目B');
        expect(result).toContain('<ul>');
        expect(result).toContain('<li>項目A</li>');
        expect(result).toContain('<li>項目B</li>');
        expect(result).toContain('</ul>');
    });

    it('**太字** が <strong> タグに変換される', () => {
        const result = renderReleaseNotes('- **重要な修正**: 詳細');
        expect(result).toContain('<strong>重要な修正</strong>');
    });

    it('テーブル行（| ... |）はスキップされる', () => {
        const md = '| Mac | file.dmg |\n|---|---|';
        const result = renderReleaseNotes(md);
        expect(result).toBe('');
    });

    it('複合的なMarkdownが正しく変換される', () => {
        const md = `## 修正内容\n\n- **バグ修正**: 詳細\n- その他\n\n## インストール`;
        const result = renderReleaseNotes(md);
        expect(result).toContain('<p>修正内容</p>');
        expect(result).toContain('<strong>バグ修正</strong>');
        expect(result).toContain('<li>');
        expect(result).toContain('<p>インストール</p>');
    });
});
