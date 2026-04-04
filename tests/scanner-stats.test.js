import { describe, it, expect } from 'vitest';

// ======================================================
// スキャン後統計計算ロジック（main.js 1118-1121行相当）
// main.js をインポートせず、同等の純粋関数としてインライン定義
// ======================================================

/**
 * 平均単語数/ノートを計算する
 * @param {number} totalWords
 * @param {number} totalMDFiles
 * @returns {number} 0 以上の整数（ゼロ除算時は 0）
 */
function calcAvgWordsPerNote(totalWords, totalMDFiles) {
    if (totalMDFiles === 0) return 0;
    return Math.round(totalWords / totalMDFiles);
}

/**
 * リンク密度（ノートあたりリンク数、小数第1位）を計算する
 * @param {number} totalLinks
 * @param {number} totalMDFiles
 * @returns {number} 0 以上の数値（ゼロ除算時は 0）
 */
function calcLinkDensity(totalLinks, totalMDFiles) {
    if (totalMDFiles === 0) return 0;
    return Math.round(totalLinks / totalMDFiles * 10) / 10;
}

/**
 * タグなし率（%）を計算する
 * @param {number} untaggedCount
 * @param {number} totalMDFiles
 * @returns {number} 0〜100 の整数（ゼロ除算時は 0）
 */
function calcUntaggedRate(untaggedCount, totalMDFiles) {
    if (totalMDFiles === 0) return 0;
    return Math.round((untaggedCount / totalMDFiles) * 100);
}

// ======================================================
// calcAvgWordsPerNote テスト
// ======================================================

describe('calcAvgWordsPerNote', () => {
    it('totalMDFiles=0 のとき 0 を返す（ゼロ除算回避）', () => {
        expect(calcAvgWordsPerNote(1000, 0)).toBe(0);
    });

    it('totalWords=0, totalMDFiles=10 → avg=0', () => {
        expect(calcAvgWordsPerNote(0, 10)).toBe(0);
    });

    it('totalWords=1000, totalMDFiles=10 → avg=100', () => {
        expect(calcAvgWordsPerNote(1000, 10)).toBe(100);
    });

    it('totalWords=1500, totalMDFiles=10 → avg=150', () => {
        expect(calcAvgWordsPerNote(1500, 10)).toBe(150);
    });

    it('totalWords=1, totalMDFiles=1 → avg=1', () => {
        expect(calcAvgWordsPerNote(1, 1)).toBe(1);
    });

    it('端数あり: totalWords=55, totalMDFiles=10 → avg=6（55/10=5.5 → round → 6）', () => {
        expect(calcAvgWordsPerNote(55, 10)).toBe(6);
    });

    it('端数あり: totalWords=54, totalMDFiles=10 → avg=5（54/10=5.4 → round → 5）', () => {
        expect(calcAvgWordsPerNote(54, 10)).toBe(5);
    });

    it('totalWords=999, totalMDFiles=7 → avg=143（999/7=142.71... → round → 143）', () => {
        expect(calcAvgWordsPerNote(999, 7)).toBe(143);
    });
});

// ======================================================
// calcLinkDensity テスト
// ======================================================

describe('calcLinkDensity', () => {
    it('totalMDFiles=0 のとき 0 を返す（ゼロ除算回避）', () => {
        expect(calcLinkDensity(100, 0)).toBe(0);
    });

    it('totalLinks=0, totalMDFiles=10 → density=0', () => {
        expect(calcLinkDensity(0, 10)).toBe(0);
    });

    it('totalLinks=35, totalMDFiles=10 → density=3.5', () => {
        // 35/10 * 10 / 10 = 3.5
        expect(calcLinkDensity(35, 10)).toBe(3.5);
    });

    it('totalLinks=30, totalMDFiles=10 → density=3.0', () => {
        expect(calcLinkDensity(30, 10)).toBe(3.0);
    });

    it('totalLinks=1, totalMDFiles=3 → density=0.3（小数第1位で丸め）', () => {
        // 1/3 = 0.333... → *10 = 3.33 → round → 3 → /10 = 0.3
        expect(calcLinkDensity(1, 3)).toBe(0.3);
    });

    it('totalLinks=2, totalMDFiles=3 → density=0.7', () => {
        // 2/3 = 0.666... → *10 = 6.66 → round → 7 → /10 = 0.7
        expect(calcLinkDensity(2, 3)).toBe(0.7);
    });

    it('totalLinks=100, totalMDFiles=100 → density=1.0', () => {
        expect(calcLinkDensity(100, 100)).toBe(1.0);
    });

    it('totalLinks=15, totalMDFiles=4 → density=3.8（15/4=3.75 → *10=37.5 → round=38 → /10=3.8）', () => {
        expect(calcLinkDensity(15, 4)).toBe(3.8);
    });
});

// ======================================================
// calcUntaggedRate テスト
// ======================================================

describe('calcUntaggedRate', () => {
    it('totalMDFiles=0 のとき 0 を返す（ゼロ除算回避）', () => {
        expect(calcUntaggedRate(5, 0)).toBe(0);
    });

    it('untaggedCount=0, totalMDFiles=10 → rate=0%', () => {
        expect(calcUntaggedRate(0, 10)).toBe(0);
    });

    it('全ノートがタグなし → rate=100%', () => {
        expect(calcUntaggedRate(10, 10)).toBe(100);
    });

    it('半数がタグなし → rate=50%', () => {
        expect(calcUntaggedRate(5, 10)).toBe(50);
    });

    it('untaggedCount=3, totalMDFiles=10 → rate=30%', () => {
        expect(calcUntaggedRate(3, 10)).toBe(30);
    });

    it('端数あり: untaggedCount=1, totalMDFiles=3 → rate=33%（1/3*100=33.33 → round → 33）', () => {
        expect(calcUntaggedRate(1, 3)).toBe(33);
    });

    it('端数あり: untaggedCount=2, totalMDFiles=3 → rate=67%（2/3*100=66.66 → round → 67）', () => {
        expect(calcUntaggedRate(2, 3)).toBe(67);
    });

    it('untaggedCount=1, totalMDFiles=100 → rate=1%', () => {
        expect(calcUntaggedRate(1, 100)).toBe(1);
    });
});
