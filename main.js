const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

// 単一インスタンス制御: 二重起動を防止
// ※ requestSingleInstanceLock は壊れたインストール残骸がある場合に
//    誤判定するため、失敗してもアプリを終了させず続行する
let gotTheLock = true;
try {
    gotTheLock = app.requestSingleInstanceLock();
} catch (_) {
    // ロック取得に失敗してもアプリは起動させる
    gotTheLock = true;
}
if (!gotTheLock) {
    // 本当に別インスタンスが動いている場合のみ終了
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length > 0) {
        app.quit();
    }
} else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}

// ユーザーのシステム設定に関わらずダークモードを強制
nativeTheme.themeSource = 'dark';

// ======================================================
// 定数
// ======================================================
const CONFIG_PATH = path.join(os.homedir(), '.obsidian-optimizer-config.json');
const BACKUP_DIR = path.join(os.homedir(), '.obsidian-optimizer-backups');

// スキャン除外エントリ（Obsidian内部・隠しフォルダ・システムファイル）— 全箇所で統一使用
const EXCLUDE_ENTRIES = new Set(['.obsidian', '.trash', '.git', 'node_modules', '.DS_Store', 'dist']);

// Vault内の実際のフォルダを動的に取得する（ルート直下1階層）
function getScanFolders(vaultPath) {
    if (!vaultPath || !fs.existsSync(vaultPath)) return [];
    try {
        return fs.readdirSync(vaultPath, { withFileTypes: true })
            .filter(d => d.isDirectory() && !EXCLUDE_ENTRIES.has(d.name) && !d.name.startsWith('.'))
            .map(d => d.name);
    } catch (_) { return []; }
}

const DEFAULT_JUNK_RULES = {
    minChars: 20,
    minBytes: 5,
    keywords: ['untitled', '無題'],
};

const DEFAULT_RULES = {
    'AI・LLM': { keywords: ['ai', 'dify', 'genspark', 'gpt', 'claude', 'llm', 'プロンプト', 'chatgpt', 'gemini'], moc: 'MOC - AI Tools & Platforms' },
    'Threads': { keywords: ['threads', 'スレ'], moc: 'MOC - Threads' },
    'Note': { keywords: ['note'], moc: 'MOC- note' },
    'マーケティング': { keywords: ['マーケティング', 'seo', 'マーケ', 'バズ', 'cvr', 'lp', 'ランディング'], moc: 'MOC- マーケティング' },
    '開発・技術': { keywords: ['開発', 'プログラミング', 'coding', 'antigravity', 'python', 'react', 'next.js', 'テック', 'javascript', 'typescript'], moc: 'MOC - Dev Skills & Engineering' },
    'SNS': { keywords: ['sns', 'twitter', 'instagram', 'x.com', 'post', 'tiktok'], moc: 'MOC - SNS Strategy' },
    'ビジネス': { keywords: ['ビジネス', '事業', '起業', '収益', 'revenue', 'saas', 'スタートアップ'], moc: 'MOC - Business Strategy' },
    '学習': { keywords: ['学習', '勉強', 'study', 'learn', '読書', 'book'], moc: 'MOC - Learning' },
};

// ======================================================
// Config管理
// ======================================================
function getDefaultVaultPath() {
    const candidates = [
        path.join(os.homedir(), 'Documents', 'GitHub', 'ObsidianSync'),
        path.join(os.homedir(), 'ObsidianSync'),
        path.join(os.homedir(), 'Documents', 'ObsidianSync'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p) && isLikelyVault(p)) return p;
    }
    // Vaultが見つからない場合はnullを返し、ユーザーに手動選択を促す
    return null;
}

// パスを正規化して比較可能にする（末尾スラッシュ除去・絶対パス化）
function normalizePath(p) {
    if (!p) return '';
    return path.resolve(p);
}

// パストラバーサル防御: 指定パスがVault内にあることを検証
function isPathInsideVault(filePath) {
    const vaultPath = getCurrentVault();
    if (!vaultPath || !filePath) return false;
    const resolved = path.resolve(filePath);
    return resolved.startsWith(vaultPath + path.sep) || resolved === vaultPath;
}

function isLikelyVault(dirPath) {
    return fs.existsSync(path.join(dirPath, '.obsidian'));
}

function loadConfig() {
    let cfg = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('設定ファイルの読み込みに失敗（デフォルト設定で起動します）:', e.message);
    }

    // v4.0 マイグレーション (単一Vaultから複数Vaultへ)
    if (cfg.vaultPath && !cfg.vaults) {
        cfg.vaults = [cfg.vaultPath];
        cfg.currentVaultIndex = 0;
        delete cfg.vaultPath;
    }

    if (!cfg.vaults || cfg.vaults.length === 0) {
        const detected = getDefaultVaultPath();
        cfg.vaults = detected ? [detected] : [];
        cfg.currentVaultIndex = 0;
    }

    // 存在しないパスを除去し、残りのパスを正規化
    cfg.vaults = cfg.vaults
        .filter(v => v && fs.existsSync(v))
        .map(v => normalizePath(v));

    if (cfg.currentVaultIndex >= cfg.vaults.length) cfg.currentVaultIndex = Math.max(0, cfg.vaults.length - 1);

    return {
        vaults: cfg.vaults,
        currentVaultIndex: cfg.currentVaultIndex,
        rules: cfg.rules || DEFAULT_RULES,
        junkRules: cfg.junkRules || DEFAULT_JUNK_RULES,
        backupBeforeDelete: cfg.backupBeforeDelete !== false,
        staleDays: cfg.staleDays ?? 180,
        rareTagThreshold: cfg.rareTagThreshold ?? 1,
        autoScanIntervalHours: cfg.autoScanIntervalHours ?? 0,
        enableJunk: cfg.enableJunk !== undefined ? cfg.enableJunk : true,
        enableMoc: cfg.enableMoc !== undefined ? cfg.enableMoc : true,
        junkAction: cfg.junkAction || 'delete',
        autoReportEnabled: cfg.autoReportEnabled || false,
        aiProvider: cfg.aiProvider || 'claude',
        aiApiKey: cfg.aiApiKey || '',
        aiModel: cfg.aiModel || '',
        // Feature 8: ゲーミフィケーション
        achievements: cfg.achievements || { junksDeleted: 0, linksFixed: 0, mocsCreated: 0, scansCompleted: 0, bestScore: 0, lastScanDate: null, streakDays: 0 },
        // Feature 10: 自動スキャンスケジュール
        autoScanSchedule: cfg.autoScanSchedule || 'off',
        // Feature 12: ダッシュボードウィジェット
        dashboardWidgets: cfg.dashboardWidgets || { healthScore: true, heatmap: true, folderDist: true, timeMachine: true, achievements: true, trends: true, noteScore: true },
    };
}

function saveConfig(cfg) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    } catch (e) {
        console.error('設定ファイルの保存に失敗:', e.message);
    }
}

let config = loadConfig();
let autoScanTimer = null;
let scanCancelFlag = false;
let lastOperation = null; // { type: 'delete'|'move'|'optimize', backupPath, files: [{path, ...}], timestamp }

function getCurrentVault() {
    if (!config.vaults || config.vaults.length === 0) return null;
    const vault = config.vaults[config.currentVaultIndex];
    return vault ? normalizePath(vault) : null;
}

// ======================================================
// 自動スキャン通知
// ======================================================
function startAutoScan() {
    if (autoScanTimer) clearInterval(autoScanTimer);
    if (!config.autoScanIntervalHours || config.autoScanIntervalHours <= 0) return;

    const ms = config.autoScanIntervalHours * 60 * 60 * 1000;
    autoScanTimer = setInterval(async () => {
        try {
            const res = await doScanVault();
            if (res && res.success) {
                const s = res.stats;
                const problems = s.orphanNotes + s.junkFiles + s.brokenLinksCount;
                if (problems > 0 && Notification.isSupported()) {
                    new Notification({
                        title: 'Obsidian Optimizer 定期チェック',
                        body: `孤立:${s.orphanNotes} / ゴミ:${s.junkFiles} / リンク切れ:${s.brokenLinksCount} が見つかりました`
                    }).show();
                }
                // Feature 6: 自動レポート保存
                if (config.autoReportEnabled) {
                    try {
                        const vaultPath = getCurrentVault();
                        if (vaultPath) {
                            const reportDir = path.join(vaultPath, '.optimizer-reports');
                            fs.mkdirSync(reportDir, { recursive: true });
                            const dateStr = new Date().toISOString().split('T')[0];
                            const reportPath = path.join(reportDir, `report-${dateStr}.md`);
                            fs.writeFileSync(reportPath, generateReportContent(s), 'utf-8');
                        }
                    } catch (reportErr) { console.error('Auto report error:', reportErr); }
                }
            }
        } catch (e) { console.error('Auto scan error:', e); }
    }, ms);
}

// ======================================================
// ウィンドウ作成
// ======================================================
let mainWindowRef = null;

function createWindow() {
    const isMac = process.platform === 'darwin';
    const windowOptions = {
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        backgroundColor: '#0b0f1e',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    };
    // macOS専用: タイトルバーを隠してトラフィックライトをカスタム配置
    if (isMac) {
        windowOptions.titleBarStyle = 'hiddenInset';
        windowOptions.trafficLightPosition = { x: 18, y: 18 };
    }
    const mainWindow = new BrowserWindow(windowOptions);
    mainWindowRef = mainWindow;
    mainWindow.loadFile('index.html');
}

// 30日以上経過した古いバックアップを自動削除
function cleanupOldBackups() {
    const MAX_BACKUP_AGE_DAYS = 30;
    const MAX_BACKUP_AGE_MS = MAX_BACKUP_AGE_DAYS * 24 * 60 * 60 * 1000;
    try {
        if (!fs.existsSync(BACKUP_DIR)) return;
        const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
        const now = Date.now();
        let deletedCount = 0;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            // フォルダ名からタイムスタンプをパース（例: backup-2024-03-15T10-30-00）
            const tsMatch = entry.name.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
            if (!tsMatch) continue;
            const folderDate = new Date(`${tsMatch[1]}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}`);
            if (isNaN(folderDate.getTime())) continue;
            if (now - folderDate.getTime() > MAX_BACKUP_AGE_MS) {
                const fullPath = path.join(BACKUP_DIR, entry.name);
                try {
                    fs.rmSync(fullPath, { recursive: true, force: true });
                    deletedCount++;
                } catch (rmErr) {
                    console.error(`古いバックアップ削除失敗: ${entry.name}`, rmErr.message);
                }
            }
        }
        if (deletedCount > 0) {
            console.log(`古いバックアップを${deletedCount}件削除しました（${MAX_BACKUP_AGE_DAYS}日以上経過）`);
        }
    } catch (e) {
        console.error('バックアップクリーンアップエラー:', e.message);
    }
}

app.whenReady().then(() => {
    createWindow();
    startAutoScan();
    startScheduledScan();
    cleanupOldBackups();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// NSIS更新時のクリーンシャットダウン: タイマーを確実に解放しプロセス終了を保証
app.on('before-quit', () => {
    if (autoScanTimer) {
        clearInterval(autoScanTimer);
        autoScanTimer = null;
    }
    if (scheduledScanTimer) {
        clearInterval(scheduledScanTimer);
        scheduledScanTimer = null;
    }
});

app.on('window-all-closed', () => {
    if (autoScanTimer) {
        clearInterval(autoScanTimer);
        autoScanTimer = null;
    }
    if (scheduledScanTimer) {
        clearInterval(scheduledScanTimer);
        scheduledScanTimer = null;
    }
    if (process.platform !== 'darwin') app.quit();
});

// ======================================================
// ファジーマッチングアルゴリズム (Levenshtein Distance)
// ======================================================
function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

function findBestMatches(targetName, allFileNames) {
    const targetLow = targetName.toLowerCase();
    const ranked = allFileNames.map(f => {
        const basename = path.basename(f, '.md');
        const d = levenshtein(targetLow, basename.toLowerCase());
        // 完全一致と部分一致の場合はボーナス
        let score = d;
        if (basename.toLowerCase().includes(targetLow)) score -= 5;
        return { name: basename, score };
    });
    ranked.sort((a, b) => a.score - b.score);
    return ranked.slice(0, 3).filter(r => r.score < 10).map(r => r.name); // 近い上位3件
}

// ======================================================
// ゴミ判定ヘルパー
// ======================================================
function isJunkFile(filePath, content, junkRules) {
    const rules = junkRules || config.junkRules || DEFAULT_JUNK_RULES;
    const minBytes = rules.minBytes ?? 5;
    const minChars = rules.minChars ?? 20;
    const keywords = rules.keywords || ['untitled', '無題'];

    let stat;
    try { stat = fs.statSync(filePath); }
    catch (_) { return { junk: false }; }
    const lowerName = path.basename(filePath).toLowerCase();

    if (stat.size < minBytes) return { junk: true, reason: '空ファイル' };
    for (const kw of keywords) {
        if (lowerName.includes(kw.toLowerCase())) return { junk: true, reason: `無題 (${kw})` };
    }
    // フロントマターはファイル先頭の ---...--- のみ除去（本文中の水平線 --- を誤って消さない）
    const clean = content.replace(/^\s*---\n[\s\S]*?\n---/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
    if (clean.length < minChars) return { junk: true, reason: 'コンテンツなし' };
    return { junk: false };
}

// ======================================================
// ヘルパー: iCloud evicted（クラウドのみ）ファイル検出
// ======================================================
// macOS iCloud Drive: evictedファイルは .icloud プレースホルダーになるか、
// 読み取り時に ETIMEDOUT が発生する。xattr で com.apple.ubiquity.is-uploaded-by-icloud を検出
function isFileLocallyAvailable(filePath) {
    try {
        // .icloud プレースホルダーファイルをスキップ
        if (path.basename(filePath).startsWith('.') && filePath.endsWith('.icloud')) return false;
        // ファイルを非同期的に開いてすぐ閉じることで可用性をチェック
        const fd = fs.openSync(filePath, 'r');
        fs.closeSync(fd);
        return true;
    } catch (e) {
        // ETIMEDOUT, ENOENT等 → ローカルに利用不可
        return false;
    }
}

// ファイル内容を安全に読み取り（iCloudタイムアウト対策）
// 同期版: ETIMEDOUTをキャッチしてnullを返す
function safeReadFileSync(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
        if (e.code === 'ETIMEDOUT' || e.message.includes('timed out')) {
            return null;
        }
        throw e;
    }
}

// 非同期版: タイムアウト付きでファイルを読み取り（iCloud evicted対策の決定版）
// iCloud Driveのevictedファイルはreadが数秒ブロックするため、500msでタイムアウト
function safeReadFile(filePath, timeoutMs = 500) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        fs.readFile(filePath, 'utf-8', (err, data) => {
            clearTimeout(timer);
            if (err) { resolve(null); return; }
            resolve(data);
        });
    });
}

// ======================================================
// ヘルパー: 全ファイル取得
// ======================================================
function getFilesRecursively(dir) {
    let results = [];
    try {
        const list = fs.readdirSync(dir);
        for (const file of list) {
            if (file.startsWith('.') || EXCLUDE_ENTRIES.has(file)) continue;
            const fullPath = path.join(dir, file);
            let stat;
            try { stat = fs.statSync(fullPath); } catch (e) {
                // iCloud evicted や権限エラーでもスキップして続行
                continue;
            }
            if (stat && stat.isDirectory()) {
                results = results.concat(getFilesRecursively(fullPath));
            } else {
                results.push(fullPath);
            }
        }
    } catch (e) {
        // readdirSync自体のETIMEDOUTもキャッチ
        if (e.code !== 'ETIMEDOUT') console.error('getFilesRecursively error:', dir, e.code);
    }
    return results;
}

// ======================================================
// IPC ハンドラ群 - Config / Vault
// ======================================================
function getWin(event) {
    try { return BrowserWindow.fromWebContents(event.sender) || mainWindowRef; }
    catch (_) { return mainWindowRef; }
}

ipcMain.handle('get-config', () => ({
    vaults: config.vaults,
    currentVaultIndex: config.currentVaultIndex,
    vaultPath: getCurrentVault(),
    rules: config.rules || DEFAULT_RULES,
    junkRules: config.junkRules || DEFAULT_JUNK_RULES,
    backupBeforeDelete: config.backupBeforeDelete !== false,
    staleDays: config.staleDays,
    rareTagThreshold: config.rareTagThreshold,
    autoScanIntervalHours: config.autoScanIntervalHours,
    enableJunk: config.enableJunk,
    enableMoc: config.enableMoc,
    junkAction: config.junkAction,
    autoReportEnabled: config.autoReportEnabled,
    aiProvider: config.aiProvider,
    aiApiKey: config.aiApiKey ? '***' : '',
    aiModel: config.aiModel,
    achievements: config.achievements,
    autoScanSchedule: config.autoScanSchedule,
    dashboardWidgets: config.dashboardWidgets,
}));

ipcMain.handle('save-config-partial', (_, partial) => {
    // ネストされたオブジェクト（junkRules等）は浅いマージだとキーが消えるため、個別にマージする
    for (const key of Object.keys(partial)) {
        if (partial[key] && typeof partial[key] === 'object' && !Array.isArray(partial[key])
            && config[key] && typeof config[key] === 'object' && !Array.isArray(config[key])) {
            config[key] = { ...config[key], ...partial[key] };
        } else {
            config[key] = partial[key];
        }
    }
    saveConfig(config);
    if ('autoScanIntervalHours' in partial) startAutoScan();
    return true;
});

ipcMain.handle('switch-vault', (_, index) => {
    if (index >= 0 && index < config.vaults.length) {
        config.currentVaultIndex = index;
        saveConfig(config);
        return getCurrentVault();
    }
    return null;
});

ipcMain.handle('add-vault', async (event) => {
    const win = getWin(event);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths.length > 0) {
        const p = normalizePath(result.filePaths[0]);
        // 正規化して比較し、重複登録を防ぐ
        const alreadyExists = config.vaults.some(v => normalizePath(v) === p);
        if (!alreadyExists) {
            config.vaults.push(p);
            config.currentVaultIndex = config.vaults.length - 1;
            saveConfig(config);
        } else {
            // 既に登録済みならそのVaultに切り替え
            config.currentVaultIndex = config.vaults.findIndex(v => normalizePath(v) === p);
            saveConfig(config);
        }
        return config.vaults;
    }
    return null;
});

ipcMain.handle('remove-vault', (_, index) => {
    if (config.vaults.length <= 1) {
        return { error: 'Vaultが1つしかないため削除できません', vaults: config.vaults };
    }
    if (index >= 0 && index < config.vaults.length) {
        config.vaults.splice(index, 1);
        config.currentVaultIndex = 0;
        saveConfig(config);
    }
    return { vaults: config.vaults };
});

ipcMain.handle('check-vault', () => {
    const vp = getCurrentVault();
    if (!vp || !fs.existsSync(vp)) {
        return { vaultPath: vp || '(未設定)', valid: false, foundFolders: [], isObsidian: false, noVault: true };
    }
    const isObsidian = fs.existsSync(path.join(vp, '.obsidian'));
    const foundFolders = getScanFolders(vp);
    return { vaultPath: vp, valid: isObsidian || foundFolders.length >= 1, foundFolders, isObsidian };
});

ipcMain.handle('open-vault-folder', async () => {
    const vp = getCurrentVault();
    if (!vp) return;
    return shell.openPath(vp);
});

// Vault選択ダイアログ（add-vaultと同等の動作、後方互換性のため維持）
ipcMain.handle('select-vault-folder', async (event) => {
    const win = getWin(event);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (!result.canceled && result.filePaths.length > 0) {
        const p = normalizePath(result.filePaths[0]);
        const alreadyExists = config.vaults.some(v => normalizePath(v) === p);
        if (!alreadyExists) {
            config.vaults.push(p);
            config.currentVaultIndex = config.vaults.length - 1;
        } else {
            config.currentVaultIndex = config.vaults.findIndex(v => normalizePath(v) === p);
        }
        saveConfig(config);
        return p;
    }
    return null;
});

ipcMain.handle('open-path', async (_, filePath) => shell.openPath(filePath));

// インポート用パス選択（Vaultリストには追加しない）
ipcMain.handle('select-import-path', async (event, { type }) => {
    const win = getWin(event);
    if (type === 'file') {
        const result = await dialog.showOpenDialog(win, {
            properties: ['openFile'],
            filters: [
                { name: 'Evernote Export', extensions: ['enex'] },
                { name: 'All Files', extensions: ['*'] },
            ],
        });
        if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
    } else {
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
    }
    return null;
});

