import { describe, it, expect } from 'vitest';
import { isJunkContent, DEFAULT_JUNK_RULES } from '../src/utils/junk.js';

// isJunkContent は fs.statSync 不要なテスト用API
describe('isJunkContent', () => {
    it('ファイルサイズが minBytes 未満なら空ファイルと判定する', () => {
        const result = isJunkContent('note.md', 3, 'hi', DEFAULT_JUNK_RULES);
        expect(result.junk).toBe(true);
        expect(result.reason).toBe('空ファイル');
    });

    it('"untitled" を含むファイル名は無題と判定する', () => {
        const result = isJunkContent('untitled.md', 100, '十分に長いコンテンツです。', DEFAULT_JUNK_RULES);
        expect(result.junk).toBe(true);
        expect(result.reason).toMatch(/無題/);
    });

    it('"無題" を含むファイル名は無題と判定する', () => {
        const result = isJunkContent('無題のノート.md', 100, '十分に長いコンテンツです。', DEFAULT_JUNK_RULES);
        expect(result.junk).toBe(true);
    });

    it('本文が minChars 未満ならコンテンツなしと判定する', () => {
        const result = isJunkContent('note.md', 100, '短い', DEFAULT_JUNK_RULES);
        expect(result.junk).toBe(true);
        expect(result.reason).toBe('コンテンツなし');
    });

    it('フロントマターを除いた本文で長さを判定する', () => {
        const content = '---\ntitle: test\n---\n短い';
        const result = isJunkContent('note.md', 100, content, DEFAULT_JUNK_RULES);
        expect(result.junk).toBe(true);
        expect(result.reason).toBe('コンテンツなし');
    });

    it('正常なノートはjunk:falseを返す', () => {
        const content = 'これは十分な長さのコンテンツが書かれた正常なノートです。テーマは AI を活用した知識管理です。';
        const result = isJunkContent('ai-note.md', 200, content, DEFAULT_JUNK_RULES);
        expect(result.junk).toBe(false);
    });

    it('カスタムキーワードでも判定できる', () => {
        const customRules = { ...DEFAULT_JUNK_RULES, keywords: ['temp', '仮'] };
        const result = isJunkContent('temp-note.md', 200, '十分に長いコンテンツが書かれています。', customRules);
        expect(result.junk).toBe(true);
    });
});
