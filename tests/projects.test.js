import { describe, it, expect } from 'vitest';

// ======================================================
// プロジェクト管理ロジック（renderer.js 6947-6961行相当）
// renderer.js をインポートせず、同等の純粋関数としてインライン定義
// ======================================================

/**
 * プロジェクトの進捗率を計算する（0〜100）
 * @param {{ tasks?: Array<{ done: boolean }> }} p
 * @returns {number}
 */
function calcProjectProgress(p) {
    if (!p.tasks || p.tasks.length === 0) return 0;
    return Math.round(p.tasks.filter(t => t.done).length / p.tasks.length * 100);
}

/**
 * プロジェクトが期限切れかどうか判定する
 * @param {{ dueDate?: string, status?: string }} p
 * @param {string} today - ISO 日付文字列 (YYYY-MM-DD)
 * @returns {boolean}
 */
function isProjectOverdue(p, today) {
    if (!p.dueDate || p.status === 'completed' || p.status === 'archived') return false;
    return new Date(p.dueDate) < new Date(today);
}

/**
 * 期限まで何日かを返す（過去なら負数、当日は 0）
 * @param {string|undefined} dueDate - ISO 日付文字列
 * @param {string} today - ISO 日付文字列 (YYYY-MM-DD)
 * @returns {number|null}
 */
function getDaysUntilDue(dueDate, today) {
    if (!dueDate) return null;
    return Math.ceil((new Date(dueDate) - new Date(today)) / 86400000);
}

// テスト用固定日付
const TODAY = '2026-04-04';
const YESTERDAY = '2026-04-03';
const TOMORROW = '2026-04-05';
const DAY_AFTER_TOMORROW = '2026-04-06';

// ======================================================
// calcProjectProgress テスト
// ======================================================

describe('calcProjectProgress', () => {
    it('タスクなし (tasks=[]) → 0%', () => {
        expect(calcProjectProgress({ tasks: [] })).toBe(0);
    });

    it('tasks プロパティ自体がない → 0%', () => {
        expect(calcProjectProgress({})).toBe(0);
    });

    it('全タスク完了 → 100%', () => {
        const p = { tasks: [{ done: true }, { done: true }, { done: true }] };
        expect(calcProjectProgress(p)).toBe(100);
    });

    it('全タスク未完了 → 0%', () => {
        const p = { tasks: [{ done: false }, { done: false }] };
        expect(calcProjectProgress(p)).toBe(0);
    });

    it('半数完了 (2/4) → 50%', () => {
        const p = { tasks: [{ done: true }, { done: true }, { done: false }, { done: false }] };
        expect(calcProjectProgress(p)).toBe(50);
    });

    it('1/3 完了 → 33%（Math.round で四捨五入）', () => {
        // 1/3 * 100 = 33.33... → round → 33
        const p = { tasks: [{ done: true }, { done: false }, { done: false }] };
        expect(calcProjectProgress(p)).toBe(33);
    });

    it('2/3 完了 → 67%（Math.round で四捨五入）', () => {
        // 2/3 * 100 = 66.66... → round → 67
        const p = { tasks: [{ done: true }, { done: true }, { done: false }] };
        expect(calcProjectProgress(p)).toBe(67);
    });

    it('1タスクのみ完了 → 100%', () => {
        expect(calcProjectProgress({ tasks: [{ done: true }] })).toBe(100);
    });

    it('1タスクのみ未完了 → 0%', () => {
        expect(calcProjectProgress({ tasks: [{ done: false }] })).toBe(0);
    });
});

// ======================================================
// isProjectOverdue テスト
// ======================================================

describe('isProjectOverdue', () => {
    it('期限が昨日・ステータス active → overdue=true', () => {
        const p = { dueDate: YESTERDAY, status: 'active' };
        expect(isProjectOverdue(p, TODAY)).toBe(true);
    });

    it('期限が昨日・ステータス on-hold → overdue=true', () => {
        const p = { dueDate: YESTERDAY, status: 'on-hold' };
        expect(isProjectOverdue(p, TODAY)).toBe(true);
    });

    it('期限が昨日・ステータス completed → overdue=false（完了済みは除外）', () => {
        const p = { dueDate: YESTERDAY, status: 'completed' };
        expect(isProjectOverdue(p, TODAY)).toBe(false);
    });

    it('期限が昨日・ステータス archived → overdue=false（アーカイブは除外）', () => {
        const p = { dueDate: YESTERDAY, status: 'archived' };
        expect(isProjectOverdue(p, TODAY)).toBe(false);
    });

    it('期限が今日（当日）→ overdue=false（当日はまだ期限切れでない）', () => {
        // new Date(TODAY) < new Date(TODAY) は false
        const p = { dueDate: TODAY, status: 'active' };
        expect(isProjectOverdue(p, TODAY)).toBe(false);
    });

    it('期限が明日 → overdue=false', () => {
        const p = { dueDate: TOMORROW, status: 'active' };
        expect(isProjectOverdue(p, TODAY)).toBe(false);
    });

    it('dueDate が未設定 → overdue=false', () => {
        const p = { status: 'active' };
        expect(isProjectOverdue(p, TODAY)).toBe(false);
    });

    it('dueDate が空文字 → overdue=false', () => {
        const p = { dueDate: '', status: 'active' };
        expect(isProjectOverdue(p, TODAY)).toBe(false);
    });
});

// ======================================================
// getDaysUntilDue テスト
// ======================================================

describe('getDaysUntilDue', () => {
    it('dueDate が未設定 → null を返す', () => {
        expect(getDaysUntilDue(undefined, TODAY)).toBeNull();
    });

    it('dueDate が空文字 → null を返す', () => {
        expect(getDaysUntilDue('', TODAY)).toBeNull();
    });

    it('期限が今日 → days=0', () => {
        expect(getDaysUntilDue(TODAY, TODAY)).toBe(0);
    });

    it('期限が明日 → days=1', () => {
        expect(getDaysUntilDue(TOMORROW, TODAY)).toBe(1);
    });

    it('期限が明後日 → days=2', () => {
        expect(getDaysUntilDue(DAY_AFTER_TOMORROW, TODAY)).toBe(2);
    });

    it('期限が昨日（1日超過）→ days=-1', () => {
        expect(getDaysUntilDue(YESTERDAY, TODAY)).toBe(-1);
    });

    it('期限が7日後 → days=7', () => {
        expect(getDaysUntilDue('2026-04-11', TODAY)).toBe(7);
    });

    it('期限が30日後 → days=30', () => {
        expect(getDaysUntilDue('2026-05-04', TODAY)).toBe(30);
    });
});
