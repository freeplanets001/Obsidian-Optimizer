import { describe, it, expect } from 'vitest';

// ======================================================
// スマートルール条件マッチングロジックのテスト
// src/handlers/smart-rules.handler.js のルール評価を純粋関数として再現
// ======================================================

/**
 * ルールの条件を評価する純粋関数
 * @param {{ field: string, operator: string, value: string }} condition
 * @param {{ name: string, content: string, tags: string[], size: number, mtime: Date }} note
 * @returns {boolean}
 */
function evaluateCondition(condition, note) {
    const { field, operator, value } = condition;
    let actual;
    switch (field) {
        case 'name':    actual = note.name; break;
        case 'content': actual = note.content; break;
        case 'tags':    actual = note.tags.join(' '); break;
        case 'size':    actual = String(note.size); break;
        default:        return false;
    }

    switch (operator) {
        case 'contains':     return actual.toLowerCase().includes(value.toLowerCase());
        case 'not_contains': return !actual.toLowerCase().includes(value.toLowerCase());
        case 'starts_with':  return actual.toLowerCase().startsWith(value.toLowerCase());
        case 'ends_with':    return actual.toLowerCase().endsWith(value.toLowerCase());
        case 'equals':       return actual.toLowerCase() === value.toLowerCase();
        case 'gt':           return parseFloat(actual) > parseFloat(value);
        case 'lt':           return parseFloat(actual) < parseFloat(value);
        default:             return false;
    }
}

/**
 * 複数条件（AND）を評価する
 */
function evaluateRule(conditions, note, matchType = 'all') {
    if (!conditions || conditions.length === 0) return false;
    if (matchType === 'all') return conditions.every(c => evaluateCondition(c, note));
    if (matchType === 'any') return conditions.some(c => evaluateCondition(c, note));
    return false;
}

/**
 * スケジュール実行が必要かどうかを判定する
 */
function shouldRunScheduled(rule, nowMs) {
    if (!rule.schedule || rule.schedule === 'off') return false;
    if (!rule.lastScheduledRun) return true;

    const last = new Date(rule.lastScheduledRun).getTime();
    const INTERVALS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000, monthly: 30 * 24 * 60 * 60 * 1000 };
    const interval = INTERVALS[rule.schedule];
    if (!interval) return false;
    return nowMs - last >= interval;
}

// テスト用ノートファクトリ
function makeNote(overrides = {}) {
    return {
        name: 'テストノート',
        content: 'これはテスト用のノートです。',
        tags: [],
        size: 1024,
        mtime: new Date('2026-04-01'),
        ...overrides,
    };
}

// ======================================================
// evaluateCondition テスト
// ======================================================
describe('evaluateCondition - contains', () => {
    it('content に指定語が含まれる場合 true', () => {
        const note = makeNote({ content: 'Obsidian は素晴らしいツールです' });
        expect(evaluateCondition({ field: 'content', operator: 'contains', value: 'Obsidian' }, note)).toBe(true);
    });

    it('content に指定語が含まれない場合 false', () => {
        const note = makeNote({ content: 'ただのテキスト' });
        expect(evaluateCondition({ field: 'content', operator: 'contains', value: 'Obsidian' }, note)).toBe(false);
    });

    it('大文字小文字を区別しない', () => {
        const note = makeNote({ content: 'obsidian test' });
        expect(evaluateCondition({ field: 'content', operator: 'contains', value: 'OBSIDIAN' }, note)).toBe(true);
    });
});

describe('evaluateCondition - not_contains', () => {
    it('指定語が含まれない場合 true', () => {
        const note = makeNote({ content: '別のテキスト' });
        expect(evaluateCondition({ field: 'content', operator: 'not_contains', value: 'Obsidian' }, note)).toBe(true);
    });

    it('指定語が含まれる場合 false', () => {
        const note = makeNote({ content: 'Obsidian のノート' });
        expect(evaluateCondition({ field: 'content', operator: 'not_contains', value: 'Obsidian' }, note)).toBe(false);
    });
});

describe('evaluateCondition - name', () => {
    it('starts_with でファイル名の先頭マッチ', () => {
        const note = makeNote({ name: 'Daily-2026-04-05' });
        expect(evaluateCondition({ field: 'name', operator: 'starts_with', value: 'Daily' }, note)).toBe(true);
    });

    it('ends_with でファイル名の末尾マッチ', () => {
        const note = makeNote({ name: 'Meeting-Notes' });
        expect(evaluateCondition({ field: 'name', operator: 'ends_with', value: 'Notes' }, note)).toBe(true);
    });

    it('equals で完全一致', () => {
        const note = makeNote({ name: 'Inbox' });
        expect(evaluateCondition({ field: 'name', operator: 'equals', value: 'inbox' }, note)).toBe(true);
    });
});

describe('evaluateCondition - tags', () => {
    it('タグが含まれる場合 true', () => {
        const note = makeNote({ tags: ['#project', '#active'] });
        expect(evaluateCondition({ field: 'tags', operator: 'contains', value: 'project' }, note)).toBe(true);
    });

    it('タグが含まれない場合 false', () => {
        const note = makeNote({ tags: ['#archive'] });
        expect(evaluateCondition({ field: 'tags', operator: 'contains', value: 'project' }, note)).toBe(false);
    });
});

