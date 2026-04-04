'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

// ======================================================
// スマートルールエンジン v2.0
// トリガー×アクションの組み合わせ、AND/OR複数条件、実行履歴対応
// ======================================================

// ---- トリガー定義 ----
const TRIGGERS = {
    'note-stale':        { label: '放置ノート（最終更新日）',    conditionType: 'days',      placeholder: '例: 180（日数）' },
    'tag-match':         { label: 'タグが一致',                  conditionType: 'tag',       placeholder: '例: #inbox' },
    'filename-pattern':  { label: 'ファイル名がパターンに一致',  conditionType: 'pattern',   placeholder: '例: DRAFT- または 正規表現' },
    'folder-match':      { label: '特定フォルダにある',          conditionType: 'folder',    placeholder: '例: 00 Inbox' },
    'content-keyword':   { label: '本文にキーワードを含む',      conditionType: 'keyword',   placeholder: '例: TODO または 要確認' },
    'no-links':          { label: 'リンクが0件（孤立ノート）',   conditionType: 'none',      placeholder: '' },
    'frontmatter-field': { label: 'frontmatterフィールド値',     conditionType: 'kv',        placeholder: '例: status=draft' },
};

// ---- アクション定義 ----
const ACTIONS = {
    'archive':            { label: 'アーカイブフォルダに移動',  targetLabel: '移動先フォルダ名',       targetPlaceholder: '例: 99 Archive' },
    'move-folder':        { label: '指定フォルダに移動',        targetLabel: '移動先フォルダパス',     targetPlaceholder: '例: 01 Projects' },
    'tag':                { label: 'タグを追加',                 targetLabel: '追加するタグ',           targetPlaceholder: '例: #stale' },
    'remove-tag':         { label: 'タグを削除',                 targetLabel: '削除するタグ',           targetPlaceholder: '例: #inbox' },
    'add-frontmatter':    { label: 'frontmatterフィールドを追加', targetLabel: 'key=value 形式',        targetPlaceholder: '例: status=archived' },
    'add-to-moc':         { label: 'MOCノートに追記',            targetLabel: 'MOCファイル名',          targetPlaceholder: '例: Inbox MOC' },
    'rename-prefix':      { label: 'ファイル名にプレフィックスを付与', targetLabel: 'プレフィックス文字列', targetPlaceholder: '例: ARCHIVE_' },
};

