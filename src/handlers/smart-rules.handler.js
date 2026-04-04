'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

// ======================================================
// スマートルール・ワークフロー・復習キューハンドラ
// ======================================================

/** スマートルールのデフォルトプリセット定義 */
const RULE_PRESETS = [
    {
        id: 'preset-stale-180',
        label: '📦 180日放置ノートをアーカイブ',
        trigger: 'note-stale',
        condition: { days: 180 },
        action: 'archive',
        actionTarget: '99 Archive',
    },
    {
        id: 'preset-stale-30-tag',
        label: '🏷️ 30日放置ノートに#staleタグを付与',
        trigger: 'note-stale',
        condition: { days: 30 },
        action: 'tag',
        actionTarget: '#stale',
    },
    {
        id: 'preset-inbox-tag',
        label: '📂 #inboxタグのノートをMOCに追加',
        trigger: 'tag-match',
        condition: { tag: '#inbox' },
        action: 'add-to-moc',
        actionTarget: 'Inbox MOC',
    },
];

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{
 *   getCurrentVault: () => string|null,
 *   getConfig: () => object,
 *   saveConfig: (c: object) => void,
 *   getFilesRecursively: (dir: string) => string[],
 *   safeReadFile: (filePath: string, timeout?: number) => Promise<string|null>,
 * }} ctx
 */
function register(ipcMain, ctx) {
    const { getCurrentVault, getConfig, saveConfig, getFilesRecursively, safeReadFile } = ctx;

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

    ipcMain.handle('get-smart-rule-presets', () => ok({ presets: RULE_PRESETS }));

    // ---- スマートルール実行 ----

    ipcMain.handle('preview-smart-rules', withErrorHandling('preview-smart-rules', async () => {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return fail('Vaultが設定されていません', 'preview-smart-rules');
        const rules = (getConfig().smartRules || []).filter(r => r.enabled);
        if (rules.length === 0) return ok({ preview: [], message: '有効なルールがありません' });

        const preview = [];
        for (const rule of rules) {
            const matchedFiles = await matchRuleFiles(rule, vaultPath, getFilesRecursively, safeReadFile);
            preview.push({
                ruleId: rule.id,
                trigger: rule.trigger,
                action: rule.action,
                actionTarget: rule.actionTarget,
                matchCount: matchedFiles.length,
                samples: matchedFiles.slice(0, 5),
            });
        }
        return ok({ preview });
    }));

    ipcMain.handle('execute-smart-rules', withErrorHandling('execute-smart-rules', async () => {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return fail('Vaultが設定されていません', 'execute-smart-rules');
        const rules = (getConfig().smartRules || []).filter(r => r.enabled);
        if (rules.length === 0) return ok({ executed: 0, message: '有効なルールがありません' });

        let actionsExecuted = 0;
        const log = [];
        for (const rule of rules) {
            const result = await executeRule(rule, vaultPath, getFilesRecursively, safeReadFile);
            actionsExecuted += result.count;
            log.push(...result.log);
        }
        return ok({ executed: actionsExecuted, log });
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
// 内部ヘルパー
// ======================================================

/** ルール条件に合致するファイル名一覧を返す */
async function matchRuleFiles(rule, vaultPath, getFilesRecursively, safeReadFile) {
    const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
    const matched = [];
    if (rule.trigger === 'note-stale') {
        const cutoff = Date.now() - (rule.condition?.days || 180) * 86400000;
        for (const file of allFiles) {
            try { if (fs.statSync(file).mtimeMs < cutoff) matched.push(path.basename(file, '.md')); } catch (_) {}
        }
    } else if (rule.trigger === 'tag-match') {
        const rawTag = rule.condition?.tag || '';
        const tagWithHash = rawTag.startsWith('#') ? rawTag : `#${rawTag}`;
        const tagWithout = rawTag.startsWith('#') ? rawTag.slice(1) : rawTag;
        const tagRe = new RegExp(`(^|\\s|,)${tagWithout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|,|$)`, 'm');
        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            if (content.includes(tagWithHash) || tagRe.test(content)) matched.push(path.basename(file, '.md'));
        }
    }
    return matched;
}

/** ルールを実際に実行して { count, log } を返す */
async function executeRule(rule, vaultPath, getFilesRecursively, safeReadFile) {
    const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
    let count = 0;
    const log = [];

    if (rule.trigger === 'note-stale') {
        const cutoff = Date.now() - (rule.condition?.days || 180) * 86400000;
        for (const file of allFiles) {
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            if (stat.mtimeMs >= cutoff) continue;
            if (rule.action === 'archive') {
                const archiveDir = path.join(vaultPath, rule.actionTarget || '99 Archive');
                fs.mkdirSync(archiveDir, { recursive: true });
                const dest = path.join(archiveDir, path.basename(file));
                if (!fs.existsSync(dest)) { fs.renameSync(file, dest); count++; log.push(`📦 ${path.basename(file)} をアーカイブ`); }
            } else if (rule.action === 'tag') {
                let content = fs.readFileSync(file, 'utf-8');
                const tagToAdd = rule.actionTarget || '#stale';
                if (!content.includes(tagToAdd)) {
                    content = /^---\n/.test(content)
                        ? content.replace(/^(---\n[\s\S]*?\n---)/, `$1\ntags: [${tagToAdd.replace(/^#/, '')}]`)
                        : `---\ntags: [${tagToAdd.replace(/^#/, '')}]\n---\n\n${content}`;
                    fs.writeFileSync(file, content, 'utf-8');
                    count++;
                    log.push(`🏷️ ${path.basename(file, '.md')} にタグ追加`);
                }
            }
        }
    } else if (rule.trigger === 'tag-match') {
        const rawTag = rule.condition?.tag;
        if (!rawTag) return { count, log };
        const tagWithHash = rawTag.startsWith('#') ? rawTag : `#${rawTag}`;
        const tagWithout = rawTag.startsWith('#') ? rawTag.slice(1) : rawTag;
        const tagRe = new RegExp(`(^|\\s|,)${tagWithout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|,|$)`, 'm');
        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            if (!content.includes(tagWithHash) && !tagRe.test(content)) continue;
            if (rule.action === 'add-to-moc') {
                const mocPath = path.join(vaultPath, rule.actionTarget || 'MOC.md');
                const basename = path.basename(file, '.md');
                let mocContent = fs.existsSync(mocPath) ? fs.readFileSync(mocPath, 'utf-8') : `# ${rule.actionTarget || 'MOC'}\n\n`;
                if (!mocContent.includes(`[[${basename}]]`)) {
                    mocContent += `\n- [[${basename}]]`;
                    fs.writeFileSync(mocPath, mocContent, 'utf-8');
                    count++;
                    log.push(`🗺️ ${basename} をMOCに追加`);
                }
            } else if (rule.action === 'archive') {
                const archiveDir = path.join(vaultPath, rule.actionTarget || '99 Archive');
                fs.mkdirSync(archiveDir, { recursive: true });
                const dest = path.join(archiveDir, path.basename(file));
                if (!fs.existsSync(dest)) { fs.renameSync(file, dest); count++; log.push(`📦 ${path.basename(file, '.md')} をアーカイブ`); }
            }
        }
    }
    return { count, log };
}

module.exports = { register };
