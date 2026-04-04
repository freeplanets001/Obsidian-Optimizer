import { describe, it, expect } from 'vitest';
import { parseFrontmatter, levenshtein, extractJsonFromLLM } from '../src/utils/markdown.js';

// ======================================================
// parseFrontmatter テスト
// ======================================================
describe('parseFrontmatter', () => {
    it('frontmatterが存在しない場合はexists:falseを返す', () => {
        const result = parseFrontmatter('# タイトル\n本文だけ');
        expect(result.exists).toBe(false);
        expect(result.fields).toEqual({});
        expect(result.bodyStart).toBe(0);
    });

    it('標準的なfrontmatterを正しくパースする', () => {
        const content = '---\ntitle: テスト\ntags: ai\n---\n# 本文';
        const result = parseFrontmatter(content);
        expect(result.exists).toBe(true);
        expect(result.fields.title).toBe('テスト');
        expect(result.fields.tags).toBe('ai');
    });

    it('frontmatterの終端位置(bodyStart)が正しい', () => {
        const content = '---\ntitle: テスト\n---\n本文';
        const result = parseFrontmatter(content);
        expect(content.slice(result.bodyStart).trim()).toBe('本文');
    });

    it('CRLF改行のfrontmatterも処理できる', () => {
        const content = '---\r\ntitle: CRLF\r\n---\r\n本文';
        const result = parseFrontmatter(content);
        expect(result.exists).toBe(true);
        expect(result.fields.title).toBe('CRLF');
    });

    it('空行のみのfrontmatterはexists:trueを返す', () => {
        // ---\n---（直後に閉じ）は正規表現が中間改行を要求するためexists:false
        // 空行を1行含む形式（---\n\n---）が有効な空frontmatter
        const content = '---\n\n---\n本文';
        const result = parseFrontmatter(content);
        expect(result.exists).toBe(true);
        expect(result.fields).toEqual({});
    });
});

// ======================================================
// levenshtein テスト
// ======================================================
describe('levenshtein', () => {
    it('同一文字列は距離0', () => {
        expect(levenshtein('abc', 'abc')).toBe(0);
    });

    it('1文字追加は距離1', () => {
        expect(levenshtein('abc', 'abcd')).toBe(1);
    });

    it('1文字削除は距離1', () => {
        expect(levenshtein('abcd', 'abc')).toBe(1);
    });

    it('1文字置換は距離1', () => {
        expect(levenshtein('abc', 'axc')).toBe(1);
    });

    it('空文字列との距離は相手の文字数', () => {
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', '')).toBe(3);
    });
});

// ======================================================
// extractJsonFromLLM テスト
// ======================================================
describe('extractJsonFromLLM', () => {
    it('nullや空文字はnullを返す', () => {
        expect(extractJsonFromLLM(null)).toBeNull();
        expect(extractJsonFromLLM('')).toBeNull();
    });

    it('```json コードブロック内のJSONを抽出する', () => {
        const text = '以下の結果です。\n```json\n[{"tag":"ai"}]\n```\n以上です。';
        expect(extractJsonFromLLM(text)).toEqual([{ tag: 'ai' }]);
    });

    it('```なしの生JSON配列を抽出する', () => {
        const text = '結果: [{"name":"テスト"}] でした。';
        expect(extractJsonFromLLM(text)).toEqual([{ name: 'テスト' }]);
    });

    it('JSONオブジェクトも抽出できる', () => {
        const text = '{"title": "AI入門", "score": 5}';
        const result = extractJsonFromLLM(text);
        expect(result).toEqual({ title: 'AI入門', score: 5 });
    });

    it('JSONが存在しないテキストはnullを返す', () => {
        expect(extractJsonFromLLM('ただの文章です')).toBeNull();
    });
});