// ---- プリセット定義 (12種) ----
const RULE_PRESETS = [
    {
        id: 'preset-stale-180',
        label: '📦 180日放置→アーカイブ',
        description: '180日以上更新されていないノートを自動アーカイブ',
        logic: 'AND',
        conditions: [{ trigger: 'note-stale', conditionValue: '180' }],
        action: 'archive',
        actionTarget: '99 Archive',
    },
    {
        id: 'preset-stale-30-tag',
        label: '🏷️ 30日放置→#staleタグ',
        description: '30日放置ノートに#staleを付けて可視化',
        logic: 'AND',
        conditions: [{ trigger: 'note-stale', conditionValue: '30' }],
        action: 'tag',
        actionTarget: '#stale',
    },
    {
        id: 'preset-inbox-moc',
        label: '📂 #inbox→Inbox MOCに追加',
        description: '#inboxタグのノートをMOCにリンク',
        logic: 'AND',
        conditions: [{ trigger: 'tag-match', conditionValue: '#inbox' }],
        action: 'add-to-moc',
        actionTarget: 'Inbox MOC',
    },
    {
        id: 'preset-draft-folder',
        label: '✏️ DRAFTノート→Draftsフォルダ',
        description: 'ファイル名がDRAFTで始まるノートを整理',
        logic: 'AND',
        conditions: [{ trigger: 'filename-pattern', conditionValue: '^DRAFT' }],
        action: 'move-folder',
        actionTarget: '00 Drafts',
    },
    {
        id: 'preset-orphan-tag',
        label: '🔍 孤立ノート→#orphanタグ',
        description: 'どこからもリンクされていないノートにタグ付け',
        logic: 'AND',
        conditions: [{ trigger: 'no-links', conditionValue: '' }],
        action: 'tag',
        actionTarget: '#orphan',
    },
    {
        id: 'preset-inbox-folder',
        label: '📥 Inboxフォルダの古いノート→整理',
        description: 'Inboxに60日以上あるノートをアーカイブ',
        logic: 'AND',
        conditions: [
            { trigger: 'folder-match', conditionValue: '00 Inbox' },
            { trigger: 'note-stale', conditionValue: '60' },
        ],
        action: 'archive',
        actionTarget: '99 Archive',
    },
    {
        id: 'preset-todo-tag',
        label: '✅ TODOノート→#actionタグ',
        description: '本文にTODOを含むノートに#actionタグを付与',
        logic: 'AND',
        conditions: [{ trigger: 'content-keyword', conditionValue: 'TODO' }],
        action: 'tag',
        actionTarget: '#action',
    },
    {
        id: 'preset-status-draft',
        label: '📝 status=draft→Draftsフォルダ',
        description: 'frontmatterのstatusがdraftのノートを整理',
        logic: 'AND',
        conditions: [{ trigger: 'frontmatter-field', conditionValue: 'status=draft' }],
        action: 'move-folder',
        actionTarget: '00 Drafts',
    },
    {
        id: 'preset-stale-moc',
        label: '🗺️ 90日放置ノート→レビューMOC',
        description: '90日放置ノートをレビュー用MOCにリスト',
        logic: 'AND',
        conditions: [{ trigger: 'note-stale', conditionValue: '90' }],
        action: 'add-to-moc',
        actionTarget: 'Review MOC',
    },
    {
        id: 'preset-rename-done',
        label: '✔️ #done→DONE_プレフィックス',
        description: '#doneタグのノートにDONE_プレフィックスを付与',
        logic: 'AND',
        conditions: [{ trigger: 'tag-match', conditionValue: '#done' }],
        action: 'rename-prefix',
        actionTarget: 'DONE_',
    },
    {
        id: 'preset-stale-frontmatter',
        label: '🕰️ 180日放置→archived=trueを付与',
        description: 'frontmatterにarchived=trueを追記してフィルタ可能に',
        logic: 'AND',
        conditions: [{ trigger: 'note-stale', conditionValue: '180' }],
        action: 'add-frontmatter',
        actionTarget: 'archived=true',
    },
    {
        id: 'preset-inbox-remove-tag',
        label: '🧹 移動済み#inbox→タグ削除',
        description: 'Inbox以外のフォルダにある#inboxタグを削除',
        logic: 'AND',
        conditions: [{ trigger: 'tag-match', conditionValue: '#inbox' }],
        action: 'remove-tag',
        actionTarget: '#inbox',
    },
];

/**
 * IPC ハンドラを登録する
 */