ipcMain.handle('open-in-obsidian', async (_, filePath) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const vaultName = path.basename(vaultPath);
        // filePathが絶対パスならrelativeに変換、既に相対パスならそのまま使う
        let relativePath;
        if (path.isAbsolute(filePath)) {
            relativePath = path.relative(vaultPath, filePath);
        } else {
            relativePath = filePath;
        }
        relativePath = relativePath.replace(/\.md$/, '');
        const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath)}`;
        await shell.openExternal(url);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// v4.0 Action Handlers
// ======================================================

// [アクション] 壊れたリンクの修正
ipcMain.handle('fix-broken-link', async (_, { srcFile, oldTarget, newTarget }) => {
    try {
        if (!isPathInsideVault(srcFile)) throw new Error('Vault外のファイルは操作できません');
        if (!fs.existsSync(srcFile)) throw new Error('Source file not found');
        let content = fs.readFileSync(srcFile, 'utf-8');
        const escaped = oldTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // エイリアス付きリンクを先に置換（[[OldTarget|Alias]] → [[NewTarget|Alias]]）
        const aliasMatchRe = new RegExp(`\\[\\[${escaped}\\|([^\\]]+)\\]\\]`, 'g');
        content = content.replace(aliasMatchRe, `[[${newTarget}|$1]]`);
        // 通常リンク置換（[[OldTarget]] → [[NewTarget]]）
        const exactMatchRe = new RegExp(`\\[\\[${escaped}\\]\\]`, 'g');
        content = content.replace(exactMatchRe, `[[${newTarget}]]`);

        fs.writeFileSync(srcFile, content, 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// [アクション] ファイルのバルク移動
ipcMain.handle('move-selected', async (_, { filePaths, targetFolder }) => {
    try {
        const VAULT_PATH = getCurrentVault();
        if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
        const destDir = path.join(VAULT_PATH, targetFolder);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        let moved = 0, errors = [];
        for (const fp of filePaths) {
            if (!isPathInsideVault(fp)) { errors.push(`${path.basename(fp)}: Vault外のファイルは操作できません`); continue; }
            if (!fs.existsSync(fp)) continue;
            const dest = path.join(destDir, path.basename(fp));
            try {
                fs.renameSync(fp, dest);
                moved++;
            } catch (err) {
                // EXDEV: クロスボリューム移動はrenameで失敗するためcopy+deleteにフォールバック
                if (err.code === 'EXDEV') {
                    try {
                        fs.copyFileSync(fp, dest);
                        fs.unlinkSync(fp);
                        moved++;
                    } catch (copyErr) {
                        errors.push(`${path.basename(fp)}: ${copyErr.message}`);
                    }
                } else {
                    errors.push(`${path.basename(fp)}: ${err.message}`);
                }
            }
        }
        return { success: true, moved, errors };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// [アクション] フォルダMOCの自動生成
ipcMain.handle('generate-folder-moc', async (_, { folderName, destFolder }) => {
    try {
        const VAULT_PATH = getCurrentVault();
        if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
        const folderPath = path.join(VAULT_PATH, folderName);
        if (!fs.existsSync(folderPath)) throw new Error('Folder does not exist');

        const files = getFilesRecursively(folderPath);
        const mdFiles = files.filter(f => f.endsWith('.md') && !path.basename(f).startsWith('_MOC'));
        if (mdFiles.length === 0) return { success: true, mocPath: null, generated: 0 };

        const mocTitle = `_MOC_${path.basename(folderName)}`;
        // destFolderが指定されていない場合はソースフォルダ直下に作成
        const outputDir = destFolder
            ? path.join(VAULT_PATH, destFolder)
            : folderPath;
        const mocPath = path.join(outputDir, `${mocTitle}.md`);

        let content = `# 🗺️ ${path.basename(folderName)} Directory MOC\n`;
        content += `tags: ["type/moc", "auto-generated"]\n\n`;
        content += `> このフォルダ内のノートを自動集約しました。\n\n`;
        content += `## Notes\n`;
        mdFiles.forEach(f => {
            const relPath = path.relative(VAULT_PATH, f).replace(/\.md$/, '');
            content += `- [[${relPath}|${path.basename(f, '.md')}]]\n`;
        });

        fs.mkdirSync(path.dirname(mocPath), { recursive: true });
        fs.writeFileSync(mocPath, content, 'utf-8');
        return { success: true, mocPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// [アクション] 個別ファイル削除
ipcMain.handle('delete-selected', async (_, filePaths) => {
    const doBackup = config.backupBeforeDelete !== false;
    const results = { deleted: 0, errors: [], backupPath: null };
    if (!filePaths || filePaths.length === 0) return { success: true, results };

    if (doBackup) {
        const vaultPath = getCurrentVault();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = path.join(BACKUP_DIR, `selected-${ts}`);
        fs.mkdirSync(backupPath, { recursive: true });
        results.backupPath = backupPath;
        for (const fp of filePaths) {
            if (!fs.existsSync(fp)) continue;
            const rel = vaultPath ? path.relative(vaultPath, fp) : path.basename(fp);
            const dest = path.join(backupPath, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            try { fs.copyFileSync(fp, dest); } catch (_) { }
        }
    }

    for (const fp of filePaths) {
        try {
            if (!isPathInsideVault(fp)) { results.errors.push(`${path.basename(fp)}: Vault外のファイルは削除できません`); continue; }
            if (fs.existsSync(fp)) { fs.unlinkSync(fp); results.deleted++; }
        } catch (e) {
            results.errors.push(`${path.basename(fp)}: ${e.message}`);
        }
    }

    // 元に戻す用の操作記録
    if (results.deleted > 0 && results.backupPath) {
        lastOperation = {
            type: 'delete',
            backupPath: results.backupPath,
            count: results.deleted,
            timestamp: Date.now(),
        };
    }

    return { success: true, results };
});


// ======================================================
// メインスキャン (doScanVault = ロジック本体)
// ======================================================
async function doScanVault(sender) {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) {
        return { success: false, error: 'Vault が設定されていません。「追加」ボタンから Vault フォルダを選択してください。' };
    }
    if (!fs.existsSync(VAULT_PATH)) {
        return { success: false, error: `Vault フォルダが見つかりません: ${VAULT_PATH}` };
    }
    try {
        const stats = {
            orphanNotes: 0, junkFiles: 0, totalFilesScanned: 0, totalMDFiles: 0, mocsCount: 0,
            folderStructure: {}, orphanList: [], junkList: [], duplicateList: [],
            brokenLinkList: [], brokenLinksCount: 0,
            tagStats: {}, topTags: [], rareTags: [], totalWords: 0, totalLinks: 0,
            staleList: [], heatmap: {}, // YYYY-MM-DD -> count
            // Feature 7: 孤立画像/添付ファイル検出
            orphanImages: [], orphanImageCount: 0, totalImages: 0,
        };

        const links = {};
        const allFiles = {};
        const nameLower = {};
        const contentHashes = {};
        const allImageFiles = []; // 画像/添付ファイル一覧
        const referencedImages = new Set(); // 参照されている画像名
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const IMAGE_EMBED_RE = /!\[\[([^\]]+)\]\]/g; // Obsidian埋め込み形式
        const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g; // Markdown画像形式
        const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.pdf', '.mp4', '.mp3']);
        const TAG_RE = /(?:^|\s)#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f/\-]+)/gm;
        const FRONTMATTER_TAG_RE = /^tags:\s*\[([^\]]+)\]/m;
        const junkRules = config.junkRules || DEFAULT_JUNK_RULES;

        const nowMs = Date.now();
        const staleLimitMs = (config.staleDays ?? 180) * 24 * 60 * 60 * 1000;

        // ファイル解析の共通処理（非同期: iCloud evicted対策）
        async function processFile(file, folderName) {
            stats.totalFilesScanned++;

            // 画像/添付ファイルの収集（Feature 7）
            const ext = path.extname(file).toLowerCase();
            if (IMAGE_EXTENSIONS.has(ext)) {
                let imgStat;
                try { imgStat = fs.statSync(file); } catch (_) { /* skip */ }
                allImageFiles.push({ name: path.basename(file), path: file, size: imgStat ? imgStat.size : 0, ext });
                return;
            }

            if (!file.endsWith('.md')) return;
            stats.totalMDFiles++;
            if (!stats.folderStructure[folderName]) stats.folderStructure[folderName] = 0;
            stats.folderStructure[folderName]++;

            const basename = path.basename(file, '.md');
            // 同名ファイル衝突対策: 先に登録済みなら相対パスをキーに使う
            const fileKey = allFiles[basename] ? path.relative(VAULT_PATH, file).replace(/\.md$/, '') : basename;
            allFiles[fileKey] = file;
            // basenameでも引けるよう、未登録ならbasenameもマッピング
            if (!allFiles[basename]) allFiles[basename] = file;

            let fileStat;
            try { fileStat = fs.statSync(file); } catch (_) { return; }

            // ヒートマップ集計
            const dKey = new Date(fileStat.mtimeMs).toISOString().split('T')[0];
            stats.heatmap[dKey] = (stats.heatmap[dKey] || 0) + 1;

            // 古いノート集計
            if (nowMs - fileStat.mtimeMs > staleLimitMs) {
                const diffDays = Math.floor((nowMs - fileStat.mtimeMs) / (1000 * 60 * 60 * 24));
                stats.staleList.push({ name: basename, path: file, days: diffDays, size: fileStat.size });
            }

            const lk = basename.toLowerCase().replace(/[\s_-]/g, '');
            if (!nameLower[lk]) nameLower[lk] = [];
            nameLower[lk].push(basename);

            if (sender) {
                try { sender.send('scan-progress', `解析中: ${basename.slice(0, 50)}`); } catch (_) { }
            }

            const content = await safeReadFile(file);
            if (content === null) return; // iCloud evicted → スキップ

            const hash = crypto.createHash('sha256').update(content).digest('hex');
            if (!contentHashes[hash]) contentHashes[hash] = [];
            contentHashes[hash].push(basename);

            // リンク（fileKeyでマッピングし、同名ファイルも区別可能にする）
            links[fileKey] = [];
            let m;
            const lr = new RegExp(LINK_RE.source, 'g');
            while ((m = lr.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest) { links[fileKey].push(dest); stats.totalLinks++; }
            }

            // 画像参照の収集（Feature 7）
            const imgEmbedRe = new RegExp(IMAGE_EMBED_RE.source, 'g');
            while ((m = imgEmbedRe.exec(content)) !== null) {
                const imgRef = m[1].split('|')[0].split('#')[0].trim();
                if (imgRef) referencedImages.add(path.basename(imgRef));
            }
            const mdImgRe = new RegExp(MD_IMAGE_RE.source, 'g');
            while ((m = mdImgRe.exec(content)) !== null) {
                const imgRef = decodeURIComponent(m[1].split('#')[0].split('?')[0].trim());
                if (imgRef) referencedImages.add(path.basename(imgRef));
            }

            // タグ
            const tr = new RegExp(TAG_RE.source, 'gm');
            while ((m = tr.exec(content)) !== null) {
                const tag = m[1];
                stats.tagStats[tag] = (stats.tagStats[tag] || 0) + 1;
            }
            const fmMatch = FRONTMATTER_TAG_RE.exec(content);
            if (fmMatch) {
                fmMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).forEach(tag => {
                    if (tag) stats.tagStats[tag] = (stats.tagStats[tag] || 0) + 1;
                });
            }

            // 文字数（フロントマターはファイル先頭のみ除去）
            const plainText = content.replace(/^\s*---\n[\s\S]*?\n---/, '').replace(/[#*\[\]]/g, '');
            stats.totalWords += plainText.trim().split(/\s+/).filter(Boolean).length;

            if (basename.includes('MOC') || basename.startsWith('_MOC')) stats.mocsCount++;

            // ゴミ判定
            const junkResult = isJunkFile(file, content, junkRules);
            if (junkResult.junk) {
                stats.junkFiles++;
                stats.junkList.push({ name: basename, path: file, reason: junkResult.reason, size: fileStat.size });
            }
        }

        // Vault直下のmdファイルもスキャン（「(root)」として集計）
        const rootFiles = fs.readdirSync(VAULT_PATH)
            .filter(f => f.endsWith('.md'))
            .map(f => path.join(VAULT_PATH, f));
        for (const file of rootFiles) {
            if (scanCancelFlag) return { success: false, error: 'スキャンがキャンセルされました' };
            await processFile(file, '(root)');
        }

        // Vault内の全フォルダを動的に取得してスキャン
        const scanFolders = getScanFolders(VAULT_PATH);
        for (const folder of scanFolders) {
            if (scanCancelFlag) return { success: false, error: 'スキャンがキャンセルされました' };
            const folderPath = path.join(VAULT_PATH, folder);
            const files = getFilesRecursively(folderPath);
            for (const file of files) {
                if (scanCancelFlag) return { success: false, error: 'スキャンがキャンセルされました' };
                await processFile(file, folder);
            }
        }

        // 重複チェック
        // 同じ内容のものが名前の重複としてもカウントされるのを防ぐため、既にハッシュ重複で見つかったものは除外することも考えられますが、
        // 今回はシンプルに両方リストアップします。
        const contentDupes = new Set();
        for (const [, names] of Object.entries(contentHashes)) {
            if (names.length >= 2) {
                stats.duplicateList.push({ type: '内容重複', files: names });
                names.forEach(n => contentDupes.add(n));
            }
        }

        for (const [, names] of Object.entries(nameLower)) {
            if (names.length >= 2) {
                // 内容重複としてリストアップ済みの完全一致ノードのペアの場合は名前重複から除外する
                const allInContentDupes = names.every(n => contentDupes.has(n));
                if (!allInContentDupes) {
                    stats.duplicateList.push({ type: '名前重複', files: names });
                }
            }
        }

        // 被リンクカウント
        const incoming = {};
        for (const f in allFiles) incoming[f] = 0;
        for (const src in links) {
            for (const dest of links[src]) {
                if (incoming[dest] !== undefined) incoming[dest]++;
            }
        }

        // 壊れたリンク＆ファジー補完
        // basenameだけでなくパス付きリンク（folder/note）にも対応するため、逆引きマップを構築
        const basenameToFile = {};
        for (const name in allFiles) {
            basenameToFile[name.toLowerCase()] = name;
        }
        const allFileNames = Object.keys(allFiles);
        for (const src in links) {
            for (const dest of links[src]) {
                const destBase = path.basename(dest).replace(/\.md$/, '');
                // 完全一致 → basename一致 → 大文字小文字無視の順で検索
                if (allFiles[dest] || allFiles[destBase] || basenameToFile[destBase.toLowerCase()]) continue;
                const suggestions = findBestMatches(destBase, allFileNames);
                stats.brokenLinkList.push({ src, dest, suggestions, srcFile: allFiles[src] });
            }
        }
        stats.brokenLinksCount = stats.brokenLinkList.length;

        // 孤立ノート
        const excludePatterns = ['MOC', 'Template', 'Dashboard', 'Inbox', 'Archive'];
        for (const f in allFiles) {
            const outLinks = links[f] || [];
            const displayName = path.basename(allFiles[f], '.md');
            const isExcluded = excludePatterns.some(p => f.includes(p)) || f.startsWith('_') || f.startsWith('00 ');
            if (outLinks.length === 0 && incoming[f] === 0 && !isExcluded) {
                stats.orphanNotes++;
                stats.orphanList.push({ name: displayName, path: allFiles[f] });
            }
        }

        const tagEntries = Object.entries(stats.tagStats).sort((a, b) => b[1] - a[1]);
        stats.topTags = tagEntries.slice(0, 15).map(([tag, count]) => ({ tag, count }));

        const rareThr = config.rareTagThreshold ?? 1;
        stats.rareTags = tagEntries.filter(t => t[1] <= rareThr).map(([tag, count]) => ({ tag, count }));

        // Feature 7: 孤立画像/添付ファイルの集計
        stats.totalImages = allImageFiles.length;
        for (const img of allImageFiles) {
            if (!referencedImages.has(img.name)) {
                stats.orphanImages.push(img);
            }
        }
        stats.orphanImageCount = stats.orphanImages.length;

        return { success: true, stats };
    } catch (error) {
        console.error('scan error:', error.code, error.message, error.stack);
        return { success: false, error: `${error.code || ''}: ${error.message}` };
    }
}

// 元に戻す操作の確認
ipcMain.handle('check-undo', () => {
    if (!lastOperation) return { available: false };
    return {
        available: true,
        type: lastOperation.type,
        count: lastOperation.count,
        timestamp: lastOperation.timestamp,
    };
});

