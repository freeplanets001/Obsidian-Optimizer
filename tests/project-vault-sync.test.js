import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ======================================================
// プロジェクト ↔ Vault ノート同期ロジックのテスト
// main.js の refreshProjectVaultNote 相当の純粋関数をインライン定義
// ======================================================

/**
 * refreshProjectVaultNote の純粋関数版
 * 実際の fs 書き込みは行わず、生成される Markdown 文字列を返す
 */
function buildProjectNoteContent(p) {
    const doneTasks = p.tasks.filter(t => t.done).length;
    const progress = p.tasks.length > 0 ? Math.round(doneTasks / p.tasks.length * 100) : 0;
    const statusLabel = { active: '進行中', completed: '完了', 'on-hold': '保留中', archived: 'アーカイブ' }[p.status] || p.status;
    const priorityLabel = { high: '🔴 高', medium: '🟡 中', low: '🔵 低' }[p.priority] || p.priority;

    const taskLines = p.tasks.length > 0
        ? p.tasks.map(t => {
            const check = t.done ? '[x]' : '[ ]';
            const due = t.dueDate ? ` 📅 ${t.dueDate}` : '';
            return `- ${check} ${t.text}${due}`;
        }).join('\n')
        : '- [ ] （タスクを追加してください）';

    const msLines = p.milestones.map(m => {
        const check = m.done ? '[x]' : '[ ]';
        const due = m.dueDate ? ` 📅 ${m.dueDate}` : '';
        return `- ${check} ${m.name}${due}`;
    }).join('\n') || '';

    const isArchived = p.status === 'archived' || p.status === 'completed';
    const baseTags = ['type/project', ...(p.tags || [])];
    if (isArchived) baseTags.push('status/done');
    const tagsYaml = baseTags.join(', ');
    const projectTag = p.name.replace(/\s+/g, '-');

    const lines = [
        '---',
        `project: "${p.name}"`,
        `status: ${p.status}`,
        `priority: ${p.priority}`,
        p.dueDate ? `due: ${p.dueDate}` : null,
        `tags: [${tagsYaml}]`,
        `progress: ${progress}`,
        `optimizer-id: "${p.id}"`,
        `created: ${p.createdAt.slice(0, 10)}`,
        `updated: ${p.updatedAt.slice(0, 10)}`,
        '---',
        '',
        `# 📁 ${p.name}`,
        '',
        `> **ステータス**: ${statusLabel} | **優先度**: ${priorityLabel} | **進捗**: ${progress}%`,
        '',
        p.description ? `## 概要\n\n${p.description}\n` : '',
        `## タスク (${doneTasks}/${p.tasks.length})\n\n${taskLines}\n\n> 以下はタスクタブで \`#project/${projectTag}\` タグを付けたVault連動タスクです\n\n\`\`\`dataview\nTASK\nFROM ""\nWHERE contains(tags, "project/${projectTag}")\nSORT file.mtime DESC\n\`\`\`\n`,
        msLines ? `## マイルストーン\n\n${msLines}\n` : '',
        p.notes ? `## メモ\n\n${p.notes}\n` : '',
    ].filter(l => l !== null).join('\n');

    return { content: lines, progress, doneTasks, isArchived };
}

// テスト用プロジェクトファクトリ
function makeProject(overrides = {}) {
    return {
        id: 'test-id-001',
        name: 'テストプロジェクト',
        status: 'active',
        priority: 'medium',
        dueDate: null,
        description: '',
        notes: '',
        tags: [],
        tasks: [],
        milestones: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-05T00:00:00.000Z',
        ...overrides,
    };
}

// ======================================================
// タスクのチェック状態がノートに反映されるか
// ======================================================
describe('buildProjectNoteContent - タスク同期', () => {
    it('タスクが未完了の場合 - [ ] で出力される', () => {
        const p = makeProject({ tasks: [{ id: '1', text: 'タスクA', done: false, dueDate: null }] });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('- [ ] タスクA');
        expect(content).not.toContain('- [x] タスクA');
    });

    it('タスクが完了した場合 - [x] で出力される', () => {
        const p = makeProject({ tasks: [{ id: '1', text: 'タスクA', done: true, dueDate: null }] });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('- [x] タスクA');
    });

    it('複数タスクで完了・未完了が混在する場合', () => {
        const p = makeProject({
            tasks: [
                { id: '1', text: '完了タスク', done: true, dueDate: null },
                { id: '2', text: '未完了タスク', done: false, dueDate: null },
            ],
        });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('- [x] 完了タスク');
        expect(content).toContain('- [ ] 未完了タスク');
    });

    it('タスクに期限がある場合 📅 日付が付く', () => {
        const p = makeProject({ tasks: [{ id: '1', text: '期限付き', done: false, dueDate: '2026-04-30' }] });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('- [ ] 期限付き 📅 2026-04-30');
    });

    it('タスクが空の場合ダミータスクが出力される', () => {
        const p = makeProject({ tasks: [] });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('- [ ] （タスクを追加してください）');
    });
});