function register(ipcMain, ctx) {
    const { getCurrentVault, getConfig, saveConfig, getFilesRecursively, safeReadFile } = ctx;

    // ---- トリガー・アクション定義を返す（UI構築用）----
    ipcMain.handle('get-smart-rule-meta', () => ok({ triggers: TRIGGERS, actions: ACTIONS }));

    // ---- スマートルール CRUD ----
    ipcMain.handle('get-smart-rules', () => ok({ rules: getConfig().smartRules || [] }));

    ipcMain.handle('save-smart-rule', withErrorHandling('save-smart-rule', (_, rule) => {
        const config = getConfig();
        if (!config.smartRules) config.smartRules = [];
        const existing = config.smartRules.findIndex(r => r.id === rule.id);
        if (existing >= 0) {
            config.smartRules[existing] = rule;
        } else {
            rule.id = rule.id || crypto.randomUUID();
            config.smartRules.push(rule);
        }
        saveConfig(config);
        return ok({ rule });
    }));

    ipcMain.handle('delete-smart-rule', withErrorHandling('delete-smart-rule', (_, ruleId) => {
        const config = getConfig();
        config.smartRules = (config.smartRules || []).filter(r => r.id !== ruleId);
        saveConfig(config);
        return ok();
    }));

    ipcMain.handle('toggle-smart-rule', withErrorHandling('toggle-smart-rule', (_, { ruleId, enabled }) => {
        const config = getConfig();
        const rule = (config.smartRules || []).find(r => r.id === ruleId);
        if (rule) { rule.enabled = enabled; saveConfig(config); }
        return ok();
    }));

    // ルール並び順を更新
    ipcMain.handle('reorder-smart-rules', withErrorHandling('reorder-smart-rules', (_, orderedIds) => {
        const config = getConfig();
        const rules = config.smartRules || [];
        config.smartRules = orderedIds.map(id => rules.find(r => r.id === id)).filter(Boolean);
        // 並び順に含まれなかったルールを末尾に追加
        const extra = rules.filter(r => !orderedIds.includes(r.id));
        config.smartRules.push(...extra);
        saveConfig(config);
        return ok();
    }));

    ipcMain.handle('get-smart-rule-presets', () => ok({ presets: RULE_PRESETS }));

    // ---- 実行履歴 ----
    ipcMain.handle('get-smart-rule-history', () => {
        const config = getConfig();
        return ok({ history: config.smartRuleHistory || [] });
    });

    ipcMain.handle('clear-smart-rule-history', withErrorHandling('clear-smart-rule-history', () => {
        const config = getConfig();
        config.smartRuleHistory = [];
        saveConfig(config);
        return ok();
    }));

    // ---- プレビュー（ドライラン）----
    ipcMain.handle('preview-smart-rules', withErrorHandling('preview-smart-rules', async () => {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return fail('Vaultが設定されていません', 'preview-smart-rules');
        const rules = (getConfig().smartRules || []).filter(r => r.enabled);
        if (rules.length === 0) return ok({ preview: [], message: '有効なルールがありません' });

        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const preview = [];
        for (const rule of rules) {
            const matchedFiles = await matchRuleFiles(rule, vaultPath, allFiles, safeReadFile);
            const actionLabel = ACTIONS[rule.action]?.label || rule.action;
            preview.push({
                ruleId: rule.id,
                ruleName: rule.name || '名称未設定',
                action: rule.action,
                actionLabel,
                actionTarget: rule.actionTarget,
                matchCount: matchedFiles.length,
                samples: matchedFiles.slice(0, 5).map(f => path.basename(f, '.md')),
            });
        }
        return ok({ preview });
    }));

    // ---- ルール実行 ----
    ipcMain.handle('execute-smart-rules', withErrorHandling('execute-smart-rules', async () => {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return fail('Vaultが設定されていません', 'execute-smart-rules');
        const config = getConfig();
        const rules = (config.smartRules || []).filter(r => r.enabled);
        if (rules.length === 0) return ok({ executed: 0, message: '有効なルールがありません' });

        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        let totalExecuted = 0;
        const log = [];
        const ruleResults = [];

        for (const rule of rules) {
            const result = await executeRule(rule, vaultPath, allFiles, safeReadFile);
            totalExecuted += result.count;
            log.push(...result.log);
            ruleResults.push({ ruleId: rule.id, ruleName: rule.name || '名称未設定', count: result.count });
        }

        // 実行履歴を保存（最新30件）
        if (!config.smartRuleHistory) config.smartRuleHistory = [];
        config.smartRuleHistory.unshift({
            id: crypto.randomUUID(),
            executedAt: new Date().toISOString(),
            totalExecuted,
            ruleResults,
            log: log.slice(0, 50),
        });
        config.smartRuleHistory = config.smartRuleHistory.slice(0, 30);
        saveConfig(config);

        return ok({ executed: totalExecuted, log, ruleResults });
    }));

    // ---- スケジュールワークフロー ----
    ipcMain.handle('get-scheduled-workflows', () => ok({ workflows: getConfig().scheduledWorkflows || [] }));

    ipcMain.handle('save-scheduled-workflow', withErrorHandling('save-scheduled-workflow', (_, workflow) => {
        const config = getConfig();
        if (!config.scheduledWorkflows) config.scheduledWorkflows = [];
        workflow.id = workflow.id || crypto.randomUUID();
        const existing = config.scheduledWorkflows.findIndex(w => w.id === workflow.id);
        if (existing >= 0) config.scheduledWorkflows[existing] = workflow;
        else config.scheduledWorkflows.push(workflow);
        saveConfig(config);
        return ok({ workflow });
    }));

    ipcMain.handle('delete-scheduled-workflow', withErrorHandling('delete-scheduled-workflow', (_, id) => {
        const config = getConfig();
        config.scheduledWorkflows = (config.scheduledWorkflows || []).filter(w => w.id !== id);
        saveConfig(config);
        return ok();
    }));

    // ---- スマート復習キュー ----
    ipcMain.handle('get-review-queue', withErrorHandling('get-review-queue', async () => {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return fail('Vaultが設定されていません', 'get-review-queue');
        const config = getConfig();
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const now = Date.now();
        const queue = [];
        const dismissed = config.dismissedReviews || {};

        for (const file of allFiles) {
            const basename = path.basename(file, '.md');
            if (dismissed[basename] && now - dismissed[basename] < 30 * 86400000) continue;
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            const daysSinceAccess = Math.floor((now - stat.atimeMs) / 86400000);
            const daysSinceModify = Math.floor((now - stat.mtimeMs) / 86400000);
            if (daysSinceAccess >= 30 && daysSinceAccess <= 365 && daysSinceModify >= 30) {
                const content = await safeReadFile(file);
                const linkCount = content ? (content.match(/\[\[(.*?)\]\]/g) || []).length : 0;
                const charCount = content ? content.length : 0;
                const priority = Math.min(linkCount * 2 + Math.floor(charCount / 500), 100);
                queue.push({ name: basename, file, daysSinceAccess, daysSinceModify, priority, preview: content ? content.slice(0, 200) : '' });
            }
        }
        queue.sort((a, b) => b.priority - a.priority);
        return ok({ queue: queue.slice(0, 30), totalEligible: queue.length });
    }));

    ipcMain.handle('dismiss-review-item', withErrorHandling('dismiss-review-item', (_, { noteName }) => {
        const config = getConfig();
        if (!config.dismissedReviews) config.dismissedReviews = {};
        config.dismissedReviews[noteName] = Date.now();
        saveConfig(config);
        return ok();
    }));
}

