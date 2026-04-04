'use strict';

// ======================================================
// MOC系IPCハンドラ
// ======================================================

// Vault内テンプレートの検索パス
const TEMPLATE_SEARCH_PATHS = [
    'MOC Template.md',
    'Templates',
];

// 除外エントリ（隠しフォルダ等）
const EXCLUDE_ENTRIES = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store', 'dist']);

/**
 * Vault内のフォルダ一覧を取得（第1階層 + 第2階層まで）
 * @param {string} vaultPath
 * @param {number} maxDepth
 * @param {object} fsModule
 * @param {object} pathModule
 * @returns {string[]}
 */
function getVaultFolders(vaultPath, maxDepth = 2, fsModule, pathModule) {
    const folders = [];
    function walk(dir, depth) {
        if (depth > maxDepth) return;
        try {
            const entries = fsModule.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith('.') || EXCLUDE_ENTRIES.has(entry.name)) continue;
                const rel = pathModule.relative(vaultPath, pathModule.join(dir, entry.name));
                folders.push(rel);
                walk(pathModule.join(dir, entry.name), depth + 1);
            }
        } catch (_) { /* ignore */ }
    }
    walk(vaultPath, 1);
    return folders.sort();
}

/**
 * Vault内のMOCファイル一覧を取得
 * @param {string} vaultPath
 * @param {Function} getFilesRecursively
 * @param {object} pathModule
 * @returns {Array<{name: string, path: string}>}
 */
function getExistingMocs(vaultPath, getFilesRecursively, pathModule) {
    const mocs = [];
    const allFiles = getFilesRecursively(vaultPath);
    for (const file of allFiles) {
        if (!file.endsWith('.md')) continue;
        const basename = pathModule.basename(file, '.md');
        if (basename.includes('MOC') || basename.startsWith('_MOC')) {
            mocs.push({
                name: basename,
                path: pathModule.relative(vaultPath, file),
            });
        }
    }
    return mocs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Vault内のテンプレートファイルを読み込む
 * @param {string} vaultPath
 * @param {object} fsModule
 * @param {object} pathModule
 * @returns {Array}
 */
function loadVaultTemplates(vaultPath, fsModule, pathModule) {
    const templates = [];
    const systemDir = pathModule.join(vaultPath, '90 System');

    for (const searchPath of TEMPLATE_SEARCH_PATHS) {
        const fullPath = pathModule.join(systemDir, searchPath);
        try {
            const stat = fsModule.statSync(fullPath);
            if (stat.isFile() && fullPath.endsWith('.md')) {
                // 単一テンプレートファイル
                const content = fsModule.readFileSync(fullPath, 'utf-8');
                templates.push({
                    id: `vault:${pathModule.basename(fullPath, '.md')}`,
                    name: pathModule.basename(fullPath, '.md'),
                    description: 'Vault内テンプレート',
                    source: 'vault',
                    filePath: fullPath,
                    body: content,
                });
            } else if (stat.isDirectory()) {
                // テンプレートフォルダ内を検索
                const files = fsModule.readdirSync(fullPath);
                for (const file of files) {
                    if (!file.endsWith('.md')) continue;
                    if (!file.toLowerCase().includes('moc')) continue;
                    const fp = pathModule.join(fullPath, file);
                    const content = fsModule.readFileSync(fp, 'utf-8');
                    templates.push({
                        id: `vault:${pathModule.basename(file, '.md')}`,
                        name: pathModule.basename(file, '.md'),
                        description: 'Vault内テンプレート',
                        source: 'vault',
                        filePath: fp,
                        body: content,
                    });
                }
            }
        } catch (_) { /* パスが存在しない場合は無視 */ }
    }
    return templates;
}

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{
 *   getCurrentVault: () => string|null,
 *   getFilesRecursively: (dir: string) => string[],
 *   config: object,
 *   saveConfig: (c: object) => void,
 *   DEFAULT_MOC_TEMPLATES: Array,
 *   fs: object,
 *   path: object,
 * }} ctx
 */
function register(ipcMain, { getCurrentVault, getFilesRecursively, config, saveConfig, DEFAULT_MOC_TEMPLATES, fs, path }) {

    // --- IPCハンドラ: テンプレート一覧 ---
    ipcMain.handle('get-moc-templates', () => {
        try {
            const vaultPath = getCurrentVault();
            const vaultTemplates = vaultPath ? loadVaultTemplates(vaultPath, fs, path) : [];
            const configTemplates = (config.mocTemplates || []).map(t => ({
                ...t,
                source: 'config',
            }));
            return {
                success: true,
                templates: [...DEFAULT_MOC_TEMPLATES, ...vaultTemplates, ...configTemplates],
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // --- IPCハンドラ: テンプレート保存 ---
    ipcMain.handle('save-moc-template', (_, template) => {
        try {
            if (!config.mocTemplates) config.mocTemplates = [];
            const id = `custom-${Date.now()}`;
            const newTemplate = {
                id,
                name: template.name || '無題テンプレート',
                description: template.description || '',
                body: template.body || '',
            };
            config.mocTemplates.push(newTemplate);
            saveConfig(config);
            return { success: true, id };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // --- IPCハンドラ: テンプレート削除 ---
    ipcMain.handle('delete-moc-template', (_, id) => {
        try {
            if (!config.mocTemplates) return { success: true };
            config.mocTemplates = config.mocTemplates.filter(t => t.id !== id);
            saveConfig(config);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // --- IPCハンドラ: Vaultフォルダ一覧 ---
    ipcMain.handle('get-vault-folders', () => {
        try {
            const vaultPath = getCurrentVault();
            if (!vaultPath) return { success: true, folders: [] };
            const folders = getVaultFolders(vaultPath, 2, fs, path);
            return { success: true, folders };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });

    // --- IPCハンドラ: 既存MOC一覧 ---
    ipcMain.handle('get-existing-mocs', () => {
        try {
            const vaultPath = getCurrentVault();
            if (!vaultPath) return { success: true, mocs: [] };
            const mocs = getExistingMocs(vaultPath, getFilesRecursively, path);
            return { success: true, mocs };
        } catch (e) {
            return { success: false, error: e.message };
        }
    });
}

module.exports = { register };