// ======================================================
// 進捗率がフロントマターに反映されるか
// ======================================================
describe('buildProjectNoteContent - 進捗率', () => {
    it('タスク 0/0 → progress: 0', () => {
        const { content, progress } = buildProjectNoteContent(makeProject({ tasks: [] }));
        expect(progress).toBe(0);
        expect(content).toContain('progress: 0');
    });

    it('タスク 1/1 完了 → progress: 100', () => {
        const p = makeProject({ tasks: [{ id: '1', text: 'A', done: true }] });
        const { progress, content } = buildProjectNoteContent(p);
        expect(progress).toBe(100);
        expect(content).toContain('progress: 100');
        expect(content).toContain('**進捗**: 100%');
    });

    it('タスク 1/2 完了 → progress: 50', () => {
        const p = makeProject({
            tasks: [
                { id: '1', text: 'A', done: true },
                { id: '2', text: 'B', done: false },
            ],
        });
        const { progress } = buildProjectNoteContent(p);
        expect(progress).toBe(50);
    });

    it('タスクセクションの見出しに完了数が反映される', () => {
        const p = makeProject({
            tasks: [
                { id: '1', text: 'A', done: true },
                { id: '2', text: 'B', done: false },
                { id: '3', text: 'C', done: false },
            ],
        });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('## タスク (1/3)');
    });
});

// ======================================================
// マイルストーンのチェック状態がノートに反映されるか
// ======================================================
describe('buildProjectNoteContent - マイルストーン同期', () => {
    it('マイルストーンが未完了の場合 - [ ] で出力される', () => {
        const p = makeProject({ milestones: [{ id: 'm1', name: 'フェーズ1', done: false, dueDate: null }] });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('- [ ] フェーズ1');
    });

    it('マイルストーンが完了した場合 - [x] で出力される', () => {
        const p = makeProject({ milestones: [{ id: 'm1', name: 'フェーズ1', done: true, dueDate: null }] });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('- [x] フェーズ1');
    });

    it('マイルストーンが空の場合マイルストーンセクション自体が省略される', () => {
        const p = makeProject({ milestones: [] });
        const { content } = buildProjectNoteContent(p);
        expect(content).not.toContain('## マイルストーン');
    });
});

// ======================================================
// フロントマター・タグの正確性
// ======================================================
describe('buildProjectNoteContent - フロントマター', () => {
    it('通常プロジェクトには type/project タグが付く', () => {
        const p = makeProject();
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('tags: [type/project]');
    });

    it('completed プロジェクトには status/done タグが付く', () => {
        const p = makeProject({ status: 'completed' });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('status/done');
        expect(content).toMatch(/tags: \[.*status\/done.*\]/);
    });

    it('optimizer-id が正しく出力される', () => {
        const p = makeProject({ id: 'abc-123' });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('optimizer-id: "abc-123"');
    });

    it('dueDate があれば due フィールドが出力される', () => {
        const p = makeProject({ dueDate: '2026-12-31' });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('due: 2026-12-31');
    });

    it('dueDate がなければ due フィールドは出力されない', () => {
        const p = makeProject({ dueDate: null });
        const { content } = buildProjectNoteContent(p);
        expect(content).not.toContain('due:');
    });
});

// ======================================================
// Dataview クエリが含まれるか（タスクタブとの連動）
// ======================================================
describe('buildProjectNoteContent - Dataview連動', () => {
    it('プロジェクト名のスペースがハイフンに変換されてDataviewクエリに使われる', () => {
        const p = makeProject({ name: 'My Project Test' });
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('project/My-Project-Test');
    });

    it('Dataviewコードブロックが含まれる', () => {
        const p = makeProject();
        const { content } = buildProjectNoteContent(p);
        expect(content).toContain('```dataview');
        expect(content).toContain('TASK');
        expect(content).toContain('WHERE contains(tags,');
    });
});
