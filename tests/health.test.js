import { describe, it, expect } from 'vitest';

// ======================================================
// ヘルススコア計算ロジック（renderer.js 828-833行相当）
// renderer.js をインポートせず、同等の純粋関数としてインライン定義
// ======================================================

/**
 * ヘルススコアを計算する
 * @param {{ orphanNotes: number, junkFiles: number, brokenLinksCount: number, dupCount: number, staleCount: number }} params
 * @returns {number} 0〜100 のスコア
 */
function calcHealthScore({ orphanNotes = 0, junkFiles = 0, brokenLinksCount = 0, dupCount = 0, staleCount = 0 } = {}) {
    const penalty = Math.min(orphanNotes * 0.35, 35)
        + Math.min(junkFiles * 2, 25)
        + Math.min(brokenLinksCount * 0.5, 15)
        + Math.min(dupCount, 10)
        + Math.min(staleCount * 0.1, 10);
    return Math.max(0, Math.round(100 - penalty));
}

// ======================================================
// calcHealthScore テスト
// ======================================================

describe('calcHealthScore', () => {
    // --- 完全クリーンな状態 ---
    it('全問題ゼロのときスコアは100', () => {
        expect(calcHealthScore({ orphanNotes: 0, junkFiles: 0, brokenLinksCount: 0, dupCount: 0, staleCount: 0 })).toBe(100);
    });

    it('引数省略時もスコアは100（デフォルト値が0）', () => {
        expect(calcHealthScore()).toBe(100);
    });

    // --- orphanNotes 単独 ---
    it('orphanNotes=10 → penalty=3.5 → score=97（Math.round で四捨五入）', () => {
        // 10 * 0.35 = 3.5 → round(100 - 3.5) = round(96.5) = 97
        expect(calcHealthScore({ orphanNotes: 10 })).toBe(97);
    });

    it('orphanNotes=100 → penalty は 35 にキャップ → score=65', () => {
        // min(100*0.35, 35) = min(35, 35) = 35
        expect(calcHealthScore({ orphanNotes: 100 })).toBe(65);
    });

    it('orphanNotes=200 → penalty は依然 35 にキャップ（上限を超えても変わらない）', () => {
        expect(calcHealthScore({ orphanNotes: 200 })).toBe(65);
    });

    // --- junkFiles 単独 ---
    it('junkFiles=5 → penalty=10 → score=90', () => {
        // min(5*2, 25) = 10
        expect(calcHealthScore({ junkFiles: 5 })).toBe(90);
    });

    it('junkFiles=13 → penalty は 25 にキャップ → score=75', () => {
        // min(13*2, 25) = min(26, 25) = 25
        expect(calcHealthScore({ junkFiles: 13 })).toBe(75);
    });

    it('junkFiles=50 → penalty は依然 25 にキャップ', () => {
        expect(calcHealthScore({ junkFiles: 50 })).toBe(75);
    });

    // --- brokenLinksCount 単独 ---
    it('brokenLinksCount=10 → penalty=5 → score=95', () => {
        // min(10*0.5, 15) = 5
        expect(calcHealthScore({ brokenLinksCount: 10 })).toBe(95);
    });

    it('brokenLinksCount=30 → penalty は 15 にキャップ → score=85', () => {
        // min(30*0.5, 15) = min(15, 15) = 15
        expect(calcHealthScore({ brokenLinksCount: 30 })).toBe(85);
    });

    // --- dupCount 単独 ---
    it('dupCount=5 → penalty=5 → score=95', () => {
        // min(5, 10) = 5
        expect(calcHealthScore({ dupCount: 5 })).toBe(95);
    });

    it('dupCount=10 → penalty は 10 にキャップ → score=90', () => {
        // min(10, 10) = 10
        expect(calcHealthScore({ dupCount: 10 })).toBe(90);
    });

    it('dupCount=20 → penalty は依然 10 にキャップ', () => {
        expect(calcHealthScore({ dupCount: 20 })).toBe(90);
    });

    // --- staleCount 単独 ---
    it('staleCount=50 → penalty=5 → score=95', () => {
        // min(50*0.1, 10) = 5
        expect(calcHealthScore({ staleCount: 50 })).toBe(95);
    });

    it('staleCount=100 → penalty は 10 にキャップ → score=90', () => {
        // min(100*0.1, 10) = 10
        expect(calcHealthScore({ staleCount: 100 })).toBe(90);
    });

    // --- 複合ペナルティ ---
    it('orphan+junk+broken が重なってもスコアは 0 以上（Math.max 保護）', () => {
        // 35 + 25 + 15 + 10 + 10 = 95 → score=5
        const score = calcHealthScore({
            orphanNotes: 200,
            junkFiles: 50,
            brokenLinksCount: 100,
            dupCount: 20,
            staleCount: 200,
        });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBe(5);
    });

    it('全キャップ値合計 95 → score=5（最低値確認）', () => {
        // 各キャップ: 35+25+15+10+10 = 95 → round(100-95) = 5
        expect(calcHealthScore({
            orphanNotes: 100,
            junkFiles: 13,
            brokenLinksCount: 30,
            dupCount: 10,
            staleCount: 100,
        })).toBe(5);
    });

    it('score が負にならない（Math.max(0,…) で保護）', () => {
        // penalty が 100 を超えても 0 止まり
        const score = calcHealthScore({
            orphanNotes: 100,
            junkFiles: 13,
            brokenLinksCount: 30,
            dupCount: 10,
            staleCount: 100,
        });
        expect(score).toBeGreaterThanOrEqual(0);
    });

    // --- 部分的な複合 ---
    it('orphanNotes=20, junkFiles=5 → penalty=7+10=17 → score=83', () => {
        // min(20*0.35,35)=7 + min(5*2,25)=10 = 17
        expect(calcHealthScore({ orphanNotes: 20, junkFiles: 5 })).toBe(83);
    });

    it('brokenLinksCount=10, dupCount=3 → penalty=5+3=8 → score=92', () => {
        expect(calcHealthScore({ brokenLinksCount: 10, dupCount: 3 })).toBe(92);
    });
});