describe('evaluateCondition - size', () => {
    it('size > 500 の場合 gt で true', () => {
        const note = makeNote({ size: 1024 });
        expect(evaluateCondition({ field: 'size', operator: 'gt', value: '500' }, note)).toBe(true);
    });

    it('size < 500 の場合 gt で false', () => {
        const note = makeNote({ size: 100 });
        expect(evaluateCondition({ field: 'size', operator: 'gt', value: '500' }, note)).toBe(false);
    });

    it('size < 1000 の場合 lt で true', () => {
        const note = makeNote({ size: 512 });
        expect(evaluateCondition({ field: 'size', operator: 'lt', value: '1000' }, note)).toBe(true);
    });
});

describe('evaluateCondition - 不明なフィールド・演算子', () => {
    it('不明なフィールドは false を返す', () => {
        const note = makeNote();
        expect(evaluateCondition({ field: 'unknown_field', operator: 'contains', value: 'test' }, note)).toBe(false);
    });

    it('不明な演算子は false を返す', () => {
        const note = makeNote({ content: 'test' });
        expect(evaluateCondition({ field: 'content', operator: 'unknown_op', value: 'test' }, note)).toBe(false);
    });
});

// ======================================================
// evaluateRule テスト（AND/ANY）
// ======================================================
describe('evaluateRule - AND条件', () => {
    it('全条件が満たされる場合 true', () => {
        const note = makeNote({ name: 'Daily-Note', content: 'meeting' });
        const conditions = [
            { field: 'name', operator: 'starts_with', value: 'Daily' },
            { field: 'content', operator: 'contains', value: 'meeting' },
        ];
        expect(evaluateRule(conditions, note, 'all')).toBe(true);
    });

    it('1条件が満たされない場合 false', () => {
        const note = makeNote({ name: 'Daily-Note', content: 'random text' });
        const conditions = [
            { field: 'name', operator: 'starts_with', value: 'Daily' },
            { field: 'content', operator: 'contains', value: 'meeting' },
        ];
        expect(evaluateRule(conditions, note, 'all')).toBe(false);
    });

    it('条件が空配列の場合 false', () => {
        const note = makeNote();
        expect(evaluateRule([], note, 'all')).toBe(false);
    });
});

describe('evaluateRule - ANY条件', () => {
    it('どれか1つが満たされる場合 true', () => {
        const note = makeNote({ name: 'Daily-Note' });
        const conditions = [
            { field: 'name', operator: 'starts_with', value: 'Daily' },
            { field: 'content', operator: 'contains', value: 'meeting' },
        ];
        expect(evaluateRule(conditions, note, 'any')).toBe(true);
    });

    it('全条件が満たされない場合 false', () => {
        const note = makeNote({ name: 'Random', content: 'nothing' });
        const conditions = [
            { field: 'name', operator: 'starts_with', value: 'Daily' },
            { field: 'content', operator: 'contains', value: 'meeting' },
        ];
        expect(evaluateRule(conditions, note, 'any')).toBe(false);
    });
});

// ======================================================
// shouldRunScheduled テスト
// ======================================================
describe('shouldRunScheduled', () => {
    const NOW = new Date('2026-04-05T12:00:00Z').getTime();

    it('schedule が off の場合 false', () => {
        expect(shouldRunScheduled({ schedule: 'off' }, NOW)).toBe(false);
    });

    it('schedule がない場合 false', () => {
        expect(shouldRunScheduled({}, NOW)).toBe(false);
    });

    it('lastScheduledRun がない場合（初回）→ true', () => {
        expect(shouldRunScheduled({ schedule: 'daily' }, NOW)).toBe(true);
    });

    it('daily: 24時間以上経過していれば true', () => {
        const last = new Date('2026-04-04T11:59:00Z').toISOString(); // 25時間前
        expect(shouldRunScheduled({ schedule: 'daily', lastScheduledRun: last }, NOW)).toBe(true);
    });

    it('daily: 24時間未満なら false', () => {
        const last = new Date('2026-04-05T11:00:00Z').toISOString(); // 1時間前
        expect(shouldRunScheduled({ schedule: 'daily', lastScheduledRun: last }, NOW)).toBe(false);
    });

    it('weekly: 7日以上経過していれば true', () => {
        const last = new Date('2026-03-28T12:00:00Z').toISOString(); // 8日前
        expect(shouldRunScheduled({ schedule: 'weekly', lastScheduledRun: last }, NOW)).toBe(true);
    });

    it('weekly: 7日未満なら false', () => {
        const last = new Date('2026-04-03T12:00:00Z').toISOString(); // 2日前
        expect(shouldRunScheduled({ schedule: 'weekly', lastScheduledRun: last }, NOW)).toBe(false);
    });

    it('monthly: 30日以上経過していれば true', () => {
        const last = new Date('2026-03-05T12:00:00Z').toISOString(); // 31日前
        expect(shouldRunScheduled({ schedule: 'monthly', lastScheduledRun: last }, NOW)).toBe(true);
    });

    it('monthly: 30日未満なら false', () => {
        const last = new Date('2026-03-20T12:00:00Z').toISOString(); // 16日前
        expect(shouldRunScheduled({ schedule: 'monthly', lastScheduledRun: last }, NOW)).toBe(false);
    });
});