// ======================================================
// 内部ヘルパー: 条件マッチ
// ======================================================

/**
 * 単一条件が1ファイルにマッチするか判定
 */
async function matchSingleCondition(condition, file, content, stat) {
    const { trigger, conditionValue } = condition;

    if (trigger === 'note-stale') {
        const days = parseInt(conditionValue) || 180;
        const cutoff = Date.now() - days * 86400000;
        return stat.mtimeMs < cutoff;
    }

    if (trigger === 'tag-match') {
        if (!content) return false;
        const rawTag = conditionValue || '';
        const tagWithHash = rawTag.startsWith('#') ? rawTag : `#${rawTag}`;
        const tagWithout = rawTag.startsWith('#') ? rawTag.slice(1) : rawTag;
        // frontmatter tags配列とインラインタグ両方を検索
        const fmMatch = new RegExp(`tags[\\s\\S]*?${tagWithout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm').test(content);
        const inlineMatch = content.includes(tagWithHash);
        return fmMatch || inlineMatch;
    }

    if (trigger === 'filename-pattern') {
        if (!conditionValue) return false;
        try {
            const re = new RegExp(conditionValue, 'i');
            return re.test(path.basename(file, '.md'));
        } catch (_) {
            return path.basename(file, '.md').toLowerCase().includes(conditionValue.toLowerCase());
        }
    }

    if (trigger === 'folder-match') {
        if (!conditionValue) return false;
        const rel = path.relative(path.dirname(path.dirname(file)), file);
        return file.includes(path.sep + conditionValue + path.sep) || file.includes('/' + conditionValue + '/');
    }

    if (trigger === 'content-keyword') {
        if (!content || !conditionValue) return false;
        return content.toLowerCase().includes(conditionValue.toLowerCase());
    }

    if (trigger === 'no-links') {
        if (!content) return true;
        const links = content.match(/\[\[.*?\]\]/g) || [];
        return links.length === 0;
    }

    if (trigger === 'frontmatter-field') {
        if (!content || !conditionValue) return false;
        const [key, val] = conditionValue.split('=');
        if (!key) return false;
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) return false;
        const fm = fmMatch[1];
        if (!val) return fm.includes(key.trim());
        const re = new RegExp(`${key.trim()}\\s*:\\s*["']?${val.trim()}["']?`, 'm');
        return re.test(fm);
    }

    return false;
}

/**
 * ルールにマッチするファイル一覧を返す（AND/OR対応）
 */
async function matchRuleFiles(rule, vaultPath, allFiles, safeReadFile) {
    const conditions = rule.conditions || [];
    // 旧形式（trigger直接指定）との互換性
    if (conditions.length === 0 && rule.trigger) {
        conditions.push({ trigger: rule.trigger, conditionValue: rule.condition?.days?.toString() || rule.condition?.tag || '' });
    }
    if (conditions.length === 0) return [];

    const logic = rule.logic || 'AND';
    const matched = [];

    for (const file of allFiles) {
        let stat;
        try { stat = fs.statSync(file); } catch (_) { continue; }
        const content = await safeReadFile(file);

        let results;
        if (logic === 'OR') {
            // OR: いずれか1つでも一致すればOK
            let anyMatch = false;
            for (const cond of conditions) {
                if (await matchSingleCondition(cond, file, content, stat)) { anyMatch = true; break; }
            }
            results = anyMatch;
        } else {
            // AND: 全条件が一致する必要あり
            let allMatch = true;
            for (const cond of conditions) {
                if (!await matchSingleCondition(cond, file, content, stat)) { allMatch = false; break; }
            }
            results = allMatch;
        }

        if (results) matched.push(file);
    }
    return matched;
}

// ======================================================
// 内部ヘルパー: アクション実行
// ======================================================

async function executeRule(rule, vaultPath, allFiles, safeReadFile) {
    const matchedFiles = await matchRuleFiles(rule, vaultPath, allFiles, safeReadFile);
    let count = 0;
    const log = [];
    const action = rule.action;
    const target = rule.actionTarget || '';

    for (const file of matchedFiles) {
        const basename = path.basename(file, '.md');
        try {
            if (action === 'archive' || action === 'move-folder') {
                const destDir = path.join(vaultPath, target || '99 Archive');
                fs.mkdirSync(destDir, { recursive: true });
                const dest = path.join(destDir, path.basename(file));
                if (!fs.existsSync(dest)) {
                    fs.renameSync(file, dest);
                    count++;
                    log.push(`${action === 'archive' ? '📦' : '📁'} "${basename}" → ${target}`);
                }

            } else if (action === 'tag') {
                let content = fs.readFileSync(file, 'utf-8');
                const tagToAdd = target.startsWith('#') ? target : `#${target}`;
                const tagName = tagToAdd.slice(1);
                if (!content.includes(tagToAdd) && !content.match(new RegExp(`tags[\\s\\S]*?${tagName}`))) {
                    content = addTagToContent(content, tagName);
                    fs.writeFileSync(file, content, 'utf-8');
                    count++;
                    log.push(`🏷️ "${basename}" にタグ ${tagToAdd} を追加`);
                }

            } else if (action === 'remove-tag') {
                let content = fs.readFileSync(file, 'utf-8');
                const tagToRemove = target.startsWith('#') ? target : `#${target}`;
                const tagName = tagToRemove.slice(1);
                const newContent = removeTagFromContent(content, tagName);
                if (newContent !== content) {
                    fs.writeFileSync(file, newContent, 'utf-8');
                    count++;
                    log.push(`🧹 "${basename}" からタグ ${tagToRemove} を削除`);
                }

            } else if (action === 'add-frontmatter') {
                let content = fs.readFileSync(file, 'utf-8');
                const [key, val] = target.split('=');
                if (!key) continue;
                const newContent = addFrontmatterField(content, key.trim(), val ? val.trim() : 'true');
                if (newContent !== content) {
                    fs.writeFileSync(file, newContent, 'utf-8');
                    count++;
                    log.push(`📋 "${basename}" に frontmatter ${target} を追加`);
                }

            } else if (action === 'add-to-moc') {
                const mocName = target || 'MOC';
                const mocPath = path.join(vaultPath, `${mocName}.md`);
                let mocContent = fs.existsSync(mocPath) ? fs.readFileSync(mocPath, 'utf-8') : `# ${mocName}\n\n`;
                if (!mocContent.includes(`[[${basename}]]`)) {
                    mocContent += `\n- [[${basename}]]`;
                    fs.writeFileSync(mocPath, mocContent, 'utf-8');
                    count++;
                    log.push(`🗺️ "${basename}" を ${mocName} に追加`);
                }

            } else if (action === 'rename-prefix') {
                const prefix = target || 'ARCHIVE_';
                const dir = path.dirname(file);
                const newName = prefix + path.basename(file);
                const newPath = path.join(dir, newName);
                if (!fs.existsSync(newPath)) {
                    fs.renameSync(file, newPath);
                    count++;
                    log.push(`✏️ "${basename}" → "${prefix}${basename}"`);
                }
            }
        } catch (err) {
            log.push(`❌ "${basename}" 処理エラー: ${err.message}`);
        }
    }
    return { count, log };
}

// ======================================================
// 内部ヘルパー: frontmatter操作
// ======================================================

function addTagToContent(content, tagName) {
    // frontmatterがある場合はtags配列に追加
    if (/^---\n/.test(content)) {
        if (/^tags\s*:/m.test(content)) {
            // tags: [a, b] 形式
            return content.replace(/^(tags\s*:\s*\[)(.*?)(\])/m, (_, pre, inner, post) => {
                const tags = inner.split(',').map(t => t.trim()).filter(Boolean);
                if (!tags.includes(tagName)) tags.push(tagName);
                return `${pre}${tags.join(', ')}${post}`;
            });
        } else {
            // frontmatterにtags追加
            return content.replace(/^(---\n)/, `$1tags: [${tagName}]\n`);
        }
    }
    // frontmatterなし → 新規作成
    return `---\ntags: [${tagName}]\n---\n\n${content}`;
}

function removeTagFromContent(content, tagName) {
    // frontmatter tags配列から削除
    let result = content.replace(/^(tags\s*:\s*\[)(.*?)(\])/m, (_, pre, inner, post) => {
        const tags = inner.split(',').map(t => t.trim()).filter(t => t && t !== tagName);
        return `${pre}${tags.join(', ')}${post}`;
    });
    // インラインタグを削除（スペース区切り）
    result = result.replace(new RegExp(`(^|\\s)#${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'gm'), '$1$2');
    return result;
}

function addFrontmatterField(content, key, value) {
    if (/^---\n/.test(content)) {
        // すでにそのキーがあれば更新
        if (new RegExp(`^${key}\\s*:`, 'm').test(content)) {
            return content.replace(new RegExp(`^(${key}\\s*:).*`, 'm'), `$1 ${value}`);
        }
        // frontmatterの末尾に追加
        return content.replace(/^(---\n[\s\S]*?)(---)/m, `$1${key}: ${value}\n$2`);
    }
    return `---\n${key}: ${value}\n---\n\n${content}`;
}

module.exports = { register };
