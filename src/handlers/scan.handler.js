'use strict';

const path = require('path');
const fs = require('fs');

// ======================================================
// スキャン系IPCハンドラ
// ======================================================

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{
 *   getCurrentVault: () => string|null,
 *   getFilesRecursively: (dir: string) => string[],
 *   doScanVault: (sender: any) => Promise<object>,
 *   getScanCancelFlag: () => boolean,
 *   setScanCancelFlag: (val: boolean) => void,
 *   isJunkFile: (file: string, content: string, rules: object) => object,
 *   config: object,
 *   DEFAULT_JUNK_RULES: object,
 *   DEFAULT_RULES: object,
 *   getScanFolders: (vaultPath: string) => string[],
 *   safeReadFileSync: (filePath: string) => string|null,
 *   dialog: Electron.Dialog,
 * }} ctx
 */
function register(ipcMain, { getCurrentVault, getFilesRecursively, doScanVault, getScanCancelFlag, setScanCancelFlag, isJunkFile, config, DEFAULT_JUNK_RULES, DEFAULT_RULES, getScanFolders, safeReadFileSync, dialog }) {

    // Vaultスキャン実行
    ipcMain.handle('scan-vault', async (event) => {
        setScanCancelFlag(false);
        return await doScanVault(event.sender);
    });

    // スキャンキャンセル
    ipcMain.handle('cancel-scan', () => {
        setScanCancelFlag(true);
        return { success: true };
    });

    // ======================================================
    // ドライラン
    // ======================================================
    ipcMain.handle('dry-run', async () => {
        const VAULT_PATH = getCurrentVault();
        if (!VAULT_PATH || !fs.existsSync(VAULT_PATH)) {
            return { success: false, error: 'Vault が設定されていません。「追加」ボタンから Vault フォルダを選択してください。' };
        }
        try {
            const preview = { junkToDelete: [], orphansToLink: [] };
            const rules = config.rules || DEFAULT_RULES;
            const junkRules = config.junkRules || DEFAULT_JUNK_RULES;
            const LINK_RE = /\[\[(.*?)\]\]/g;

            if (config.enableJunk !== false) {
                const dryRunFolders = getScanFolders(VAULT_PATH);
                for (const folder of dryRunFolders) {
                    const folderPath = path.join(VAULT_PATH, folder);
                    const files = getFilesRecursively(folderPath);
                    for (const file of files) {
                        if (!file.endsWith('.md')) continue;
                        const content = safeReadFileSync(file);
                        if (content === null) continue;
                        const result = isJunkFile(file, content, junkRules);
                        if (result.junk) {
                            preview.junkToDelete.push({ name: path.basename(file, '.md'), path: file, reason: result.reason });
                        }
                    }
                }
                // ルート直下のmdファイルもチェック
                const rootMds = fs.readdirSync(VAULT_PATH).filter(f => f.endsWith('.md')).map(f => path.join(VAULT_PATH, f));
                for (const file of rootMds) {
                    const content = safeReadFileSync(file);
                    if (content === null) continue;
                    const result = isJunkFile(file, content, junkRules);
                    if (result.junk) {
                        preview.junkToDelete.push({ name: path.basename(file, '.md'), path: file, reason: result.reason });
                    }
                }
            }

            const links = {};
            const allFiles = {};
            // フォルダ内 + ルート直下の全mdファイルを解析
            const allDryRunLinkTargets = [];
            const dryRunLinkFolders = getScanFolders(VAULT_PATH);
            for (const folder of dryRunLinkFolders) {
                const folderPath = path.join(VAULT_PATH, folder);
                const files = getFilesRecursively(folderPath);
                allDryRunLinkTargets.push(...files);
            }
            const rootMdsForDryLinks = fs.readdirSync(VAULT_PATH).filter(f => f.endsWith('.md')).map(f => path.join(VAULT_PATH, f));
            allDryRunLinkTargets.push(...rootMdsForDryLinks);

            for (const file of allDryRunLinkTargets) {
                if (!file.endsWith('.md')) continue;
                const basename = path.basename(file, '.md');
                allFiles[basename] = file;
                const content = safeReadFileSync(file);
                if (content === null) continue;
                links[basename] = [];
                let m;
                const lr = new RegExp(LINK_RE.source, 'g');
                while ((m = lr.exec(content)) !== null) {
                    const dest = m[1].split('|')[0].split('#')[0].trim();
                    if (dest) links[basename].push(dest);
                }
            }
            const incoming = {};
            for (const f in allFiles) incoming[f] = 0;
            for (const src in links) {
                for (const dest of links[src]) {
                    if (incoming[dest] !== undefined) incoming[dest]++;
                }
            }
            const excludePatterns = ['MOC', 'Template', 'Dashboard', 'Inbox', 'Archive'];
            if (config.enableMoc !== false) {
                for (const f in allFiles) {
                    const outLinks = links[f] || [];
                    const isExcluded = excludePatterns.some(p => f.includes(p)) || f.startsWith('_') || f.startsWith('00 ');
                    if (outLinks.length === 0 && incoming[f] === 0 && !isExcluded) {
                        let cat = 'その他';
                        const lk = f.toLowerCase();
                        for (const [catName, rule] of Object.entries(rules)) {
                            if (rule.keywords.some(kw => lk.includes(kw.toLowerCase()))) { cat = catName; break; }
                        }
                        const targetMoc = (rules[cat] && rules[cat].moc) || '_Uncategorized Orphans';
                        preview.orphansToLink.push({ name: f, path: allFiles[f], category: cat, targetMoc });
                    }
                }
            }

            return { success: true, preview };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { register };