// 元に戻す操作の実行
ipcMain.handle('undo-last-operation', async () => {
    if (!lastOperation) return { success: false, error: '元に戻す操作がありません' };
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

    try {
        if (lastOperation.type === 'delete' && lastOperation.backupPath) {
            const backupPath = lastOperation.backupPath;
            if (!fs.existsSync(backupPath)) return { success: false, error: 'バックアップが見つかりません' };
            const files = getFilesRecursively(backupPath);
            let restored = 0;
            for (const file of files) {
                const rel = path.relative(backupPath, file);
                const dest = path.join(vaultPath, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(file, dest);
                restored++;
            }
            const result = { success: true, restored, type: lastOperation.type };
            lastOperation = null;
            return result;
        }
        return { success: false, error: 'この操作タイプは元に戻せません' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('scan-vault', async (event) => {
    scanCancelFlag = false;
    return await doScanVault(event.sender);
});

ipcMain.handle('cancel-scan', () => {
    scanCancelFlag = true;
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

// ======================================================
// 最適化実行
// ======================================================
ipcMain.handle('optimize-vault', async (event, options) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH || !fs.existsSync(VAULT_PATH)) {
        return { success: false, error: 'Vault が設定されていません。「追加」ボタンから Vault フォルダを選択してください。' };
    }
    const { deleteJunk = true, linkOrphans = true } = options || {};
    const doBackup = config.backupBeforeDelete !== false;
    const junkRules = config.junkRules || DEFAULT_JUNK_RULES;

    const send = (msg) => { try { event.sender.send('optimize-progress', msg); } catch (_) { } };

    try {
        const results = { deletedJunk: 0, linkedOrphans: 0, log: [], backupPath: null };
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const rules = config.rules || DEFAULT_RULES;

        const shouldDeleteJunk = deleteJunk && config.enableJunk !== false;
        if (shouldDeleteJunk && doBackup) {
            send('バックアップ中...');
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const backupPath = path.join(BACKUP_DIR, `backup-${ts}`);
            fs.mkdirSync(backupPath, { recursive: true });
            results.backupPath = backupPath;
            const backupFolders = getScanFolders(VAULT_PATH);
            for (const folder of backupFolders) {
                const folderPath = path.join(VAULT_PATH, folder);
                const files = getFilesRecursively(folderPath);
                for (const file of files) {
                    if (!file.endsWith('.md')) continue;
                    const rel = path.relative(VAULT_PATH, file);
                    const dest = path.join(backupPath, rel);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.copyFileSync(file, dest);
                }
            }
            // ルート直下のmdファイルもバックアップ
            const rootMds = fs.readdirSync(VAULT_PATH).filter(f => f.endsWith('.md')).map(f => path.join(VAULT_PATH, f));
            for (const file of rootMds) {
                const rel = path.relative(VAULT_PATH, file);
                const dest = path.join(backupPath, rel);
                fs.copyFileSync(file, dest);
            }
            results.log.push(`💾 バックアップ: ${backupPath}`);
        }
        
        const junkAction = config.junkAction || 'delete';

        if (shouldDeleteJunk) {
            send('ゴミファイルを削除中...');
            // 全mdファイルを収集（フォルダ + ルート直下）
            const allJunkTargets = [];
            const junkFolders = getScanFolders(VAULT_PATH);
            for (const folder of junkFolders) {
                const folderPath = path.join(VAULT_PATH, folder);
                const files = getFilesRecursively(folderPath);
                allJunkTargets.push(...files);
            }
            // ルート直下のmdファイルも対象に含める
            const rootMdsForJunk = fs.readdirSync(VAULT_PATH).filter(f => f.endsWith('.md')).map(f => path.join(VAULT_PATH, f));
            allJunkTargets.push(...rootMdsForJunk);

            for (const file of allJunkTargets) {
                if (!file.endsWith('.md')) continue;
                const content = safeReadFileSync(file);
                if (content === null) continue;
                const result = isJunkFile(file, content, junkRules);
                if (result.junk) {
                    if (junkAction === 'archive') {
                        const archiveDir = path.join(VAULT_PATH, '99 Archive', 'Junk');
                        fs.mkdirSync(archiveDir, { recursive: true });
                        const dest = path.join(archiveDir, path.basename(file));
                        let finalDest = dest;
                        let counter = 1;
                        while (fs.existsSync(finalDest)) {
                            const ext = path.extname(file);
                            const name = path.basename(file, ext);
                            finalDest = path.join(archiveDir, `${name}_${counter}${ext}`);
                            counter++;
                        }
                        fs.renameSync(file, finalDest);
                        results.deletedJunk++;
                        results.log.push(`📦 アーカイブ: ${path.basename(file)}`);
                    } else if (junkAction === 'trash') {
                        // OSのゴミ箱に移動（Electron shell.trashItem）
                        try {
                            await shell.trashItem(file);
                            results.log.push(`🗑️ ゴミ箱へ移動: ${path.basename(file)}`);
                            results.deletedJunk++;
                        } catch (trashErr) {
                            // ゴミ箱移動が失敗した場合はフォールバックで削除
                            fs.unlinkSync(file);
                            results.log.push(`🗑️ 削除(ゴミ箱移動失敗): ${path.basename(file)}`);
                            results.deletedJunk++;
                        }
                    } else { // 'delete'
                        fs.unlinkSync(file);
                        results.log.push(`🗑️ 削除: ${path.basename(file)}`);
                        results.deletedJunk++;
                    }
                }
            }
        }

        // 元に戻す用の操作記録（最適化の削除分）
        if (results.deletedJunk > 0 && results.backupPath) {
            lastOperation = {
                type: 'delete',
                backupPath: results.backupPath,
                count: results.deletedJunk,
                timestamp: Date.now(),
            };
        }

        const shouldLinkOrphans = linkOrphans && config.enableMoc !== false;
        if (shouldLinkOrphans) {
            send('孤立ノートをMOCに接続中...');
            const links = {};
            const allFiles = {};
            // フォルダ内 + ルート直下の全mdファイルを解析
            const allLinkTargets = [];
            const linkFolders = getScanFolders(VAULT_PATH);
            for (const folder of linkFolders) {
                const folderPath = path.join(VAULT_PATH, folder);
                const files = getFilesRecursively(folderPath);
                allLinkTargets.push(...files);
            }
            const rootMdsForLinks = fs.readdirSync(VAULT_PATH).filter(f => f.endsWith('.md')).map(f => path.join(VAULT_PATH, f));
            allLinkTargets.push(...rootMdsForLinks);

            for (const file of allLinkTargets) {
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
            for (const f in allFiles) {
                const outLinks = links[f] || [];
                const isExcluded = excludePatterns.some(p => f.includes(p)) || f.startsWith('_') || f.startsWith('00 ');
                if (outLinks.length !== 0 || incoming[f] !== 0 || isExcluded) continue;

                let assignedCat = null;
                const lk = f.toLowerCase();
                for (const [catName, rule] of Object.entries(rules)) {
                    if (rule.keywords.some(kw => lk.includes(kw.toLowerCase()))) { assignedCat = catName; break; }
                }
                const targetMoc = assignedCat ? rules[assignedCat].moc : '_Uncategorized Orphans';
                const currentContent = fs.readFileSync(allFiles[f], 'utf-8');
                if (currentContent.includes(`[[${targetMoc}]]`)) continue;
                fs.appendFileSync(allFiles[f], `\n\n---\n> 🗺️ **関連MOC**: [[${targetMoc}]]\n`);

                try {
                    let mocPath = allFiles[targetMoc];
                    if (!mocPath) {
                        mocPath = path.join(VAULT_PATH, '10 Atlas', `${targetMoc}.md`);
                        fs.mkdirSync(path.dirname(mocPath), { recursive: true });
                        if (!fs.existsSync(mocPath)) {
                            const mocName = targetMoc.replace('_Uncategorized Orphans', 'カテゴリ未分類 孤立ノート');
                            fs.writeFileSync(mocPath, `# ${mocName}\ntags: ["type/moc", "auto-generated"]\n\n> 自動生成されたMOCです。\n\n`, 'utf-8');
                        }
                    }
                    const mocContent = fs.readFileSync(mocPath, 'utf-8');
                    if (!mocContent.includes(`[[${f}]]`)) {
                        fs.appendFileSync(mocPath, `- [[${f}]]\n`);
                    }
                    results.linkedOrphans++;
                    results.log.push(`🔗 リンク: [[${f}]] → [[${targetMoc}]]`);
                } catch (linkErr) {
                    results.log.push(`⚠️ リンク失敗: ${f} → ${linkErr.message}`);
                }
            }
        }

        return { success: true, results };
    } catch (error) {
        console.error('optimize error:', error);
        return { success: false, error: error.message };
    }
});

// レポート生成の共通関数（Feature 6: 自動レポート保存でも使用）
function generateReportContent(scanStats) {
    const ts = new Date().toLocaleString('ja-JP');
    const lines = [
        '# Obsidian Optimizer レポート (v4.3)',
        `**生成日時**: ${ts}`,
        `**Vault**: ${getCurrentVault()}`,
        '',
        '## サマリー',
        '| 項目 | 件数 |',
        '|------|------|',
        `| 総ノート数 | ${scanStats.totalMDFiles} |`,
        `| MOC数 | ${scanStats.mocsCount} |`,
        `| 孤立ノート | ${scanStats.orphanNotes} |`,
        `| ゴミファイル | ${scanStats.junkFiles} |`,
        `| 壊れたリンク | ${scanStats.brokenLinksCount || 0} |`,
        `| 放置(Stale)ノート | ${(scanStats.staleList || []).length} |`,
        `| 孤立画像/添付 | ${scanStats.orphanImageCount || 0} |`,
        '',
        '## 孤立ノート一覧',
        ...(scanStats.orphanList || []).map(o => `- [[${o.name}]]`),
        '',
        '## 放置ノート (Stale)',
        ...(scanStats.staleList || []).map(s => `- [[${s.name}]] (${s.days}日更新なし)`),
        '',
        '## ゴミファイル一覧',
        ...(scanStats.junkList || []).map(j => `- ${j.name} (${j.reason})`),
        '',
        '## 壊れたリンク一覧',
        ...(scanStats.brokenLinkList || []).map(b => `- [[${b.src}]] → [[${b.dest}]]`),
        '',
        '## 孤立画像/添付ファイル',
        ...(scanStats.orphanImages || []).map(i => `- ${i.name} (${(i.size / 1024).toFixed(1)}KB)`),
    ];
    return lines.join('\n');
}

ipcMain.handle('export-report', async (event, scanStats) => {
    try {
        const reportContent = generateReportContent(scanStats);

        const win = getWin(event);
        const result = await dialog.showSaveDialog(win, {
            defaultPath: path.join(os.homedir(), `obsidian-report-${Date.now()}.md`),
            filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (!result.canceled && result.filePath) {
            fs.writeFileSync(result.filePath, reportContent, 'utf-8');
            return { success: true, filePath: result.filePath };
        }
        return { success: false, canceled: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// データ書出（CSV / JSON）
ipcMain.handle('export-data', async (event, { stats, format }) => {
    try {
        const ext = format === 'json' ? 'json' : 'csv';
        const filterName = format === 'json' ? 'JSON' : 'CSV';
        const win = getWin(event);
        const result = await dialog.showSaveDialog(win, {
            defaultPath: path.join(os.homedir(), `obsidian-data-${Date.now()}.${ext}`),
            filters: [{ name: filterName, extensions: [ext] }],
        });
        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }

        // 全ノートデータを統合して一覧化
        const rows = [];
        for (const note of (stats.orphanList || [])) {
            rows.push({ name: note.name, path: note.path || '', status: '孤立', reason: '', days: '' });
        }
        for (const note of (stats.staleList || [])) {
            rows.push({ name: note.name, path: note.path || '', status: '放置', reason: '', days: note.days || '' });
        }
        for (const note of (stats.junkList || [])) {
            rows.push({ name: note.name, path: note.path || '', status: 'ゴミ', reason: note.reason || '', days: '' });
        }
        for (const link of (stats.brokenLinkList || [])) {
            rows.push({ name: link.src, path: '', status: '壊れたリンク', reason: `→ ${link.dest}`, days: '' });
        }

        let content;
        if (format === 'json') {
            const exportObj = {
                generatedAt: new Date().toISOString(),
                vault: getCurrentVault(),
                summary: {
                    totalMDFiles: stats.totalMDFiles,
                    mocsCount: stats.mocsCount,
                    orphanNotes: stats.orphanNotes,
                    junkFiles: stats.junkFiles,
                    brokenLinksCount: stats.brokenLinksCount || 0,
                    staleNotes: (stats.staleList || []).length,
                },
                items: rows,
            };
            content = JSON.stringify(exportObj, null, 2);
        } else {
            // CSV（BOM付きUTF-8でExcel互換）
            const BOM = '\uFEFF';
            const header = '名前,パス,ステータス,理由,放置日数';
            const csvRows = rows.map(r => {
                const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
                return [escape(r.name), escape(r.path), escape(r.status), escape(r.reason), escape(r.days)].join(',');
            });
            content = BOM + [header, ...csvRows].join('\n');
        }

        fs.writeFileSync(result.filePath, content, 'utf-8');
        return { success: true, filePath: result.filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ======================================================
// MOC作成機能 — テンプレート管理 & MOC生成
// ======================================================

const DEFAULT_MOC_TEMPLATES = [
    {
        id: 'builtin-standard',
        name: '標準MOC',
        description: 'Pinned Notes・Dataviewクエリ付きの本格的なMOC',
        builtin: true,
        body: [
            '---',
            'type: {{TYPE}}',
            'created: "{{DATE}}"',
            'tags: [{{TAGS}}]',
            'auto_folders: [{{AUTO_FOLDERS}}]',
            'auto_tags: [{{AUTO_TAGS}}]',
            '{{CSS_CLASSES}}',
            '---',
            '',
            '# MOC - {{NAME}}',
            '',
            '> {{DESCRIPTION}}',
            '',
            '## Pinned Notes',
            '> 特に重要なノートを手動でピン留め。',
            '',
            '',
            '## Related MOCs',
            '{{RELATED_MOCS}}',
            '',
            '## Open Questions',
            '-',
            '',
            '---',
            '',
            '## Auto: Folder-based',
            '```dataview',
            'TABLE WITHOUT ID',
            '  link(file.path, file.name) AS "Note",',
            '  file.mday AS "Updated"',
            'FROM {{DV_FOLDER_FROM}}',
            'SORT file.mday DESC',
            '```',
            '',
            '## Auto: Tagged Notes',
            '```dataview',
            'TABLE WITHOUT ID',
            '  link(file.path, file.name) AS "Note",',
            '  file.folder AS "Location",',
            '  file.mday AS "Updated"',
            'FROM {{DV_TAG_FROM}}',
            'WHERE file.path != this.file.path',
            'SORT file.mday DESC',
            '```',
            '',
            '## Auto: Permanent Notes',
            '```dataview',
            'TABLE WITHOUT ID',
            '  link(file.path, file.name) AS "Note",',
            '  file.mday AS "Updated"',
            'FROM "20 Notes"',
            'WHERE {{DV_TAG_WHERE}}',
            'SORT file.mday DESC',
            '```',
        ].join('\n'),
    },
    {
        id: 'builtin-simple',
        name: 'シンプルMOC',
        description: 'フロントマター + リンクリストのみのシンプル構成',
        builtin: true,
        body: [
            '---',
            'type: {{TYPE}}',
            'created: "{{DATE}}"',
            'tags: [{{TAGS}}]',
            '{{CSS_CLASSES}}',
            '---',
            '',
            '# MOC - {{NAME}}',
            '',
            '> {{DESCRIPTION}}',
            '',
            '## Notes',
            '',
            '',
            '## Related MOCs',
            '{{RELATED_MOCS}}',
        ].join('\n'),
    },
    {
        id: 'builtin-folder',
        name: 'フォルダMOC',
        description: 'フォルダ内ファイルを自動集約するMOC',
        builtin: true,
        body: [
            '---',
            'type: {{TYPE}}',
            'created: "{{DATE}}"',
            'tags: [{{TAGS}}, auto-generated]',
            '{{CSS_CLASSES}}',
            '---',
            '',
            '# 🗺️ {{NAME}} Directory MOC',
            '',
            '> {{DESCRIPTION}}',
            '',
            '## Notes',
            '{{FOLDER_FILES}}',
            '',
            '---',
            '',
            '## Auto: Folder Contents',
            '```dataview',
            'TABLE WITHOUT ID',
            '  link(file.path, file.name) AS "Note",',
            '  file.mday AS "Updated"',
            'FROM {{DV_FOLDER_FROM}}',
            'WHERE file.path != this.file.path',
            'SORT file.mday DESC',
            '```',
        ].join('\n'),
    },
    {
        id: 'builtin-zettelkasten',
        name: 'Zettelkasten MOC',
        description: '双方向リンク中心のZettelkasten式MOC',
        builtin: true,
        body: [
            '---',
            'type: {{TYPE}}',
            'created: "{{DATE}}"',
            'tags: [{{TAGS}}, zettelkasten]',
            '{{CSS_CLASSES}}',
            '---',
            '',
            '# 🔗 {{NAME}}',
            '',
            '> {{DESCRIPTION}}',
            '',
            '## Structure Notes',
            '> このMOCのコアとなるノート。ここから辿れば全体像が見える。',
            '',
            '',
            '## Related MOCs',
            '{{RELATED_MOCS}}',
            '',
            '## Backlinks',
            '```dataview',
            'TABLE WITHOUT ID',
            '  link(file.path, file.name) AS "Note",',
            '  length(file.inlinks) AS "Inlinks",',
            '  length(file.outlinks) AS "Outlinks",',
            '  file.mday AS "Updated"',
            'FROM {{DV_TAG_FROM}}',
            'WHERE file.path != this.file.path',
            'SORT length(file.inlinks) DESC',
            '```',
            '',
            '## Recently Added',
            '```dataview',
            'TABLE WITHOUT ID',
            '  link(file.path, file.name) AS "Note",',
            '  file.cday AS "Created"',
            'FROM {{DV_TAG_FROM}}',
            'WHERE file.path != this.file.path',
            'SORT file.cday DESC',
            'LIMIT 10',
            '```',
        ].join('\n'),
    },
    {
        id: 'builtin-tag-based',
        name: 'タグベースMOC',
        description: '特定タグを持つノートを自動収集するMOC',
        builtin: true,
        body: [
            '---',
            'type: {{TYPE}}',
            'created: "{{DATE}}"',
            'tags: [{{TAGS}}]',
            '{{CSS_CLASSES}}',
            '---',
            '',
            '# 🏷️ {{NAME}}',
            '',
            '> {{DESCRIPTION}}',
            '',
            '## Tagged Notes',
            '```dataview',
            'TABLE WITHOUT ID',
            '  link(file.path, file.name) AS "Note",',
            '  file.tags AS "Tags",',
            '  file.folder AS "Location",',
            '  file.mday AS "Updated"',
            'FROM {{DV_TAG_FROM}}',
            'WHERE file.path != this.file.path',
            'SORT file.mday DESC',
            '```',
            '',
            '## Tag Statistics',
            '```dataview',
            'TABLE WITHOUT ID',
            '  length(rows) AS "Count",',
            '  rows.file.link AS "Notes"',
            'FROM {{DV_TAG_FROM}}',
            'WHERE file.path != this.file.path',
            'GROUP BY file.folder',
            'SORT length(rows) DESC',
            '```',
            '',
            '## Related MOCs',
            '{{RELATED_MOCS}}',
        ].join('\n'),
    },
];

// Vault内テンプレートの検索パス
const TEMPLATE_SEARCH_PATHS = [
    'MOC Template.md',
    'Templates',
];

/**
 * Vault内のフォルダ一覧を取得（第1階層 + 第2階層まで）
 */
function getVaultFolders(vaultPath, maxDepth = 2) {
    const folders = [];
    function walk(dir, depth) {
        if (depth > maxDepth) return;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith('.') || EXCLUDE_ENTRIES.has(entry.name)) continue;
                const rel = path.relative(vaultPath, path.join(dir, entry.name));
                folders.push(rel);
                walk(path.join(dir, entry.name), depth + 1);
            }
        } catch (_) { /* ignore */ }
    }
    walk(vaultPath, 1);
    return folders.sort();
}

/**
 * Vault内のMOCファイル一覧を取得
 */
function getExistingMocs(vaultPath) {
    const mocs = [];
    const allFiles = getFilesRecursively(vaultPath);
    for (const file of allFiles) {
        if (!file.endsWith('.md')) continue;
        const basename = path.basename(file, '.md');
        if (basename.includes('MOC') || basename.startsWith('_MOC')) {
            mocs.push({
                name: basename,
                path: path.relative(vaultPath, file),
            });
        }
    }
    return mocs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Vault内のテンプレートファイルを読み込む
 */
function loadVaultTemplates(vaultPath) {
    const templates = [];
    const systemDir = path.join(vaultPath, '90 System');

    for (const searchPath of TEMPLATE_SEARCH_PATHS) {
        const fullPath = path.join(systemDir, searchPath);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && fullPath.endsWith('.md')) {
                // 単一テンプレートファイル
                const content = fs.readFileSync(fullPath, 'utf-8');
                templates.push({
                    id: `vault:${path.basename(fullPath, '.md')}`,
                    name: path.basename(fullPath, '.md'),
                    description: 'Vault内テンプレート',
                    source: 'vault',
                    filePath: fullPath,
                    body: content,
                });
            } else if (stat.isDirectory()) {
                // テンプレートフォルダ内を検索
                const files = fs.readdirSync(fullPath);
                for (const file of files) {
                    if (!file.endsWith('.md')) continue;
                    if (!file.toLowerCase().includes('moc')) continue;
                    const fp = path.join(fullPath, file);
                    const content = fs.readFileSync(fp, 'utf-8');
                    templates.push({
                        id: `vault:${path.basename(file, '.md')}`,
                        name: path.basename(file, '.md'),
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
 * テンプレートのプレースホルダーを実際の値で置換する
 */
function renderMocTemplate(templateBody, params) {
    const today = new Date().toISOString().split('T')[0];
    const name = params.name || 'Untitled';
    const type = params.type || 'moc';
    const tags = (params.tags || []).map(t => `"${t}"`).join(', ');
    const autoFolders = (params.autoFolders || []).map(f => `"${f}"`).join(', ');
    const autoTags = (params.autoTags || []).map(t => `"${t}"`).join(', ');
    const description = params.description || `${name} に関するノートのマップ`;
    const cssLine = (params.cssClasses && params.cssClasses.length > 0)
        ? `cssclasses: [${params.cssClasses.join(', ')}]`
        : '';

    // Related MOCs
    const relatedMocs = (params.relatedMocs || [])
        .map(m => `- [[${m}]]`)
        .join('\n') || '-';

    // Dataview: フォルダFROM句
    const dvFolderFrom = (params.autoFolders && params.autoFolders.length > 0)
        ? params.autoFolders.map(f => `"${f}"`).join(' OR ')
        : `"10 Sources"`;

    // Dataview: タグFROM句
    const dvTagFrom = (params.autoTags && params.autoTags.length > 0)
        ? params.autoTags.map(t => `#${t}`).join(' OR ')
        : `#topic/${name.toLowerCase().replace(/\s+/g, '-')}`;

    // Dataview: タグWHERE句
    const dvTagWhere = (params.autoTags && params.autoTags.length > 0)
        ? params.autoTags.map(t => `contains(file.tags, "${t}")`).join(' OR ')
        : `contains(file.tags, "topic/${name.toLowerCase().replace(/\s+/g, '-')}")`;

    // フォルダ内ファイルリスト
    let folderFiles = '';
    if (params.autoFolders && params.autoFolders.length > 0) {
        const vaultPath = getCurrentVault();
        if (vaultPath) {
            for (const folder of params.autoFolders) {
                const folderPath = path.join(vaultPath, folder);
                if (fs.existsSync(folderPath)) {
                    const files = getFilesRecursively(folderPath);
                    const mdFiles = files.filter(f => f.endsWith('.md') && !path.basename(f).startsWith('_MOC'));
                    mdFiles.forEach(f => {
                        const relPath = path.relative(vaultPath, f).replace(/\.md$/, '');
                        folderFiles += `- [[${relPath}|${path.basename(f, '.md')}]]\n`;
                    });
                }
            }
        }
    }
    if (!folderFiles) folderFiles = '- _(ノートを追加してください)_';

    let result = templateBody;
    result = result.replace(/\{\{NAME\}\}/g, name);
    result = result.replace(/\{\{TYPE\}\}/g, type);
    result = result.replace(/\{\{DATE\}\}/g, today);
    result = result.replace(/\{\{TAGS\}\}/g, tags);
    result = result.replace(/\{\{AUTO_FOLDERS\}\}/g, autoFolders);
    result = result.replace(/\{\{AUTO_TAGS\}\}/g, autoTags);
    result = result.replace(/\{\{DESCRIPTION\}\}/g, description);
    result = result.replace(/\{\{CSS_CLASSES\}\}/g, cssLine);
    result = result.replace(/\{\{RELATED_MOCS\}\}/g, relatedMocs);
    result = result.replace(/\{\{DV_FOLDER_FROM\}\}/g, dvFolderFrom);
    result = result.replace(/\{\{DV_TAG_FROM\}\}/g, dvTagFrom);
    result = result.replace(/\{\{DV_TAG_WHERE\}\}/g, dvTagWhere);
    result = result.replace(/\{\{FOLDER_FILES\}\}/g, folderFiles.trim());

    // Templater構文を処理（tp.date.now, tp.file.title）
    result = result.replace(/<% tp\.date\.now\(['"]([^'"]+)['"]\) %>/g, () => today);
    result = result.replace(/<% tp\.file\.title %>/g, `MOC - ${name}`);

    // フロントマター内の空行を除去（CSS_CLASSESが空の場合などに発生する空行をクリーンアップ）
    const fmEnd = result.indexOf('\n---', result.indexOf('---') + 3);
    if (fmEnd > 0) {
        const frontmatter = result.substring(0, fmEnd + 4);
        const afterFm = result.substring(fmEnd + 4);
        const cleanedFm = frontmatter.replace(/^\s*\n/gm, (match, offset) => {
            // 最初の --- と最後の --- の間にある空行のみ除去
            return (offset > 3 && offset < frontmatter.length - 4) ? '' : match;
        });
        result = cleanedFm + afterFm;
    }

    return result;
}

// --- IPCハンドラ: テンプレート一覧 ---
ipcMain.handle('get-moc-templates', () => {
    try {
        const vaultPath = getCurrentVault();
        const vaultTemplates = vaultPath ? loadVaultTemplates(vaultPath) : [];
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
        const folders = getVaultFolders(vaultPath);
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
        const mocs = getExistingMocs(vaultPath);
        return { success: true, mocs };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- IPCハンドラ: テンプレートからMOC作成 ---
ipcMain.handle('create-moc-from-template', async (_, params) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const { templateId, name, destFolder } = params;

        if (!name || !name.trim()) {
            return { success: false, error: 'MOC名を入力してください' };
        }

        // テンプレートを取得
        let templateBody = '';
        if (templateId && templateId.startsWith('vault:')) {
            const vaultTemplates = loadVaultTemplates(vaultPath);
            const found = vaultTemplates.find(t => t.id === templateId);
            if (!found) return { success: false, error: 'テンプレートが見つかりません' };
            templateBody = found.body;
        } else if (templateId && templateId.startsWith('custom-')) {
            const found = (config.mocTemplates || []).find(t => t.id === templateId);
            if (!found) return { success: false, error: 'テンプレートが見つかりません' };
            templateBody = found.body;
        } else {
            const builtin = DEFAULT_MOC_TEMPLATES.find(t => t.id === templateId);
            if (!builtin) return { success: false, error: 'テンプレートが見つかりません' };
            templateBody = builtin.body;
        }

        // テンプレートを展開
        const content = renderMocTemplate(templateBody, params);

        // 保存先の決定
        const dest = destFolder || '10 Atlas';
        const destDir = path.join(vaultPath, dest);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        const fileName = `MOC - ${name.trim()}.md`;
        const filePath = path.join(destDir, fileName);

        // 同名ファイルチェック
        if (fs.existsSync(filePath)) {
            return { success: false, error: `ファイルが既に存在します: ${fileName}` };
        }

        fs.writeFileSync(filePath, content, 'utf-8');

        return {
            success: true,
            filePath,
            fileName,
            relativePath: path.relative(vaultPath, filePath),
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- IPCハンドラ: スマートノート候補（Vault分析ベース） ---
ipcMain.handle('analyze-vault-for-moc', (_, params) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const topic = (params.topic || '').toLowerCase().trim();
        if (!topic) return { success: true, notes: [] };

        const filterTags = (params.tags || []).map(t => t.toLowerCase());
        const filterFolders = params.folders || [];

        const allFiles = getFilesRecursively(vaultPath);
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const TAG_RE = /(?:^|\s)#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f/\-]+)/gm;
        const FRONTMATTER_TAG_RE = /^tags:\s*\[([^\]]+)\]/m;

        const results = [];
        const topicWords = topic.split(/[\s,/\-_]+/).filter(Boolean);

        for (const file of allFiles) {
            if (!file.endsWith('.md')) continue;
            const basename = path.basename(file, '.md');
            // MOCファイル自体は候補から除外
            if (basename.includes('MOC') || basename.startsWith('_MOC')) continue;

            let score = 0;
            const reasons = [];
            const lowerName = basename.toLowerCase();
            const relPath = path.relative(vaultPath, file);
            const folderName = path.dirname(relPath).split(path.sep)[0] || '(root)';

            // ノート名マッチ
            for (const w of topicWords) {
                if (lowerName.includes(w)) {
                    score += 10;
                    reasons.push(`名前に「${w}」を含む`);
                }
            }

            // フォルダフィルター
            if (filterFolders.length > 0 && filterFolders.includes(folderName)) {
                score += 5;
                reasons.push(`フォルダ: ${folderName}`);
            }

            // 内容解析（重いので名前マッチがある場合のみ深堀り or 全件軽量チェック）
            let content = '';
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }

            // タグマッチ
            const fileTags = [];
            let m;
            const tr = new RegExp(TAG_RE.source, 'gm');
            while ((m = tr.exec(content)) !== null) fileTags.push(m[1].toLowerCase());
            const fmMatch = FRONTMATTER_TAG_RE.exec(content);
            if (fmMatch) {
                fmMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '').toLowerCase()).forEach(t => {
                    if (t) fileTags.push(t);
                });
            }

            for (const ft of fileTags) {
                if (filterTags.length > 0 && filterTags.includes(ft)) {
                    score += 8;
                    reasons.push(`タグ: #${ft}`);
                }
                for (const w of topicWords) {
                    if (ft.includes(w)) {
                        score += 3;
                        reasons.push(`タグに「${w}」`);
                    }
                }
            }

            // 内容キーワードマッチ（先頭500文字のみ軽量チェック）
            const snippet = content.substring(0, 500).toLowerCase();
            for (const w of topicWords) {
                if (snippet.includes(w) && !lowerName.includes(w)) {
                    score += 2;
                    reasons.push(`内容に「${w}」`);
                }
            }

            if (score > 0) {
                results.push({
                    name: basename,
                    path: file,
                    relPath,
                    score,
                    matchReason: [...new Set(reasons)].slice(0, 3).join(', '),
                });
            }
        }

        results.sort((a, b) => b.score - a.score);
        return { success: true, notes: results.slice(0, 30) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- IPCハンドラ: 既存MOCの更新・リフレッシュ ---
ipcMain.handle('refresh-moc', (_, params) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const { mocPath, strategy } = params;
        const mocFullPath = path.join(vaultPath, mocPath);
        if (!fs.existsSync(mocFullPath)) return { success: false, error: 'MOCファイルが見つかりません' };

        const mocContent = fs.readFileSync(mocFullPath, 'utf-8');

        // フロントマターからauto_foldersとauto_tagsを読み取り
        const foldersMatch = /^auto_folders:\s*\[([^\]]*)\]/m.exec(mocContent);
        const tagsMatch = /^auto_tags:\s*\[([^\]]*)\]/m.exec(mocContent);
        const autoFolders = foldersMatch
            ? foldersMatch[1].split(',').map(f => f.trim().replace(/['"]/g, '')).filter(Boolean)
            : [];
        const autoTags = tagsMatch
            ? tagsMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean)
            : [];

        // 既存リンクを抽出
        const existingLinks = new Set();
        const LINK_RE = /\[\[(.*?)\]\]/g;
        let m;
        while ((m = LINK_RE.exec(mocContent)) !== null) {
            const dest = m[1].split('|')[0].split('#')[0].trim();
            existingLinks.add(dest);
            existingLinks.add(path.basename(dest));
        }

        // 新規ノートを検出
        const newNotes = [];
        const TAG_RE = /(?:^|\s)#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f/\-]+)/gm;
        const FRONTMATTER_TAG_RE = /^tags:\s*\[([^\]]+)\]/m;

        // フォルダベースの検出
        for (const folder of autoFolders) {
            const folderPath = path.join(vaultPath, folder);
            if (!fs.existsSync(folderPath)) continue;
            const files = getFilesRecursively(folderPath);
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const basename = path.basename(file, '.md');
                const relPath = path.relative(vaultPath, file).replace(/\.md$/, '');
                if (existingLinks.has(basename) || existingLinks.has(relPath)) continue;
                if (basename.includes('MOC') || basename.startsWith('_MOC')) continue;
                newNotes.push({ name: basename, path: file, relPath, source: `フォルダ: ${folder}` });
            }
        }

        // タグベースの検出
        if (autoTags.length > 0) {
            const allFiles = getFilesRecursively(vaultPath);
            for (const file of allFiles) {
                if (!file.endsWith('.md')) continue;
                const basename = path.basename(file, '.md');
                const relPath = path.relative(vaultPath, file).replace(/\.md$/, '');
                if (existingLinks.has(basename) || existingLinks.has(relPath)) continue;
                if (basename.includes('MOC') || basename.startsWith('_MOC')) continue;
                // 既にフォルダベースで見つかっているものはスキップ
                if (newNotes.some(n => n.name === basename)) continue;

                let content;
                try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }

                const fileTags = [];
                let tm;
                const tr = new RegExp(TAG_RE.source, 'gm');
                while ((tm = tr.exec(content)) !== null) fileTags.push(tm[1].toLowerCase());
                const fmMatch = FRONTMATTER_TAG_RE.exec(content);
                if (fmMatch) {
                    fmMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '').toLowerCase()).forEach(t => {
                        if (t) fileTags.push(t);
                    });
                }

                const hasMatchingTag = autoTags.some(at => fileTags.includes(at.toLowerCase()));
                if (hasMatchingTag) {
                    newNotes.push({ name: basename, path: file, relPath, source: 'タグ一致' });
                }
            }
        }

        if (strategy === 'preview') {
            return { success: true, newNotes, mocPath: mocFullPath };
        }

        // append: 末尾に追加
        if (newNotes.length > 0) {
            let appendContent = '\n';
            for (const note of newNotes) {
                appendContent += `- [[${note.relPath}|${note.name}]]\n`;
            }
            fs.appendFileSync(mocFullPath, appendContent, 'utf-8');
        }

        return { success: true, added: newNotes.length, mocPath: mocFullPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- IPCハンドラ: 一括MOC生成 ---
ipcMain.handle('batch-generate-mocs', async (_, params) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const { folders, destFolder } = params;
        if (!folders || folders.length === 0) return { success: false, error: 'フォルダが選択されていません' };

        const results = [];
        for (const folder of folders) {
            try {
                const folderPath = path.join(vaultPath, folder);
                if (!fs.existsSync(folderPath)) {
                    results.push({ folder, success: false, error: 'フォルダが存在しません' });
                    continue;
                }

                const files = getFilesRecursively(folderPath);
                const mdFiles = files.filter(f => f.endsWith('.md') && !path.basename(f).startsWith('_MOC'));
                if (mdFiles.length === 0) {
                    results.push({ folder, success: true, skipped: true, reason: 'mdファイルなし' });
                    continue;
                }

                const mocTitle = `_MOC_${path.basename(folder)}`;
                const outputDir = destFolder ? path.join(vaultPath, destFolder) : folderPath;
                const mocPath = path.join(outputDir, `${mocTitle}.md`);

                // 既存チェック
                if (fs.existsSync(mocPath)) {
                    results.push({ folder, success: true, skipped: true, reason: 'MOC既に存在', mocPath });
                    continue;
                }

                let content = `# 🗺️ ${path.basename(folder)} Directory MOC\n`;
                content += `tags: ["type/moc", "auto-generated"]\n\n`;
                content += `> このフォルダ内のノートを自動集約しました。\n\n`;
                content += `## Notes\n`;
                mdFiles.forEach(f => {
                    const relPath = path.relative(vaultPath, f).replace(/\.md$/, '');
                    content += `- [[${relPath}|${path.basename(f, '.md')}]]\n`;
                });

                fs.mkdirSync(path.dirname(mocPath), { recursive: true });
                fs.writeFileSync(mocPath, content, 'utf-8');
                results.push({ folder, success: true, mocPath, noteCount: mdFiles.length });
            } catch (err) {
                results.push({ folder, success: false, error: err.message });
            }
        }

        const created = results.filter(r => r.success && !r.skipped).length;
        return { success: true, results, totalCreated: created };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- IPCハンドラ: MOCマップ（関連性グラフ） ---
ipcMain.handle('get-moc-graph', () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const mocs = getExistingMocs(vaultPath);
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const nodes = [];
        const edges = [];
        const mocNames = new Set(mocs.map(m => m.name));

        for (const moc of mocs) {
            const fullPath = path.join(vaultPath, moc.path);
            let content = '';
            let noteCount = 0;
            try { content = fs.readFileSync(fullPath, 'utf-8'); } catch (_) { continue; }

            // リンク数をカウント
            let m;
            const lr = new RegExp(LINK_RE.source, 'g');
            while ((m = lr.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                const destBase = path.basename(dest).replace(/\.md$/, '');
                if (mocNames.has(dest) || mocNames.has(destBase)) {
                    const targetName = mocNames.has(dest) ? dest : destBase;
                    if (targetName !== moc.name) {
                        edges.push({ from: moc.name, to: targetName });
                    }
                } else {
                    noteCount++;
                }
            }

            nodes.push({ id: moc.name, name: moc.name, noteCount });
        }

        return { success: true, nodes, edges };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- IPCハンドラ: タグベース自動MOC候補 ---
ipcMain.handle('suggest-tag-mocs', () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const TAG_RE = /(?:^|\s)#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f/\-]+)/gm;
        const FRONTMATTER_TAG_RE = /^tags:\s*\[([^\]]+)\]/m;
        const TAG_MOC_THRESHOLD = 3;

        const tagStats = {};
        const allFiles = getFilesRecursively(vaultPath);

        for (const file of allFiles) {
            if (!file.endsWith('.md')) continue;
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }

            let m;
            const tr = new RegExp(TAG_RE.source, 'gm');
            while ((m = tr.exec(content)) !== null) {
                const tag = m[1];
                tagStats[tag] = (tagStats[tag] || 0) + 1;
            }
            const fmMatch = FRONTMATTER_TAG_RE.exec(content);
            if (fmMatch) {
                fmMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).forEach(tag => {
                    if (tag) tagStats[tag] = (tagStats[tag] || 0) + 1;
                });
            }
        }

        // 既存MOCとの照合
        const existingMocs = getExistingMocs(vaultPath);
        const mocNameSet = new Set(existingMocs.map(m => m.name.toLowerCase()));

        const suggestions = [];
        for (const [tag, count] of Object.entries(tagStats)) {
            if (count < TAG_MOC_THRESHOLD) continue;
            // type/moc や auto-generated 等のメタタグは除外
            if (['type/moc', 'auto-generated', 'type', 'moc'].includes(tag.toLowerCase())) continue;

            const suggestedName = `MOC - ${tag.charAt(0).toUpperCase() + tag.slice(1)}`;
            const existingMoc = mocNameSet.has(suggestedName.toLowerCase())
                ? suggestedName
                : null;

            suggestions.push({ tag, count, existingMoc, suggestedName });
        }

        suggestions.sort((a, b) => b.count - a.count);
        return { success: true, suggestions: suggestions.slice(0, 20) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- IPCハンドラ: MOCプレビュー生成（ファイルには書き出さない） ---
ipcMain.handle('preview-moc', (_, params) => {
    try {
        const { templateId } = params;
        const vaultPath = getCurrentVault();

        let templateBody = '';
        if (templateId && templateId.startsWith('vault:')) {
            if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
            const vaultTemplates = loadVaultTemplates(vaultPath);
            const found = vaultTemplates.find(t => t.id === templateId);
            if (!found) return { success: false, error: 'テンプレートが見つかりません' };
            templateBody = found.body;
        } else if (templateId && templateId.startsWith('custom-')) {
            const found = (config.mocTemplates || []).find(t => t.id === templateId);
            if (!found) return { success: false, error: 'テンプレートが見つかりません' };
            templateBody = found.body;
        } else {
            const builtin = DEFAULT_MOC_TEMPLATES.find(t => t.id === templateId);
            if (!builtin) return { success: false, error: 'テンプレートが見つかりません' };
            templateBody = builtin.body;
        }

        const content = renderMocTemplate(templateBody, params);
        return { success: true, content };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 1: バックアップ一覧 & 復元
// ======================================================
const SCAN_HISTORY_PATH = path.join(os.homedir(), '.obsidian-optimizer-scan-history.json');

ipcMain.handle('list-backups', () => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return { success: true, backups: [] };
        const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => {
                const fullPath = path.join(BACKUP_DIR, d.name);
                let fileCount = 0;
                let totalSize = 0;
                try {
                    const files = getFilesRecursively(fullPath);
                    fileCount = files.length;
                    for (const f of files) {
                        try { totalSize += fs.statSync(f).size; } catch (_) { }
                    }
                } catch (_) { }
                // タイムスタンプをフォルダ名からパース（backup-2024-03-15T10-30-00 形式）
                const tsMatch = d.name.match(/(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})/);
                const dateStr = tsMatch ? `${tsMatch[1]} ${tsMatch[2].replace(/-/g, ':')}` : d.name;
                return { name: d.name, path: fullPath, dateStr, fileCount, totalSize };
            })
            .sort((a, b) => b.name.localeCompare(a.name)); // 新しい順
        return { success: true, backups: entries };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('restore-backup', async (event, backupName) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const backupPath = path.join(BACKUP_DIR, backupName);
        if (!backupPath.startsWith(BACKUP_DIR)) return { success: false, error: '不正なバックアップパスです' };
        if (!fs.existsSync(backupPath)) return { success: false, error: 'バックアップが見つかりません' };

        const win = getWin(event);
        const confirm = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['復元する', 'キャンセル'],
            defaultId: 1,
            title: 'バックアップ復元',
            message: `バックアップ「${backupName}」をVaultに復元します。同名ファイルは上書きされます。続行しますか？`,
        });
        if (confirm.response !== 0) return { success: false, canceled: true };

        const files = getFilesRecursively(backupPath);
        let restored = 0;
        for (const file of files) {
            const rel = path.relative(backupPath, file);
            const dest = path.join(vaultPath, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(file, dest);
            restored++;
        }
        return { success: true, restored };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-backup', async (event, backupName) => {
    try {
        const backupPath = path.join(BACKUP_DIR, backupName);
        if (!backupPath.startsWith(BACKUP_DIR)) return { success: false, error: '不正なパスです' };
        if (!fs.existsSync(backupPath)) return { success: false, error: '見つかりません' };
        fs.rmSync(backupPath, { recursive: true, force: true });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 2: スキャン履歴 (前回比較)
// ======================================================
ipcMain.handle('get-last-scan', () => {
    try {
        if (!fs.existsSync(SCAN_HISTORY_PATH)) return { success: true, lastScan: null };
        const data = JSON.parse(fs.readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
        return { success: true, lastScan: data };
    } catch (_) {
        return { success: true, lastScan: null };
    }
});

ipcMain.handle('save-scan-snapshot', (_, snapshot) => {
    try {
        fs.writeFileSync(SCAN_HISTORY_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 3: ノートプレビュー
// ======================================================
ipcMain.handle('read-note-preview', async (_, filePath) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').slice(0, 25);
        return { success: true, preview: lines.join('\n'), totalLines: content.split('\n').length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 5: タグ名変更/マージ
// ======================================================
ipcMain.handle('rename-tag', async (event, { oldTag, newTag }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!oldTag || !newTag) return { success: false, error: 'タグ名を入力してください' };
        if (oldTag === newTag) return { success: false, error: '同じタグ名です' };

        const win = getWin(event);
        const confirm = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['変更する', 'キャンセル'],
            defaultId: 1,
            title: 'タグ名変更',
            message: `#${oldTag} → #${newTag} に変更します。対象の全ファイルが書き換えられます。`,
        });
        if (confirm.response !== 0) return { success: false, canceled: true };

        // バックアップ作成
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = path.join(BACKUP_DIR, `tag-rename-${ts}`);
        fs.mkdirSync(backupPath, { recursive: true });

        const allFiles = getFilesRecursively(vaultPath);
        let changedFiles = 0;
        const escapedOld = oldTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // インラインタグ: #oldTag の後ろが単語境界
        const inlineTagRe = new RegExp(`((?:^|\\s)#)${escapedOld}(?=[\\s,;.!?\\])}\\n]|$)`, 'gm');
        // フロントマター内タグ
        const fmTagRe = new RegExp(`(["']?)${escapedOld}\\1`, 'g');

        for (const file of allFiles) {
            if (!file.endsWith('.md')) continue;
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }

            let newContent = content;
            // インラインタグ置換
            newContent = newContent.replace(inlineTagRe, `$1${newTag}`);
            // フロントマター内のtags配列を置換
            newContent = newContent.replace(/^(tags:\s*\[)([^\]]*)\]/m, (match, prefix, tagList) => {
                const replaced = tagList.replace(fmTagRe, `$1${newTag}$1`);
                return `${prefix}${replaced}]`;
            });

            if (newContent !== content) {
                // バックアップ保存
                const rel = path.relative(vaultPath, file);
                const dest = path.join(backupPath, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(file, dest);
                // 書き込み
                fs.writeFileSync(file, newContent, 'utf-8');
                changedFiles++;
            }
        }

        // バックアップが空なら削除
        if (changedFiles === 0) {
            try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch (_) { }
        }

        return { success: true, changedFiles, backupPath: changedFiles > 0 ? backupPath : null };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature A: ナレッジグラフ分析エンジン
// ======================================================
ipcMain.handle('analyze-knowledge-graph', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const LINK_RE = /\[\[(.*?)\]\]/g;
        const TAG_RE = /(?:^|\s)#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f/\-]+)/gm;
        const FRONTMATTER_TAG_RE = /^tags:\s*\[([^\]]+)\]/m;
        const noteMap = {};
        const incomingMap = {};

        const allMdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        for (const file of allMdFiles) {
            const basename = path.basename(file, '.md');
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }

            const outgoing = [];
            let m;
            const lr = new RegExp(LINK_RE.source, 'g');
            while ((m = lr.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest) outgoing.push(dest);
            }

            const tags = new Set();
            const tr = new RegExp(TAG_RE.source, 'gm');
            while ((m = tr.exec(content)) !== null) tags.add(m[1]);
            const fmMatch = FRONTMATTER_TAG_RE.exec(content);
            if (fmMatch) {
                fmMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).forEach(tag => { if (tag) tags.add(tag); });
            }

            noteMap[basename] = { path: file, outgoing, tags };
        }

        for (const [src, info] of Object.entries(noteMap)) {
            for (const dest of info.outgoing) {
                if (!incomingMap[dest]) incomingMap[dest] = new Set();
                incomingMap[dest].add(src);
            }
        }

        // 弱接続ノート
        const weakNotes = [];
        for (const [name, info] of Object.entries(noteMap)) {
            const linkCount = (incomingMap[name] ? incomingMap[name].size : 0) + info.outgoing.length;
            if (linkCount <= 1) weakNotes.push({ name, path: info.path, linkCount });
        }

        // タグ共起クラスター
        const tagIndex = {};
        for (const [name, info] of Object.entries(noteMap)) {
            for (const tag of info.tags) {
                if (!tagIndex[tag]) tagIndex[tag] = new Set();
                tagIndex[tag].add(name);
            }
        }
        const clusterMap = {};
        const tagKeys = Object.keys(tagIndex);
        for (let i = 0; i < tagKeys.length; i++) {
            for (let j = i + 1; j < tagKeys.length; j++) {
                const shared = [];
                for (const n of tagIndex[tagKeys[i]]) {
                    if (tagIndex[tagKeys[j]].has(n)) shared.push(n);
                }
                if (shared.length >= 3) {
                    const key = [tagKeys[i], tagKeys[j]].sort().join('+');
                    clusterMap[key] = { tags: [tagKeys[i], tagKeys[j]], notes: new Set(shared) };
                }
            }
        }
        const clusters = Object.values(clusterMap)
            .map(v => ({ name: v.tags.join(' + '), notes: Array.from(v.notes), tags: v.tags }))
            .sort((a, b) => b.notes.length - a.notes.length).slice(0, 30);

        // リンク提案: 2+タグ共有だがリンクなし
        const suggestions = [];
        const noteNames = Object.keys(noteMap);
        for (let i = 0; i < noteNames.length && suggestions.length < 50; i++) {
            const src = noteNames[i];
            const srcOut = new Set(noteMap[src].outgoing);
            const srcIn = incomingMap[src] || new Set();
            for (let j = i + 1; j < noteNames.length && suggestions.length < 50; j++) {
                const tgt = noteNames[j];
                if (srcOut.has(tgt) || srcIn.has(tgt)) continue;
                const tgtOut = new Set(noteMap[tgt].outgoing);
                if (tgtOut.has(src)) continue;
                const shared = [];
                for (const tag of noteMap[src].tags) { if (noteMap[tgt].tags.has(tag)) shared.push(tag); }
                if (shared.length >= 2) {
                    suggestions.push({ source: src, target: tgt, reason: `共有タグ: #${shared.join(', #')}`, score: Math.min(100, shared.length * 25) });
                }
            }
        }
        suggestions.sort((a, b) => b.score - a.score);

        return { success: true, clusters, weakNotes, suggestions };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature E: スマートアーカイブ提案
// ======================================================
ipcMain.handle('suggest-archives', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const LINK_RE = /\[\[(.*?)\]\]/g;
        const noteInfoList = [];
        const incomingCount = {};
        const allMdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));

        for (const file of allMdFiles) {
            const basename = path.basename(file, '.md');
            let stat, content;
            try { stat = fs.statSync(file); content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }

            const outgoing = [];
            let m;
            const lr = new RegExp(LINK_RE.source, 'g');
            while ((m = lr.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest) outgoing.push(dest);
            }
            noteInfoList.push({ name: basename, path: file, mtimeMs: stat.mtimeMs, outgoing });
        }

        for (const info of noteInfoList) {
            for (const dest of info.outgoing) { incomingCount[dest] = (incomingCount[dest] || 0) + 1; }
        }

        const staleDaysRef = config.staleDays ?? 180;
        const nowMs = Date.now();
        const maxIncoming = Math.max(1, ...Object.values(incomingCount));
        const maxOutgoing = Math.max(1, ...noteInfoList.map(n => n.outgoing.length));

        const archiveSuggestions = [];
        for (const info of noteInfoList) {
            const days = Math.floor((nowMs - info.mtimeMs) / 86400000);
            const incoming = incomingCount[info.name] || 0;
            const daysScore = Math.min(100, (days / staleDaysRef) * 100);
            const inScore = Math.max(0, 100 - (incoming / maxIncoming) * 100);
            const outScore = Math.max(0, 100 - (info.outgoing.length / maxOutgoing) * 100);
            const archiveScore = Math.round(daysScore * 0.4 + inScore * 0.3 + outScore * 0.3);

            if (archiveScore > 60) {
                const reasons = [];
                if (days >= staleDaysRef) reasons.push(`${days}日間未更新`);
                if (incoming === 0) reasons.push('被リンクなし');
                if (info.outgoing.length === 0) reasons.push('発リンクなし');
                archiveSuggestions.push({ name: info.name, path: info.path, archiveScore, reasons });
            }
        }
        archiveSuggestions.sort((a, b) => b.archiveScore - a.archiveScore);
        return { success: true, suggestions: archiveSuggestions };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature F: インテリジェント重複マージ
// ======================================================
ipcMain.handle('preview-merge', async (_, { fileA, fileB }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(fileA) || !isPathInsideVault(fileB)) return { success: false, error: 'Vault外のファイルは操作できません' };
        if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return { success: false, error: 'ファイルが見つかりません' };

        const contentA = fs.readFileSync(fileA, 'utf-8');
        const contentB = fs.readFileSync(fileB, 'utf-8');
        const nameA = path.basename(fileA, '.md');
        const nameB = path.basename(fileB, '.md');
        const mergedContent = contentA + `\n\n---\n\n> 以下は「${nameB}」から統合された内容です\n\n` + contentB;

        const LINK_RE = /\[\[(.*?)\]\]/g;
        const incomingLinks = [];
        const allMdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        for (const file of allMdFiles) {
            if (file === fileA || file === fileB) continue;
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            let m;
            const lr = new RegExp(LINK_RE.source, 'g');
            while ((m = lr.exec(content)) !== null) {
                if (m[1].split('|')[0].split('#')[0].trim() === nameB) {
                    incomingLinks.push({ file: path.basename(file, '.md'), path: file });
                    break;
                }
            }
        }
        return { success: true, mergedContent, nameA, nameB, incomingLinks };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('execute-merge', async (_, { fileA, fileB, mergedContent }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(fileA) || !isPathInsideVault(fileB)) return { success: false, error: 'Vault外のファイルは操作できません' };

        const nameA = path.basename(fileA, '.md');
        const nameB = path.basename(fileB, '.md');

        // バックアップ
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const backupPath = path.join(BACKUP_DIR, `merge-${ts}`);
        fs.mkdirSync(backupPath, { recursive: true });
        fs.copyFileSync(fileA, path.join(backupPath, path.basename(fileA)));
        fs.copyFileSync(fileB, path.join(backupPath, path.basename(fileB)));

        fs.writeFileSync(fileA, mergedContent, 'utf-8');

        // リンク書き換え
        let updatedFiles = 0;
        const escapedName = nameB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const linkRe = new RegExp(`\\[\\[${escapedName}(\\|[^\\]]*)?\\]\\]`, 'g');
        const allMdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        for (const file of allMdFiles) {
            if (file === fileA || file === fileB) continue;
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            const newContent = content.replace(linkRe, (match, alias) => alias ? `[[${nameA}${alias}]]` : `[[${nameA}]]`);
            if (newContent !== content) { fs.writeFileSync(file, newContent, 'utf-8'); updatedFiles++; }
        }

        fs.unlinkSync(fileB);
        return { success: true, updatedFiles, backupPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature B: ライティング分析
// ======================================================
ipcMain.handle('get-writing-analytics', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const mdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const now = new Date();
        const nowMs = now.getTime();
        const MS_PER_DAY = 86400000;
        const FM_RE = /^\s*---\n[\s\S]*?\n---/;
        const BULLET_ONLY_RE = /^(\s*[-*+]\s+.*(\n|$))+$/;

        const WEEKS = 12;
        const weeklyBuckets = Array.from({ length: WEEKS }, (_, i) => ({
            start: nowMs - (WEEKS - i) * 7 * MS_PER_DAY, end: nowMs - (WEEKS - 1 - i) * 7 * MS_PER_DAY, words: 0, noteCount: 0,
        }));
        const MONTHS = 6;
        const monthlyBuckets = Array.from({ length: MONTHS }, (_, i) => {
            const d = new Date(now.getFullYear(), now.getMonth() - (MONTHS - 1 - i), 1);
            return { year: d.getFullYear(), month: d.getMonth(), words: 0, noteCount: 0 };
        });

        const activeDays = new Set();
        const topicMap = {};
        const drafts = [];

        // Phase 1: statのみで高速にタイムライン分析（ファイル内容は読まない）
        const recentFiles = []; // 内容分析は最近のファイルだけ
        const RECENT_DAYS = 90;
        const recentThreshold = nowMs - RECENT_DAYS * MS_PER_DAY;

        for (const file of mdFiles) {
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            const mtimeMs = stat.mtimeMs;
            const mtime = new Date(mtimeMs);
            const dateStr = mtime.toISOString().split('T')[0];
            activeDays.add(dateStr);

            // ファイルサイズから語数を推定（読み込み不要）
            // 日本語: 約3バイト/文字、平均2文字/語 → 約6バイト/語
            // 英語: 約5バイト/語。混合で約5.5バイト/語として推定
            const estimatedWords = Math.round(stat.size / 5.5);

            for (const b of weeklyBuckets) { if (mtimeMs >= b.start && mtimeMs < b.end) { b.words += estimatedWords; b.noteCount++; break; } }
            for (const b of monthlyBuckets) { if (mtime.getFullYear() === b.year && mtime.getMonth() === b.month) { b.words += estimatedWords; b.noteCount++; break; } }

            if (mtimeMs >= recentThreshold) {
                const folder = path.dirname(path.relative(vaultPath, file)).split(path.sep)[0] || '(root)';
                if (!topicMap[folder]) topicMap[folder] = { count: 0, lastEditMs: 0 };
                topicMap[folder].count++;
                if (mtimeMs > topicMap[folder].lastEditMs) topicMap[folder].lastEditMs = mtimeMs;
                // 小さいファイルのみ下書き候補として内容チェック対象に
                if (stat.size < 2000) recentFiles.push({ file, stat });
            }
        }

        // Phase 2: 下書き検出のみ — 小さい最近のファイルだけ内容を読む（高速）
        const DRAFT_BATCH = 100;
        for (let i = 0; i < recentFiles.length && i < DRAFT_BATCH; i++) {
            const { file, stat } = recentFiles[i];
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            const basename = path.basename(file, '.md');
            const body = content.replace(FM_RE, '').trim();
            if (FM_RE.test(content) && body.length === 0) drafts.push({ name: basename, path: file, reason: 'フロントマターのみ' });
            else if (body.length > 0 && body.length < 50) drafts.push({ name: basename, path: file, reason: '50文字未満' });
            else if (body.length > 0 && BULLET_ONLY_RE.test(body)) drafts.push({ name: basename, path: file, reason: '箇条書きのみ' });
        }

        // ストリーク計算
        const todayIso = now.toISOString().split('T')[0];
        let currentStreak = 0;
        let checkDate = new Date(todayIso);
        if (!activeDays.has(todayIso)) checkDate = new Date(checkDate.getTime() - MS_PER_DAY);
        while (activeDays.has(checkDate.toISOString().split('T')[0])) { currentStreak++; checkDate = new Date(checkDate.getTime() - MS_PER_DAY); }

        const sortedAsc = Array.from(activeDays).sort();
        let longestStreak = 0, temp = 0;
        for (let i = 0; i < sortedAsc.length; i++) {
            if (i === 0) { temp = 1; } else {
                temp = (new Date(sortedAsc[i]).getTime() - new Date(sortedAsc[i - 1]).getTime() === MS_PER_DAY) ? temp + 1 : 1;
            }
            if (temp > longestStreak) longestStreak = temp;
        }

        const monthNames = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
        return {
            success: true,
            weeklyTrend: weeklyBuckets.map(b => ({ week: new Date(b.start).toISOString().split('T')[0], words: b.words, noteCount: b.noteCount })),
            monthlyTrend: monthlyBuckets.map(b => ({ month: `${b.year}/${monthNames[b.month]}`, words: b.words, noteCount: b.noteCount })),
            streak: { current: currentStreak, longest: longestStreak },
            drafts: drafts.slice(0, 100),
            topicActivity: Object.entries(topicMap).map(([t, d]) => ({ topic: t, count: d.count, lastEdit: new Date(d.lastEditMs).toISOString().split('T')[0] })).sort((a, b) => b.count - a.count).slice(0, 20),
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature D: リアルタイムVault監視
// ======================================================
let vaultWatcher = null;
let watchDebounceTimers = {};

ipcMain.handle('start-vault-watch', async () => {
    try {
        if (vaultWatcher) { vaultWatcher.close(); vaultWatcher = null; watchDebounceTimers = {}; }
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        vaultWatcher = fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
            if (!filename || !filename.endsWith('.md')) return;
            const segments = filename.split(path.sep);
            if (segments.some(seg => EXCLUDE_ENTRIES.has(seg) || seg.startsWith('.'))) return;

            const fullPath = path.join(vaultPath, filename);
            if (watchDebounceTimers[fullPath]) clearTimeout(watchDebounceTimers[fullPath]);
            watchDebounceTimers[fullPath] = setTimeout(() => {
                delete watchDebounceTimers[fullPath];
                if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
                if (!fs.existsSync(fullPath)) {
                    mainWindowRef.webContents.send('vault-watch-event', { type: 'delete', file: filename, issues: [] });
                    return;
                }
                const issues = [];
                let content;
                try { content = fs.readFileSync(fullPath, 'utf-8'); } catch (_) { return; }
                const junkResult = isJunkFile(fullPath, content, config.junkRules);
                if (junkResult.junk) issues.push({ type: 'junk', message: `ゴミ判定: ${junkResult.reason}` });

                const LINK_CHECK_RE = /\[\[([^\]]+)\]\]/g;
                let lm;
                while ((lm = LINK_CHECK_RE.exec(content)) !== null) {
                    const dest = lm[1].split('|')[0].split('#')[0].trim();
                    if (!dest) continue;
                    const destBase = dest.split('/').pop();
                    const found = fs.existsSync(path.join(vaultPath, dest + '.md')) || fs.existsSync(path.join(vaultPath, dest));
                    if (!found) issues.push({ type: 'broken-link', message: `リンク切れ: [[${dest}]]` });
                }
                mainWindowRef.webContents.send('vault-watch-event', { type: eventType === 'rename' ? 'rename' : 'change', file: filename, issues });
            }, 300);
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stop-vault-watch', async () => {
    try {
        if (vaultWatcher) { vaultWatcher.close(); vaultWatcher = null; }
        for (const k of Object.keys(watchDebounceTimers)) clearTimeout(watchDebounceTimers[k]);
        watchDebounceTimers = {};
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature G: Vaultタイムマシン
// ======================================================
ipcMain.handle('get-vault-timeline', async (_, dateStr) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return { success: false, error: '無効な日付形式です' };

        const targetStart = new Date(dateStr + 'T00:00:00').getTime();
        const targetEnd = targetStart + 86400000;
        const mdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const timeline = [];

        for (const file of mdFiles) {
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            if (stat.mtimeMs >= targetStart && stat.mtimeMs < targetEnd) {
                let snippet = '';
                try { const c = fs.readFileSync(file, 'utf-8'); snippet = c.replace(/^\s*---\n[\s\S]*?\n---/, '').trim().slice(0, 100); } catch (_) { }
                timeline.push({ name: path.basename(file, '.md'), path: file, mtime: new Date(stat.mtimeMs).toISOString(), size: stat.size, snippet });
            }
        }
        timeline.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
        return { success: true, date: dateStr, files: timeline };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature C: Vault構造テンプレート
// ======================================================
const STRUCTURE_TEMPLATES = [
    {
        id: 'para', name: 'PARA メソッド',
        description: 'Projects(進行中) → Areas(継続的責任) → Resources(参考資料) → Archives(完了済み)',
        folders: ['01 Projects', '02 Areas', '03 Resources', '04 Archives'],
        rules: { '01 Projects': { keywords: ['project','プロジェクト','todo','タスク','wip'] }, '02 Areas': { keywords: ['area','エリア','習慣','健康','財務'] }, '03 Resources': { keywords: ['resource','リソース','参考','howto','ガイド','学習'] }, '04 Archives': { keywords: ['archive','アーカイブ','完了','done','過去'] } },
    },
    {
        id: 'zettelkasten', name: 'Zettelkasten',
        description: 'Fleeting(メモ) → Literature(読書) → Permanent(恒久ノート)の成熟度分類',
        folders: ['00 Inbox', '10 Fleeting', '20 Literature', '30 Permanent', '90 Templates'],
        rules: { '00 Inbox': { keywords: ['inbox','未整理','new','capture'] }, '10 Fleeting': { keywords: ['fleeting','メモ','memo','thought','アイデア'] }, '20 Literature': { keywords: ['literature','読書','book','論文','記事'] }, '30 Permanent': { keywords: ['permanent','恒久','concept','原則','知見'] } },
    },
    {
        id: 'johnny-decimal', name: 'Johnny.Decimal',
        description: '10単位のカテゴリ番号で全情報を一意に管理する体系',
        folders: ['10-19 Administration', '20-29 Projects', '30-39 Resources', '40-49 Archive'],
        rules: { '10-19 Administration': { keywords: ['admin','管理','事務','財務','法務'] }, '20-29 Projects': { keywords: ['project','プロジェクト','クライアント','開発'] }, '30-39 Resources': { keywords: ['resource','テンプレート','参考','研修'] }, '40-49 Archive': { keywords: ['archive','完了','過去'] } },
    },
];

ipcMain.handle('get-structure-templates', () => ({ success: true, templates: STRUCTURE_TEMPLATES }));

ipcMain.handle('analyze-vault-structure', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const existing = getScanFolders(vaultPath);
        const allMd = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const noteData = allMd.map(file => { try { return { name: path.basename(file, '.md').toLowerCase(), content: fs.readFileSync(file, 'utf-8').toLowerCase() }; } catch (_) { return null; } }).filter(Boolean);

        const results = STRUCTURE_TEMPLATES.map(tpl => {
            let matched = 0;
            for (const tf of tpl.folders) {
                const tfNorm = tf.toLowerCase().replace(/[\d\-\s]+/g, '').trim();
                if (existing.some(ef => { const en = ef.toLowerCase().replace(/[\d\-\s]+/g, '').trim(); return en === tfNorm || en.includes(tfNorm) || tfNorm.includes(en); })) matched++;
            }
            let kwHits = 0, kwTotal = 0;
            for (const [, rule] of Object.entries(tpl.rules)) { for (const kw of rule.keywords) { kwTotal++; if (noteData.some(n => n.name.includes(kw.toLowerCase()) || n.content.includes(kw.toLowerCase()))) kwHits++; } }
            const fitScore = Math.round(((matched / Math.max(tpl.folders.length, 1)) * 0.4 + (kwHits / Math.max(kwTotal, 1)) * 0.6) * 100);
            const missingFolders = tpl.folders.filter(tf => { const tn = tf.toLowerCase().replace(/[\d\-\s]+/g, '').trim(); return !existing.some(ef => { const en = ef.toLowerCase().replace(/[\d\-\s]+/g, '').trim(); return en === tn || en.includes(tn) || tn.includes(en); }); });
            return { templateId: tpl.id, templateName: tpl.name, fitScore, missingFolders };
        }).sort((a, b) => b.fitScore - a.fitScore);
        return { success: true, results };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('apply-structure-template', async (_, { templateId, preview }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const tpl = STRUCTURE_TEMPLATES.find(t => t.id === templateId);
        if (!tpl) return { success: false, error: 'テンプレートが見つかりません' };
        const existing = getScanFolders(vaultPath);
        const foldersToCreate = tpl.folders.filter(f => !existing.some(ef => ef.toLowerCase() === f.toLowerCase()));

        const allMd = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const moveSuggestions = [];
        for (const file of allMd) {
            const bn = path.basename(file, '.md').toLowerCase();
            let content = ''; try { content = fs.readFileSync(file, 'utf-8').toLowerCase(); } catch (_) { continue; }
            const curFolder = path.relative(vaultPath, path.dirname(file)).split(path.sep)[0] || '(root)';
            let bestFolder = null, bestScore = 0;
            for (const [fn, rule] of Object.entries(tpl.rules)) { let sc = 0; for (const kw of rule.keywords) { if (bn.includes(kw)) sc += 3; if (content.includes(kw)) sc += 1; } if (sc > bestScore) { bestScore = sc; bestFolder = fn; } }
            const target = tpl.folders.find(f => f === bestFolder) || bestFolder;
            if (bestFolder && bestScore >= 2 && curFolder.toLowerCase() !== target?.toLowerCase()) {
                moveSuggestions.push({ file, name: path.basename(file, '.md'), from: curFolder, to: target, score: bestScore });
            }
        }
        if (preview) return { success: true, preview: true, foldersToCreate, moveSuggestions: moveSuggestions.sort((a, b) => b.score - a.score).slice(0, 200), template: { id: tpl.id, name: tpl.name } };

        let foldersCreated = 0, notesMoved = 0;
        for (const f of foldersToCreate) { const fp = path.join(vaultPath, f); if (!fs.existsSync(fp)) { fs.mkdirSync(fp, { recursive: true }); foldersCreated++; } }
        for (const s of moveSuggestions) {
            try { if (!isPathInsideVault(s.file)) continue; const destDir = path.join(vaultPath, s.to); if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true }); const dest = path.join(destDir, path.basename(s.file)); if (fs.existsSync(dest)) continue; fs.renameSync(s.file, dest); notesMoved++; } catch (err) { if (err.code === 'EXDEV') { try { const dest = path.join(vaultPath, s.to, path.basename(s.file)); fs.copyFileSync(s.file, dest); fs.unlinkSync(s.file); notesMoved++; } catch (_) { } } }
        }
        return { success: true, preview: false, foldersCreated, notesMoved, template: { id: tpl.id, name: tpl.name } };
    } catch (e) { return { success: false, error: e.message }; }
});

// ======================================================
// Feature H: フルグラフデータ
// ======================================================
ipcMain.handle('get-full-graph', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const MAX_NODES = 500;
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const TAG_RE = /(?:^|\s)#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f/\-]+)/gm;
        const allMd = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const nodeMap = {};
        const edgesRaw = [];
        const linkCount = {};

        for (const file of allMd) {
            const bn = path.basename(file, '.md');
            const folder = path.relative(vaultPath, path.dirname(file)).split(path.sep)[0] || '(root)';
            let content = ''; try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            const tags = new Set(); let m; const tr = new RegExp(TAG_RE.source, 'gm'); while ((m = tr.exec(content)) !== null) tags.add(m[1]);
            const isMoc = bn.includes('MOC') || bn.startsWith('_MOC');
            const outLinks = []; const lr = new RegExp(LINK_RE.source, 'g'); while ((m = lr.exec(content)) !== null) { const d = m[1].split('|')[0].split('#')[0].trim(); if (d) outLinks.push(d); }
            const relPath = path.relative(vaultPath, file);
            if (!nodeMap[bn]) nodeMap[bn] = { id: bn, name: bn, folder, tagCount: tags.size, linkCount: 0, isMoc, path: relPath };
            for (const d of outLinks) { const db = path.basename(d).replace(/\.md$/, ''); edgesRaw.push({ source: bn, target: db }); linkCount[bn] = (linkCount[bn] || 0) + 1; linkCount[db] = (linkCount[db] || 0) + 1; }
        }
        for (const [n, node] of Object.entries(nodeMap)) node.linkCount = linkCount[n] || 0;
        let nodes = Object.values(nodeMap);
        if (nodes.length > MAX_NODES) { nodes.sort((a, b) => b.linkCount - a.linkCount); nodes = nodes.slice(0, MAX_NODES); }
        const nodeIds = new Set(nodes.map(n => n.id));
        const edgeSet = new Set();
        const edges = edgesRaw.filter(e => { if (!nodeIds.has(e.source) || !nodeIds.has(e.target) || e.source === e.target) return false; const k = [e.source, e.target].sort().join('||'); if (edgeSet.has(k)) return false; edgeSet.add(k); return true; });
        return { success: true, nodes, edges };
    } catch (e) { return { success: false, error: e.message }; }
});

// ======================================================
// Feature I: i18n
// ======================================================
ipcMain.handle('get-app-language', () => {
    try { const lang = config.appLanguage || (app.getLocale().startsWith('zh') ? 'zh' : app.getLocale().startsWith('en') ? 'en' : 'ja'); return { success: true, language: lang }; }
    catch (_) { return { success: true, language: 'ja' }; }
});
ipcMain.handle('set-app-language', (_, lang) => {
    try { if (!['ja', 'en', 'zh'].includes(lang)) return { success: false, error: '未対応の言語' }; config.appLanguage = lang; saveConfig(config); return { success: true, language: lang }; }
    catch (e) { return { success: false, error: e.message }; }
});

// ======================================================
// Feature J: 拡張Obsidian URI + Dataviewレポートノート
// ======================================================
ipcMain.handle('generate-optimizer-report-note', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const dateStr = new Date().toISOString().split('T')[0];
        const reportName = `Optimizer Report ${dateStr}`;
        const outputDir = fs.existsSync(path.join(vaultPath, '10 Atlas')) ? path.join(vaultPath, '10 Atlas') : vaultPath;
        const reportPath = path.join(outputDir, `${reportName}.md`);
        const content = `---\ntags: ["type/report", "auto-generated", "optimizer"]\ndate: ${dateStr}\n---\n\n# 📊 Vault 最適化レポート (${dateStr})\n\n> Obsidian Optimizer が自動生成。Dataview有効時は自動更新されます。\n\n## 🔍 被リンク数TOP20\n\n\`\`\`dataview\nTABLE length(file.inlinks) AS "被リンク", length(file.outlinks) AS "発リンク"\nFROM "" SORT length(file.inlinks) DESC LIMIT 20\n\`\`\`\n\n## ⚠️ 孤立ノート\n\n\`\`\`dataview\nTABLE file.folder AS "フォルダ", file.mtime AS "最終更新"\nFROM "" WHERE length(file.inlinks)=0 AND length(file.outlinks)=0\nAND !contains(file.name,"MOC") AND !contains(file.name,"Template")\nSORT file.mtime ASC LIMIT 50\n\`\`\`\n\n## 📅 放置ノート（180日以上）\n\n\`\`\`dataview\nTABLE file.folder AS "フォルダ", round((date(now)-file.mtime).days) AS "経過日数"\nFROM "" WHERE (date(now)-file.mtime).days > 180\nAND !contains(file.path,"Archive")\nSORT file.mtime ASC LIMIT 50\n\`\`\`\n\n## 🏷️ タグ別ノート数\n\n\`\`\`dataview\nTABLE length(rows) AS "ノート数"\nFROM "" FLATTEN file.tags AS tag\nGROUP BY tag SORT length(rows) DESC LIMIT 30\n\`\`\`\n\n---\n*Generated by Obsidian Optimizer v4.3*\n`;
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, content, 'utf-8');
        return { success: true, reportPath, reportName };
    } catch (e) { return { success: false, error: e.message }; }
});

// ======================================================
// Obsidian ダッシュボード/タスク管理ノート生成
// ======================================================
ipcMain.handle('generate-obsidian-dashboard', async (_, { type }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const year = now.getFullYear();
        // ISO週番号の計算
        const jan1 = new Date(year, 0, 1);
        const dayOfYear = Math.ceil((now - jan1) / (24 * 60 * 60 * 1000));
        const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);
        const weekStr = `${year}-W${String(weekNum).padStart(2, '0')}`;

        // 週の開始日と終了日を計算
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const monday = new Date(now);
        monday.setDate(now.getDate() + mondayOffset);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const dateRange = `${fmt(monday)} ~ ${fmt(sunday)}`;

        // 保存先: "05 MOCs" フォルダがあればそこに、なければルート
        const mocDir = path.join(vaultPath, '05 MOCs');
        const outputDir = fs.existsSync(mocDir) ? mocDir : vaultPath;

        let fileName;
        let content;

        switch (type) {
            case 'full':
                fileName = '\u{1F5A5}\uFE0F Dashboard.md';
                content = `---\ntype: dashboard\ncreated: "${dateStr}"\ncssclasses: [dashboard]\n---\n\n# \u{1F5A5}\uFE0F Dashboard\n\n## \u{1F4CA} Vault Overview\n\`\`\`dataview\nTABLE WITHOUT ID\n  length(filter(file.tasks, (t) => !t.completed)) AS "\u672A\u5B8C\u4E86\u30BF\u30B9\u30AF",\n  length(filter(file.tasks, (t) => t.completed)) AS "\u5B8C\u4E86\u30BF\u30B9\u30AF"\nFROM ""\nWHERE length(file.tasks) > 0\nLIMIT 1\n\`\`\`\n\n## \u2705 \u4ECA\u65E5\u306E\u30BF\u30B9\u30AF\n\`\`\`tasks\ndue today\nnot done\nshort mode\n\`\`\`\n\n## \u{1F4C5} \u4ECA\u9031\u306E\u671F\u9650\n\`\`\`tasks\ndue before next week\ndue after yesterday\nnot done\nshort mode\n\`\`\`\n\n## \u26A0\uFE0F \u671F\u9650\u5207\u308C\u30BF\u30B9\u30AF\n\`\`\`tasks\ndue before today\nnot done\nshort mode\n\`\`\`\n\n## \u{1F4DD} \u6700\u8FD1\u66F4\u65B0\u3057\u305F\u30CE\u30FC\u30C8\n\`\`\`dataview\nTABLE file.mday AS "\u66F4\u65B0\u65E5", file.folder AS "\u30D5\u30A9\u30EB\u30C0"\nFROM ""\nWHERE file.name != this.file.name\nSORT file.mday DESC\nLIMIT 15\n\`\`\`\n\n## \u{1F3F7}\uFE0F \u30BF\u30B0\u5225\u30CE\u30FC\u30C8\u6570\n\`\`\`dataview\nTABLE length(rows) AS "\u30CE\u30FC\u30C8\u6570"\nFROM ""\nFLATTEN file.tags AS tag\nGROUP BY tag\nSORT length(rows) DESC\nLIMIT 20\n\`\`\`\n\n## \u{1F4C2} \u30D5\u30A9\u30EB\u30C0\u5225\u30CE\u30FC\u30C8\u6570\n\`\`\`dataview\nTABLE length(rows) AS "\u30CE\u30FC\u30C8\u6570"\nFROM ""\nGROUP BY file.folder\nSORT length(rows) DESC\nLIMIT 15\n\`\`\`\n\n## \u{1F517} \u88AB\u30EA\u30F3\u30AF\u6570TOP10\n\`\`\`dataview\nTABLE length(file.inlinks) AS "\u88AB\u30EA\u30F3\u30AF\u6570", length(file.outlinks) AS "\u767A\u30EA\u30F3\u30AF\u6570"\nFROM ""\nSORT length(file.inlinks) DESC\nLIMIT 10\n\`\`\`\n\n## \u{1F5D3}\uFE0F \u4ECA\u6708\u4F5C\u6210\u3057\u305F\u30CE\u30FC\u30C8\n\`\`\`dataview\nTABLE file.cday AS "\u4F5C\u6210\u65E5", file.folder AS "\u30D5\u30A9\u30EB\u30C0"\nFROM ""\nWHERE file.cday >= date(today) - dur(30 days)\nSORT file.cday DESC\n\`\`\`\n\n## \u{1F331} \u5B64\u7ACB\u30CE\u30FC\u30C8\uFF08\u30EA\u30F3\u30AF\u306A\u3057\uFF09\n\`\`\`dataview\nTABLE file.folder AS "\u30D5\u30A9\u30EB\u30C0", file.mday AS "\u6700\u7D42\u66F4\u65B0"\nFROM ""\nWHERE length(file.inlinks) = 0 AND length(file.outlinks) = 0\nAND !contains(file.name, "MOC") AND !contains(file.name, "Template") AND !contains(file.name, "Dashboard")\nSORT file.mday ASC\nLIMIT 20\n\`\`\`\n\n---\n*Generated by Obsidian Optimizer v4.3*\n`;
                break;

            case 'tasks':
                fileName = '\u2705 Task Board.md';
                content = `---\ntype: task-board\ncreated: "${dateStr}"\n---\n\n# \u2705 Task Board\n\n## \u{1F534} \u671F\u9650\u5207\u308C\n\`\`\`tasks\ndue before today\nnot done\ngroup by due\n\`\`\`\n\n## \u{1F7E1} \u4ECA\u65E5\n\`\`\`tasks\ndue today\nnot done\n\`\`\`\n\n## \u{1F535} \u4ECA\u9031\n\`\`\`tasks\ndue after today\ndue before in 7 days\nnot done\ngroup by due\n\`\`\`\n\n## \u{1F7E2} \u6765\u9031\u4EE5\u964D\n\`\`\`tasks\ndue after in 7 days\nnot done\ngroup by due\n\`\`\`\n\n## \u2705 \u6700\u8FD1\u5B8C\u4E86\u3057\u305F\u30BF\u30B9\u30AF\n\`\`\`tasks\ndone after 7 days ago\nshort mode\n\`\`\`\n\n## \u{1F4CA} \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u5225\u30BF\u30B9\u30AF\n\`\`\`dataview\nTABLE \n  length(filter(file.tasks, (t) => !t.completed)) AS "\u672A\u5B8C\u4E86",\n  length(filter(file.tasks, (t) => t.completed)) AS "\u5B8C\u4E86"\nFROM ""\nWHERE length(file.tasks) > 0\nSORT length(filter(file.tasks, (t) => !t.completed)) DESC\n\`\`\`\n\n## \u{1F4CC} \u512A\u5148\u5EA6\u9AD8\u30BF\u30B9\u30AF\n\`\`\`tasks\nnot done\npriority is high\n\`\`\`\n\n---\n*Generated by Obsidian Optimizer v4.3*\n`;
                break;

            case 'weekly':
                fileName = `\u{1F4C5} Weekly Review ${dateStr}.md`;
                content = `---\ntype: weekly-review\nweek: "${weekStr}"\ncreated: "${dateStr}"\n---\n\n# \u{1F4C5} Weekly Review (${dateRange})\n\n## \u{1F4DD} \u4ECA\u9031\u66F8\u3044\u305F\u30CE\u30FC\u30C8\n\`\`\`dataview\nTABLE file.folder AS "\u30D5\u30A9\u30EB\u30C0", file.cday AS "\u4F5C\u6210\u65E5"\nFROM ""\nWHERE file.cday >= date(today) - dur(7 days)\nSORT file.cday DESC\n\`\`\`\n\n## \u2705 \u4ECA\u9031\u5B8C\u4E86\u3057\u305F\u30BF\u30B9\u30AF\n\`\`\`tasks\ndone after 7 days ago\nshort mode\n\`\`\`\n\n## \u23F3 \u6301\u3061\u8D8A\u3057\u30BF\u30B9\u30AF\n\`\`\`tasks\ndue before today\nnot done\n\`\`\`\n\n## \u{1F4CA} \u4ECA\u9031\u306E\u632F\u308A\u8FD4\u308A\n### \u3088\u304B\u3063\u305F\u3053\u3068\n- \n\n### \u6539\u5584\u3057\u305F\u3044\u3053\u3068\n- \n\n### \u6765\u9031\u306E\u76EE\u6A19\n- \n\n## \u{1F517} \u4ECA\u9031\u30EA\u30F3\u30AF\u3057\u305F\u30CE\u30FC\u30C8\n\`\`\`dataview\nTABLE length(file.outlinks) AS "\u30EA\u30F3\u30AF\u6570"\nFROM ""\nWHERE file.mday >= date(today) - dur(7 days)\nSORT length(file.outlinks) DESC\nLIMIT 10\n\`\`\`\n\n---\n*Generated by Obsidian Optimizer v4.3*\n`;
                break;

            case 'projects':
                fileName = '\u{1F4CB} Projects.md';
                content = `---\ntype: project-board\ncreated: "${dateStr}"\n---\n\n# \u{1F4CB} Project Board\n\n## \u{1F525} \u30A2\u30AF\u30C6\u30A3\u30D6\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\n\`\`\`dataview\nTABLE\n  length(filter(file.tasks, (t) => !t.completed)) AS "\u6B8B\u30BF\u30B9\u30AF",\n  length(filter(file.tasks, (t) => t.completed)) AS "\u5B8C\u4E86",\n  round(length(filter(file.tasks, (t) => t.completed)) / length(file.tasks) * 100) + "%" AS "\u9032\u6357"\nFROM "01 Projects" OR #type/project\nWHERE length(file.tasks) > 0\nSORT length(filter(file.tasks, (t) => !t.completed)) DESC\n\`\`\`\n\n## \u{1F4C5} \u671F\u9650\u304C\u8FD1\u3044\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\n\`\`\`dataview\nTABLE\n  dateformat(due, "yyyy-MM-dd") AS "\u671F\u9650"\nFROM "01 Projects" OR #type/project\nWHERE due\nSORT due ASC\nLIMIT 10\n\`\`\`\n\n## \u2705 \u5B8C\u4E86\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\n\`\`\`dataview\nTABLE file.mday AS "\u5B8C\u4E86\u65E5"\nFROM "04 Archives" OR #status/done\nWHERE contains(file.tags, "type/project")\nSORT file.mday DESC\nLIMIT 10\n\`\`\`\n\n## \u{1F4CA} \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u6982\u8981\n\`\`\`dataview\nTABLE length(file.outlinks) AS "\u95A2\u9023\u30CE\u30FC\u30C8", file.mday AS "\u6700\u7D42\u66F4\u65B0"\nFROM "01 Projects" OR #type/project\nSORT file.mday DESC\n\`\`\`\n\n---\n*Generated by Obsidian Optimizer v4.3*\n`;
                break;

            default:
                return { success: false, error: `不明なダッシュボードタイプ: ${type}` };
        }

        const filePath = path.join(outputDir, fileName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true, path: filePath, name: fileName };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 4: ノートスコアリングシステム
// ======================================================
const SCORE_WEIGHTS = {
    OUTLINK: 3,
    INLINK: 5,
    CONTENT_DEPTH_MAX: 10,
    CONTENT_DEPTH_THRESHOLD: 200,
    RECENCY_BONUS: 10,
    RECENCY_DAYS: 30,
    METADATA_BONUS: 5,
    MAX_SCORE: 100,
};

ipcMain.handle('get-note-scores', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const LINK_RE = /\[\[(.*?)\]\]/g;
        const TAG_RE = /(?:^|\s)#([\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f/\-]+)/gm;
        const FRONTMATTER_RE = /^\s*---\n[\s\S]*?\n---/;
        const nowMs = Date.now();
        const recencyLimitMs = SCORE_WEIGHTS.RECENCY_DAYS * 24 * 60 * 60 * 1000;

        const allMd = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const noteData = {};
        const outLinks = {};

        // 第1パス: 全ノートのデータを収集
        for (const file of allMd) {
            const basename = path.basename(file, '.md');
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }

            // 発リンク
            const links = [];
            let m;
            const lr = new RegExp(LINK_RE.source, 'g');
            while ((m = lr.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest) links.push(dest);
            }
            outLinks[basename] = links;

            // ワードカウント（フロントマター除去後）
            const plainText = content.replace(FRONTMATTER_RE, '').replace(/[#*\[\]]/g, '');
            const wordCount = plainText.trim().split(/\s+/).filter(Boolean).length;

            // フロントマターとタグの有無
            const hasFrontmatter = FRONTMATTER_RE.test(content);
            const tr = new RegExp(TAG_RE.source, 'gm');
            const hasTags = tr.test(content);

            // 最近の更新チェック
            const recentlyUpdated = (nowMs - stat.mtimeMs) < recencyLimitMs;

            noteData[basename] = {
                name: basename,
                path: file,
                linkCount: links.length,
                inlinkCount: 0,
                wordCount,
                recentlyUpdated,
                hasTagsAndFrontmatter: hasFrontmatter && hasTags,
                mtimeMs: stat.mtimeMs,
            };
        }

        // 第2パス: 被リンクカウント
        for (const src in outLinks) {
            for (const dest of outLinks[src]) {
                const destBase = path.basename(dest).replace(/\.md$/, '');
                if (noteData[destBase]) {
                    noteData[destBase].inlinkCount++;
                } else if (noteData[dest]) {
                    noteData[dest].inlinkCount++;
                }
            }
        }

        // スコア計算
        const scores = Object.values(noteData).map(note => {
            const linksScore = Math.min(note.linkCount * SCORE_WEIGHTS.OUTLINK, 30);
            const inlinksScore = Math.min(note.inlinkCount * SCORE_WEIGHTS.INLINK, 35);
            const wordsScore = note.wordCount > SCORE_WEIGHTS.CONTENT_DEPTH_THRESHOLD
                ? SCORE_WEIGHTS.CONTENT_DEPTH_MAX
                : Math.round(note.wordCount / (SCORE_WEIGHTS.CONTENT_DEPTH_THRESHOLD / SCORE_WEIGHTS.CONTENT_DEPTH_MAX));
            const recencyScore = note.recentlyUpdated ? SCORE_WEIGHTS.RECENCY_BONUS : 0;
            const metadataScore = note.hasTagsAndFrontmatter ? SCORE_WEIGHTS.METADATA_BONUS : 0;

            const rawScore = linksScore + inlinksScore + wordsScore + recencyScore + metadataScore;
            const score = Math.min(rawScore, SCORE_WEIGHTS.MAX_SCORE);

            return {
                name: note.name,
                path: note.path,
                score,
                breakdown: {
                    links: linksScore,
                    inlinks: inlinksScore,
                    words: wordsScore,
                    recency: recencyScore,
                    metadata: metadataScore,
                },
            };
        });

        scores.sort((a, b) => b.score - a.score);
        return { success: true, scores };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 5: Vault比較（タイムトラベル）— スナップショット履歴
// ======================================================
const VAULT_HISTORY_PATH = path.join(os.homedir(), '.obsidian-optimizer-vault-history.json');

ipcMain.handle('save-vault-snapshot', (_, snapshot) => {
    try {
        let history = [];
        if (fs.existsSync(VAULT_HISTORY_PATH)) {
            try { history = JSON.parse(fs.readFileSync(VAULT_HISTORY_PATH, 'utf-8')); } catch (_) { history = []; }
        }
        if (!Array.isArray(history)) history = [];
        // 最大100件保持
        const MAX_HISTORY = 100;
        history.push(snapshot);
        if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
        fs.writeFileSync(VAULT_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-vault-history', () => {
    try {
        if (!fs.existsSync(VAULT_HISTORY_PATH)) return { success: true, history: [] };
        const data = JSON.parse(fs.readFileSync(VAULT_HISTORY_PATH, 'utf-8'));
        return { success: true, history: Array.isArray(data) ? data : [] };
    } catch (_) {
        return { success: true, history: [] };
    }
});

// ======================================================
// Feature 8: ゲーミフィケーション — 実績システム
// ======================================================
const ACHIEVEMENT_DEFS = [
    { id: 'beginner', emoji: '🌱', name: '初心者', description: '初回スキャンを完了', check: (a) => a.scansCompleted >= 1 },
    { id: 'tidy', emoji: '🧹', name: '整理整頓', description: 'ゴミファイルを累計10件以上削除', check: (a) => a.junksDeleted >= 10 },
    { id: 'linkmaster', emoji: '🔗', name: 'リンクマスター', description: '壊れたリンクを累計10件以上修復', check: (a) => a.linksFixed >= 10 },
    { id: 'mocbuilder', emoji: '🗺️', name: 'MOCビルダー', description: 'MOCを累計5件以上作成', check: (a) => a.mocsCreated >= 5 },
    { id: 'perfectionist', emoji: '⭐', name: '完璧主義者', description: '健全度スコア90以上を達成', check: (a) => a.bestScore >= 90 },
    { id: 'streak7', emoji: '🔥', name: '7日連続', description: '7日連続でスキャンを実行', check: (a) => a.streakDays >= 7 },
    { id: 'vaultkeeper', emoji: '🏆', name: 'Vault Keeper', description: '全実績を達成', check: (a, allDefs) => allDefs.filter(d => d.id !== 'vaultkeeper').every(d => d.check(a)) },
];

ipcMain.handle('get-achievements', () => {
    try {
        const achievements = config.achievements || { junksDeleted: 0, linksFixed: 0, mocsCreated: 0, scansCompleted: 0, bestScore: 0, lastScanDate: null, streakDays: 0 };
        const result = ACHIEVEMENT_DEFS.map(def => ({
            id: def.id,
            emoji: def.emoji,
            name: def.name,
            description: def.description,
            earned: def.check(achievements, ACHIEVEMENT_DEFS),
        }));
        return { success: true, achievements: result, progress: achievements };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('update-achievement-progress', (_, updates) => {
    try {
        if (!config.achievements) {
            config.achievements = { junksDeleted: 0, linksFixed: 0, mocsCreated: 0, scansCompleted: 0, bestScore: 0, lastScanDate: null, streakDays: 0 };
        }
        for (const [key, value] of Object.entries(updates)) {
            if (key === 'junksDeleted' || key === 'linksFixed' || key === 'mocsCreated') {
                config.achievements[key] = (config.achievements[key] || 0) + value;
            } else if (key === 'scansCompleted') {
                config.achievements.scansCompleted = (config.achievements.scansCompleted || 0) + 1;
                // ストリーク計算
                const today = new Date().toISOString().split('T')[0];
                const lastDate = config.achievements.lastScanDate;
                if (lastDate) {
                    const lastMs = new Date(lastDate).getTime();
                    const todayMs = new Date(today).getTime();
                    const diffDays = Math.round((todayMs - lastMs) / (24 * 60 * 60 * 1000));
                    if (diffDays === 1) {
                        config.achievements.streakDays = (config.achievements.streakDays || 0) + 1;
                    } else if (diffDays > 1) {
                        config.achievements.streakDays = 1;
                    }
                    // 同日なら変更なし
                } else {
                    config.achievements.streakDays = 1;
                }
                config.achievements.lastScanDate = today;
            } else if (key === 'bestScore') {
                config.achievements.bestScore = Math.max(config.achievements.bestScore || 0, value);
            }
        }
        saveConfig(config);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 10: スケジュール自動スキャン
// ======================================================
let scheduledScanTimer = null;

function startScheduledScan() {
    if (scheduledScanTimer) { clearInterval(scheduledScanTimer); scheduledScanTimer = null; }
    const schedule = config.autoScanSchedule || 'off';
    if (schedule === 'off') return;

    const DAILY_MS = 24 * 60 * 60 * 1000;
    const WEEKLY_MS = 7 * DAILY_MS;
    const intervalMs = schedule === 'daily' ? DAILY_MS : WEEKLY_MS;

    scheduledScanTimer = setInterval(async () => {
        try {
            const res = await doScanVault();
            if (res && res.success) {
                const s = res.stats;
                // スナップショット自動保存
                const snapshot = {
                    timestamp: new Date().toISOString(),
                    totalMDFiles: s.totalMDFiles,
                    orphanNotes: s.orphanNotes,
                    junkFiles: s.junkFiles,
                    brokenLinksCount: s.brokenLinksCount || 0,
                    staleCount: (s.staleList || []).length,
                    mocsCount: s.mocsCount,
                    healthScore: Math.max(0, Math.round(100 - (
                        Math.min(s.orphanNotes * 0.35, 35) +
                        Math.min(s.junkFiles * 2, 25) +
                        Math.min((s.brokenLinksCount || 0) * 0.5, 15) +
                        Math.min((s.duplicateList || []).length, 10) +
                        Math.min((s.staleList || []).length * 0.1, 10)
                    ))),
                };
                // 履歴に保存
                let history = [];
                if (fs.existsSync(VAULT_HISTORY_PATH)) {
                    try { history = JSON.parse(fs.readFileSync(VAULT_HISTORY_PATH, 'utf-8')); } catch (_) { history = []; }
                }
                if (!Array.isArray(history)) history = [];
                history.push(snapshot);
                if (history.length > 100) history = history.slice(-100);
                fs.writeFileSync(VAULT_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');

                // 問題があれば通知
                const problems = s.orphanNotes + s.junkFiles + (s.brokenLinksCount || 0);
                if (problems > 0 && Notification.isSupported()) {
                    new Notification({
                        title: 'Obsidian Optimizer 定期スキャン',
                        body: `孤立:${s.orphanNotes} / ゴミ:${s.junkFiles} / リンク切れ:${s.brokenLinksCount || 0} が見つかりました`
                    }).show();
                }
            }
        } catch (e) { console.error('Scheduled scan error:', e); }
    }, intervalMs);
}

ipcMain.handle('set-auto-scan-schedule', (_, schedule) => {
    try {
        if (!['off', 'daily', 'weekly'].includes(schedule)) return { success: false, error: '無効なスケジュール' };
        config.autoScanSchedule = schedule;
        saveConfig(config);
        startScheduledScan();
        return { success: true, schedule };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 3: Vault ヘルスレポート MD 出力
// ======================================================
ipcMain.handle('export-health-report', async (event) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const vaultName = path.basename(vaultPath);

        // 最新スキャンデータを取得（履歴ファイルから）
        let scanStats = null;
        try {
            if (fs.existsSync(SCAN_HISTORY_PATH)) {
                scanStats = JSON.parse(fs.readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
            }
        } catch (_) { /* ignore */ }

        // スキャンデータがない場合はスキャン実行
        if (!scanStats) {
            const scanResult = await doScanVault();
            if (scanResult && scanResult.success) {
                scanStats = scanResult.stats;
            } else {
                return { success: false, error: 'スキャンデータがありません。先にスキャンを実行してください。' };
            }
        }

        // ヘルススコア算出
        const dupCount = (scanStats.duplicateList || []).length;
        const staleCount = (scanStats.staleList || []).length;
        const penalty = Math.min((scanStats.orphanNotes || 0) * 0.35, 35)
            + Math.min((scanStats.junkFiles || 0) * 2, 25)
            + Math.min((scanStats.brokenLinksCount || 0) * 0.5, 15)
            + Math.min(dupCount, 10)
            + Math.min(staleCount * 0.1, 10);
        const healthScore = Math.max(0, Math.round(100 - penalty));

        const ts = new Date().toLocaleString('ja-JP');
        const dateStr = new Date().toISOString().split('T')[0];

        // 推奨事項を生成
        const recommendations = [];
        if (healthScore < 50) recommendations.push('- 健全度が低いです。ゴミファイルの削除と孤立ノートのMOC接続を優先的に実施してください。');
        if ((scanStats.orphanNotes || 0) > 20) recommendations.push('- 孤立ノートが多数あります。「最適化 → 孤立ノートをMOCへ接続」を実行してください。');
        if ((scanStats.junkFiles || 0) > 10) recommendations.push('- ゴミファイルが多数あります。スキャン結果タブから確認・削除してください。');
        if ((scanStats.brokenLinksCount || 0) > 5) recommendations.push('- 壊れたリンクがあります。スキャン結果タブから修復してください。');
        if (staleCount > 30) recommendations.push('- 放置ノートが多数あります。アーカイブまたはレビューを検討してください。');
        if ((scanStats.orphanImageCount || 0) > 10) recommendations.push('- 孤立画像が多数あります。不要な画像を削除してVault容量を節約してください。');
        if (recommendations.length === 0) recommendations.push('- Vaultは良好な状態です。定期的なスキャンを続けてください。');

        // トップ問題リスト
        const topIssues = [];
        if ((scanStats.orphanNotes || 0) > 0) topIssues.push(`| 孤立ノート | ${scanStats.orphanNotes} | 他のノートとリンクされていない |`);
        if ((scanStats.junkFiles || 0) > 0) topIssues.push(`| ゴミファイル | ${scanStats.junkFiles} | 空・無題・コンテンツなし |`);
        if ((scanStats.brokenLinksCount || 0) > 0) topIssues.push(`| 壊れたリンク | ${scanStats.brokenLinksCount} | リンク先が存在しない |`);
        if (staleCount > 0) topIssues.push(`| 放置ノート | ${staleCount} | ${config.staleDays || 180}日以上未更新 |`);
        if (dupCount > 0) topIssues.push(`| 重複ノート候補 | ${dupCount} | 類似コンテンツの可能性 |`);
        if ((scanStats.orphanImageCount || 0) > 0) topIssues.push(`| 孤立画像/添付 | ${scanStats.orphanImageCount} | 未参照の画像ファイル |`);

        const reportLines = [
            '# Vault ヘルスレポート',
            '',
            `> 生成日時: ${ts}`,
            `> Vault: ${vaultName}`,
            `> パス: ${vaultPath}`,
            '',
            '---',
            '',
            `## 健全度スコア: **${healthScore} / 100**`,
            '',
            healthScore >= 80 ? 'Vaultは **良好** な状態です。' :
            healthScore >= 50 ? 'Vaultに **注意が必要** な問題があります。' :
            'Vaultの状態が **深刻** です。早急な対応を推奨します。',
            '',
            '---',
            '',
            '## サマリー統計',
            '',
            '| 項目 | 値 |',
            '|------|------|',
            `| 総ノート数 | ${scanStats.totalMDFiles || 0} |`,
            `| MOC数 | ${scanStats.mocsCount || 0} |`,
            `| 総リンク数 | ${scanStats.totalLinks || 0} |`,
            `| 総単語数 | ${(scanStats.totalWords || 0).toLocaleString()} |`,
            `| 総画像/添付数 | ${scanStats.totalImages || 0} |`,
            '',
            '---',
            '',
            '## 検出された問題',
            '',
            '| 問題 | 件数 | 説明 |',
            '|------|------|------|',
            ...topIssues,
            '',
            '---',
            '',
            '## 推奨アクション',
            '',
            ...recommendations,
            '',
            '---',
            '',
            '## フォルダ別ノート数',
            '',
            '| フォルダ | ノート数 |',
            '|----------|----------|',
            ...Object.entries(scanStats.folderStructure || {}).map(([f, c]) => `| ${f} | ${c} |`),
            '',
            '---',
            '',
            '## タグ TOP 15',
            '',
            '| タグ | 使用回数 |',
            '|------|----------|',
            ...(scanStats.topTags || []).slice(0, 15).map(t => `| ${t.tag} | ${t.count} |`),
            '',
            '---',
            '',
            '*Generated by Obsidian Optimizer v4.3*',
        ];

        const reportContent = reportLines.join('\n');

        const win = getWin(event);
        const result = await dialog.showSaveDialog(win, {
            defaultPath: path.join(os.homedir(), `vault-health-report-${dateStr}.md`),
            filters: [{ name: 'Markdown', extensions: ['md'] }],
        });

        if (result.canceled || !result.filePath) {
            return { success: false, canceled: true };
        }

        fs.writeFileSync(result.filePath, reportContent, 'utf-8');
        return { success: true, filePath: result.filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ======================================================
// Feature 9: ノートインポーター (Notion / Evernote / Bear)
// ======================================================

// HTML→Markdown簡易変換（外部ライブラリ不使用）
function htmlToBasicMarkdown(html) {
    if (!html) return '';
    let md = html;
    // ブロック要素の処理
    md = md.replace(/<br\s*\/?>/gi, '\n');
    md = md.replace(/<\/p>/gi, '\n\n');
    md = md.replace(/<\/div>/gi, '\n');
    md = md.replace(/<\/li>/gi, '\n');
    md = md.replace(/<li[^>]*>/gi, '- ');
    md = md.replace(/<\/h1>/gi, '\n\n');
    md = md.replace(/<\/h2>/gi, '\n\n');
    md = md.replace(/<\/h3>/gi, '\n\n');
    md = md.replace(/<\/h4>/gi, '\n\n');
    md = md.replace(/<h1[^>]*>/gi, '# ');
    md = md.replace(/<h2[^>]*>/gi, '## ');
    md = md.replace(/<h3[^>]*>/gi, '### ');
    md = md.replace(/<h4[^>]*>/gi, '#### ');
    // インライン要素の処理
    md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
    md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
    md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
    md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
    md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
    md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
    md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
    md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');
    // チェックボックス
    md = md.replace(/<en-todo\s+checked="true"\s*\/?>/gi, '- [x] ');
    md = md.replace(/<en-todo[^>]*\/?>/gi, '- [ ] ');
    // 水平線
    md = md.replace(/<hr[^>]*\/?>/gi, '\n---\n');
    // 残りのHTMLタグを除去
    md = md.replace(/<[^>]+>/g, '');
    // HTMLエンティティをデコード
    md = md.replace(/&amp;/g, '&');
    md = md.replace(/&lt;/g, '<');
    md = md.replace(/&gt;/g, '>');
    md = md.replace(/&quot;/g, '"');
    md = md.replace(/&#39;/g, "'");
    md = md.replace(/&nbsp;/g, ' ');
    // 過剰な空行を整理
    md = md.replace(/\n{3,}/g, '\n\n');
    return md.trim();
}

// Notionファイル名からUUIDを除去
function cleanNotionFilename(filename) {
    const UUID_PATTERN = /\s+[a-f0-9]{32}$/i;
    const baseName = filename.replace(/\.md$/, '');
    const cleaned = baseName.replace(UUID_PATTERN, '');
    return cleaned || baseName;
}

// Notionリンクの修正
function cleanNotionLinks(content) {
    return content.replace(/\[\[([^\]]*?)\s+[a-f0-9]{32}\]\]/gi, '[[$1]]');
}

// ENEXファイルをパースしてノート配列を返す（簡易XMLパーサー）
function parseEnexFile(enexContent) {
    const notes = [];
    const NOTE_RE = /<note>([\s\S]*?)<\/note>/gi;
    let noteMatch;
    while ((noteMatch = NOTE_RE.exec(enexContent)) !== null) {
        const noteXml = noteMatch[1];
        const titleMatch = noteXml.match(/<title>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
        const contentMatch = noteXml.match(/<content>([\s\S]*?)<\/content>/i);
        let htmlContent = '';
        if (contentMatch) {
            htmlContent = contentMatch[1];
            htmlContent = htmlContent.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '');
            htmlContent = htmlContent.replace(/<\/?en-note[^>]*>/gi, '');
        }
        const tags = [];
        const TAG_RE = /<tag>([\s\S]*?)<\/tag>/gi;
        let tagMatch;
        while ((tagMatch = TAG_RE.exec(noteXml)) !== null) {
            tags.push(tagMatch[1].trim());
        }
        notes.push({ title, htmlContent, tags });
    }
    return notes;
}

// Bear タグの変換: #multiple words# → #multiple-words
function convertBearTags(content) {
    return content.replace(/#([^#\n]+)#/g, (_, tagContent) => {
        const cleaned = tagContent.trim().replace(/\s+/g, '-');
        return `#${cleaned}`;
    });
}

ipcMain.handle('import-notes', async (event, { source, inputPath }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません', imported: 0, errors: [] };

        const inboxDir = path.join(vaultPath, '00 Inbox');
        fs.mkdirSync(inboxDir, { recursive: true });

        let imported = 0;
        const errors = [];

        const sanitizeFilename = (name) => {
            return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 200);
        };

        if (source === 'notion') {
            if (!fs.existsSync(inputPath)) return { success: false, error: '指定パスが見つかりません', imported: 0, errors: [] };
            const stat = fs.statSync(inputPath);
            let mdFiles = [];
            if (stat.isDirectory()) {
                const walkDir = (dir) => {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) walkDir(fullPath);
                        else if (entry.name.endsWith('.md')) mdFiles.push(fullPath);
                    }
                };
                walkDir(inputPath);
            } else if (inputPath.endsWith('.md')) {
                mdFiles = [inputPath];
            }
            for (const mdFile of mdFiles) {
                try {
                    let content = fs.readFileSync(mdFile, 'utf-8');
                    const originalName = path.basename(mdFile, '.md');
                    const cleanedName = cleanNotionFilename(originalName);
                    content = cleanNotionLinks(content);
                    const destPath = path.join(inboxDir, `${sanitizeFilename(cleanedName)}.md`);
                    if (fs.existsSync(destPath)) { errors.push(`スキップ（既存）: ${cleanedName}.md`); continue; }
                    fs.writeFileSync(destPath, content, 'utf-8');
                    imported++;
                } catch (fileErr) { errors.push(`${path.basename(mdFile)}: ${fileErr.message}`); }
            }
        } else if (source === 'evernote') {
            if (!fs.existsSync(inputPath)) return { success: false, error: '指定パスが見つかりません', imported: 0, errors: [] };
            if (!inputPath.endsWith('.enex')) return { success: false, error: '.enex ファイルを選択してください', imported: 0, errors: [] };
            const enexContent = fs.readFileSync(inputPath, 'utf-8');
            const notes = parseEnexFile(enexContent);
            for (const note of notes) {
                try {
                    const markdown = htmlToBasicMarkdown(note.htmlContent);
                    const safeName = sanitizeFilename(note.title);
                    const frontmatterTags = note.tags.length > 0
                        ? `tags: [${note.tags.map(t => `"${t}"`).join(', ')}]`
                        : 'tags: []';
                    const fullContent = `---\n${frontmatterTags}\nsource: evernote\nimported: ${new Date().toISOString().split('T')[0]}\n---\n\n# ${note.title}\n\n${markdown}`;
                    const destPath = path.join(inboxDir, `${safeName}.md`);
                    if (fs.existsSync(destPath)) { errors.push(`スキップ（既存）: ${safeName}.md`); continue; }
                    fs.writeFileSync(destPath, fullContent, 'utf-8');
                    imported++;
                } catch (noteErr) { errors.push(`${note.title}: ${noteErr.message}`); }
            }
        } else if (source === 'bear') {
            if (!fs.existsSync(inputPath)) return { success: false, error: '指定パスが見つかりません', imported: 0, errors: [] };
            const stat = fs.statSync(inputPath);
            let mdFiles = [];
            if (stat.isDirectory()) {
                const entries = fs.readdirSync(inputPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith('.md')) mdFiles.push(path.join(inputPath, entry.name));
                }
            } else if (inputPath.endsWith('.md')) {
                mdFiles = [inputPath];
            }
            for (const mdFile of mdFiles) {
                try {
                    let content = fs.readFileSync(mdFile, 'utf-8');
                    content = convertBearTags(content);
                    const baseName = path.basename(mdFile, '.md');
                    const safeName = sanitizeFilename(baseName);
                    const destPath = path.join(inboxDir, `${safeName}.md`);
                    if (fs.existsSync(destPath)) { errors.push(`スキップ（既存）: ${safeName}.md`); continue; }
                    fs.writeFileSync(destPath, content, 'utf-8');
                    imported++;
                } catch (fileErr) { errors.push(`${path.basename(mdFile)}: ${fileErr.message}`); }
            }
        } else {
            return { success: false, error: `未対応のソース: ${source}`, imported: 0, errors: [] };
        }

        return { success: true, imported, errors };
    } catch (error) {
        return { success: false, error: error.message, imported: 0, errors: [] };
    }
});

// ======================================================
// Feature 11: MOC テンプレート共有 (エクスポート/インポート)
// ======================================================
ipcMain.handle('export-moc-template', async (event, templateId) => {
    try {
        const allTemplates = [...DEFAULT_MOC_TEMPLATES, ...(config.mocTemplates || [])];
        const tpl = allTemplates.find(t => t.id === templateId);
        if (!tpl) return { success: false, error: 'テンプレートが見つかりません' };

        const exportData = {
            name: tpl.name,
            description: tpl.description || '',
            body: tpl.body || '',
            version: '1.0',
            author: '',
        };

        const win = getWin(event);
        const result = await dialog.showSaveDialog(win, {
            defaultPath: path.join(os.homedir(), `moc-template-${tpl.name.replace(/[^a-zA-Z0-9_\-\u3040-\u30ff\u4e00-\u9fff]/g, '_')}.json`),
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });

        if (result.canceled || !result.filePath) return { success: false, canceled: true };
        fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
        return { success: true, filePath: result.filePath };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('import-moc-template', async (event) => {
    try {
        const win = getWin(event);
        const result = await dialog.showOpenDialog(win, {
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile'],
        });

        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }

        const filePath = result.filePaths[0];
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        let templateData;
        try { templateData = JSON.parse(rawContent); }
        catch (_) { return { success: false, error: 'JSONファイルの形式が不正です' }; }

        if (!templateData.name || typeof templateData.name !== 'string') {
            return { success: false, error: 'テンプレート名が不足しています' };
        }
        if (templateData.body !== undefined && typeof templateData.body !== 'string') {
            return { success: false, error: 'テンプレート本文の形式が不正です' };
        }

        if (!config.mocTemplates) config.mocTemplates = [];
        const id = `imported-${Date.now()}`;
        const newTemplate = { id, name: templateData.name, description: templateData.description || '', body: templateData.body || '' };
        config.mocTemplates.push(newTemplate);
        saveConfig(config);

        return { success: true, template: newTemplate };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ======================================================
// AI統合機能: LLM呼び出し抽象化レイヤー
// ======================================================

// AIモデル定義
const AI_MODELS = {
    claude: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    openai: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4o'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
};

/**
 * LLMプロバイダーに応じたHTTPSリクエストを送信して応答テキストを取得する
 * SDK不使用・Node.js組み込みhttpsモジュールのみ使用
 */
async function callLLM(prompt, systemPrompt = '') {
    const provider = config.aiProvider || 'claude';
    const apiKey = config.aiApiKey || '';
    const model = config.aiModel || (AI_MODELS[provider] ? AI_MODELS[provider][0] : '');
    if (!apiKey) throw new Error('APIキーが設定されていません');
    if (!model) throw new Error('モデルが選択されていません');

    // コンテンツ長制限（トークン節約のため最大8000文字に制限）
    const MAX_CONTENT_LENGTH = 8000;
    const trimmedPrompt = prompt.length > MAX_CONTENT_LENGTH
        ? prompt.slice(0, MAX_CONTENT_LENGTH) + '\n\n...(以下省略)'
        : prompt;

    if (provider === 'claude') {
        return callClaude(trimmedPrompt, systemPrompt, apiKey, model);
    } else if (provider === 'openai') {
        return callOpenAI(trimmedPrompt, systemPrompt, apiKey, model);
    } else if (provider === 'gemini') {
        return callGemini(trimmedPrompt, systemPrompt, apiKey, model);
    } else {
        throw new Error(`未対応のプロバイダー: ${provider}`);
    }
}

function httpsRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(new Error(`レスポンスのパースに失敗: ${data.slice(0, 200)}`)); }
                } else {
                    let errMsg = `HTTP ${res.statusCode}`;
                    try {
                        const errData = JSON.parse(data);
                        errMsg += ': ' + (errData.error?.message || errData.error?.type || JSON.stringify(errData.error || errData));
                    } catch (_) {
                        errMsg += ': ' + data.slice(0, 300);
                    }
                    reject(new Error(errMsg));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('リクエストタイムアウト (60秒)')); });
        if (body) req.write(body);
        req.end();
    });
}

async function callClaude(prompt, systemPrompt, apiKey, model) {
    const body = JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt || 'あなたは優秀なアシスタントです。日本語で簡潔に回答してください。',
        messages: [{ role: 'user', content: prompt }],
    });
    const options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    const data = await httpsRequest(options, body);
    if (data.content && data.content[0] && data.content[0].text) {
        return data.content[0].text;
    }
    throw new Error('Claudeからの応答を解析できませんでした');
}

async function callOpenAI(prompt, systemPrompt, apiKey, model) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const body = JSON.stringify({ model, messages, max_tokens: 1024 });
    const options = {
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(body),
        },
    };
    const data = await httpsRequest(options, body);
    if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
    }
    throw new Error('OpenAIからの応答を解析できませんでした');
}

async function callGemini(prompt, systemPrompt, apiKey, model) {
    const contents = [];
    if (systemPrompt) {
        contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
        contents.push({ role: 'model', parts: [{ text: '承知しました。' }] });
    }
    contents.push({ role: 'user', parts: [{ text: prompt }] });
    const body = JSON.stringify({
        contents,
        generationConfig: { maxOutputTokens: 1024 },
    });
    const encodedPath = `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: encodedPath,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    const data = await httpsRequest(options, body);
    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
        const parts = data.candidates[0].content.parts;
        if (parts && parts[0] && parts[0].text) return parts[0].text;
    }
    throw new Error('Geminiからの応答を解析できませんでした');
}

// ======================================================
// AI IPC ハンドラー
// ======================================================

ipcMain.handle('save-ai-config', (_, { provider, apiKey, model }) => {
    try {
        if (provider) config.aiProvider = provider;
        // APIキーが空文字の場合は既存値を維持（ユーザーが変更しなかった場合）
        if (apiKey && apiKey.trim().length > 0) config.aiApiKey = apiKey;
        if (model) config.aiModel = model;
        saveConfig(config);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('test-ai-connection', async () => {
    try {
        const result = await callLLM('「接続成功」と返してください。他の言葉は不要です。');
        return { success: true, message: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('ai-summarize-note', async (_, filePath) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };
        const summary = await callLLM(
            `以下のノートを3行で要約してください:\n\n${content}`,
            'あなたはObsidianノートの内容分析アシスタントです。簡潔かつ正確に要約してください。'
        );
        return { success: true, summary: summary.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('ai-suggest-tags', async (_, filePath) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const vaultPath = getCurrentVault();
        const existingTags = new Set();
        if (vaultPath) {
            const collectTags = (dir) => {
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) { collectTags(fullPath); continue; }
                        if (!entry.name.endsWith('.md')) continue;
                        try {
                            const fc = fs.readFileSync(fullPath, 'utf-8');
                            const tagMatches = fc.match(/#[a-zA-Z\u3040-\u9FFF][a-zA-Z0-9_/\u3040-\u9FFF-]*/g);
                            if (tagMatches) tagMatches.forEach(t => existingTags.add(t));
                        } catch (_) { /* スキップ */ }
                    }
                } catch (_) { /* スキップ */ }
            };
            collectTags(vaultPath);
        }
        const existingTagList = Array.from(existingTags).slice(0, 100).join(', ');

        const result = await callLLM(
            `以下のノートに最適なタグを5個以内で提案してください。既存タグ: ${existingTagList || '(なし)'}。JSON配列で返してください（例: ["#tag1", "#tag2"]）。説明は不要です:\n\n${content}`,
            'あなたはObsidianノートのタグ分類アシスタントです。タグは#から始めてください。'
        );

        let tags = [];
        try {
            const jsonMatch = result.match(/\[[\s\S]*?\]/);
            if (jsonMatch) { tags = JSON.parse(jsonMatch[0]); }
        } catch (_) {
            const tagMatches = result.match(/#[a-zA-Z\u3040-\u9FFF][a-zA-Z0-9_/\u3040-\u9FFF-]*/g);
            if (tagMatches) tags = tagMatches;
        }

        return { success: true, tags, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('ai-find-duplicates', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const MAX_NOTES = 20;
        const notes = [];
        const collectShortNotes = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectShortNotes(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    try {
                        const stat = fs.statSync(fullPath);
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const bodyContent = content.replace(/^---[\s\S]*?---\n?/, '').trim();
                        if (bodyContent.length > 10 && bodyContent.length < 2000) {
                            notes.push({ path: fullPath, name: entry.name, content: bodyContent, size: stat.size });
                        }
                    } catch (_) { /* スキップ */ }
                }
            } catch (_) { /* スキップ */ }
        };
        collectShortNotes(vaultPath);

        notes.sort((a, b) => a.size - b.size);
        const targetNotes = notes.slice(0, MAX_NOTES);
        if (targetNotes.length < 2) return { success: true, duplicates: [], message: '比較対象のノートが少なすぎます' };

        let noteList = '';
        targetNotes.forEach((n, i) => {
            noteList += `\n--- ノート${i + 1}: ${n.name} ---\n${n.content.slice(0, 500)}\n`;
        });

        const result = await callLLM(
            `以下の${targetNotes.length}個のノートの中から、内容が意味的に重複しているペアを見つけてください。\nJSON配列で返してください。各要素は {"noteA": ノート番号, "noteB": ノート番号, "reason": "理由"} の形式です。\n重複がなければ空配列[]を返してください:\n${noteList}`,
            'あなたはObsidianノートの重複検出アシスタントです。意味的に同じ内容・テーマのノートペアを見つけてください。'
        );

        let duplicates = [];
        try {
            const jsonMatch = result.match(/\[[\s\S]*?\]/);
            if (jsonMatch) {
                const raw = JSON.parse(jsonMatch[0]);
                duplicates = raw.map(d => ({
                    noteA: targetNotes[d.noteA - 1] ? { name: targetNotes[d.noteA - 1].name, path: targetNotes[d.noteA - 1].path } : null,
                    noteB: targetNotes[d.noteB - 1] ? { name: targetNotes[d.noteB - 1].name, path: targetNotes[d.noteB - 1].path } : null,
                    reason: d.reason || '',
                })).filter(d => d.noteA && d.noteB);
            }
        } catch (_) { /* パース失敗 */ }

        return { success: true, duplicates, raw: result.trim(), totalChecked: targetNotes.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('ai-suggest-links', async (_, filePath) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const noteTitles = [];
        const collectTitles = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectTitles(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    if (fullPath === filePath) continue;
                    noteTitles.push(entry.name.replace(/\.md$/, ''));
                }
            } catch (_) { /* スキップ */ }
        };
        collectTitles(vaultPath);

        const limitedTitles = noteTitles.slice(0, 200);
        const titleList = limitedTitles.join('\n');

        const result = await callLLM(
            `このノートの内容に基づき、リンクすべき関連ノートを以下のリストから選んでください。\n最大10件をJSON配列で返してください。各要素は {"title": "ノートタイトル", "reason": "関連理由"} の形式です:\n\n--- 対象ノート ---\n${content}\n\n--- ノートリスト ---\n${titleList}`,
            'あなたはObsidianのナレッジベース管理アシスタントです。ノート間の意味的な関連性を見つけてリンク提案をしてください。'
        );

        let suggestions = [];
        try {
            const jsonMatch = result.match(/\[[\s\S]*?\]/);
            if (jsonMatch) { suggestions = JSON.parse(jsonMatch[0]); }
        } catch (_) { /* パース失敗 */ }

        return { success: true, suggestions, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// 整理ツール: 共通ヘルパー
// ======================================================

/** Vault内の全.mdファイルを再帰収集する */
function collectAllMdFiles(dir) {
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...collectAllMdFiles(fullPath));
            } else if (entry.name.endsWith('.md')) {
                results.push(fullPath);
            }
        }
    } catch (_) { /* アクセスエラーはスキップ */ }
    return results;
}

/** Vault内の全フォルダを再帰収集する */
function collectAllFolders(dir) {
    const results = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            results.push(fullPath);
            results.push(...collectAllFolders(fullPath));
        }
    } catch (_) { /* アクセスエラーはスキップ */ }
    return results;
}

/** frontmatterをパースする（---で囲まれた部分を抽出） */
function parseFrontmatter(content) {
    const FM_REGEX = /^---\r?\n([\s\S]*?)\r?\n---/;
    const match = content.match(FM_REGEX);
    if (!match) return { exists: false, fields: {}, raw: '', bodyStart: 0 };
    const raw = match[1];
    const fields = {};
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
        const kv = line.match(/^(\w[\w-]*):\s*(.*)/);
        if (kv) {
            fields[kv[1]] = kv[2].trim();
        }
    }
    return { exists: true, fields, raw, bodyStart: match[0].length };
}

// ======================================================
// Feature 1: ノートタイトル自動リネーム
// ======================================================

ipcMain.handle('scan-title-mismatches', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const allMd = collectAllMdFiles(vaultPath);
        const mismatches = [];
        const MAX_RESULTS = 100;

        for (const mdPath of allMd) {
            if (mismatches.length >= MAX_RESULTS) break;
            try {
                const content = fs.readFileSync(mdPath, 'utf-8');
                const currentTitle = path.basename(mdPath, '.md');

                const fm = parseFrontmatter(content);
                const body = fm.exists ? content.slice(fm.bodyStart).trim() : content.trim();

                const headingMatch = body.match(/^#\s+(.+)/m);
                if (!headingMatch) continue; // 見出しが無いノートはスキップ

                let heuristicTitle = headingMatch[1].trim().replace(/[/\\:*?"<>|#^[\]]/g, '').trim();
                if (!heuristicTitle) continue;
                if (heuristicTitle === currentTitle) continue;

                mismatches.push({
                    path: mdPath,
                    currentTitle,
                    heuristicTitle,
                    aiTitle: null,
                    relPath: path.relative(vaultPath, mdPath),
                });
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        return { success: true, mismatches };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('suggest-note-title', async (_, filePath) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };

        const content = fs.readFileSync(filePath, 'utf-8');
        const currentTitle = path.basename(filePath, '.md');

        // ヒューリスティック: 最初の#見出し → frontmatter後の最初の非空行 → 先頭50文字
        let heuristicTitle = currentTitle;
        const fm = parseFrontmatter(content);
        const body = fm.exists ? content.slice(fm.bodyStart).trim() : content.trim();

        const headingMatch = body.match(/^#\s+(.+)/m);
        if (headingMatch) {
            heuristicTitle = headingMatch[1].trim();
        } else {
            const lines = body.split(/\r?\n/).filter(l => l.trim());
            if (lines.length > 0) {
                const TITLE_MAX_CHARS = 50;
                heuristicTitle = lines[0].trim().slice(0, TITLE_MAX_CHARS);
            }
        }

        // ファイル名に使えない文字を除去
        heuristicTitle = heuristicTitle.replace(/[/\\:*?"<>|#^[\]]/g, '').trim();

        let aiTitle = null;
        if (config.aiApiKey) {
            try {
                const aiResult = await callLLM(
                    `以下のノート内容に最適なタイトルを1つだけ提案してください。タイトルのみを返してください（説明不要）。\n\n${content.slice(0, 2000)}`,
                    'あなたはObsidianノートのタイトル提案アシスタントです。簡潔で内容を表すタイトルを提案してください。'
                );
                aiTitle = aiResult.trim().replace(/[/\\:*?"<>|#^[\]]/g, '').replace(/^["']|["']$/g, '');
            } catch (_) { /* AI利用不可の場合はスキップ */ }
        }

        return { success: true, heuristicTitle, aiTitle, currentTitle };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('rename-note', async (_, { filePath, newTitle }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        if (!newTitle || !newTitle.trim()) return { success: false, error: 'タイトルが空です' };

        const oldTitle = path.basename(filePath, '.md');
        const safeTitle = newTitle.replace(/[/\\:*?"<>|#^[\]]/g, '').trim();
        if (!safeTitle) return { success: false, error: '有効なタイトルがありません' };
        if (safeTitle === oldTitle) return { success: false, error: '同じタイトルです' };

        const dir = path.dirname(filePath);
        const newPath = path.join(dir, safeTitle + '.md');
        if (fs.existsSync(newPath)) return { success: false, error: '同名のファイルが既に存在します' };

        // ファイルリネーム
        fs.renameSync(filePath, newPath);

        // Vault全体のリンク更新
        const allMd = collectAllMdFiles(vaultPath);
        let linksUpdated = 0;
        const oldLinkPattern = new RegExp(
            `\\[\\[${oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`,
            'g'
        );
        for (const mdPath of allMd) {
            if (mdPath === newPath) continue;
            try {
                const c = fs.readFileSync(mdPath, 'utf-8');
                const updated = c.replace(oldLinkPattern, (match, alias) => {
                    linksUpdated++;
                    return alias ? `[[${safeTitle}${alias}]]` : `[[${safeTitle}]]`;
                });
                if (updated !== c) {
                    fs.writeFileSync(mdPath, updated, 'utf-8');
                }
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        return { success: true, linksUpdated, newPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 2: Frontmatter標準化
// ======================================================

const REQUIRED_FRONTMATTER_FIELDS = ['tags', 'created'];

ipcMain.handle('scan-frontmatter', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const allMd = collectAllMdFiles(vaultPath);
        const notesWithoutFrontmatter = [];
        const notesMissingFields = [];

        for (const mdPath of allMd) {
            try {
                const content = fs.readFileSync(mdPath, 'utf-8');
                const fm = parseFrontmatter(content);
                const relPath = path.relative(vaultPath, mdPath);
                const name = path.basename(mdPath, '.md');

                if (!fm.exists) {
                    notesWithoutFrontmatter.push({ path: mdPath, name, relPath });
                } else {
                    const missing = REQUIRED_FRONTMATTER_FIELDS.filter(f => !(f in fm.fields));
                    if (missing.length > 0) {
                        notesMissingFields.push({ path: mdPath, name, relPath, missing, existingFields: Object.keys(fm.fields) });
                    }
                }
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        return { success: true, notesWithoutFrontmatter, notesMissingFields };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('fix-frontmatter', async (_, { filePath, addFields }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };

        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);

        // デフォルト値の用意
        const defaults = { ...addFields };
        if (!defaults.created) {
            try {
                const stat = fs.statSync(filePath);
                defaults.created = stat.mtime.toISOString().slice(0, 10);
            } catch (_) {
                defaults.created = new Date().toISOString().slice(0, 10);
            }
        }
        if (!defaults.tags) {
            defaults.tags = '[]';
        }

        let newContent;
        if (!fm.exists) {
            // frontmatterが無い場合: 新規追加
            const lines = [];
            for (const [key, value] of Object.entries(defaults)) {
                lines.push(`${key}: ${value}`);
            }
            newContent = `---\n${lines.join('\n')}\n---\n${content}`;
        } else {
            // frontmatterがある場合: 不足フィールドを追加
            const existingLines = fm.raw.split(/\r?\n/);
            for (const [key, value] of Object.entries(defaults)) {
                if (!(key in fm.fields)) {
                    existingLines.push(`${key}: ${value}`);
                }
            }
            const newFm = `---\n${existingLines.join('\n')}\n---`;
            const bodyContent = content.slice(fm.bodyStart);
            newContent = newFm + (bodyContent.startsWith('\n') ? '' : '\n') + bodyContent;
        }

        fs.writeFileSync(filePath, newContent, 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 3: Auto-Folder Sorting (Inbox Sorter)
// ======================================================

ipcMain.handle('suggest-folder-moves', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        // Inboxフォルダ候補を探す
        const inboxCandidates = ['00 Inbox', 'Inbox', '00_Inbox', 'inbox'];
        let inboxPath = null;
        for (const name of inboxCandidates) {
            const candidate = path.join(vaultPath, name);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                inboxPath = candidate;
                break;
            }
        }

        // Inboxが無い場合はルート直下の.mdファイルを対象にする
        const targetDir = inboxPath || vaultPath;

        let targetFiles;
        try {
            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            targetFiles = entries
                .filter(e => !e.isDirectory() && e.name.endsWith('.md'))
                .map(e => path.join(targetDir, e.name));
        } catch (_) {
            return { success: true, suggestions: [], inboxPath: targetDir };
        }

        // 既存フォルダ構造を取得
        const folders = getScanFolders(vaultPath);
        const rules = config.rules || DEFAULT_RULES;

        const suggestions = [];
        for (const filePath of targetFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8').toLowerCase();
                const name = path.basename(filePath, '.md');
                const fmContent = fs.readFileSync(filePath, 'utf-8');
                const fm = parseFrontmatter(fmContent);
                const tags = fm.fields.tags ? fm.fields.tags.replace(/[\[\]#]/g, '').split(/[,\s]+/).filter(Boolean) : [];

                let suggestedFolder = null;
                let reason = '';

                // ルールベースでマッチング
                for (const [category, rule] of Object.entries(rules)) {
                    const matched = rule.keywords.some(kw =>
                        content.includes(kw.toLowerCase()) || tags.some(t => t.toLowerCase().includes(kw.toLowerCase()))
                    );
                    if (matched) {
                        // 対応するフォルダを探す
                        const matchingFolder = folders.find(f =>
                            f.toLowerCase().includes(category.toLowerCase()) ||
                            (rule.moc && f.toLowerCase().includes(category.toLowerCase().split('・')[0]))
                        );
                        if (matchingFolder) {
                            suggestedFolder = matchingFolder;
                            reason = `キーワード「${category}」に一致`;
                            break;
                        }
                    }
                }

                if (suggestedFolder) {
                    suggestions.push({
                        path: filePath,
                        name,
                        suggestedFolder,
                        reason,
                        relPath: path.relative(vaultPath, filePath),
                    });
                }
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        return { success: true, suggestions, inboxPath: path.relative(vaultPath, targetDir) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('move-note-to-folder', async (_, { filePath, targetFolder }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };

        const targetDir = path.join(vaultPath, targetFolder);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        const fileName = path.basename(filePath);
        const newPath = path.join(targetDir, fileName);
        if (fs.existsSync(newPath)) return { success: false, error: '移動先に同名ファイルが存在します' };

        fs.renameSync(filePath, newPath);

        return { success: true, newPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 4: 長文ノート分割提案
// ======================================================

const SPLIT_THRESHOLD_CHARS = 3000;

ipcMain.handle('find-splittable-notes', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const allMd = collectAllMdFiles(vaultPath);
        const splittable = [];

        for (const mdPath of allMd) {
            try {
                const content = fs.readFileSync(mdPath, 'utf-8');
                if (content.length < SPLIT_THRESHOLD_CHARS) continue;

                // ##レベルの見出しを抽出
                const headings = [];
                const lines = content.split(/\r?\n/);
                let currentSection = { text: '(冒頭)', charCount: 0 };

                for (const line of lines) {
                    const headingMatch = line.match(/^##\s+(.+)/);
                    if (headingMatch) {
                        if (currentSection.charCount > 0) {
                            headings.push({ ...currentSection });
                        }
                        currentSection = { text: headingMatch[1].trim(), charCount: 0 };
                    } else {
                        currentSection.charCount += line.length + 1;
                    }
                }
                if (currentSection.charCount > 0) {
                    headings.push({ ...currentSection });
                }

                // 見出しが2つ以上ある場合のみ分割候補
                if (headings.length >= 2) {
                    splittable.push({
                        path: mdPath,
                        name: path.basename(mdPath, '.md'),
                        relPath: path.relative(vaultPath, mdPath),
                        charCount: content.length,
                        headings,
                    });
                }
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        // 文字数の多い順にソート
        splittable.sort((a, b) => b.charCount - a.charCount);

        return { success: true, notes: splittable };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 5: 空フォルダ検出
// ======================================================

ipcMain.handle('find-empty-folders', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const allFolders = collectAllFolders(vaultPath);
        const emptyFolders = [];

        for (const folderPath of allFolders) {
            const mdFiles = collectAllMdFiles(folderPath);
            if (mdFiles.length === 0) {
                // 他のファイル（画像等）も含めてチェック
                let hasAnyFile = false;
                try {
                    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
                    hasAnyFile = entries.some(e => !e.isDirectory() && !EXCLUDE_ENTRIES.has(e.name) && !e.name.startsWith('.'));
                } catch (_) { /* スキップ */ }

                emptyFolders.push({
                    path: folderPath,
                    name: path.basename(folderPath),
                    relPath: path.relative(vaultPath, folderPath),
                    hasOtherFiles: hasAnyFile,
                });
            }
        }

        return { success: true, folders: emptyFolders };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-empty-folders', async (_, paths) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        let deleted = 0;
        for (const folderPath of paths) {
            if (!isPathInsideVault(folderPath)) continue;
            if (!fs.existsSync(folderPath)) continue;
            try {
                // 安全確認: .mdファイルがないことを再確認
                const mdFiles = collectAllMdFiles(folderPath);
                if (mdFiles.length > 0) continue;

                fs.rmSync(folderPath, { recursive: true, force: true });
                deleted++;
            } catch (_) { /* 個別エラーはスキップ */ }
        }

        return { success: true, deleted };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 7: Daily Note TODO抽出
// ======================================================

const DAILY_NOTE_PATTERN = /\d{4}-\d{2}-\d{2}/;

ipcMain.handle('extract-daily-todos', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        // Daily Notesフォルダの候補
        const dailyCandidates = ['01 Daily Notes', 'Daily Notes', 'DailyNotes', 'daily', 'journal', 'Journal'];
        let dailyDir = null;
        for (const name of dailyCandidates) {
            const candidate = path.join(vaultPath, name);
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                dailyDir = candidate;
                break;
            }
        }

        // Daily Notesフォルダが無い場合はVault全体からYYYY-MM-DDパターンのファイルを探す
        const allMd = dailyDir ? collectAllMdFiles(dailyDir) : collectAllMdFiles(vaultPath);
        const dailyFiles = allMd.filter(f => DAILY_NOTE_PATTERN.test(path.basename(f, '.md')));

        const results = [];
        for (const filePath of dailyFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split(/\r?\n/);
                const todos = [];

                for (let i = 0; i < lines.length; i++) {
                    const todoMatch = lines[i].match(/^[\s]*-\s+\[\s\]\s+(.+)/);
                    if (todoMatch) {
                        todos.push({ text: todoMatch[1].trim(), line: i + 1 });
                    }
                }

                if (todos.length > 0) {
                    const dateMatch = path.basename(filePath, '.md').match(DAILY_NOTE_PATTERN);
                    results.push({
                        date: dateMatch ? dateMatch[0] : path.basename(filePath, '.md'),
                        file: filePath,
                        relPath: path.relative(vaultPath, filePath),
                        todos,
                    });
                }
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        // 日付の新しい順にソート
        results.sort((a, b) => b.date.localeCompare(a.date));

        return { success: true, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 8: リンク正規化
// ======================================================

ipcMain.handle('find-inconsistent-links', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const allMd = collectAllMdFiles(vaultPath);

        // ファイル名のマップを作成（小文字 → 正式名の配列）
        const titleMap = new Map();
        const titleSet = new Set();
        for (const mdPath of allMd) {
            const title = path.basename(mdPath, '.md');
            titleSet.add(title);
            const lower = title.toLowerCase();
            if (!titleMap.has(lower)) titleMap.set(lower, []);
            titleMap.get(lower).push(title);
        }

        const issues = [];
        const LINK_REGEX = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g;

        for (const mdPath of allMd) {
            try {
                const content = fs.readFileSync(mdPath, 'utf-8');
                const relPath = path.relative(vaultPath, mdPath);
                let match;

                while ((match = LINK_REGEX.exec(content)) !== null) {
                    const linkTarget = match[1].trim();
                    const alias = match[2] ? match[2].slice(1).trim() : null;

                    // パス付きリンクの場合はファイル名部分を抽出
                    const linkName = linkTarget.includes('/') ? linkTarget.split('/').pop() : linkTarget;

                    // 大文字小文字不一致チェック
                    if (!titleSet.has(linkName)) {
                        const lower = linkName.toLowerCase();
                        const candidates = titleMap.get(lower);
                        if (candidates && candidates.length > 0) {
                            issues.push({
                                file: mdPath,
                                relPath,
                                link: match[0],
                                linkTarget: linkName,
                                issue: 'case_mismatch',
                                suggestion: candidates[0],
                                alias,
                            });
                            continue;
                        }

                        // 壊れたリンク（どのファイルにも一致しない）
                        issues.push({
                            file: mdPath,
                            relPath,
                            link: match[0],
                            linkTarget: linkName,
                            issue: 'broken',
                            suggestion: null,
                            alias,
                        });
                    }
                }
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        return { success: true, issues };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('normalize-links', async (_, items) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        // case_mismatch のみ修正（brokenは自動修正しない）
        const fixable = items.filter(item => item.issue === 'case_mismatch' && item.suggestion);

        // ファイルごとにグルーピング
        const byFile = new Map();
        for (const item of fixable) {
            if (!byFile.has(item.file)) byFile.set(item.file, []);
            byFile.get(item.file).push(item);
        }

        let fixed = 0;
        for (const [filePath, fileItems] of byFile) {
            if (!isPathInsideVault(filePath)) continue;
            if (!fs.existsSync(filePath)) continue;
            try {
                let content = fs.readFileSync(filePath, 'utf-8');
                for (const item of fileItems) {
                    const oldLink = item.link;
                    const newLink = item.alias
                        ? `[[${item.suggestion}|${item.alias}]]`
                        : `[[${item.suggestion}]]`;
                    if (content.includes(oldLink)) {
                        content = content.split(oldLink).join(newLink);
                        fixed++;
                    }
                }
                fs.writeFileSync(filePath, content, 'utf-8');
            } catch (_) { /* 個別ファイルエラーはスキップ */ }
        }

        return { success: true, fixed };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
