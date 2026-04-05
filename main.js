const { app, BrowserWindow, ipcMain, dialog, shell, Notification, nativeTheme, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');

// ======================================================
// ログ初期化 (electron-log)
// ログファイル: ~/Library/Logs/Obsidian Optimizer/main.log
// ======================================================
const log = require('electron-log/main');
log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'warn';
log.info('=== Obsidian Optimizer 起動 ===');

// 未捕捉エラーをログに記録
process.on('uncaughtException', (err) => {
    log.error('uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection:', reason);
});

// ちらつき防止: GPU合成を安定化させるフラグ
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-software-rasterizer');

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

// テーマ設定を設定ファイルから取得（なければダーク）
let savedTheme = 'dark';
try {
    const tmpCfg = fs.existsSync(path.join(os.homedir(), '.obsidian-optimizer-config.json'))
        ? JSON.parse(fs.readFileSync(path.join(os.homedir(), '.obsidian-optimizer-config.json'), 'utf-8'))
        : {};
    savedTheme = tmpCfg.appTheme || 'dark';
} catch (_) { /* デフォルトのダークを使用 */ }
nativeTheme.themeSource = savedTheme;

// ======================================================
// 定数
// ======================================================
const CONFIG_PATH = path.join(os.homedir(), '.obsidian-optimizer-config.json');
const BACKUP_DIR = path.join(os.homedir(), '.obsidian-optimizer-backups');

// ======================================================
// ライセンスキー検証（オフライン方式 - HMACハッシュベース）
// キー形式: OPT-XXXX-XXXX-XXXX-XXXX
// ======================================================
const LICENSE_HMAC_SECRET = 'ObsidianOptimizer2026CraftLab';

function generateLicenseHash(key) {
    return crypto.createHmac('sha256', LICENSE_HMAC_SECRET).update(key).digest('hex').slice(0, 16);
}

function isValidLicenseKey(key) {
    if (!key) return false;
    // フォーマットチェック: OPT-XXXX-XXXX-XXXX-XXXX
    if (!/^OPT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key)) return false;
    // ハッシュ検証: 最後の4文字がキーの残りから生成されたハッシュの先頭4文字と一致
    const prefix = key.slice(0, -5); // OPT-XXXX-XXXX-XXXX 部分
    const checksum = key.slice(-4);
    const hash = generateLicenseHash(prefix).slice(0, 4).toUpperCase();
    return checksum === hash;
}

// ライセンスキーを生成する関数（開発者用）
function generateLicenseKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let prefix = 'OPT';
    for (let i = 0; i < 3; i++) {
        prefix += '-';
        for (let j = 0; j < 4; j++) {
            prefix += chars[crypto.randomInt(chars.length)];
        }
    }
    const hash = generateLicenseHash(prefix).slice(0, 4).toUpperCase();
    return prefix + '-' + hash;
}

// ======================================================
// アップデートチェック（GitHub Releases API）
// ======================================================
const APP_VERSION = require('./package.json').version;
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/freeplanets001/Obsidian-Optimizer/releases/latest';

function compareVersions(a, b) {
    // セマンティックバージョニング比較: a > b なら正数を返す
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'ObsidianOptimizer/' + APP_VERSION } }, (res) => {
            // リダイレクト対応
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchJson(res.headers.location).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                res.resume();
                return;
            }
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('タイムアウト')); });
    });
}

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
        // オンボーディング完了フラグ
        onboardingCompleted: cfg.onboardingCompleted || false,
        // MOCテンプレート
        mocTemplates: cfg.mocTemplates || [],
        // AI利用状況
        aiUsage: cfg.aiUsage || { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCost: 0, history: [] },
        // ライセンスキー
        licenseKey: cfg.licenseKey || '',
        // テーマ設定
        appTheme: cfg.appTheme || 'dark',
        // Feature 5: お気に入りノート
        favorites: cfg.favorites || [],
        // Feature 7: 自動バックアップスケジュール
        backupSchedule: cfg.backupSchedule || 'off',
        // Git設定 (Plan B): Vaultパスをキーとした設定マップ
        gitSettings: cfg.gitSettings || {},
        // プロジェクト一覧
        projects: cfg.projects || [],
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
    // macOS専用: タイトルバーを隠す ('hidden'はSequoia/Sonomaでのちらつきが少ない)
    if (isMac) {
        windowOptions.titleBarStyle = 'hidden';
        windowOptions.trafficLightPosition = { x: 18, y: 18 };
    }
    windowOptions.show = false; // ちらつき防止: ready-to-show まで非表示
    const mainWindow = new BrowserWindow(windowOptions);
    mainWindowRef = mainWindow;
    mainWindow.once('ready-to-show', () => mainWindow.show());
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
    startBackupSchedule();
    cleanupOldBackups();

    // ─── クイックキャプチャ: グローバルショートカット ───
    try {
        globalShortcut.register('CommandOrControl+Shift+Space', () => {
            const wins = BrowserWindow.getAllWindows();
            if (wins.length > 0) {
                const win = wins[0];
                if (win.isMinimized()) win.restore();
                win.show();
                win.focus();
                win.webContents.send('quick-capture-focus');
            }
        });
    } catch (e) {
        console.warn('グローバルショートカット登録失敗:', e.message);
    }

    // ─── タスクリマインダー (起動5分後 + 24時間ごと) ───
    setTimeout(() => scheduleTaskReminders(), 5 * 60 * 1000);

    // ─── v5.3: スマートルールスケジュール実行 (起動10分後 + 1時間ごとにチェック) ───
    setTimeout(() => runScheduledSmartRules(), 10 * 60 * 1000);
    setInterval(() => runScheduledSmartRules(), 60 * 60 * 1000);

    // ─── 繰り返しタスク処理 (起動30秒後: 起動直後の遅延を避ける) ───
    setTimeout(() => processRecurringTasks(), 30 * 1000);

    // ─── Dockバッジ更新 (起動15秒後: スキャン完了を待つ) ───
    setTimeout(() => updateDockBadge(), 15 * 1000);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// NSIS更新時のクリーンシャットダウン: タイマーを確実に解放しプロセス終了を保証
app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (_) {}
});

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
    onboardingCompleted: config.onboardingCompleted || false,
    appVersion: APP_VERSION,
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
            // 拡張スタッツ（ダッシュボード強化用）
            untaggedCount: 0,    // タグなしノート数
            avgWordsPerNote: 0,  // 平均単語数/ノート（スキャン後計算）
            recentlyEdited: [],  // [{name, path, mtime, days}] Top 5
            thisWeekCreated: 0,  // 今週作成ノート数（birthtimeMs近似）
            linkDensity: 0,      // totalLinks / totalMDFiles（スキャン後計算）
            noteList: [],        // 品質ボード用: [{name, path, outlinks, tags, words, mtime, incoming}]
        };
        const _noteDetailsMap = {}; // fileKey → noteDetail (scanData.noteListの構築用)

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
        const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const allNotesMtime = []; // recentlyEdited集計用

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

            // 最近編集・今週作成の集計
            allNotesMtime.push({ name: basename, path: file, mtime: fileStat.mtimeMs });
            if (nowMs - fileStat.birthtimeMs < WEEK_MS) stats.thisWeekCreated++;

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
            let fileTagCount = 0;
            const tr = new RegExp(TAG_RE.source, 'gm');
            while ((m = tr.exec(content)) !== null) {
                fileTagCount++;
                const tag = m[1];
                stats.tagStats[tag] = (stats.tagStats[tag] || 0) + 1;
            }
            const fmMatch = FRONTMATTER_TAG_RE.exec(content);
            if (fmMatch) {
                const fmTags = fmMatch[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean);
                fileTagCount += fmTags.length;
                fmTags.forEach(tag => {
                    stats.tagStats[tag] = (stats.tagStats[tag] || 0) + 1;
                });
            }
            if (fileTagCount === 0) stats.untaggedCount++;

            // 文字数（フロントマターはファイル先頭のみ除去）
            const plainText = content.replace(/^\s*---\n[\s\S]*?\n---/, '').replace(/[#*\[\]]/g, '');
            const noteWords = plainText.trim().split(/\s+/).filter(Boolean).length;
            stats.totalWords += noteWords;

            // 品質ボード用ノートデータ収集
            _noteDetailsMap[fileKey] = { name: basename, path: file, outlinks: (links[fileKey] || []).length, tags: fileTagCount, words: noteWords, mtime: fileStat.mtimeMs, incoming: 0 };

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
        // setImmediate でイベントループを定期的に解放 → Main Thread ブロッキング防止
        const BATCH_SIZE = 20; // 20ファイルごとにイベントループを譲る
        const scanFolders = getScanFolders(VAULT_PATH);
        for (const folder of scanFolders) {
            if (scanCancelFlag) return { success: false, error: 'スキャンがキャンセルされました' };
            const folderPath = path.join(VAULT_PATH, folder);
            const files = getFilesRecursively(folderPath);
            for (let i = 0; i < files.length; i++) {
                if (scanCancelFlag) return { success: false, error: 'スキャンがキャンセルされました' };
                await processFile(files[i], folder);
                // BATCH_SIZE ごとにイベントループを解放してUIの応答性を維持
                if (i % BATCH_SIZE === BATCH_SIZE - 1) {
                    await new Promise(resolve => setImmediate(resolve));
                }
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

        // 拡張スタッツのポスト計算
        allNotesMtime.sort((a, b) => b.mtime - a.mtime);
        stats.recentlyEdited = allNotesMtime.slice(0, 5).map(n => ({
            name: n.name,
            path: n.path,
            mtime: new Date(n.mtime).toISOString(),
            days: Math.floor((nowMs - n.mtime) / (1000 * 60 * 60 * 24)),
        }));
        stats.avgWordsPerNote = stats.totalMDFiles > 0
            ? Math.round(stats.totalWords / stats.totalMDFiles) : 0;
        stats.linkDensity = stats.totalMDFiles > 0
            ? Math.round(stats.totalLinks / stats.totalMDFiles * 10) / 10 : 0;

        // 品質ボード用: 被リンク数を各ノートに付与してnoteListを構築
        for (const f in incoming) {
            if (_noteDetailsMap[f]) _noteDetailsMap[f].incoming = incoming[f] || 0;
        }
        stats.noteList = Object.values(_noteDetailsMap);

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

// スキャン系ハンドラ → src/handlers/scan.handler.js に移動済み
require('./src/handlers/scan.handler').register(ipcMain, {
    getCurrentVault,
    getFilesRecursively,
    doScanVault,
    getScanCancelFlag: () => scanCancelFlag,
    setScanCancelFlag: (val) => { scanCancelFlag = val; },
    isJunkFile,
    config,
    DEFAULT_JUNK_RULES,
    DEFAULT_RULES,
    getScanFolders,
    safeReadFileSync,
    dialog,
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

// MOC系ハンドラ → src/handlers/moc.handler.js に移動済み
require('./src/handlers/moc.handler').register(ipcMain, {
    getCurrentVault,
    getFilesRecursively,
    config,
    saveConfig,
    DEFAULT_MOC_TEMPLATES,
    fs,
    path,
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

// バックアップ・スキャン履歴ハンドラ → src/handlers/backup.handler.js に移動済み
const { SCAN_HISTORY_PATH } = require('./src/handlers/backup.handler');
require('./src/handlers/backup.handler').register(ipcMain, {
    getCurrentVault,
    getFilesRecursively,
    getWin,
    dialog,
    getConfig: () => config,
    saveConfig,
    startBackupSchedule,
    doVaultBackup,
});

// Feature 1/2: バックアップ・スキャン履歴 → src/handlers/backup.handler.js 参照

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

        // 保存先: 常にVaultルート直下
        const outputDir = vaultPath;

        // CSSスニペットを自動インストール（常に最新版に上書き）
        const snippetDir = path.join(vaultPath, '.obsidian', 'snippets');
        const snippetPath = path.join(snippetDir, 'optimizer-dashboard.css');
        fs.mkdirSync(snippetDir, { recursive: true });
        const cssSnippet = `/* ═══════════════════════════════════════════════
   Obsidian Optimizer Dashboard v4.3
   世界一使いやすいダッシュボードCSS
   ═══════════════════════════════════════════════ */

/* ── ページ全体 ── */
.dashboard {
  --dash-accent: #7c6cf8;
  --dash-green: #34d399;
  --dash-yellow: #fbbf24;
  --dash-red: #f87171;
  --dash-blue: #60a5fa;
  --dash-card-bg: rgba(255,255,255,0.03);
  --dash-border: rgba(255,255,255,0.08);
  max-width: 960px;
  margin: 0 auto;
  padding: 20px 0;
}

/* ── タイトル ── */
.dashboard h1 {
  text-align: center;
  font-size: 2.2em;
  font-weight: 800;
  margin-bottom: 0.1em;
  background: linear-gradient(135deg, var(--dash-accent), var(--dash-green));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.dashboard > p:first-of-type {
  text-align: center;
  opacity: 0.45;
  font-size: 0.82em;
  margin-bottom: 2em;
}

/* ── 水平線 ── */
.dashboard hr {
  border: none;
  height: 1px;
  background: linear-gradient(to right, transparent, rgba(124,108,248,0.3), transparent);
  margin: 2.5em 0;
}

/* ── Callout カード化 ── */
.dashboard .callout {
  border-radius: 14px !important;
  border: 1px solid var(--dash-border) !important;
  margin-bottom: 1.4em;
  box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  backdrop-filter: blur(8px);
  transition: transform 0.2s, box-shadow 0.2s;
}
.dashboard .callout:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(0,0,0,0.25);
}
.dashboard .callout-title {
  font-size: 1.05em;
  font-weight: 700;
  padding: 14px 18px 8px;
}
.dashboard .callout-content {
  padding: 4px 18px 16px;
}

/* ── テーブル ── */
.dashboard table {
  width: 100%;
  font-size: 0.85em;
  border-collapse: separate;
  border-spacing: 0;
  border-radius: 10px;
  overflow: hidden;
}
.dashboard thead tr {
  background: rgba(124,108,248,0.12) !important;
}
.dashboard th {
  padding: 10px 14px;
  font-weight: 600;
  text-align: left;
  font-size: 0.82em;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 2px solid rgba(124,108,248,0.2);
}
.dashboard td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--dash-border);
}
.dashboard tbody tr:hover {
  background: rgba(124,108,248,0.06);
}
.dashboard tbody tr:last-child td {
  border-bottom: none;
}

/* ── 内部リンク ── */
.dashboard .internal-link {
  color: var(--dash-accent);
  text-decoration: none;
  border-bottom: 1px dotted rgba(124,108,248,0.3);
  transition: border-color 0.2s;
}
.dashboard .internal-link:hover {
  border-bottom-color: var(--dash-accent);
}

/* ── タスク表示の大幅強化 ── */
.dashboard .task-list-item {
  padding: 10px 14px !important;
  margin: 4px 0 !important;
  border-radius: 8px !important;
  border: 1px solid rgba(124,108,248,0.1) !important;
  background: rgba(124,108,248,0.03) !important;
  transition: background 0.15s, border-color 0.15s;
  list-style: none !important;
}
.dashboard .task-list-item:hover {
  background: rgba(124,108,248,0.08) !important;
  border-color: rgba(124,108,248,0.25) !important;
}
.dashboard .task-list-item input[type="checkbox"] {
  margin-right: 10px;
  width: 18px;
  height: 18px;
  accent-color: var(--dash-accent);
}
.dashboard .task-list-item.is-checked {
  opacity: 0.5;
  text-decoration: line-through;
  background: rgba(52,211,153,0.05) !important;
  border-color: rgba(52,211,153,0.15) !important;
}
/* Tasks プラグインのフィルターバーを改善 */
.dashboard .tasks-group-heading {
  font-weight: 700 !important;
  font-size: 0.92em !important;
  padding: 8px 0 4px !important;
  color: var(--dash-accent) !important;
  border-bottom: 2px solid rgba(124,108,248,0.2) !important;
  margin-bottom: 8px !important;
}
.dashboard .plugin-tasks-query-explanation {
  font-size: 0.82em;
  opacity: 0.5;
  padding: 4px 0;
}
/* "0 tasks" の空メッセージを改善 */
.dashboard .plugin-tasks-query-result .tasks-count {
  padding: 16px;
  text-align: center;
  font-size: 0.88em;
  opacity: 0.4;
  font-style: italic;
}
/* タスクの期限バッジ */
.dashboard .task-due {
  font-size: 0.8em;
  padding: 2px 8px;
  border-radius: 6px;
  background: rgba(245,158,11,0.12);
  color: #d97706;
  font-weight: 500;
}
.dashboard .task-overdue .task-due {
  background: rgba(239,68,68,0.12) !important;
  color: #dc2626 !important;
}

/* ── Dataviewの"0 results"表示改善 ── */
.dashboard .dataview.dataview-error-box,
.dashboard .dataview .dataview-no-result {
  padding: 20px;
  text-align: center;
  opacity: 0.4;
  font-style: italic;
  font-size: 0.88em;
}

/* ── フッター ── */
.dashboard > p:last-of-type {
  text-align: center;
  opacity: 0.3;
  font-size: 0.75em;
  margin-top: 3em;
  font-style: italic;
}

/* ═══ ライトテーマ対応 ═══ */
.theme-light .dashboard {
  --dash-card-bg: rgba(0,0,0,0.02);
  --dash-border: rgba(0,0,0,0.06);
}
.theme-light .dashboard h1 {
  background: linear-gradient(135deg, #6d5dd3, #22b783) !important;
  -webkit-background-clip: text !important;
  -webkit-text-fill-color: transparent !important;
}
.theme-light .dashboard hr {
  background: linear-gradient(to right, transparent, rgba(109,93,211,0.25), transparent) !important;
}
.theme-light .dashboard .callout {
  border: 1px solid rgba(0,0,0,0.08) !important;
  box-shadow: 0 2px 8px rgba(0,0,0,0.06) !important;
}
.theme-light .dashboard .callout:hover {
  box-shadow: 0 4px 16px rgba(0,0,0,0.1) !important;
}
.theme-light .dashboard thead tr {
  background: rgba(109,93,211,0.08) !important;
}
.theme-light .dashboard th {
  border-bottom: 2px solid rgba(109,93,211,0.15) !important;
}
.theme-light .dashboard td {
  border-bottom: 1px solid rgba(0,0,0,0.05) !important;
}
.theme-light .dashboard tbody tr:hover {
  background: rgba(109,93,211,0.04) !important;
}
.theme-light .dashboard .task-list-item {
  border: 1px solid rgba(109,93,211,0.1) !important;
  background: rgba(109,93,211,0.03) !important;
}
.theme-light .dashboard .task-list-item:hover {
  background: rgba(109,93,211,0.07) !important;
  border-color: rgba(109,93,211,0.2) !important;
}
.theme-light .dashboard .internal-link {
  color: #6d5dd3 !important;
}
`;
        fs.writeFileSync(snippetPath, cssSnippet, 'utf-8');

        // CSSスニペットを自動有効化（appearance.jsonに書き込む）
        const appearancePath = path.join(vaultPath, '.obsidian', 'appearance.json');
        try {
            let appearance = {};
            if (fs.existsSync(appearancePath)) appearance = JSON.parse(fs.readFileSync(appearancePath, 'utf-8'));
            if (!appearance.enabledCssSnippets) appearance.enabledCssSnippets = [];
            if (!appearance.enabledCssSnippets.includes('optimizer-dashboard')) {
                appearance.enabledCssSnippets.push('optimizer-dashboard');
                fs.writeFileSync(appearancePath, JSON.stringify(appearance, null, 2), 'utf-8');
            }
        } catch (_) { /* appearance.json操作エラーは無視 */ }

        let fileName;
        let content;

        switch (type) {
            case 'full':
                fileName = 'Dashboard.md';
                content = `---
type: dashboard
created: "${dateStr}"
cssclasses:
  - dashboard
---

# 🖥️ Dashboard
> *Obsidian Optimizer が自動生成したダッシュボード — Dataview プラグインで自動更新されます*

---

> [!check] ✅ 今日のタスク
> \`\`\`tasks
> due today
> not done
> short mode
> \`\`\`

> [!warning] ⚠️ 期限切れタスク
> \`\`\`tasks
> due before today
> not done
> short mode
> \`\`\`

> [!todo] 📅 今週の期限
> \`\`\`tasks
> due before next week
> due after yesterday
> not done
> short mode
> \`\`\`

---

> [!note] 📝 最近更新したノート（TOP 15）
> \`\`\`dataview
> TABLE file.mday AS "更新日", file.folder AS "フォルダ"
> FROM ""
> WHERE file.name != this.file.name
> SORT file.mday DESC
> LIMIT 15
> \`\`\`

> [!abstract] 🏷️ タグ別ノート数（TOP 20）
> \`\`\`dataview
> TABLE length(rows) AS "ノート数"
> FROM ""
> FLATTEN file.tags AS tag
> GROUP BY tag
> SORT length(rows) DESC
> LIMIT 20
> \`\`\`

---

> [!info] 📂 フォルダ別ノート数
> \`\`\`dataview
> TABLE length(rows) AS "ノート数"
> FROM ""
> GROUP BY file.folder
> SORT length(rows) DESC
> LIMIT 15
> \`\`\`

> [!tip] 🔗 被リンク数 TOP 10
> \`\`\`dataview
> TABLE length(file.inlinks) AS "被リンク数", length(file.outlinks) AS "発リンク数"
> FROM ""
> SORT length(file.inlinks) DESC
> LIMIT 10
> \`\`\`

---

> [!example] 🗓️ 今月作成したノート
> \`\`\`dataview
> TABLE file.cday AS "作成日", file.folder AS "フォルダ"
> FROM ""
> WHERE file.cday >= date(today) - dur(30 days)
> SORT file.cday DESC
> \`\`\`

> [!danger] 🌱 孤立ノート（リンクなし）
> 他のノートからリンクされておらず、自分からもリンクしていないノートです。
> \`\`\`dataview
> TABLE file.folder AS "フォルダ", file.mday AS "最終更新"
> FROM ""
> WHERE length(file.inlinks) = 0 AND length(file.outlinks) = 0
> AND !contains(file.name, "MOC") AND !contains(file.name, "Template") AND !contains(file.name, "Dashboard")
> SORT file.mday ASC
> LIMIT 20
> \`\`\`

---
*Generated by Obsidian Optimizer v4.3 — ${dateStr}*
`;
                break;

            case 'tasks':
                fileName = 'Task Board.md';
                content = `---
type: task-board
created: "${dateStr}"
cssclasses:
  - dashboard
---

# ✅ Task Board
> *タスクの進捗を一目で確認できるボードです*

---

> [!danger] 🔴 期限切れタスク
> 期限を過ぎたタスクです。すぐに対応してください。
> \`\`\`tasks
> due before today
> not done
> group by due
> \`\`\`

> [!warning] 🟡 今日のタスク
> \`\`\`tasks
> due today
> not done
> \`\`\`

> [!todo] 🔵 今週のタスク
> \`\`\`tasks
> due after today
> due before in 7 days
> not done
> group by due
> \`\`\`

> [!info] 🟢 来週以降のタスク
> \`\`\`tasks
> due after in 7 days
> not done
> group by due
> \`\`\`

---

> [!check] ✅ 最近完了したタスク
> \`\`\`tasks
> done after 7 days ago
> short mode
> \`\`\`

> [!abstract] 📊 プロジェクト別タスク集計
> \`\`\`dataview
> TABLE
>   length(filter(file.tasks, (t) => !t.completed)) AS "未完了",
>   length(filter(file.tasks, (t) => t.completed)) AS "完了"
> FROM ""
> WHERE length(file.tasks) > 0
> SORT length(filter(file.tasks, (t) => !t.completed)) DESC
> \`\`\`

> [!important] 📌 優先度高タスク
> \`\`\`tasks
> not done
> priority is high
> \`\`\`

---
*Generated by Obsidian Optimizer v4.3 — ${dateStr}*
`;
                break;

            case 'weekly':
                fileName = `Weekly Review ${dateStr}.md`;
                content = `---
type: weekly-review
week: "${weekStr}"
created: "${dateStr}"
cssclasses:
  - dashboard
---

# 📅 Weekly Review
> *${dateRange} の振り返り*

---

> [!note] 📝 今週書いたノート
> \`\`\`dataview
> TABLE file.folder AS "フォルダ", file.cday AS "作成日"
> FROM ""
> WHERE file.cday >= date(today) - dur(7 days)
> SORT file.cday DESC
> \`\`\`

> [!check] ✅ 今週完了したタスク
> \`\`\`tasks
> done after 7 days ago
> short mode
> \`\`\`

> [!warning] ⏳ 持ち越しタスク
> \`\`\`tasks
> due before today
> not done
> \`\`\`

---

> [!tip] 📊 今週の振り返り
> ### よかったこと
> -
>
> ### 改善したいこと
> -
>
> ### 来週の目標
> -

---

> [!info] 🔗 今週リンクしたノート
> \`\`\`dataview
> TABLE length(file.outlinks) AS "リンク数"
> FROM ""
> WHERE file.mday >= date(today) - dur(7 days)
> SORT length(file.outlinks) DESC
> LIMIT 10
> \`\`\`

---
*Generated by Obsidian Optimizer v4.3 — ${dateStr}*
`;
                break;

            case 'projects':
                fileName = '📋 Project Board.md';
                content = `---
type: project-board
created: "${dateStr}"
updated: "${dateStr}"
cssclasses:
  - dashboard
tags: [dashboard, project-board]
---

# 📋 Project Board
> *Obsidian Optimizer が管理するプロジェクトの統合ダッシュボード*

---

## 📊 サマリー

\`\`\`dataviewjs
const projects = dv.pages('"01 Projects" OR #type/project');
const archived = dv.pages('"04 Archives"').where(p => p.file.tags && p.file.tags.includes("type/project"));
const total = projects.length;
const active = projects.where(p => p.status === "active").length;
const onHold = projects.where(p => p.status === "on-hold").length;
const done = archived.length;
const overdue = projects.where(p => p.due && dv.date(p.due) < dv.date("today")).length;
const avgProgress = total > 0 ? Math.round(projects.array().reduce((a,p) => a + (p.progress || 0), 0) / total) : 0;

dv.paragraph(
  \`| 📁 合計 | 🔥 進行中 | ⏸ 保留 | ✅ 完了 | ⚠️ 期限切れ | 📈 平均進捗 |\\n\` +
  \`|:---:|:---:|:---:|:---:|:---:|:---:|\\n\` +
  \`| **\${total}** | **\${active}** | **\${onHold}** | **\${done}** | **\${overdue}** | **\${avgProgress}%** |\`
);
\`\`\`

---

## 🔥 進行中のプロジェクト

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS "プロジェクト",
  choice(priority = "high", "🔴 高", choice(priority = "medium", "🟡 中", "🔵 低")) AS "優先度",
  (progress + "%") AS "進捗",
  choice(length(filter(file.tasks, (t) => !t.completed)) > 0,
    string(length(filter(file.tasks, (t) => !t.completed))) + " 件残",
    "✅ 完了") AS "残タスク",
  choice(due, dateformat(date(due), "MM/dd"), "—") AS "期限",
  choice(due AND date(due) < date(today), "⚠️ 期限切れ",
    choice(due AND date(due) <= date(today) + dur(7 days), "🔔 間近", "")) AS "アラート"
FROM "01 Projects" OR #type/project
WHERE status = "active" OR (!status AND !contains(file.tags, "status/done"))
SORT choice(priority = "high", 1, choice(priority = "medium", 2, 3)) ASC, due ASC
\`\`\`

---

## ⚠️ 期限切れ・緊急

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS "プロジェクト",
  dateformat(date(due), "yyyy-MM-dd") AS "期限",
  (date(today) - date(due)).days + " 日超過" AS "超過"
FROM "01 Projects" OR #type/project
WHERE due AND date(due) < date(today) AND status != "archived" AND status != "completed"
SORT due ASC
\`\`\`

---

## 📅 今後30日の期限

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS "プロジェクト",
  dateformat(date(due), "MM月dd日 (ddd)") AS "期限",
  (date(due) - date(today)).days + " 日後" AS "残り",
  (progress + "%") AS "進捗"
FROM "01 Projects" OR #type/project
WHERE due
  AND date(due) >= date(today)
  AND date(due) <= date(today) + dur(30 days)
  AND status != "archived" AND status != "completed"
SORT due ASC
\`\`\`

---

## ⏸ 保留中

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS "プロジェクト",
  (progress + "%") AS "進捗",
  file.mday AS "最終更新"
FROM "01 Projects" OR #type/project
WHERE status = "on-hold"
SORT file.mday DESC
\`\`\`

---

## ✅ 最近完了したプロジェクト

\`\`\`dataview
TABLE WITHOUT ID
  file.link AS "プロジェクト",
  file.mday AS "完了日"
FROM "04 Archives" OR #type/project
WHERE contains(file.tags, "status/done") OR status = "completed"
SORT file.mday DESC
LIMIT 10
\`\`\`

---

## 🏷️ タグ別プロジェクト

\`\`\`dataviewjs
const projects = dv.pages('"01 Projects" OR #type/project');
const tagMap = {};
for (const p of projects) {
  const tags = (p.file.tags || []).filter(t => t !== "type/project" && !t.startsWith("status/"));
  for (const t of tags) {
    tagMap[t] = (tagMap[t] || 0) + 1;
  }
}
const rows = Object.entries(tagMap).sort((a,b) => b[1]-a[1]);
if (rows.length > 0) {
  dv.table(["タグ", "件数"], rows.map(([t,c]) => ["#"+t, c]));
} else {
  dv.paragraph("タグ付きプロジェクトはありません");
}
\`\`\`

---

*🤖 Obsidian Optimizer v5.0.1 が生成 — ${dateStr}*
*プロジェクト追加後、このファイルを再生成するには「ダッシュボード」タブから再生成してください*
`;
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

// AIモデル定義・コストレートを外部設定ファイルから読み込む
// 新モデル追加時は src/config/ai-models.js のみ編集すればよい
const { AI_MODELS, AI_COST_RATES, getDefaultModel, getCostRate } = require('./src/config/ai-models');

/**
 * LLMプロバイダーに応じたHTTPSリクエストを送信して応答テキストを取得する
 * SDK不使用・Node.js組み込みhttpsモジュールのみ使用
 */

// LLMレスポンスからJSONを安全に抽出するヘルパー
// ```json ... ``` コードブロック、生JSON配列、生JSONオブジェクトに対応
function extractJsonFromLLM(text) {
    if (!text) return null;
    // markdownコードブロック（閉じタグなしにも対応）
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
    if (codeBlock && codeBlock[1].trim().startsWith('[')) {
        try { return JSON.parse(codeBlock[1].trim()); } catch (_) {}
    }
    if (codeBlock && codeBlock[1].trim().startsWith('{')) {
        try { return JSON.parse(codeBlock[1].trim()); } catch (_) {}
    }
    // テキスト中に埋め込まれたJSON配列を抽出
    const arrMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrMatch) {
        try { return JSON.parse(arrMatch[0]); } catch (_) {
            // 不完全なJSON（末尾切れ）を修復
            let fixed = arrMatch[0];
            // 最後の完全なオブジェクトまでカット
            const lastComplete = fixed.lastIndexOf('}');
            if (lastComplete > 0) {
                fixed = fixed.slice(0, lastComplete + 1) + ']';
                try { return JSON.parse(fixed); } catch (_2) {}
            }
        }
    }
    // 生JSON配列
    const simpleArr = text.match(/\[[\s\S]*\]/);
    if (simpleArr) {
        try { return JSON.parse(simpleArr[0]); } catch (_) {}
    }
    // 生JSONオブジェクト
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try { return JSON.parse(objMatch[0]); } catch (_) {}
    }
    return null;
}

function trackAiUsage(featureName, inputText, outputText, model) {
    try {
        if (!config.aiUsage) {
            config.aiUsage = { totalCalls: 0, totalInputTokens: 0, totalOutputTokens: 0, totalEstimatedCost: 0, history: [] };
        }
        // 概算: 1トークン ≈ 4文字（日本語は約2文字だが平均値として）
        const inputTokens = Math.ceil(inputText.length / 4);
        const outputTokens = Math.ceil(outputText.length / 4);
        const rates = getCostRate(model);
        const costUsd = (inputTokens * rates[0] / 1000000) + (outputTokens * rates[1] / 1000000);

        config.aiUsage.totalCalls += 1;
        config.aiUsage.totalInputTokens += inputTokens;
        config.aiUsage.totalOutputTokens += outputTokens;
        config.aiUsage.totalEstimatedCost += costUsd;

        // 履歴は最大100件保持
        const MAX_HISTORY = 100;
        config.aiUsage.history.push({
            date: new Date().toISOString(),
            feature: featureName,
            inputTokens,
            outputTokens,
            cost: costUsd,
            model,
        });
        if (config.aiUsage.history.length > MAX_HISTORY) {
            config.aiUsage.history = config.aiUsage.history.slice(-MAX_HISTORY);
        }
        saveConfig(config);
    } catch (_) { /* トラッキングエラーは無視 */ }
}

async function callLLM(prompt, systemPrompt = '', featureName = 'unknown') {
    // ローカルLLMが有効な場合はそちらを優先
    const llmConfig = config.localLlm || {};
    if (llmConfig.enabled && llmConfig.endpoint) {
        return callAI(prompt, systemPrompt || 'あなたは優秀なアシスタントです。日本語で簡潔に回答してください。', {});
    }

    const provider = config.aiProvider || 'claude';
    const apiKey = config.aiApiKey || '';
    const model = config.aiModel || (AI_MODELS[provider] ? AI_MODELS[provider][0] : '');
    if (!apiKey) throw new Error('APIキーが設定されていません。設定画面でAPIキーを入力するか、ローカルLLM（Ollama等）を有効にしてください');
    if (!model) throw new Error('モデルが選択されていません');

    // コンテンツ長制限（トークン節約のため最大8000文字に制限）
    const MAX_CONTENT_LENGTH = 8000;
    const trimmedPrompt = prompt.length > MAX_CONTENT_LENGTH
        ? prompt.slice(0, MAX_CONTENT_LENGTH) + '\n\n...(以下省略)'
        : prompt;

    let result;
    if (provider === 'claude') {
        result = await callClaude(trimmedPrompt, systemPrompt, apiKey, model);
    } else if (provider === 'openai') {
        result = await callOpenAI(trimmedPrompt, systemPrompt, apiKey, model);
    } else if (provider === 'gemini') {
        result = await callGemini(trimmedPrompt, systemPrompt, apiKey, model);
    } else {
        throw new Error(`未対応のプロバイダー: ${provider}`);
    }

    // コストトラッキング
    const fullInput = (systemPrompt || '') + trimmedPrompt;
    trackAiUsage(featureName, fullInput, result, model);

    return result;
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
        max_tokens: 4096,
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
        generationConfig: { maxOutputTokens: 4096 },
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

// AI設定ハンドラ（save-ai-config, test-ai-connection, get-ai-models）
// → src/handlers/ai-config.handler.js に移動済み（get-ai-usage/reset-ai-usageも含む）
require('./src/handlers/ai-config.handler').register(ipcMain, {
    getConfig: () => config,
    saveConfig,
    callLLM,
});

ipcMain.handle('ai-summarize-note', async (_, filePath) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };
        const summary = await callLLM(
            `以下のノートを3行で要約してください:\n\n${content}`,
            'あなたはObsidianノートの内容分析アシスタントです。簡潔かつ正確に要約してください。',
            'ノート要約'
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
            'あなたはObsidianノートのタグ分類アシスタントです。タグは#から始めてください。',
            'タグ提案'
        );

        let tags = [];
        const parsed = extractJsonFromLLM(result);
        if (Array.isArray(parsed)) {
            tags = parsed;
        } else {
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
            'あなたはObsidianノートの重複検出アシスタントです。意味的に同じ内容・テーマのノートペアを見つけてください。',
            '重複検出'
        );

        let duplicates = [];
        const parsed = extractJsonFromLLM(result);
        if (Array.isArray(parsed)) {
            duplicates = parsed.map(d => ({
                noteA: targetNotes[d.noteA - 1] ? { name: targetNotes[d.noteA - 1].name, path: targetNotes[d.noteA - 1].path } : null,
                noteB: targetNotes[d.noteB - 1] ? { name: targetNotes[d.noteB - 1].name, path: targetNotes[d.noteB - 1].path } : null,
                reason: d.reason || '',
            })).filter(d => d.noteA && d.noteB);
        }

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
            'あなたはObsidianのナレッジベース管理アシスタントです。ノート間の意味的な関連性を見つけてリンク提案をしてください。',
            'リンク提案'
        );

        let suggestions = [];
        const parsed = extractJsonFromLLM(result);
        if (Array.isArray(parsed)) { suggestions = parsed; }

        return { success: true, suggestions, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 8: AI翻訳
// ======================================================
ipcMain.handle('ai-translate-note', async (_, { filePath, targetLang }) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const LANG_LABELS = { en: '英語', ja: '日本語', zh: '中国語' };
        const langLabel = LANG_LABELS[targetLang] || targetLang;

        const translated = await callLLM(
            `以下のテキストを${langLabel}に翻訳してください。Markdownの書式は維持してください。\n\n${content}`,
            'あなたはプロフェッショナルな翻訳者です。原文のニュアンスと構造を保ちながら自然な翻訳を行ってください。',
            '翻訳'
        );

        const LANG_SUFFIXES = { en: 'EN', ja: 'JA', zh: 'ZH' };
        const suffix = LANG_SUFFIXES[targetLang] || targetLang.toUpperCase();
        const parsed = path.parse(filePath);
        const translatedPath = path.join(parsed.dir, `${parsed.name} (${suffix})${parsed.ext}`);
        fs.writeFileSync(translatedPath, translated, 'utf-8');

        return { success: true, translatedPath, content: translated };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 9: 会議メモ構造化
// ======================================================
ipcMain.handle('ai-structure-meeting', async (_, { filePath }) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const structured = await callLLM(
            `以下は会議のメモです。以下の構造に整理してください:\n## 📋 議題\n## ✅ 決定事項\n## 📌 アクションアイテム（担当者・期限付き）\n## 📝 メモ・備考\n## 📅 次回の予定\n\n${content}`,
            'あなたは会議メモの整理が得意なアシスタントです。情報を漏れなく、分かりやすく構造化してください。',
            '議事録整理'
        );

        return { success: true, structured: structured.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 10: 文体変換
// ======================================================
ipcMain.handle('ai-convert-tone', async (_, { filePath, tone }) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const TONE_LABELS = { formal: 'フォーマル', casual: 'カジュアル', academic: '学術的', blog: 'ブログ風' };
        const toneLabel = TONE_LABELS[tone] || tone;

        const converted = await callLLM(
            `以下の文章を${toneLabel}な文体に変換してください。内容は変えず、文体だけ変更してください。\n\n${content}`,
            'あなたは文体変換のプロフェッショナルです。内容を変えずに指定された文体に変換してください。',
            '文体変換'
        );

        return { success: true, converted: converted.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 11: AIスマート検索
// ======================================================
ipcMain.handle('ai-smart-search', async (_, { query }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!query || !query.trim()) return { success: false, error: '検索クエリを入力してください' };

        const MAX_NOTES = 100;
        const notes = [];
        const collectNotes = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (notes.length >= MAX_NOTES) return;
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectNotes(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    try {
                        const fc = fs.readFileSync(fullPath, 'utf-8');
                        const preview = fc.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 100);
                        notes.push({ name: entry.name.replace(/\.md$/, ''), path: fullPath, preview });
                    } catch (_) { /* スキップ */ }
                }
            } catch (_) { /* スキップ */ }
        };
        collectNotes(vaultPath);

        const noteList = notes.map(n => `- ${n.name}: ${n.preview}`).join('\n');

        const result = await callLLM(
            `以下のノートリストから「${query}」に関連するノートを最大10個選んでください。\n\n重要: 説明文は一切不要です。JSON配列のみを返してください。他のテキストは含めないでください。\n\nフォーマット: [{"name":"ノート名","relevance":"高","reason":"理由"}]\n\nノートリスト:\n${noteList}`,
            'あなたは検索APIです。JSON配列のみを返してください。説明文やmarkdownコードブロックは不要です。純粋なJSON配列だけを出力してください。',
            'スマート検索'
        );

        let results = [];
        const parsed = extractJsonFromLLM(result);
        if (Array.isArray(parsed)) {
            results = parsed.map(r => {
                const rName = (r.name || '').replace(/\.md$/, '').trim();
                const rLower = rName.toLowerCase();
                const found = notes.find(n => n.name === rName)
                    || notes.find(n => n.name.toLowerCase() === rLower)
                    || notes.find(n => n.name.toLowerCase().includes(rLower) || rLower.includes(n.name.toLowerCase()));
                return {
                    name: r.name || rName,
                    path: found ? found.path : '',
                    relevance: r.relevance || '中',
                    reason: r.reason || '',
                };
            });
        } else if (result && result.trim()) {
            // JSONパース失敗時はraw応答をフォールバック表示
            results = [{ name: '(AI応答)', path: '', relevance: '情報', reason: result.trim().slice(0, 500) }];
        }
        return { success: true, results, totalNotes: notes.length, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 12: 感情分析トレンド
// ======================================================
ipcMain.handle('ai-sentiment-analysis', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const MAX_NOTES = 30;
        const PREVIEW_LENGTH = 200;
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

        const recentNotes = [];
        const collectRecent = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectRecent(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    try {
                        const stat = fs.statSync(fullPath);
                        if (stat.mtimeMs >= thirtyDaysAgo) {
                            const fc = fs.readFileSync(fullPath, 'utf-8');
                            const body = fc.replace(/^---[\s\S]*?---\n?/, '').trim();
                            if (body.length > 10) {
                                recentNotes.push({
                                    name: entry.name.replace(/\.md$/, ''),
                                    path: fullPath,
                                    date: stat.mtime.toISOString().split('T')[0],
                                    preview: body.slice(0, PREVIEW_LENGTH),
                                });
                            }
                        }
                    } catch (_) { /* スキップ */ }
                }
            } catch (_) { /* スキップ */ }
        };
        collectRecent(vaultPath);

        recentNotes.sort((a, b) => b.date.localeCompare(a.date));
        const targetNotes = recentNotes.slice(0, MAX_NOTES);

        if (targetNotes.length === 0) {
            return { success: true, results: [], trend: { positive: 0, negative: 0, neutral: 0 }, message: '過去30日間のノートが見つかりません' };
        }

        const noteList = targetNotes.map((n, i) => `--- ノート${i + 1}: ${n.name} (${n.date}) ---\n${n.preview}`).join('\n\n');

        const result = await callLLM(
            `以下の各ノートの感情トーンを分析してください。説明文は不要です。JSON配列のみ返してください。\nフォーマット: [{"name":"ノート名","sentiment":"positive","score":75}]\n\n${noteList}`,
            'あなたは感情分析のエキスパートです。各ノートの全体的な感情トーンを分析してください。',
            '感情分析'
        );

        let results = [];
        const parsed = extractJsonFromLLM(result);
        if (Array.isArray(parsed)) {
            results = parsed.map((r, i) => {
                const note = targetNotes[i] || targetNotes.find(n => n.name === r.name);
                return {
                    name: r.name || (note ? note.name : ''),
                    date: note ? note.date : '',
                    sentiment: r.sentiment || 'neutral',
                    score: typeof r.score === 'number' ? r.score : 50,
                };
            });
        }

        const trend = { positive: 0, negative: 0, neutral: 0 };
        results.forEach(r => {
            if (r.sentiment === 'positive') trend.positive++;
            else if (r.sentiment === 'negative') trend.negative++;
            else trend.neutral++;
        });

        return { success: true, results, trend, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 13: 無題ノート自動タイトル提案
// ======================================================
ipcMain.handle('ai-auto-titles', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const MAX_NOTES = 20;
        const UNTITLED_PATTERNS = [/^untitled/i, /^無題/, /^名称未設定/, /^new note/i, /^メモ$/i, /^note$/i, /^\d{8}$/, /^\d{4}-\d{2}-\d{2}$/, /^Pasted image/i];
        const untitledNotes = [];

        const collectUntitled = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (untitledNotes.length >= MAX_NOTES) return;
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectUntitled(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    const baseName = entry.name.replace(/\.md$/, '');
                    const isUntitled = UNTITLED_PATTERNS.some(p => p.test(baseName)) || baseName.length <= 2;
                    if (isUntitled) {
                        try {
                            const fc = fs.readFileSync(fullPath, 'utf-8');
                            const body = fc.replace(/^---[\s\S]*?---\n?/, '').trim();
                            // 空でなければ対象（1文字以上）。空ファイルもタイトル提案の対象にする
                            if (true) {
                                untitledNotes.push({
                                    currentName: entry.name,
                                    path: fullPath,
                                    preview: body.slice(0, 200),
                                });
                            }
                        } catch (_) { /* スキップ */ }
                    }
                }
            } catch (_) { /* スキップ */ }
        };
        collectUntitled(vaultPath);

        if (untitledNotes.length === 0) {
            return { success: true, suggestions: [], message: '無題のノートが見つかりません' };
        }

        const noteList = untitledNotes.map((n, i) => `--- ノート${i + 1}: ${n.currentName} ---\n${n.preview}`).join('\n\n');

        const result = await callLLM(
            `以下のノートの内容に基づいて、適切なタイトルを提案してください。説明文は不要です。JSON配列のみ返してください。\nフォーマット: [{"currentName":"ファイル名","suggestedTitle":"提案"}]\n\n${noteList}`,
            'あなたはObsidianノートのタイトル提案アシスタントです。ノートの内容を端的に表す、分かりやすいタイトルを提案してください。',
            'タイトル提案'
        );

        let suggestions = [];
        const parsed = extractJsonFromLLM(result);
        if (Array.isArray(parsed)) {
            suggestions = parsed.map((s, i) => {
                const note = untitledNotes[i] || untitledNotes.find(n => n.currentName === s.currentName);
                return {
                    currentName: s.currentName || (note ? note.currentName : ''),
                    path: note ? note.path : '',
                    suggestedTitle: s.suggestedTitle || '',
                };
            }).filter(s => s.path && s.suggestedTitle);
        }

        return { success: true, suggestions, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 14: AIライティング提案
// ======================================================
ipcMain.handle('ai-writing-prompt', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const tagCounts = {};
        const folderCounts = {};
        const allMd = [];

        const collectInfo = (dir, depth) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (depth === 0) folderCounts[entry.name] = 0;
                        collectInfo(fullPath, depth + 1);
                        continue;
                    }
                    if (!entry.name.endsWith('.md')) continue;
                    allMd.push(fullPath);
                    if (depth === 0) {
                        folderCounts['(ルート)'] = (folderCounts['(ルート)'] || 0) + 1;
                    } else {
                        const rel = path.relative(vaultPath, dir).split(path.sep)[0];
                        folderCounts[rel] = (folderCounts[rel] || 0) + 1;
                    }
                    try {
                        const fc = fs.readFileSync(fullPath, 'utf-8');
                        const tagMatches = fc.match(/#[a-zA-Z\u3040-\u9FFF][a-zA-Z0-9_/\u3040-\u9FFF-]*/g);
                        if (tagMatches) tagMatches.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
                    } catch (_) { /* スキップ */ }
                }
            } catch (_) { /* スキップ */ }
        };
        collectInfo(vaultPath, 0);

        const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20)
            .map(([tag, count]) => `${tag} (${count}回)`).join(', ');
        const folderInfo = Object.entries(folderCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
            .map(([folder, count]) => `${folder}: ${count}件`).join(', ');

        const activity = `総ノート数: ${allMd.length}\nよく使うタグ: ${topTags || '(なし)'}\nフォルダ構成: ${folderInfo || '(なし)'}`;

        const result = await callLLM(
            `以下はObsidian Vaultの活動状況です。今日書くべきノートのアイデアを5つ提案してください。説明文は不要です。JSON配列のみ返してください。\nフォーマット: [{"title":"タイトル","description":"説明","suggestedFolder":"フォルダ名"}]\n\n活動状況:\n${activity}`,
            'JSON配列のみを返してください。他のテキストは含めないでください。',
            'ライティング提案'
        );

        let prompts = [];
        const parsedPrompts = extractJsonFromLLM(result);
        if (Array.isArray(parsedPrompts)) { prompts = parsedPrompts; }

        return { success: true, prompts, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 14補助: ライティング提案からノートを作成
ipcMain.handle('ai-create-note-from-prompt', async (_, { title, content, folder }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        let targetDir = vaultPath;
        if (folder) {
            targetDir = path.join(vaultPath, folder);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }
        }

        const safeName = title.replace(/[/\\:*?"<>|]/g, '_');
        const filePath = path.join(targetDir, `${safeName}.md`);

        const now = new Date().toISOString().split('T')[0];
        const noteContent = `---\ncreated: ${now}\ntags: []\n---\n# ${title}\n\n${content || ''}`;
        fs.writeFileSync(filePath, noteContent, 'utf-8');

        return { success: true, filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// AI拡張機能 (Feature 1-8)
// ======================================================

// Feature 1: Ask Your Vault (RAG-like Q&A)
ipcMain.handle('ai-ask-vault', async (_, { question }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!question || !question.trim()) return { success: false, error: '質問を入力してください' };

        const notes = [];
        const collectNotes = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectNotes(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        const snippet = content.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 200);
                        notes.push({ name: entry.name.replace(/\.md$/, ''), path: fullPath, snippet });
                    } catch (_) { /* スキップ */ }
                }
            } catch (_) { /* スキップ */ }
        };
        collectNotes(vaultPath);

        // キーワードマッチングで関連ノートを探す
        const keywords = question.toLowerCase().split(/[\s\u3000\u3001\u3002,./\\-]+/).filter(w => w.length > 1);
        const scored = notes.map(n => {
            const textLower = (n.name + ' ' + n.snippet).toLowerCase();
            let score = 0;
            for (const kw of keywords) {
                if (textLower.includes(kw)) score += 1;
                if (n.name.toLowerCase().includes(kw)) score += 2;
            }
            return { ...n, score };
        }).filter(n => n.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);

        let snippetsText = '';
        if (scored.length > 0) {
            snippetsText = scored.map(n => `--- ${n.name} ---\n${n.snippet}`).join('\n\n');
        } else {
            snippetsText = '(関連ノートが見つかりませんでした)';
        }

        const answer = await callLLM(
            `あなたはObsidian Vaultのナレッジアシスタントです。以下のノートの内容に基づいて質問に回答してください。\n\n関連ノート:\n${snippetsText}\n\n質問: ${question}`,
            '',
            'Vault Q&A'
        );

        const sources = scored.map(n => ({ name: n.name, path: n.path }));
        return { success: true, answer: answer.trim(), sources };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 2: Weekly AI Insight Report
ipcMain.handle('ai-weekly-insight', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        const MAX_NOTES = 20;
        const recentNotes = [];

        const collectRecent = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectRecent(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    try {
                        const stat = fs.statSync(fullPath);
                        if (now - stat.mtimeMs <= ONE_WEEK_MS) {
                            const content = fs.readFileSync(fullPath, 'utf-8');
                            const body = content.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 300);
                            recentNotes.push({ name: entry.name.replace(/\.md$/, ''), body, mtime: stat.mtimeMs });
                        }
                    } catch (_) { /* スキップ */ }
                }
            } catch (_) { /* スキップ */ }
        };
        collectRecent(vaultPath);

        recentNotes.sort((a, b) => b.mtime - a.mtime);
        const targetNotes = recentNotes.slice(0, MAX_NOTES);

        if (targetNotes.length === 0) {
            return { success: true, insight: '今週更新されたノートがありません。', notesAnalyzed: 0 };
        }

        const notesContent = targetNotes.map(n => `--- ${n.name} ---\n${n.body}`).join('\n\n');

        const insight = await callLLM(
            `以下は今週更新されたノートです。以下の3項目について日本語で分析してください:\n1. 今週のトピック傾向\n2. 知識のギャップ（書くべきだが書いていないトピック）\n3. おすすめの次のアクション\n\nノート:\n${notesContent}`,
            '',
            '週次インサイト'
        );

        return { success: true, insight: insight.trim(), notesAnalyzed: targetNotes.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 3: AI MOC Auto-composition
ipcMain.handle('ai-compose-moc', async (_, { topic }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!topic || !topic.trim()) return { success: false, error: 'トピックを入力してください' };

        const notes = [];
        const collectNotes = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectNotes(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    notes.push(entry.name.replace(/\.md$/, ''));
                }
            } catch (_) { /* スキップ */ }
        };
        collectNotes(vaultPath);

        const noteList = notes.slice(0, 300).join('\n');

        const result = await callLLM(
            `以下のノートリストから「${topic}」に関連するMOCを構成してください。JSON形式で {"title": "MOCタイトル", "description": "説明", "sections": [{"heading": "セクション見出し", "noteLinks": ["ノート名1", "ノート名2"]}]} を返してください。\n\nノート:\n${noteList}`,
            'あなたはObsidian MOC構成アシスタントです。関連性の高いノートをセクションにグループ化してMOCを提案してください。',
            'AI MOC構成'
        );

        let mocData = extractJsonFromLLM(result);
        if (Array.isArray(mocData)) { mocData = null; } // オブジェクトのみ受け付ける

        if (!mocData) {
            return { success: true, raw: result.trim(), mocData: null };
        }

        return { success: true, mocData, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 4: Note Quality Review
ipcMain.handle('ai-review-note', async (_, { filePath }) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const result = await callLLM(
            `以下のノートの品質をレビューしてください。以下の項目について日本語で評価:\n1. 構成の改善点\n2. 不足している情報\n3. リンクすべき関連トピック\n4. 総合スコア（0-100）\n\n${content}`,
            'あなたはObsidianノートの品質レビューアシスタントです。具体的で改善可能なフィードバックをしてください。',
            'ノートレビュー'
        );

        let score = null;
        const scoreMatch = result.match(/(?:総合スコア|スコア)[：:\s]*(\d{1,3})/);
        if (scoreMatch) { score = parseInt(scoreMatch[1], 10); }

        return { success: true, review: result.trim(), score };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 5: Flashcard Generation
ipcMain.handle('ai-generate-flashcards', async (_, { filePath }) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const result = await callLLM(
            `以下のノートからフラッシュカードを5-10枚作成してください。説明文は不要です。JSON配列のみ返してください。\nフォーマット: [{"question":"質問","answer":"回答"}]\n\n${content}`,
            'あなたは学習支援アシスタントです。ノートの重要なポイントをQ&A形式のフラッシュカードにしてください。',
            'フラッシュカード'
        );

        let cards = [];
        const parsedCards = extractJsonFromLLM(result);
        if (Array.isArray(parsedCards)) { cards = parsedCards; }

        // フラッシュカード用Markdownファイルを保存
        if (cards.length > 0) {
            const noteName = path.basename(filePath, '.md');
            const flashcardPath = path.join(path.dirname(filePath), `Flashcards - ${noteName}.md`);
            let mdContent = `# Flashcards - ${noteName}\n\n`;
            mdContent += `> 自動生成日: ${new Date().toLocaleDateString('ja-JP')}\n\n`;
            cards.forEach((c, i) => {
                mdContent += `## Q${i + 1}: ${c.question}\n\n`;
                mdContent += `**A:** ${c.answer}\n\n---\n\n`;
            });
            fs.writeFileSync(flashcardPath, mdContent, 'utf-8');
        }

        return { success: true, cards, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 6: Bullet Point Expansion
ipcMain.handle('ai-expand-note', async (_, { filePath }) => {
    try {
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルです' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) return { success: false, error: 'ノートが空です' };

        const expanded = await callLLM(
            `以下の箇条書きメモを、読みやすい文章に展開してください。元の情報を全て保持し、段落構成で書き直してください。\n\n${content}`,
            'あなたはライティングアシスタントです。箇条書きを読みやすい文章に変換してください。構造は維持しつつ自然な日本語にしてください。',
            '文章展開'
        );

        return { success: true, expanded: expanded.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 7: Knowledge Gap Detection
ipcMain.handle('ai-detect-gaps', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const noteTitles = [];
        const allTags = new Set();
        const collectInfo = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (EXCLUDE_ENTRIES.has(entry.name) || entry.name.startsWith('.')) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) { collectInfo(fullPath); continue; }
                    if (!entry.name.endsWith('.md')) continue;
                    noteTitles.push(entry.name.replace(/\.md$/, ''));
                    try {
                        const fc = fs.readFileSync(fullPath, 'utf-8');
                        const tagMatches = fc.match(/#[a-zA-Z\u3040-\u9FFF][a-zA-Z0-9_/\u3040-\u9FFF-]*/g);
                        if (tagMatches) tagMatches.forEach(t => allTags.add(t));
                    } catch (_) { /* スキップ */ }
                }
            } catch (_) { /* スキップ */ }
        };
        collectInfo(vaultPath);

        const tagList = Array.from(allTags).slice(0, 50).join(', ');
        const noteList = noteTitles.slice(0, 200).join('\n');

        const result = await callLLM(
            `以下のVaultに欠けているトピックを5-10個提案してください。説明文は不要です。JSON配列のみ返してください。\nフォーマット: [{"topic":"トピック名","reason":"理由"}]\n\nタグ: ${tagList || '(なし)'}\n\nノート一覧:\n${noteList}`,
            'あなたはナレッジマネジメントのアドバイザーです。Vaultの内容を分析し、知識のギャップを特定してください。',
            '知識ギャップ検出'
        );

        let gaps = [];
        const parsedGaps = extractJsonFromLLM(result);
        if (Array.isArray(parsedGaps)) { gaps = parsedGaps; }

        return { success: true, gaps, raw: result.trim() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Feature 8: Cost Tracking - Get/Reset AI Usage
// get-ai-usage / reset-ai-usage → src/handlers/ai-config.handler.js に移動済み

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
                    'あなたはObsidianノートのタイトル提案アシスタントです。簡潔で内容を表すタイトルを提案してください。',
                    'タイトル提案'
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

// ノート分割実行
ipcMain.handle('split-note', async (_, { filePath, headingLevel }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルは操作できません' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };

        const content = fs.readFileSync(filePath, 'utf-8');
        const noteName = path.basename(filePath, '.md');
        const noteDir = path.dirname(filePath);
        const level = headingLevel || 2;
        const headingRe = new RegExp(`^${'#'.repeat(level)}\\s+(.+)`);

        // frontmatterを先に分離
        const fmRe = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
        const fmMatch = content.match(fmRe);
        const bodyContent = fmMatch ? content.slice(fmMatch[0].length) : content;
        const lines = bodyContent.split(/\r?\n/);

        // セクションごとに分割（frontmatter除外済み）
        const sections = [];
        let currentSection = { title: null, lines: [] };

        for (const line of lines) {
            const m = line.match(headingRe);
            if (m) {
                if (currentSection.lines.length > 0 || currentSection.title) {
                    sections.push({ ...currentSection });
                }
                currentSection = { title: m[1].trim(), lines: [] };
            } else {
                currentSection.lines.push(line);
            }
        }
        if (currentSection.lines.length > 0 || currentSection.title) {
            sections.push(currentSection);
        }

        if (sections.length < 2) return { success: false, error: '分割できるセクションが見つかりません' };

        const createdFiles = [];
        const indexLines = [];
        if (fmMatch) indexLines.push(fmMatch[0].trimEnd(), '');
        indexLines.push(`# ${noteName}`, '', `> このノートは自動分割されました。`, '');

        for (const sec of sections) {
            if (!sec.title) {
                // 冒頭部分（frontmatter除外済み）をインデックスに含める
                const trimmed = sec.lines.join('\n').trim();
                if (trimmed) indexLines.push(trimmed, '');
                continue;
            }
            // 安全なファイル名を生成
            const safeTitle = sec.title.replace(/[/\\:*?"<>|]/g, '_').substring(0, 80);
            const newFileName = `${noteName} - ${safeTitle}.md`;
            const newFilePath = path.join(noteDir, newFileName);

            const newContent = [
                `# ${sec.title}`,
                '',
                `> 元ノート: [[${noteName}]]`,
                '',
                ...sec.lines,
            ].join('\n');

            fs.writeFileSync(newFilePath, newContent, 'utf-8');
            createdFiles.push({ title: sec.title, path: newFilePath });
            indexLines.push(`- [[${path.basename(newFilePath, '.md')}|${sec.title}]]`);
        }

        // 元ノートをインデックスノートに更新
        fs.writeFileSync(filePath, indexLines.join('\n'), 'utf-8');

        return { success: true, createdFiles, count: createdFiles.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 機密情報マスク処理
ipcMain.handle('mask-secrets', async (_, { filePath, findings }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        // 相対パスの場合は絶対パスに変換
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(vaultPath, filePath);
        filePath = absPath;
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルは操作できません' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };

        let content = fs.readFileSync(filePath, 'utf-8');
        let maskedCount = 0;

        // 行番号とパターンでマッチしてマスク
        const lines = content.split('\n');
        for (const finding of findings) {
            const lineIdx = finding.line - 1;
            if (lineIdx < 0 || lineIdx >= lines.length) continue;
            const patterns = [
                /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
                /AKIA[0-9A-Z]{16}/g,
                /gh[ps]_[A-Za-z0-9_]{36,}/g,
                /sk-[a-zA-Z0-9]{20,}/g,
                /(?:password|passwd|pass)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
                /xox[bprs]-[0-9A-Za-z-]+/g,
                /Bearer\s+[a-zA-Z0-9._\-]{20,}/g,
                /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g,
            ];
            for (const re of patterns) {
                const before = lines[lineIdx];
                lines[lineIdx] = lines[lineIdx].replace(re, '***REDACTED***');
                if (lines[lineIdx] !== before) maskedCount++;
            }
        }

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { success: true, maskedCount };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 未参照画像の検出と削除
ipcMain.handle('find-unreferenced-images', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const allFiles = getFilesRecursively(vaultPath);
        const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.svg', '.webp']);
        const images = allFiles.filter(f => imageExts.has(path.extname(f).toLowerCase()));
        const mdFiles = allFiles.filter(f => f.endsWith('.md'));

        // 全MDファイルの内容を結合して画像参照を検索
        let allMdContent = '';
        for (const md of mdFiles) {
            try { allMdContent += fs.readFileSync(md, 'utf-8') + '\n'; } catch (_) {}
        }

        const unreferenced = [];
        for (const img of images) {
            const imgName = path.basename(img);
            // Obsidianのリンク形式とMarkdown形式の両方をチェック
            if (!allMdContent.includes(imgName)) {
                let size = 0;
                try { size = fs.statSync(img).size; } catch (_) {}
                unreferenced.push({
                    path: img,
                    relPath: path.relative(vaultPath, img),
                    name: imgName,
                    size,
                });
            }
        }

        unreferenced.sort((a, b) => b.size - a.size);
        return { success: true, images: unreferenced, count: unreferenced.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-unreferenced-images', async (_, { paths }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        let deleted = 0;
        let totalSize = 0;
        for (const imgPath of paths) {
            if (!isPathInsideVault(imgPath)) continue;
            try {
                const stat = fs.statSync(imgPath);
                totalSize += stat.size;
                fs.unlinkSync(imgPath);
                deleted++;
            } catch (_) {}
        }

        return { success: true, deleted, totalSize };
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

// ======================================================
// タスク管理機能
// ======================================================

// 優先度をObsidian Tasks形式の絵文字に変換
const PRIORITY_EMOJI_MAP = { high: ' ⏫', medium: ' 🔼', low: ' 🔽' };

ipcMain.handle('add-task', async (_, { text, dueDate, priority, targetNote, projectTag, recur }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!text || !text.trim()) return { success: false, error: 'タスクテキストが空です' };

        // タスク行を組み立て（Obsidian Tasks形式）
        let taskLine = `- [ ] ${text.trim()}`;
        if (dueDate) taskLine += ` 📅 ${dueDate}`;
        if (priority && PRIORITY_EMOJI_MAP[priority]) taskLine += PRIORITY_EMOJI_MAP[priority];
        // 繰り返し設定
        if (recur && recur !== 'none') taskLine += ` 🔁 ${recur}`;
        // プロジェクトタグ (スペースをハイフンに変換してタグとして追加)
        if (projectTag) taskLine += ` #project/${projectTag.replace(/\s+/g, '-')}`;

        // 保存先ファイルを決定
        let filePath;
        if (targetNote && targetNote !== '__default__') {
            filePath = targetNote;
        } else {
            filePath = path.join(vaultPath, '📋 Tasks.md');
        }

        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルには書き込めません' };

        // ファイルが存在しない場合は作成
        if (!fs.existsSync(filePath)) {
            const header = `# 📋 Tasks\n\n`;
            fs.writeFileSync(filePath, header + taskLine + '\n', 'utf-8');
        } else {
            // 既存ファイルの末尾に追記
            let content = fs.readFileSync(filePath, 'utf-8');
            // 末尾に改行がなければ追加
            if (!content.endsWith('\n')) content += '\n';
            content += taskLine + '\n';
            fs.writeFileSync(filePath, content, 'utf-8');
        }

        return { success: true, filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-all-tasks', async (_, opts) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const sourceFilter = (opts && opts.source) || 'all'; // 'registered' | 'all'
        let allFiles;
        if (sourceFilter === 'registered') {
            // 登録タスクのみ: タスク保存先ファイルだけをスキャン
            const taskFiles = [];
            const defaultTaskFile = path.join(vaultPath, '📋 Tasks.md');
            if (fs.existsSync(defaultTaskFile)) taskFiles.push(defaultTaskFile);
            // ユーザーがカスタム保存先を使っている場合もカバー
            const mdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
            for (const f of mdFiles) {
                if (taskFiles.includes(f)) continue;
                const basename = path.basename(f);
                if (basename.startsWith('📋')) {
                    taskFiles.push(f);
                }
            }
            allFiles = taskFiles;
        } else {
            allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        }
        const tasks = [];
        // タスク行のパターン: `- [ ] ...` または `- [x] ...`
        const taskLineRe = /^(\s*)-\s*\[([ xX])\]\s*(.+)$/;
        // 期限: 📅 YYYY-MM-DD
        const dueDateRe = /📅\s*(\d{4}-\d{2}-\d{2})/;
        // 優先度: ⏫ / 🔼 / 🔽
        const priorityHighRe = /⏫/;
        const priorityMedRe = /🔼/;
        const priorityLowRe = /🔽/;
        // プロジェクトタグ: #project/name
        const projectTagRe = /#project\/([^\s#]+)/;
        // 繰り返し: 🔁 daily/weekly/monthly
        const recurRe = /🔁\s*(daily|weekly|monthly)/;

        for (const file of allFiles) {
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const m = taskLineRe.exec(lines[i]);
                if (!m) continue;
                const done = m[2].toLowerCase() === 'x';
                let rawText = m[3];

                // 期限を抽出
                let dueDate = null;
                const dm = dueDateRe.exec(rawText);
                if (dm) dueDate = dm[1];

                // 優先度を抽出
                let priority = null;
                if (priorityHighRe.test(rawText)) priority = 'high';
                else if (priorityMedRe.test(rawText)) priority = 'medium';
                else if (priorityLowRe.test(rawText)) priority = 'low';

                // プロジェクトタグを抽出
                const pm = projectTagRe.exec(rawText);
                const projectTag = pm ? pm[1] : null;

                // 繰り返し設定を抽出
                const rm = recurRe.exec(rawText);
                const recur = rm ? rm[1] : null;

                // 表示用テキスト（メタ絵文字・タグを除去）
                const displayText = rawText
                    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
                    .replace(/[⏫🔼🔽]/g, '')
                    .replace(/🔁\s*(daily|weekly|monthly)/g, '')
                    .replace(/#project\/\S+/g, '')
                    .trim();

                const relPath = path.relative(vaultPath, file);
                tasks.push({ text: displayText, done, dueDate, priority, projectTag, recur, filePath: file, relPath, lineNumber: i });
            }
        }

        // ソート: 完了を後ろへ → 期限切れ → 期限あり昇順 → 期限なし
        const now = new Date().toISOString().slice(0, 10);
        tasks.sort((a, b) => {
            // 完了タスクは最後
            if (a.done !== b.done) return a.done ? 1 : -1;
            // 両方未完了の場合
            if (!a.done && !b.done) {
                const aOverdue = a.dueDate && a.dueDate < now;
                const bOverdue = b.dueDate && b.dueDate < now;
                if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
                if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
                if (a.dueDate) return -1;
                if (b.dueDate) return 1;
            }
            return 0;
        });

        return { success: true, tasks };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('toggle-task', async (_, { filePath, lineNumber, done }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルは操作できません' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        if (lineNumber < 0 || lineNumber >= lines.length) return { success: false, error: '行番号が無効です' };

        if (done) {
            // 未完了→完了
            lines[lineNumber] = lines[lineNumber].replace(/- \[ \]/, '- [x]');

            // 繰り返しタスクの場合: 次回分を自動生成
            const recurRe = /🔁\s*(daily|weekly|monthly)/;
            const dueDateRe = /📅\s*(\d{4}-\d{2}-\d{2})/;
            const origLine = lines[lineNumber];
            const recurMatch = recurRe.exec(origLine);
            if (recurMatch) {
                const recurType = recurMatch[1];
                const dm = dueDateRe.exec(origLine);
                let nextDate;
                if (dm) {
                    const prevDate = new Date(dm[1]);
                    if (recurType === 'daily') prevDate.setDate(prevDate.getDate() + 1);
                    else if (recurType === 'weekly') prevDate.setDate(prevDate.getDate() + 7);
                    else if (recurType === 'monthly') prevDate.setMonth(prevDate.getMonth() + 1);
                    nextDate = prevDate.toISOString().slice(0, 10);
                } else {
                    nextDate = new Date().toISOString().slice(0, 10);
                }
                // 完了マークを外し、日付を更新した新しいタスク行を挿入
                let nextLine = origLine.replace(/- \[[xX]\]/, '- [ ]');
                if (dm) {
                    nextLine = nextLine.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${nextDate}`);
                } else {
                    nextLine = nextLine.replace(recurRe, `📅 ${nextDate} 🔁 ${recurType}`);
                }
                lines.splice(lineNumber + 1, 0, nextLine);
            }
        } else {
            // 完了→未完了
            lines[lineNumber] = lines[lineNumber].replace(/- \[[xX]\]/, '- [ ]');
        }

        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        // Dockバッジ更新
        updateDockBadge().catch(() => {});
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-task', async (_, { filePath, lineNumber }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルは操作できません' };
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        if (lineNumber < 0 || lineNumber >= lines.length) return { success: false, error: '行番号が無効です' };

        lines.splice(lineNumber, 1);
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-task-targets', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const taskFiles = [];
        const taskLineRe = /^(\s*)-\s*\[[ xX]\]/;

        for (const file of allFiles) {
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            const lines = content.split('\n');
            const hasTask = lines.some(line => taskLineRe.test(line));
            if (hasTask) {
                taskFiles.push({ filePath: file, relPath: path.relative(vaultPath, file) });
            }
        }

        // 名前順ソート
        taskFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

        // デフォルトオプションを先頭に追加
        const defaultTasksPath = path.join(vaultPath, '📋 Tasks.md');
        const defaultExists = fs.existsSync(defaultTasksPath);
        const defaultLabel = defaultExists ? '📋 Tasks.md' : '📋 Tasks.md (新規作成)';

        return { success: true, targets: taskFiles, defaultPath: defaultTasksPath, defaultLabel };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// タスク拡張機能: リマインダー・繰り返し・Dockバッジ・週次レポート
// ======================================================

// ======================================================
// v5.3: スマートルールスケジュール自動実行
// ======================================================
async function runScheduledSmartRules() {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return;
    const rules = config.smartRules || [];
    const scheduled = rules.filter(r => r.enabled && r.schedule && r.schedule !== 'off');
    if (scheduled.length === 0) return;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    let anyRan = false;
    let totalExecuted = 0;

    for (const rule of scheduled) {
        const lastRun = rule.lastScheduledRun ? rule.lastScheduledRun.slice(0, 10) : null;
        let shouldRun = false;

        if (rule.schedule === 'daily') {
            shouldRun = lastRun !== todayStr;
        } else if (rule.schedule === 'weekly') {
            if (!lastRun) {
                shouldRun = true;
            } else {
                const daysDiff = Math.floor((now - new Date(lastRun)) / 86400000);
                shouldRun = daysDiff >= 7;
            }
        } else if (rule.schedule === 'monthly') {
            if (!lastRun) {
                shouldRun = true;
            } else {
                const lastRunDate = new Date(lastRun);
                shouldRun = now.getMonth() !== lastRunDate.getMonth() || now.getFullYear() !== lastRunDate.getFullYear();
            }
        }

        if (!shouldRun) continue;

        try {
            const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
            const { executeRuleExported } = require('./src/handlers/smart-rules.handler');
            if (executeRuleExported) {
                const result = await executeRuleExported(rule, vaultPath, allFiles, safeReadFile);
                totalExecuted += result.count || 0;
            }
            rule.lastScheduledRun = now.toISOString();
            anyRan = true;
        } catch (_) {
            rule.lastScheduledRun = now.toISOString();
            anyRan = true;
        }
    }

    if (anyRan) {
        saveConfig(config);
        if (totalExecuted > 0 && Notification.isSupported()) {
            try {
                new Notification({
                    title: '⚡ スマートルール自動実行完了',
                    body: `スケジュール実行: ${totalExecuted}件処理しました`,
                    silent: true,
                }).show();
            } catch (_) {}
        }
    }
}

// タスクリマインダースケジューラ
function scheduleTaskReminders() {
    const checkReminders = async () => {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return;
        const today = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().slice(0, 10);
        try {
            const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
            const taskLineRe = /^(\s*)-\s*\[([ xX])\]\s*(.+)$/;
            const dueDateRe = /📅\s*(\d{4}-\d{2}-\d{2})/;
            let overdueCount = 0;
            let tomorrowCount = 0;
            for (const file of allFiles) {
                let content;
                try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
                for (const line of content.split('\n')) {
                    const m = taskLineRe.exec(line);
                    if (!m || m[2].toLowerCase() === 'x') continue;
                    const dm = dueDateRe.exec(m[3]);
                    if (!dm) continue;
                    if (dm[1] < today) overdueCount++;
                    else if (dm[1] === tomorrowStr) tomorrowCount++;
                }
            }
            if (overdueCount > 0 || tomorrowCount > 0) {
                const lines = [];
                if (overdueCount > 0) lines.push(`⚠️ 期限切れタスク: ${overdueCount}件`);
                if (tomorrowCount > 0) lines.push(`🔔 明日が期限: ${tomorrowCount}件`);
                if (Notification.isSupported()) {
                    new Notification({
                        title: 'Obsidian Optimizer - タスクリマインダー',
                        body: lines.join('\n'),
                    }).show();
                }
            }
        } catch (e) { console.warn('タスクリマインダーエラー:', e.message); }
    };
    setInterval(checkReminders, 24 * 60 * 60 * 1000);
}

// Dockバッジ更新（期限切れ＋本日期限の未完了タスク数）
async function updateDockBadge() {
    if (process.platform === 'linux') return;
    const vaultPath = getCurrentVault();
    if (!vaultPath) { try { app.setBadgeCount(0); } catch (_) {} return; }
    try {
        const today = new Date().toISOString().slice(0, 10);
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const taskLineRe = /^(\s*)-\s*\[([ xX])\]\s*(.+)$/;
        const dueDateRe = /📅\s*(\d{4}-\d{2}-\d{2})/;
        let urgentCount = 0;
        for (const file of allFiles) {
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            for (const line of content.split('\n')) {
                const m = taskLineRe.exec(line);
                if (!m || m[2].toLowerCase() === 'x') continue;
                const dm = dueDateRe.exec(m[3]);
                // 今日が期限のタスクのみカウント（過去分は積み上がらないよう除外）
                if (dm && dm[1] === today) urgentCount++;
            }
        }
        app.setBadgeCount(urgentCount);
    } catch (e) { console.warn('Dockバッジ更新エラー:', e.message); }
}

ipcMain.handle('reset-dock-badge', () => {
    try { app.setBadgeCount(0); } catch (_) {}
    return { success: true };
});

ipcMain.handle('update-dock-badge', async () => {
    await updateDockBadge();
    return { success: true };
});

// 繰り返しタスク処理（アプリ起動時に未生成分を補完）
async function processRecurringTasks() {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const doneTaskRe = /^(\s*)-\s*\[[xX]\]\s*(.+)$/;
        const dueDateRe = /📅\s*(\d{4}-\d{2}-\d{2})/;
        const recurRe = /🔁\s*(daily|weekly|monthly)/;
        for (const file of allFiles) {
            let content;
            try { content = fs.readFileSync(file, 'utf-8'); } catch (_) { continue; }
            const lines = content.split('\n');
            const additions = [];
            for (let i = 0; i < lines.length; i++) {
                const m = doneTaskRe.exec(lines[i]);
                if (!m) continue;
                const rawText = m[2];
                const recurMatch = recurRe.exec(rawText);
                if (!recurMatch) continue;
                const recurType = recurMatch[1];
                const dm = dueDateRe.exec(rawText);
                let nextDate;
                if (dm) {
                    const d = new Date(dm[1]);
                    if (recurType === 'daily') d.setDate(d.getDate() + 1);
                    else if (recurType === 'weekly') d.setDate(d.getDate() + 7);
                    else if (recurType === 'monthly') d.setMonth(d.getMonth() + 1);
                    nextDate = d.toISOString().slice(0, 10);
                } else { nextDate = today; }
                if (nextDate > today) continue;
                let nextLine = lines[i].replace(/- \[[xX]\]/, '- [ ]');
                if (dm) nextLine = nextLine.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${nextDate}`);
                // 既に同じ未完了タスクが存在すればスキップ
                if (!lines.some(l => l.trim() === nextLine.trim())) {
                    additions.push({ afterIdx: i, line: nextLine });
                }
            }
            if (additions.length > 0) {
                for (let k = additions.length - 1; k >= 0; k--) {
                    lines.splice(additions[k].afterIdx + 1, 0, additions[k].line);
                }
                fs.writeFileSync(file, lines.join('\n'), 'utf-8');
            }
        }
    } catch (e) { console.warn('繰り返しタスク処理エラー:', e.message); }
}

ipcMain.handle('process-recurring-tasks', async () => {
    await processRecurringTasks();
    return { success: true };
});

// 週次レポート生成
ipcMain.handle('generate-weekly-report', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const today = new Date();
        const todayStr = today.toISOString().slice(0, 10);
        // 月曜日を週の起点として計算
        const dow = today.getDay();
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
        const weekStartStr = weekStart.toISOString().slice(0, 10);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);
        const weekEndStr = weekEnd.toISOString().slice(0, 10);

        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const taskLineRe = /^(\s*)-\s*\[([ xX])\]\s*(.+)$/;
        const dueDateRe = /📅\s*(\d{4}-\d{2}-\d{2})/;
        const projectTagRe = /#project\/([^\s#]+)/;

        const completedTasks = [];
        const overdueTasks = [];
        const thisWeekTasks = [];

        for (const file of allFiles) {
            let content, stat;
            try { content = fs.readFileSync(file, 'utf-8'); stat = fs.statSync(file); } catch (_) { continue; }
            const modDate = stat.mtime.toISOString().slice(0, 10);
            const lines = content.split('\n');
            for (const line of lines) {
                const m = taskLineRe.exec(line);
                if (!m) continue;
                const done = m[2].toLowerCase() === 'x';
                const rawText = m[3];
                const displayText = rawText
                    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
                    .replace(/[⏫🔼🔽]/g, '')
                    .replace(/🔁\s*(daily|weekly|monthly)/g, '')
                    .replace(/#project\/\S+/g, '')
                    .trim();
                const dm = dueDateRe.exec(rawText);
                const dueDate = dm ? dm[1] : null;
                const pm = projectTagRe.exec(rawText);
                const project = pm ? pm[1] : null;
                const item = { text: displayText, dueDate, project };
                if (done && modDate >= weekStartStr) completedTasks.push(item);
                else if (!done && dueDate && dueDate < todayStr) overdueTasks.push(item);
                else if (!done && dueDate && dueDate >= weekStartStr && dueDate <= weekEndStr) thisWeekTasks.push(item);
            }
        }

        const projects = getProjects();
        const activeProjects = projects.filter(p => p.status === 'active');

        const fmtTask = (t, done) => {
            const check = done ? '[x]' : '[ ]';
            const proj = t.project ? ` _(${t.project})_` : '';
            const due = t.dueDate ? ` 📅 ${t.dueDate}` : '';
            return `- ${check} ${t.text}${proj}${due}`;
        };

        const completedSection = completedTasks.length > 0
            ? completedTasks.map(t => fmtTask(t, true)).join('\n')
            : '_今週の完了タスクはありません_';
        const thisWeekSection = thisWeekTasks.length > 0
            ? thisWeekTasks.map(t => fmtTask(t, false)).join('\n')
            : '_今週締め切りのタスクはありません_';
        const overdueSection = overdueTasks.length > 0
            ? overdueTasks.map(t => fmtTask(t, false)).join('\n')
            : '_期限切れタスクはありません_ 🎉';
        const projectsSection = activeProjects.length > 0
            ? activeProjects.map(p => {
                const done = (p.tasks || []).filter(t => t.done).length;
                const total = (p.tasks || []).length;
                return `- **${p.name}** ${p.progress || 0}% 完了 (タスク: ${done}/${total})`;
            }).join('\n')
            : '_進行中のプロジェクトはありません_';

        const reportFolder = path.join(vaultPath, 'Reports');
        fs.mkdirSync(reportFolder, { recursive: true });
        const fileName = `週次レポート ${todayStr}.md`;
        const reportPath = path.join(reportFolder, fileName);

        const reportContent =
`---
tags: [weekly-report]
date: ${todayStr}
week: "${weekStartStr} ～ ${weekEndStr}"
---

# 📊 週次レポート ${todayStr}

> 対象期間: **${weekStartStr}** ～ **${weekEndStr}**

---

## ✅ 今週完了したタスク (${completedTasks.length}件)

${completedSection}

---

## 📅 今週締め切りのタスク (${thisWeekTasks.length}件)

${thisWeekSection}

---

## ⚠️ 期限切れタスク (${overdueTasks.length}件)

${overdueSection}

---

## 📁 進行中のプロジェクト (${activeProjects.length}件)

${projectsSection}

---

## 📝 今週の振り返り

> *(ここに振り返りを書いてください)*

## 🎯 来週の目標

> *(ここに来週の目標を書いてください)*
`;
        fs.writeFileSync(reportPath, reportContent, 'utf-8');
        return { success: true, filePath: reportPath };
    } catch (e) { return { success: false, error: e.message }; }
});

// ======================================================
// プロジェクト管理機能
// ======================================================

const { v4: uuidv4 } = (() => {
    try { return require('uuid'); } catch (_) {
        // uuid未インストール時は簡易UUID生成
        return { v4: () => Date.now().toString(36) + Math.random().toString(36).slice(2) };
    }
})();

function getProjects() {
    return config.projects || [];
}

function saveProjects(projects) {
    config.projects = projects;
    saveConfig(config);
}

// プロジェクト一覧取得
ipcMain.handle('get-projects', () => {
    try {
        return { success: true, projects: getProjects() };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// プロジェクト保存（新規 or 更新）
ipcMain.handle('save-project', (_, project) => {
    try {
        const projects = getProjects();
        const now = new Date().toISOString();
        if (project.id) {
            const idx = projects.findIndex(p => p.id === project.id);
            if (idx === -1) return { success: false, error: 'プロジェクトが見つかりません' };
            projects[idx] = { ...projects[idx], ...project, updatedAt: now };
        } else {
            projects.push({
                id: uuidv4(),
                name: project.name || '無題のプロジェクト',
                description: project.description || '',
                status: project.status || 'active',
                priority: project.priority || 'medium',
                color: project.color || '#6366f1',
                startDate: project.startDate || now.slice(0, 10),
                dueDate: project.dueDate || null,
                tags: project.tags || [],
                tasks: [],
                milestones: [],
                notes: project.notes || '',
                vaultNotePath: project.vaultNotePath || null,
                createdAt: now,
                updatedAt: now,
            });
        }
        saveProjects(projects);
        return { success: true, projects };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// プロジェクト削除
ipcMain.handle('delete-project', (_, { id }) => {
    try {
        const projects = getProjects().filter(p => p.id !== id);
        saveProjects(projects);
        return { success: true, projects };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// プロジェクトステータス更新
ipcMain.handle('update-project-status', (_, { id, status }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === id);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        p.status = status;
        p.updatedAt = new Date().toISOString();
        if (status === 'completed') p.completedAt = p.updatedAt;
        saveProjects(projects);
        return { success: true, project: p };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// プロジェクトのサブタスク追加
ipcMain.handle('add-project-task', (_, { projectId, text, dueDate, priority }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        const task = {
            id: uuidv4(),
            text: text.trim(),
            done: false,
            dueDate: dueDate || null,
            priority: priority || null,
            createdAt: new Date().toISOString(),
        };
        p.tasks.push(task);
        p.updatedAt = new Date().toISOString();
        refreshProjectVaultNote(p);
        saveProjects(projects);
        return { success: true, task, project: p };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// プロジェクトのサブタスク完了切替
ipcMain.handle('toggle-project-task', (_, { projectId, taskId }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        const task = p.tasks.find(t => t.id === taskId);
        if (!task) return { success: false, error: 'タスクが見つかりません' };
        task.done = !task.done;
        task.doneAt = task.done ? new Date().toISOString() : null;
        p.updatedAt = new Date().toISOString();
        // 全タスク完了でプロジェクトを自動完了
        if (p.tasks.length > 0 && p.tasks.every(t => t.done) && p.status === 'active') {
            p.status = 'completed';
            p.completedAt = p.updatedAt;
        } else if (p.status === 'completed' && p.tasks.some(t => !t.done)) {
            p.status = 'active'; // タスクを未完了に戻したら再開
        }
        refreshProjectVaultNote(p);
        saveProjects(projects);
        return { success: true, project: p };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// プロジェクトのサブタスク削除
ipcMain.handle('delete-project-task', (_, { projectId, taskId }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        p.tasks = p.tasks.filter(t => t.id !== taskId);
        p.updatedAt = new Date().toISOString();
        refreshProjectVaultNote(p);
        saveProjects(projects);
        return { success: true, project: p };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// マイルストーン追加
ipcMain.handle('add-project-milestone', (_, { projectId, name, dueDate }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        const ms = { id: uuidv4(), name: name.trim(), dueDate: dueDate || null, done: false };
        p.milestones.push(ms);
        p.updatedAt = new Date().toISOString();
        refreshProjectVaultNote(p);
        saveProjects(projects);
        return { success: true, milestone: ms, project: p };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// マイルストーン完了切替
ipcMain.handle('toggle-project-milestone', (_, { projectId, milestoneId }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        const ms = p.milestones.find(m => m.id === milestoneId);
        if (!ms) return { success: false, error: 'マイルストーンが見つかりません' };
        ms.done = !ms.done;
        p.updatedAt = new Date().toISOString();
        refreshProjectVaultNote(p);
        saveProjects(projects);
        return { success: true, project: p };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// マイルストーン削除
ipcMain.handle('delete-project-milestone', (_, { projectId, milestoneId }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        p.milestones = p.milestones.filter(m => m.id !== milestoneId);
        p.updatedAt = new Date().toISOString();
        refreshProjectVaultNote(p);
        saveProjects(projects);
        return { success: true, project: p };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// プロジェクトメモ更新
ipcMain.handle('update-project-notes', (_, { projectId, notes }) => {
    try {
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };
        p.notes = notes;
        p.updatedAt = new Date().toISOString();
        refreshProjectVaultNote(p);
        saveProjects(projects);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// プロジェクトノート生成ヘルパー（タスク/マイルストーン変更時に自動呼び出し）
// ======================================================
function refreshProjectVaultNote(p) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return;
    try {
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

        const unifiedTasksSection =
`## タスク (${doneTasks}/${p.tasks.length})

${taskLines}

> 以下はタスクタブで \`#project/${projectTag}\` タグを付けたVault連動タスクです

\`\`\`dataview
TASK
FROM ""
WHERE contains(tags, "project/${projectTag}")
SORT file.mtime DESC
\`\`\`
`;

        const content = [
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
            unifiedTasksSection,
            msLines ? `## マイルストーン\n\n${msLines}\n` : '',
            p.notes ? `## メモ\n\n${p.notes}\n` : '',
        ].filter(l => l !== null).join('\n');

        const targetFolder = isArchived ? '04 Archives' : '01 Projects';
        const folderPath = path.join(vaultPath, targetFolder);
        fs.mkdirSync(folderPath, { recursive: true });
        const safeFileName = p.name.replace(/[/\\:*?"<>|]/g, '-');
        const notePath = path.join(folderPath, `📁 ${safeFileName}.md`);
        fs.writeFileSync(notePath, content, 'utf-8');

        if (p.vaultNotePath && p.vaultNotePath !== notePath && fs.existsSync(p.vaultNotePath)) {
            try { fs.unlinkSync(p.vaultNotePath); } catch (_) {}
        }
        p.vaultNotePath = notePath;
    } catch (_) {
        // Vault書き込み失敗は無視（操作自体は成功させる）
    }
}

// VaultにプロジェクトノートをMarkdown形式で生成
ipcMain.handle('generate-project-note', async (_, { projectId }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };

        refreshProjectVaultNote(p);
        p.updatedAt = new Date().toISOString();
        saveProjects(projects);

        return { success: true, notePath: p.vaultNotePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// v5.3 新機能: プロジェクト間タスク移動
// ======================================================
ipcMain.handle('move-project-task', (_, { fromProjectId, taskId, toProjectId }) => {
    try {
        if (!fromProjectId || !taskId || !toProjectId) return { success: false, error: 'パラメータ不足' };
        if (fromProjectId === toProjectId) return { success: false, error: '移動先が同じプロジェクトです' };
        const projects = getProjects();
        const fromP = projects.find(p => p.id === fromProjectId);
        const toP   = projects.find(p => p.id === toProjectId);
        if (!fromP) return { success: false, error: '移動元プロジェクトが見つかりません' };
        if (!toP)   return { success: false, error: '移動先プロジェクトが見つかりません' };
        const taskIdx = (fromP.tasks || []).findIndex(t => t.id === taskId);
        if (taskIdx < 0) return { success: false, error: 'タスクが見つかりません' };
        const [task] = fromP.tasks.splice(taskIdx, 1);
        if (!toP.tasks) toP.tasks = [];
        toP.tasks.push(task);
        fromP.updatedAt = new Date().toISOString();
        toP.updatedAt   = new Date().toISOString();
        saveProjects(projects);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// v5.3 新機能: VaultノートからプロジェクトTaskを同期（双方向同期）
// ======================================================
ipcMain.handle('sync-vault-to-project', async (_, { projectId }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const projects = getProjects();
        const p = projects.find(p => p.id === projectId);
        if (!p) return { success: false, error: 'プロジェクトが見つかりません' };

        // プロジェクトのVaultノートパスを特定
        const safeFileName = p.name.replace(/[/\\:*?"<>|]/g, '-');
        const notePath = p.vaultNotePath || path.join(vaultPath, '01 Projects', `📁 ${safeFileName}.md`);
        if (!fs.existsSync(notePath)) {
            return { success: false, error: 'Vaultノートがまだありません。「Vaultノートを生成」してから同期してください。' };
        }

        const content = fs.readFileSync(notePath, 'utf-8');
        // ## タスク セクションのチェックボックスを抽出（- [ ] / - [x]）
        const taskSection = content.match(/## タスク[^\n]*\n([\s\S]*?)(?=\n##|\n---|\n```|$)/);
        if (!taskSection) return { success: false, error: 'Vaultノートにタスクセクションが見つかりません' };

        const rawLines = taskSection[1].split('\n');
        const vaultTasks = [];
        for (const line of rawLines) {
            const m = line.match(/^- \[([ xX])\] (.+)/);
            if (!m) continue;
            const done = m[1].toLowerCase() === 'x';
            let text = m[2].trim();
            // 📅 日付を除去してテキストのみ抽出
            const dueMatch = text.match(/📅 (\d{4}-\d{2}-\d{2})/);
            const dueDate = dueMatch ? dueMatch[1] : null;
            text = text.replace(/📅 \d{4}-\d{2}-\d{2}/, '').trim();
            if (text && !text.startsWith('（タスクを追加してください）')) {
                vaultTasks.push({ text, done, dueDate });
            }
        }

        if (vaultTasks.length === 0) return { success: false, error: 'Vaultノートに有効なタスクが見つかりません' };

        // 既存のプロジェクトタスクをマージ（新しいタスクのみ追加、既存は更新）
        let added = 0;
        let updated = 0;
        for (const vt of vaultTasks) {
            const existing = (p.tasks || []).find(t => t.text === vt.text);
            if (existing) {
                // done状態を同期
                if (existing.done !== vt.done) {
                    existing.done = vt.done;
                    updated++;
                }
            } else {
                // 新しいタスクを追加
                if (!p.tasks) p.tasks = [];
                p.tasks.push({
                    id: require('crypto').randomUUID(),
                    text: vt.text,
                    done: vt.done,
                    dueDate: vt.dueDate || null,
                    priority: null,
                    createdAt: new Date().toISOString(),
                });
                added++;
            }
        }
        p.updatedAt = new Date().toISOString();
        saveProjects(projects);
        return { success: true, added, updated, total: vaultTasks.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// v5.3 新機能: ダッシュボードウィジェット用データ
// ======================================================
ipcMain.handle('get-dashboard-widget-data', async () => {
    try {
        const vaultPath = getCurrentVault();
        const today = new Date().toISOString().slice(0, 10);
        const projects = getProjects();

        // プロジェクト統計
        const activeProjects = projects.filter(p => p.status === 'active');
        const projectStats = activeProjects.slice(0, 5).map(p => {
            const done = (p.tasks || []).filter(t => t.done).length;
            const total = (p.tasks || []).length;
            const progress = total > 0 ? Math.round(done / total * 100) : 0;
            return { id: p.id, name: p.name, progress, done, total, color: p.color || '#6366f1' };
        });

        // 今日のタスク（Vaultタスク）
        let todayTaskCount = 0;
        let overdueCount = 0;
        if (vaultPath) {
            const { getAllTasksFromVault } = (() => {
                // 簡易タスク集計（既存ロジックと同様）
                const mdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
                let today_count = 0;
                let overdue_count = 0;
                for (const f of mdFiles.slice(0, 200)) {
                    try {
                        const lines = fs.readFileSync(f, 'utf-8').split('\n');
                        for (const line of lines) {
                            const m = line.match(/^- \[[ ]\] .+ 📅 (\d{4}-\d{2}-\d{2})/);
                            if (!m) continue;
                            if (m[1] === today) today_count++;
                            else if (m[1] < today) overdue_count++;
                        }
                    } catch (_) {}
                }
                return { getAllTasksFromVault: () => ({ today: today_count, overdue: overdue_count }) };
            })();
            const counts = getAllTasksFromVault();
            todayTaskCount = counts.today;
            overdueCount = counts.overdue;
        }

        return { success: true, projectStats, todayTaskCount, overdueCount, activeProjectCount: activeProjects.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// v5.3 新機能: スマートルールスケジュール（ルール単位）
// ======================================================
ipcMain.handle('set-smart-rule-schedule', (_, { ruleId, schedule }) => {
    try {
        if (!['off', 'daily', 'weekly', 'monthly'].includes(schedule)) {
            return { success: false, error: '無効なスケジュール値' };
        }
        const rules = config.smartRules || [];
        const rule = rules.find(r => r.id === ruleId);
        if (!rule) return { success: false, error: 'ルールが見つかりません' };
        rule.schedule = schedule;
        saveConfig(config);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ライセンス認証・アップデートチェック → src/handlers/license.handler.js に移動済み
require('./src/handlers/license.handler').register(ipcMain, {
    getConfig: () => config,
    saveConfig,
    isValidLicenseKey,
    generateLicenseKey,
    fetchJson,
    APP_VERSION,
    GITHUB_RELEASES_URL,
    compareVersions,
});

// ======================================================
// アップデート直接ダウンロード（進捗イベント付き）
// ======================================================
ipcMain.handle('download-update', async (event, { url, fileName }) => {
    const https = require('https');
    const http  = require('http');
    const dest  = path.join(os.tmpdir(), fileName);

    return new Promise((resolve) => {
        const download = (downloadUrl) => {
            const proto = downloadUrl.startsWith('https') ? https : http;
            proto.get(downloadUrl, (res) => {
                // リダイレクト追従
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return download(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    return resolve({ success: false, error: `HTTP ${res.statusCode}` });
                }
                const total = parseInt(res.headers['content-length'] || '0', 10);
                let received = 0;
                const file = fs.createWriteStream(dest);
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (total > 0) {
                        const pct = Math.round(received / total * 100);
                        try { event.sender.send('update-download-progress', { pct, received, total }); } catch (_) {}
                    }
                });
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve({ success: true, filePath: dest }); });
                file.on('error', (e) => resolve({ success: false, error: e.message }));
            }).on('error', (e) => resolve({ success: false, error: e.message }));
        };
        download(url);
    });
});

// ダウンロード済みインストーラーを開く
ipcMain.handle('open-installer', async (_, filePath) => {
    const { shell } = require('electron');
    await shell.openPath(filePath);
    return { success: true };
});

// ======================================================
// クラッシュレポート / ログ (electron-log)
// ======================================================
ipcMain.handle('get-log-path', () => {
    return { path: log.transports.file.getFile().path };
});

ipcMain.handle('get-log-content', () => {
    try {
        const logPath = log.transports.file.getFile().path;
        if (!fs.existsSync(logPath)) return { content: '（ログファイルがまだ作成されていません）' };
        const raw = fs.readFileSync(logPath, 'utf-8');
        // 最新200行のみ返す
        const lines = raw.split('\n');
        return { content: lines.slice(-200).join('\n') };
    } catch (e) {
        return { content: 'ログ読み込みエラー: ' + e.message };
    }
});

ipcMain.handle('open-log-file', async () => {
    const logPath = log.transports.file.getFile().path;
    await shell.openPath(path.dirname(logPath));
    return { success: true };
});

// レンダラーからのエラーをメインプロセスのログに記録
ipcMain.on('renderer-error', (_, { message, stack }) => {
    log.error('[Renderer]', message, stack || '');
});

// インストール完了後の再起動
ipcMain.handle('relaunch-app', () => {
    app.relaunch();
    app.exit(0);
});

// ======================================================
// Feature 3: スキャンデータエクスポート（CSV/JSON）
// ======================================================
ipcMain.handle('export-scan-data', async (event, { format }) => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };

        const snapshotPath = path.join(os.homedir(), '.obsidian-optimizer-last-scan.json');
        if (!fs.existsSync(snapshotPath)) {
            return { success: false, error: 'スキャンデータがありません。先にスキャンを実行してください。' };
        }
        const scanDataRaw = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));

        const ext = format === 'json' ? 'json' : 'csv';
        const filterName = format === 'json' ? 'JSON' : 'CSV';
        const win = getWin(event);
        const result = await dialog.showSaveDialog(win, {
            title: 'スキャンデータをエクスポート',
            defaultPath: path.join(vaultPath, `vault-scan-data.${ext}`),
            filters: [{ name: filterName, extensions: [ext] }],
        });
        if (result.canceled) return { success: false, canceled: true };

        let output;
        if (format === 'json') {
            output = JSON.stringify(scanDataRaw, null, 2);
        } else {
            const rows = [['カテゴリ', 'ファイルパス', '詳細']];
            const addRows = (category, list, detailFn) => {
                if (!list) return;
                for (const item of list) {
                    const filePath = typeof item === 'string' ? item : (item.file || item.path || item.name || '');
                    const detail = detailFn ? detailFn(item) : '';
                    rows.push([category, filePath, detail]);
                }
            };
            addRows('孤立ノート', scanDataRaw.orphanList);
            addRows('ゴミファイル', scanDataRaw.junkList);
            addRows('放置ノート', scanDataRaw.staleList, item => typeof item === 'object' ? `${item.days || ''}日` : '');
            addRows('壊れたリンク', scanDataRaw.brokenList, item => typeof item === 'object' ? (item.target || '') : '');
            output = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
        }

        fs.writeFileSync(result.filePath, output, 'utf-8');
        return { success: true, path: result.filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 4: テーマ切り替え IPC ハンドラ
// ======================================================
ipcMain.handle('set-app-theme', (_, theme) => {
    const validTheme = theme === 'light' ? 'light' : 'dark';
    config.appTheme = validTheme;
    saveConfig(config);
    nativeTheme.themeSource = validTheme;
    return { success: true, theme: validTheme };
});

// ======================================================
// Feature 5: お気に入りノート
// ======================================================
ipcMain.handle('toggle-favorite', (_, { notePath }) => {
    try {
        if (!notePath) return { success: false, error: 'パスが指定されていません' };
        const idx = config.favorites.indexOf(notePath);
        if (idx >= 0) {
            config.favorites.splice(idx, 1);
        } else {
            config.favorites.push(notePath);
        }
        saveConfig(config);
        return { success: true, favorites: config.favorites };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-favorites', () => {
    try {
        const vaultPath = getCurrentVault();
        const favorites = (config.favorites || []).filter(f => fs.existsSync(f));
        const result = favorites.map(f => ({
            path: f,
            name: path.basename(f, '.md'),
            folder: vaultPath ? path.dirname(path.relative(vaultPath, f)) : path.dirname(f),
        }));
        return { success: true, favorites: result };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('select-favorite-note', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const result = await dialog.showOpenDialog({
            title: 'お気に入りに追加するノートを選択',
            defaultPath: vaultPath,
            filters: [{ name: 'Markdown', extensions: ['md'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths[0]) return { success: false, error: 'キャンセルされました' };
        const selected = result.filePaths[0];
        if (!selected.endsWith('.md')) return { success: false, error: 'Markdownファイルを選択してください' };
        // お気に入りに追加
        if (!config.favorites.includes(selected)) {
            config.favorites.push(selected);
            saveConfig(config);
        }
        return { success: true, path: selected, name: path.basename(selected, '.md') };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('open-favorite', (_, filePath) => {
    try {
        if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const vaultPath = getCurrentVault();
        if (vaultPath) {
            const relPath = path.relative(vaultPath, filePath).replace(/\.md$/, '');
            const vaultName = path.basename(vaultPath);
            const obsidianUri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relPath)}`;
            shell.openExternal(obsidianUri);
        } else {
            shell.openPath(filePath);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 6: Vault間ノート操作
// ======================================================
ipcMain.handle('get-vault-list', () => {
    try {
        const vaults = (config.vaults || []).map((v, i) => {
            let noteCount = 0;
            try {
                if (fs.existsSync(v)) {
                    noteCount = getFilesRecursively(v).filter(f => f.endsWith('.md')).length;
                }
            } catch (_) { /* ignore */ }
            return { path: v, name: path.basename(v), index: i, noteCount };
        });
        return { success: true, vaults };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('copy-note-to-vault', (_, { sourcePath, targetVaultPath }) => {
    try {
        if (!sourcePath || !fs.existsSync(sourcePath)) return { success: false, error: 'ソースファイルが見つかりません' };
        if (!targetVaultPath || !fs.existsSync(targetVaultPath)) return { success: false, error: 'ターゲットVaultが見つかりません' };

        const inboxPath = path.join(targetVaultPath, '00 Inbox');
        if (!fs.existsSync(inboxPath)) {
            fs.mkdirSync(inboxPath, { recursive: true });
        }

        const fileName = path.basename(sourcePath);
        let destPath = path.join(inboxPath, fileName);

        // 同名ファイルが存在する場合はタイムスタンプサフィックスを付与
        if (fs.existsSync(destPath)) {
            const ext = path.extname(fileName);
            const base = path.basename(fileName, ext);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            destPath = path.join(inboxPath, `${base}_${timestamp}${ext}`);
        }

        fs.copyFileSync(sourcePath, destPath);
        return { success: true, destPath, fileName: path.basename(destPath) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('compare-vaults', () => {
    try {
        if (!config.vaults || config.vaults.length < 2) {
            return { success: false, error: '比較には2つ以上のVaultが必要です' };
        }

        const vaultStats = config.vaults.map(v => {
            const files = fs.existsSync(v) ? getFilesRecursively(v).filter(f => f.endsWith('.md')) : [];
            const tags = new Set();
            const noteNames = new Set();
            const tagRe = /#([^\s#\[\]]+)/g;

            for (const f of files) {
                noteNames.add(path.basename(f, '.md'));
                try {
                    const content = fs.readFileSync(f, 'utf-8');
                    let match;
                    while ((match = tagRe.exec(content)) !== null) {
                        tags.add(match[1]);
                    }
                } catch (_) { /* ignore */ }
            }

            return {
                path: v,
                name: path.basename(v),
                noteCount: files.length,
                tagCount: tags.size,
                tags: [...tags].slice(0, 50),
                noteNames: [...noteNames],
            };
        });

        // 共通ノート名を検出
        const allNameSets = vaultStats.map(s => new Set(s.noteNames));
        const commonNotes = [];
        if (allNameSets.length >= 2) {
            for (const name of allNameSets[0]) {
                if (allNameSets.slice(1).every(s => s.has(name))) {
                    commonNotes.push(name);
                }
            }
        }

        const stats = vaultStats.map(s => ({ path: s.path, name: s.name, noteCount: s.noteCount, tagCount: s.tagCount, tags: s.tags }));
        return { success: true, vaults: stats, commonNotes: commonNotes.slice(0, 100) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Feature 7: 自動Vaultバックアップスケジュール
// ======================================================
let backupScheduleTimer = null;

function startBackupSchedule() {
    if (backupScheduleTimer) clearInterval(backupScheduleTimer);
    const schedule = config.backupSchedule || 'off';
    if (schedule === 'off') return;

    const DAILY_MS = 24 * 60 * 60 * 1000;
    const WEEKLY_MS = 7 * DAILY_MS;
    const intervalMs = schedule === 'daily' ? DAILY_MS : WEEKLY_MS;

    backupScheduleTimer = setInterval(async () => {
        try {
            await doVaultBackup();
        } catch (e) {
            console.error('自動バックアップ失敗:', e.message);
        }
    }, intervalMs);
}

async function doVaultBackup() {
    const vaultPath = getCurrentVault();
    if (!vaultPath || !fs.existsSync(vaultPath)) {
        return { success: false, error: 'Vaultが見つかりません' };
    }

    const backupBaseDir = path.join(os.homedir(), '.obsidian-optimizer-backups');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const vaultName = path.basename(vaultPath);
    const backupDir = path.join(backupBaseDir, `vault-backup-${vaultName}-${timestamp}`);

    if (!fs.existsSync(backupBaseDir)) fs.mkdirSync(backupBaseDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    const files = getFilesRecursively(vaultPath);
    let copiedCount = 0;

    for (const file of files) {
        try {
            const relPath = path.relative(vaultPath, file);
            const destPath = path.join(backupDir, relPath);
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(file, destPath);
            copiedCount++;
        } catch (_) { /* 個別ファイルのエラーはスキップ */ }
    }

    return { success: true, backupDir, copiedCount, totalFiles: files.length };
}

// set-backup-schedule / run-vault-backup / get-backup-schedule → src/handlers/backup.handler.js 参照

// ======================================================
// v5.0 新機能 IPC ハンドラー群
// ======================================================

// --- 差分スキャンキャッシュ ---
let lastScanCache = { fileHashes: {}, timestamp: 0 };

// Phase 1: 基盤強化 — 差分スキャン
ipcMain.handle('incremental-scan', async (event) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH || !fs.existsSync(VAULT_PATH)) {
        return { success: false, error: 'Vaultが設定されていません' };
    }
    try {
        const sender = event.sender;
        const allFiles = getFilesRecursively(VAULT_PATH);
        const changedFiles = [];
        const newHashes = {};
        let checked = 0;

        for (const file of allFiles) {
            checked++;
            if (checked % 100 === 0) {
                try { sender.send('scan-progress', `差分チェック中: ${checked}/${allFiles.length}`); } catch (_) {}
            }
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            const key = path.relative(VAULT_PATH, file);
            const hash = `${stat.mtimeMs}-${stat.size}`;
            newHashes[key] = hash;
            if (lastScanCache.fileHashes[key] !== hash) {
                changedFiles.push(file);
            }
        }
        // 削除されたファイルの検出
        const deletedFiles = Object.keys(lastScanCache.fileHashes).filter(k => !newHashes[k]);

        lastScanCache = { fileHashes: newHashes, timestamp: Date.now() };

        // 変更・新規ファイルのみスキャンし、フルスキャンと同じstats構造を返す
        if (changedFiles.length === 0 && deletedFiles.length === 0) {
            return { success: true, noChanges: true, message: '前回スキャンから変更はありません' };
        }

        // 変更があった場合はフルスキャンを実行（差分情報付き）
        const result = await doScanVault(sender);
        if (result.success) {
            result.incrementalInfo = {
                changedFiles: changedFiles.length,
                deletedFiles: deletedFiles.length,
                totalFiles: allFiles.length,
            };
        }
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Phase 1: フォーカスモード（特定フォルダのみスキャン）
ipcMain.handle('focus-scan', async (event, folderPath) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    const targetPath = path.isAbsolute(folderPath) ? folderPath : path.join(VAULT_PATH, folderPath);
    if (!fs.existsSync(targetPath)) return { success: false, error: `フォルダが見つかりません: ${folderPath}` };
    if (!targetPath.startsWith(VAULT_PATH)) return { success: false, error: 'Vault外のフォルダは指定できません' };

    try {
        const sender = event.sender;
        const stats = {
            orphanNotes: 0, junkFiles: 0, totalFilesScanned: 0, totalMDFiles: 0, mocsCount: 0,
            folderStructure: {}, orphanList: [], junkList: [], duplicateList: [],
            brokenLinkList: [], brokenLinksCount: 0,
            tagStats: {}, topTags: [], rareTags: [], totalWords: 0, totalLinks: 0,
            staleList: [], heatmap: {},
            orphanImages: [], orphanImageCount: 0, totalImages: 0,
            focusFolder: path.relative(VAULT_PATH, targetPath),
        };

        const files = getFilesRecursively(targetPath);
        const links = {};
        const allFiles = {};
        const junkRules = config.junkRules || DEFAULT_JUNK_RULES;
        const nowMs = Date.now();
        const staleLimitMs = (config.staleDays ?? 180) * 24 * 60 * 60 * 1000;
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.pdf', '.mp4', '.mp3']);
        const folderName = path.relative(VAULT_PATH, targetPath) || '(root)';

        for (const file of files) {
            stats.totalFilesScanned++;
            const ext = path.extname(file).toLowerCase();
            if (IMAGE_EXTENSIONS.has(ext)) { stats.totalImages++; continue; }
            if (!file.endsWith('.md')) continue;
            stats.totalMDFiles++;
            if (!stats.folderStructure[folderName]) stats.folderStructure[folderName] = 0;
            stats.folderStructure[folderName]++;

            const basename = path.basename(file, '.md');
            allFiles[basename] = file;
            let fileStat;
            try { fileStat = fs.statSync(file); } catch (_) { continue; }

            const dKey = new Date(fileStat.mtimeMs).toISOString().split('T')[0];
            stats.heatmap[dKey] = (stats.heatmap[dKey] || 0) + 1;

            if (nowMs - fileStat.mtimeMs > staleLimitMs) {
                stats.staleList.push({ name: basename, path: file, days: Math.floor((nowMs - fileStat.mtimeMs) / 86400000), size: fileStat.size });
            }

            try { sender.send('scan-progress', `フォーカススキャン: ${basename.slice(0, 50)}`); } catch (_) {}

            const content = await safeReadFile(file);
            if (content === null) continue;

            links[basename] = [];
            let m;
            const lr = new RegExp(LINK_RE.source, 'g');
            while ((m = lr.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest) { links[basename].push(dest); stats.totalLinks++; }
            }

            if (basename.includes('MOC') || basename.startsWith('_MOC')) stats.mocsCount++;

            const junkResult = isJunkFile(file, content, junkRules);
            if (junkResult.junk) {
                stats.junkFiles++;
                stats.junkList.push({ name: basename, path: file, reason: junkResult.reason, size: fileStat.size });
            }
        }

        // 壊れたリンク検出（フォーカス範囲内）
        const allFileNames = Object.keys(allFiles);
        for (const src in links) {
            for (const dest of links[src]) {
                if (allFiles[dest] || allFiles[path.basename(dest).replace(/\.md$/, '')]) continue;
                const suggestions = findBestMatches(path.basename(dest).replace(/\.md$/, ''), allFileNames);
                stats.brokenLinkList.push({ src, dest, suggestions, srcFile: allFiles[src] });
            }
        }
        stats.brokenLinksCount = stats.brokenLinkList.length;

        // 孤立ノート
        const incoming = {};
        for (const f in allFiles) incoming[f] = 0;
        for (const src in links) { for (const dest of links[src]) { if (incoming[dest] !== undefined) incoming[dest]++; } }
        for (const f in allFiles) {
            if ((links[f] || []).length === 0 && incoming[f] === 0) {
                stats.orphanNotes++;
                stats.orphanList.push({ name: path.basename(allFiles[f], '.md'), path: allFiles[f] });
            }
        }

        const tagEntries = Object.entries(stats.tagStats).sort((a, b) => b[1] - a[1]);
        stats.topTags = tagEntries.slice(0, 15).map(([tag, count]) => ({ tag, count }));

        return { success: true, stats };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Phase 1: 同期コンフリクト検出
ipcMain.handle('detect-sync-conflicts', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH);
        const conflicts = [];
        // Obsidian Syncの競合ファイルパターン
        const conflictPatterns = [
            /\s+\d{4}-\d{2}-\d{2}\s+\d{2}\.\d{2}\.\d{2}/, // タイムスタンプ付き
            / conflict /i,
            / \(conflict\)/i,
            /-conflict-/,
            / copy \d+/i,
        ];
        // iCloudの重複パターン
        const icloudDupePattern = / \d+\.\w+$/;

        for (const file of allFiles) {
            const basename = path.basename(file);
            for (const pattern of conflictPatterns) {
                if (pattern.test(basename)) {
                    // 元ファイルを推測
                    let originalName = basename;
                    for (const p of conflictPatterns) { originalName = originalName.replace(p, ''); }
                    const ext = path.extname(file);
                    if (!originalName.endsWith(ext)) originalName += ext;
                    const originalPath = path.join(path.dirname(file), originalName);
                    let stat;
                    try { stat = fs.statSync(file); } catch (_) { continue; }
                    conflicts.push({
                        conflictFile: file,
                        originalFile: fs.existsSync(originalPath) ? originalPath : null,
                        basename: basename,
                        originalName,
                        size: stat.size,
                        modified: stat.mtimeMs,
                        type: 'sync-conflict',
                    });
                    break;
                }
            }
            if (icloudDupePattern.test(path.basename(file, path.extname(file)))) {
                let stat;
                try { stat = fs.statSync(file); } catch (_) { continue; }
                conflicts.push({
                    conflictFile: file,
                    originalFile: null,
                    basename,
                    size: stat.size,
                    modified: stat.mtimeMs,
                    type: 'icloud-duplicate',
                });
            }
        }
        return { success: true, conflicts, count: conflicts.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('resolve-sync-conflict', async (_, { conflictFile, action, keepFile }) => {
    if (!isPathInsideVault(conflictFile)) return { success: false, error: 'Vault外のファイルです' };
    try {
        if (action === 'delete') {
            if (fs.existsSync(conflictFile)) fs.unlinkSync(conflictFile);
            return { success: true, action: 'deleted' };
        } else if (action === 'keep' && keepFile) {
            // keepFile以外を削除
            if (fs.existsSync(conflictFile) && conflictFile !== keepFile) {
                fs.unlinkSync(conflictFile);
            }
            return { success: true, action: 'kept', file: keepFile };
        }
        return { success: false, error: '不明なアクション' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Phase 2: 壊れたリンク機能の大幅強化
// ======================================================

// リンク修復履歴の管理
let linkFixHistory = [];

// 外部URLリンク腐食チェック
ipcMain.handle('check-external-urls', async (event) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const sender = event.sender;
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const urlRegex = /https?:\/\/[^\s\)\]"'<>]+/g;
        const results = [];
        let checked = 0;
        const urlCache = {};

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const urls = content.match(urlRegex) || [];
            for (const url of [...new Set(urls)]) {
                checked++;
                if (checked % 5 === 0) {
                    try { sender.send('external-url-progress', { checked, url: url.slice(0, 60) }); } catch (_) {}
                }
                if (urlCache[url] !== undefined) {
                    if (urlCache[url] !== 200) {
                        results.push({ file: path.relative(VAULT_PATH, file), url, status: urlCache[url], basename: path.basename(file, '.md') });
                    }
                    continue;
                }
                try {
                    const status = await new Promise((resolve) => {
                        const timer = setTimeout(() => resolve(0), 8000);
                        const req = https.get(url, { headers: { 'User-Agent': 'ObsidianOptimizer/5.0' }, timeout: 7000 }, (res) => {
                            clearTimeout(timer);
                            resolve(res.statusCode);
                            res.resume();
                        });
                        req.on('error', () => { clearTimeout(timer); resolve(-1); });
                        req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve(0); });
                    });
                    urlCache[url] = status;
                    if (status !== 200 && status !== 301 && status !== 302) {
                        results.push({ file: path.relative(VAULT_PATH, file), url, status, basename: path.basename(file, '.md') });
                    }
                } catch (_) {
                    urlCache[url] = -1;
                    results.push({ file: path.relative(VAULT_PATH, file), url, status: -1, basename: path.basename(file, '.md') });
                }
            }
        }
        return { success: true, results, totalChecked: checked };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ヘッディングリンク検証: [[note#heading]] のアンカー検証
ipcMain.handle('check-heading-links', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const fileMap = {};
        const headingMap = {};
        for (const file of allFiles) {
            const basename = path.basename(file, '.md');
            fileMap[basename] = file;
            const content = await safeReadFile(file);
            if (!content) continue;
            const headings = [];
            for (const line of content.split('\n')) {
                const match = line.match(/^#{1,6}\s+(.+)/);
                if (match) headings.push(match[1].trim());
            }
            headingMap[basename] = headings;
        }

        const brokenHeadingLinks = [];
        const headingLinkRe = /\[\[([^\]#|]+)#([^\]|]+)(?:\|[^\]]+)?\]\]/g;

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            let m;
            const re = new RegExp(headingLinkRe.source, 'g');
            while ((m = re.exec(content)) !== null) {
                const targetNote = m[1].trim();
                const targetHeading = m[2].trim();
                const targetFile = fileMap[targetNote] || fileMap[path.basename(targetNote)];
                if (!targetFile) {
                    brokenHeadingLinks.push({ src: basename, srcFile: file, dest: targetNote, heading: targetHeading, reason: 'ノートが見つかりません' });
                    continue;
                }
                const headings = headingMap[path.basename(targetFile, '.md')] || [];
                // Obsidianの見出しリンク正規化: スペース→スペース、大文字小文字は保持
                const normalizedTarget = targetHeading.toLowerCase().replace(/\s+/g, ' ');
                const found = headings.some(h => h.toLowerCase().replace(/\s+/g, ' ') === normalizedTarget);
                if (!found) {
                    brokenHeadingLinks.push({
                        src: basename, srcFile: file, dest: targetNote, heading: targetHeading,
                        reason: '見出しが見つかりません',
                        availableHeadings: headings.slice(0, 10),
                    });
                }
            }
        }
        return { success: true, brokenHeadingLinks, count: brokenHeadingLinks.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ブロック参照検証: [[note^block-id]]
ipcMain.handle('check-block-ref-links', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const fileMap = {};
        const blockIdMap = {};
        for (const file of allFiles) {
            const basename = path.basename(file, '.md');
            fileMap[basename] = file;
            const content = await safeReadFile(file);
            if (!content) continue;
            const blockIds = [];
            const blockRe = /\^([a-zA-Z0-9-]+)\s*$/gm;
            let bm;
            while ((bm = blockRe.exec(content)) !== null) { blockIds.push(bm[1]); }
            blockIdMap[basename] = blockIds;
        }

        const brokenBlockRefs = [];
        const blockRefRe = /\[\[([^\]#|]+)\^([^\]|]+)(?:\|[^\]]+)?\]\]/g;

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            let m;
            const re = new RegExp(blockRefRe.source, 'g');
            while ((m = re.exec(content)) !== null) {
                const targetNote = m[1].trim();
                const blockId = m[2].trim();
                const targetFile = fileMap[targetNote] || fileMap[path.basename(targetNote)];
                if (!targetFile) {
                    brokenBlockRefs.push({ src: basename, srcFile: file, dest: targetNote, blockId, reason: 'ノートが見つかりません' });
                    continue;
                }
                const blockIds = blockIdMap[path.basename(targetFile, '.md')] || [];
                if (!blockIds.includes(blockId)) {
                    brokenBlockRefs.push({ src: basename, srcFile: file, dest: targetNote, blockId, reason: 'ブロックIDが見つかりません' });
                }
            }
        }
        return { success: true, brokenBlockRefs, count: brokenBlockRefs.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 埋め込みリンク検証: ![[...]]
ipcMain.handle('check-embed-links', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH);
        const fileNames = new Set(allFiles.map(f => path.basename(f)));
        const mdFiles = allFiles.filter(f => f.endsWith('.md'));
        const brokenEmbeds = [];
        const embedRe = /!\[\[([^\]]+)\]\]/g;

        for (const file of mdFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            let m;
            const re = new RegExp(embedRe.source, 'g');
            while ((m = re.exec(content)) !== null) {
                const ref = m[1].split('|')[0].split('#')[0].split('^')[0].trim();
                const refBasename = path.basename(ref);
                // ファイル名一致チェック（拡張子付き・なし両方）
                const found = fileNames.has(refBasename) || fileNames.has(refBasename + '.md') || fileNames.has(ref);
                if (!found) {
                    brokenEmbeds.push({ src: basename, srcFile: file, embed: ref, fullMatch: m[0] });
                }
            }
        }
        return { success: true, brokenEmbeds, count: brokenEmbeds.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リネーム追跡: Git履歴 or ファイルシステム変更から推測
ipcMain.handle('track-renames', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const renames = [];
        // .obsidian/plugins/obsidian-optimizer/rename-log.json があれば読む
        const renameLogPath = path.join(VAULT_PATH, '.obsidian', 'plugins', 'obsidian-optimizer', 'rename-log.json');
        if (fs.existsSync(renameLogPath)) {
            try {
                const log = JSON.parse(fs.readFileSync(renameLogPath, 'utf-8'));
                renames.push(...(log.renames || []));
            } catch (_) {}
        }
        // Git履歴からリネームを検出 (非同期で実行してメインプロセスをブロックしない)
        const gitDir = path.join(VAULT_PATH, '.git');
        if (fs.existsSync(gitDir)) {
            try {
                const { execFile: ef } = require('child_process');
                const { promisify: pfy } = require('util');
                const efAsync = pfy(ef);
                const { stdout: gitLog } = await efAsync('git',
                    ['log', '--diff-filter=R', '--name-status', '-n', '50', '--format='],
                    { cwd: VAULT_PATH, encoding: 'utf-8', timeout: 10000 }
                );
                for (const line of gitLog.split('\n')) {
                    const parts = line.split('\t');
                    if (parts.length >= 3 && parts[0].startsWith('R')) {
                        renames.push({ from: parts[1], to: parts[2], source: 'git' });
                    }
                }
            } catch (_) { /* gitが使えなくてもエラーにしない */ }
        }
        return { success: true, renames, count: renames.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リネームに基づくリンク自動修復
ipcMain.handle('auto-fix-renamed-links', async (_, { oldName, newName }) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        let fixedCount = 0;
        const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, 'g');

        for (const file of allFiles) {
            let content = fs.readFileSync(file, 'utf-8');
            const newContent = content.replace(re, (match, alias) => {
                fixedCount++;
                return alias ? `[[${newName}${alias}]]` : `[[${newName}]]`;
            });
            if (newContent !== content) {
                fs.writeFileSync(file, newContent, 'utf-8');
            }
        }

        linkFixHistory.push({ type: 'rename-fix', oldName, newName, fixedCount, timestamp: Date.now(), id: crypto.randomUUID() });
        return { success: true, fixedCount };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リンク先プレビュー
ipcMain.handle('preview-link-target', async (_, filePath) => {
    try {
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = await safeReadFile(filePath);
        if (!content) return { success: false, error: 'ファイルを読み込めません' };
        // 先頭500文字をプレビュー
        return { success: true, preview: content.slice(0, 500), fullLength: content.length, basename: path.basename(filePath, '.md') };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リアルタイム壊れたリンク防止（Vault Watcher連携）
ipcMain.handle('prevent-broken-links', async (_, { filePath, action }) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        if (action === 'check-before-delete' || action === 'check-before-rename') {
            const basename = path.basename(filePath, '.md');
            const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
            const referencingFiles = [];
            const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\[\\[${escaped}(#[^\\]]*|\\^[^\\]]*|\\|[^\\]]*)?\\]\\]`, 'g');

            for (const file of allFiles) {
                if (file === filePath) continue;
                const content = await safeReadFile(file);
                if (!content) continue;
                if (re.test(content)) {
                    referencingFiles.push({ path: file, basename: path.basename(file, '.md') });
                }
                re.lastIndex = 0;
            }
            return { success: true, referencingFiles, count: referencingFiles.length, willBreak: referencingFiles.length > 0 };
        }
        return { success: false, error: '不明なアクション' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リンクヘルス履歴
ipcMain.handle('get-link-health-history', async () => {
    try {
        const historyPath = path.join(os.homedir(), '.obsidian-optimizer-link-health.json');
        if (fs.existsSync(historyPath)) {
            const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            return { success: true, history };
        }
        return { success: true, history: [] };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 一括リンク置換
ipcMain.handle('bulk-replace-links', async (_, { oldTarget, newTarget }) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        let totalFixed = 0;
        const escaped = oldTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        for (const file of allFiles) {
            let content = fs.readFileSync(file, 'utf-8');
            // エイリアス付き
            const aliasRe = new RegExp(`\\[\\[${escaped}\\|([^\\]]+)\\]\\]`, 'g');
            let newContent = content.replace(aliasRe, (_, alias) => { totalFixed++; return `[[${newTarget}|${alias}]]`; });
            // 通常リンク
            const exactRe = new RegExp(`\\[\\[${escaped}\\]\\]`, 'g');
            newContent = newContent.replace(exactRe, () => { totalFixed++; return `[[${newTarget}]]`; });
            if (newContent !== content) {
                fs.writeFileSync(file, newContent, 'utf-8');
            }
        }

        const operationId = crypto.randomUUID();
        linkFixHistory.push({ id: operationId, type: 'bulk-replace', oldTarget, newTarget, fixedCount: totalFixed, timestamp: Date.now() });
        return { success: true, fixedCount: totalFixed, operationId };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リンク修復Undo
ipcMain.handle('undo-link-fix', async (_, operationId) => {
    const op = linkFixHistory.find(h => h.id === operationId);
    if (!op) return { success: false, error: '操作が見つかりません' };
    // 逆方向に置換
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        if (op.type === 'bulk-replace' || op.type === 'rename-fix') {
            const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
            let reverted = 0;
            const escaped = (op.newTarget || op.newName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const oldVal = op.oldTarget || op.oldName;
            for (const file of allFiles) {
                let content = fs.readFileSync(file, 'utf-8');
                const re = new RegExp(`\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, 'g');
                const newContent = content.replace(re, (_, alias) => {
                    reverted++;
                    return alias ? `[[${oldVal}${alias}]]` : `[[${oldVal}]]`;
                });
                if (newContent !== content) fs.writeFileSync(file, newContent, 'utf-8');
            }
            linkFixHistory = linkFixHistory.filter(h => h.id !== operationId);
            return { success: true, reverted };
        }
        return { success: false, error: 'この操作タイプはUndoできません' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リンク修復履歴取得
ipcMain.handle('get-link-fix-history', () => {
    return { success: true, history: linkFixHistory };
});

// ======================================================
// Phase 3: AI次世代化
// ======================================================

// ローカルLLM設定
ipcMain.handle('configure-local-llm', async (_, params) => {
    try {
        config.localLlm = {
            enabled: params.enabled || false,
            endpoint: params.endpoint || 'http://localhost:11434',
            model: params.model || 'llama3.2',
            provider: params.provider || 'ollama', // ollama | lm-studio
        };
        saveConfig(config);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('test-local-llm', async () => {
    try {
        const llmConfig = config.localLlm || {};
        const endpoint = llmConfig.endpoint || 'http://localhost:11434';
        const provider = llmConfig.provider || 'ollama';

        let testUrl;
        if (provider === 'ollama') {
            testUrl = `${endpoint}/api/tags`;
        } else {
            testUrl = `${endpoint}/v1/models`;
        }

        const http = require('http');
        const result = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ success: false, error: 'タイムアウト' }), 5000);
            const req = http.get(testUrl, (res) => {
                clearTimeout(timer);
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const models = provider === 'ollama' ? (json.models || []).map(m => m.name) : (json.data || []).map(m => m.id);
                        resolve({ success: true, models, provider });
                    } catch (_) {
                        resolve({ success: true, models: [], provider });
                    }
                });
            });
            req.on('error', (e) => { clearTimeout(timer); resolve({ success: false, error: e.message }); });
        });
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// AI用共通ヘルパー: ローカルLLMまたはクラウドAPIを使用
async function callAI(prompt, systemPrompt, options = {}) {
    const llmConfig = config.localLlm || {};
    // ローカルLLMが有効な場合
    if (llmConfig.enabled && llmConfig.endpoint) {
        const http = require('http');
        const provider = llmConfig.provider || 'ollama';
        let url, body;
        if (provider === 'ollama') {
            url = `${llmConfig.endpoint}/api/generate`;
            body = JSON.stringify({ model: llmConfig.model || 'llama3.2', prompt: `${systemPrompt}\n\n${prompt}`, stream: false });
        } else {
            url = `${llmConfig.endpoint}/v1/chat/completions`;
            body = JSON.stringify({ model: llmConfig.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], max_tokens: options.maxTokens || 2000 });
        }

        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const req = http.request({ hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const text = provider === 'ollama' ? json.response : json.choices[0].message.content;
                        resolve(text);
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(60000, () => { req.destroy(); reject(new Error('タイムアウト')); });
            req.write(body);
            req.end();
        });
    }

    // クラウドAPI（既存のAI設定を使用）
    const aiProvider = config.aiProvider || 'claude';
    const apiKey = config.aiApiKey;
    if (!apiKey) throw new Error('APIキーが設定されていません。設定画面でAPIキーを入力するか、ローカルLLM（Ollama等）を有効にしてください。');

    if (aiProvider === 'claude') {
        const body = JSON.stringify({ model: config.aiModel || 'claude-sonnet-4-6', max_tokens: options.maxTokens || 2000, system: systemPrompt, messages: [{ role: 'user', content: prompt }] });
        return new Promise((resolve, reject) => {
            const req = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try { const json = JSON.parse(data); resolve(json.content[0].text); } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(60000, () => { req.destroy(); reject(new Error('タイムアウト')); });
            req.write(body);
            req.end();
        });
    } else if (aiProvider === 'openai') {
        const body = JSON.stringify({ model: config.aiModel || 'gpt-4o', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], max_tokens: options.maxTokens || 2000 });
        return new Promise((resolve, reject) => {
            const req = https.request({ hostname: 'api.openai.com', path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` } }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try { const json = JSON.parse(data); resolve(json.choices[0].message.content); } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(60000, () => { req.destroy(); reject(new Error('タイムアウト')); });
            req.write(body);
            req.end();
        });
    } else if (aiProvider === 'gemini') {
        const model = config.aiModel || 'gemini-2.0-flash';
        const geminiUrl = `/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const body = JSON.stringify({ contents: [{ parts: [{ text: `${systemPrompt}\n\n${prompt}` }] }], generationConfig: { maxOutputTokens: options.maxTokens || 2000 } });
        return new Promise((resolve, reject) => {
            const req = https.request({ hostname: 'generativelanguage.googleapis.com', path: geminiUrl, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.candidates && json.candidates[0]) {
                            resolve(json.candidates[0].content.parts[0].text);
                        } else if (json.error) {
                            reject(new Error(`Gemini API エラー: ${json.error.message || JSON.stringify(json.error)}`));
                        } else {
                            reject(new Error('Gemini API: 予期しないレスポンス形式'));
                        }
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.setTimeout(60000, () => { req.destroy(); reject(new Error('タイムアウト')); });
            req.write(body);
            req.end();
        });
    }
    throw new Error(`未対応のAIプロバイダー "${aiProvider}" です。設定画面でClaude / OpenAI / Geminiのいずれかを選択してください。`);
}

// RAG対応 Vault Q&A
ipcMain.handle('build-vault-index', async (event) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const sender = event.sender;
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const index = [];
        let processed = 0;
        for (const file of allFiles) {
            processed++;
            if (processed % 50 === 0) { try { sender.send('index-progress', { processed, total: allFiles.length }); } catch (_) {} }
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            // チャンク分割（500文字ずつ、100文字オーバーラップ）
            const cleanContent = content.replace(/^\s*---\n[\s\S]*?\n---/, '').trim();
            const chunkSize = 500;
            const overlap = 100;
            for (let i = 0; i < cleanContent.length; i += chunkSize - overlap) {
                index.push({ file: path.relative(VAULT_PATH, file), basename, chunk: cleanContent.slice(i, i + chunkSize), offset: i });
            }
        }
        // インデックスをファイルに保存
        const indexPath = path.join(os.homedir(), '.obsidian-optimizer-vault-index.json');
        fs.writeFileSync(indexPath, JSON.stringify({ timestamp: Date.now(), vaultPath: VAULT_PATH, chunks: index }), 'utf-8');
        return { success: true, totalChunks: index.length, totalFiles: allFiles.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('ai-rag-query', async (_, { query }) => {
    try {
        const indexPath = path.join(os.homedir(), '.obsidian-optimizer-vault-index.json');
        if (!fs.existsSync(indexPath)) return { success: false, error: 'Vaultインデックスが作成されていません。先にインデックスを構築してください。' };
        const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        // シンプルなキーワードベースの検索（TF-IDFライク）
        const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
        const scored = indexData.chunks.map(chunk => {
            let score = 0;
            const text = chunk.chunk.toLowerCase();
            for (const term of queryTerms) {
                const count = (text.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
                score += count;
            }
            return { ...chunk, score };
        }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);

        if (scored.length === 0) return { success: true, answer: '関連するノートが見つかりませんでした。', sources: [] };

        const context = scored.map(c => `[${c.basename}]: ${c.chunk}`).join('\n\n');
        const answer = await callAI(
            `以下のVaultのコンテンツを参考に、質問に日本語で回答してください。参照元のノート名も示してください。\n\n--- コンテンツ ---\n${context}\n\n--- 質問 ---\n${query}`,
            'あなたはObsidian Vaultのナレッジアシスタントです。Vault内の情報に基づいて正確に回答してください。'
        );
        const sources = [...new Set(scored.map(c => c.basename))];
        return { success: true, answer, sources };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ノート品質コーチ
ipcMain.handle('ai-note-coach', async (_, filePath) => {
    try {
        if (!fs.existsSync(filePath)) return { success: false, error: 'ファイルが見つかりません' };
        const content = fs.readFileSync(filePath, 'utf-8');
        const basename = path.basename(filePath, '.md');
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const links = (content.match(LINK_RE) || []).length;
        const headings = (content.match(/^#{1,6}\s+.+/gm) || []).length;
        const tags = (content.match(/#[\w\u3000-\u9fff]+/g) || []).length;
        const words = content.replace(/^\s*---\n[\s\S]*?\n---/, '').trim().length;

        const feedback = await callAI(
            `以下のObsidianノートを分析し、改善提案をJSON形式で返してください。
ノート名: ${basename}
文字数: ${words}
リンク数: ${links}
見出し数: ${headings}
タグ数: ${tags}

ノート内容（先頭2000文字）:
${content.slice(0, 2000)}

以下のJSON形式で返してください:
{
  "score": 0-100の品質スコア,
  "strengths": ["良い点1", "良い点2"],
  "improvements": ["改善点1", "改善点2", "改善点3"],
  "suggestedLinks": ["リンクすべきトピック1", "トピック2"],
  "suggestedTags": ["tag1", "tag2"],
  "atomicity": "good|needs-split|too-short の判定",
  "summary": "1文の総合評価"
}`,
            'Obsidianノートの品質を評価する専門家として回答してください。JSON形式のみで応答してください。'
        );

        try {
            const jsonMatch = feedback.match(/\{[\s\S]*\}/);
            const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: 50, summary: feedback, improvements: [], strengths: [] };
            return { success: true, feedback: parsed, basename };
        } catch (_) {
            return { success: true, feedback: { score: 50, summary: feedback, improvements: [], strengths: [] }, basename };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 自動要約ダイジェスト
ipcMain.handle('ai-auto-digest', async (_, { period }) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const now = Date.now();
        const periodMs = period === 'weekly' ? 7 * 86400000 : 30 * 86400000;
        const recentFiles = [];
        for (const file of allFiles) {
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            if (now - stat.mtimeMs < periodMs) {
                recentFiles.push({ file, basename: path.basename(file, '.md'), modified: stat.mtimeMs });
            }
        }
        recentFiles.sort((a, b) => b.modified - a.modified);
        const topFiles = recentFiles.slice(0, 30);
        const summaryData = [];
        for (const f of topFiles) {
            const content = await safeReadFile(f.file);
            if (content) summaryData.push(`[${f.basename}]: ${content.slice(0, 200)}`);
        }

        const digest = await callAI(
            `以下はObsidian Vaultの${period === 'weekly' ? '過去1週間' : '過去1ヶ月'}の更新ノート一覧です（${recentFiles.length}件中上位${topFiles.length}件）。
日本語でダイジェストレポートを作成してください。

${summaryData.join('\n')}

以下を含めてください:
1. 主な活動トピック
2. 新しく追加された知識領域
3. 注力していた分野
4. 推奨アクション（リンク追加、MOC作成など）`,
            'Obsidian Vaultのナレッジマネージャーとして、ユーザーの知識活動を分析してください。'
        );
        return { success: true, digest, period, totalUpdated: recentFiles.length, analyzed: topFiles.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// AI知識ギャップ検出
ipcMain.handle('ai-knowledge-gaps', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        // グラフのクラスタ間接続を分析
        const result = await doScanVault(null);
        if (!result.success) return result;
        const tagGroups = {};
        for (const [tag, count] of Object.entries(result.stats.tagStats)) {
            const topLevel = tag.split('/')[0];
            if (!tagGroups[topLevel]) tagGroups[topLevel] = 0;
            tagGroups[topLevel] += count;
        }
        const topTagGroups = Object.entries(tagGroups).sort((a, b) => b[1] - a[1]).slice(0, 20);
        const folderInfo = Object.entries(result.stats.folderStructure).map(([f, c]) => `${f}: ${c}ノート`).join(', ');

        const gaps = await callAI(
            `Obsidian Vaultの構造情報:
- 総ノート数: ${result.stats.totalMDFiles}
- 総リンク数: ${result.stats.totalLinks}
- 孤立ノート: ${result.stats.orphanNotes}
- フォルダ構造: ${folderInfo}
- 主要タグ: ${topTagGroups.map(([t, c]) => `${t}(${c})`).join(', ')}

この情報から知識ギャップを分析し、以下のJSON形式で返してください:
{
  "gaps": [
    {"area": "ギャップのある領域", "description": "説明", "suggestion": "推奨アクション"},
  ],
  "weakConnections": ["接続が弱いトピックペア"],
  "missingBridges": ["橋渡しノートが必要な箇所"]
}`,
            'ナレッジグラフ分析の専門家として回答してください。JSON形式のみで応答してください。'
        );
        try {
            const jsonMatch = gaps.match(/\{[\s\S]*\}/);
            return { success: true, analysis: jsonMatch ? JSON.parse(jsonMatch[0]) : { gaps: [], weakConnections: [], missingBridges: [] } };
        } catch (_) {
            return { success: true, analysis: { gaps: [], weakConnections: [], missingBridges: [], raw: gaps } };
        }
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Phase 4: 高度な分析
// ======================================================

// クラスター自動検出（Louvain法の簡易実装）
ipcMain.handle('detect-clusters', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const nodes = {};
        const edges = [];
        const LINK_RE = /\[\[(.*?)\]\]/g;

        for (const file of allFiles) {
            const basename = path.basename(file, '.md');
            nodes[basename] = { name: basename, file, community: -1 };
            const content = await safeReadFile(file);
            if (!content) continue;
            let m;
            const re = new RegExp(LINK_RE.source, 'g');
            while ((m = re.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest && dest !== basename) edges.push({ from: basename, to: dest });
            }
        }

        // 簡易コミュニティ検出: ラベル伝播法
        const nodeNames = Object.keys(nodes);
        nodeNames.forEach((n, i) => { nodes[n].community = i; });
        const adjacency = {};
        for (const n of nodeNames) adjacency[n] = [];
        for (const e of edges) {
            if (nodes[e.to]) {
                adjacency[e.from] = adjacency[e.from] || [];
                adjacency[e.from].push(e.to);
                adjacency[e.to] = adjacency[e.to] || [];
                adjacency[e.to].push(e.from);
            }
        }

        // 10回イテレーション
        for (let iter = 0; iter < 10; iter++) {
            const shuffled = [...nodeNames].sort(() => Math.random() - 0.5);
            for (const node of shuffled) {
                const neighbors = adjacency[node] || [];
                if (neighbors.length === 0) continue;
                const communityCount = {};
                for (const n of neighbors) {
                    const c = nodes[n].community;
                    communityCount[c] = (communityCount[c] || 0) + 1;
                }
                const bestCommunity = Object.entries(communityCount).sort((a, b) => b[1] - a[1])[0][0];
                nodes[node].community = parseInt(bestCommunity);
            }
        }

        // クラスターにグループ化
        const clusters = {};
        for (const [name, node] of Object.entries(nodes)) {
            const c = node.community;
            if (!clusters[c]) clusters[c] = [];
            clusters[c].push({ name, file: node.file });
        }

        // 小さすぎるクラスター（1ノート）を「その他」にまとめる
        const validClusters = {};
        const miscCluster = [];
        let clusterIndex = 0;
        for (const [, members] of Object.entries(clusters)) {
            if (members.length >= 3) {
                validClusters[clusterIndex++] = members;
            } else {
                miscCluster.push(...members);
            }
        }
        if (miscCluster.length > 0) validClusters['misc'] = miscCluster;

        return { success: true, clusters: validClusters, totalClusters: Object.keys(validClusters).length, totalNodes: nodeNames.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// PageRank計算
ipcMain.handle('calculate-page-rank', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const nodeMap = {};
        const outLinks = {};
        const LINK_RE = /\[\[(.*?)\]\]/g;

        for (const file of allFiles) {
            const basename = path.basename(file, '.md');
            nodeMap[basename] = file;
            const content = await safeReadFile(file);
            if (!content) { outLinks[basename] = []; continue; }
            const links = [];
            let m;
            const re = new RegExp(LINK_RE.source, 'g');
            while ((m = re.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest && dest !== basename && nodeMap[dest] !== undefined) links.push(dest);
            }
            outLinks[basename] = [...new Set(links)];
        }

        // PageRank計算（20回反復）
        const d = 0.85;
        const N = Object.keys(nodeMap).length;
        let ranks = {};
        for (const node of Object.keys(nodeMap)) ranks[node] = 1 / N;

        for (let i = 0; i < 20; i++) {
            const newRanks = {};
            for (const node of Object.keys(nodeMap)) {
                let sum = 0;
                for (const other of Object.keys(nodeMap)) {
                    if (outLinks[other] && outLinks[other].includes(node)) {
                        sum += ranks[other] / (outLinks[other].length || 1);
                    }
                }
                newRanks[node] = (1 - d) / N + d * sum;
            }
            ranks = newRanks;
        }

        const ranked = Object.entries(ranks).sort((a, b) => b[1] - a[1]).map(([name, score], idx) => ({
            rank: idx + 1, name, score: Math.round(score * 10000) / 10000, file: nodeMap[name],
            outLinks: (outLinks[name] || []).length,
        }));

        return { success: true, rankings: ranked.slice(0, 100), totalNodes: N };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// リンク予測
ipcMain.handle('predict-links', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const nodeMap = {};
        const adjacency = {};
        const LINK_RE = /\[\[(.*?)\]\]/g;

        for (const file of allFiles) {
            const basename = path.basename(file, '.md');
            nodeMap[basename] = file;
            adjacency[basename] = new Set();
            const content = await safeReadFile(file);
            if (!content) continue;
            let m;
            const re = new RegExp(LINK_RE.source, 'g');
            while ((m = re.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                if (dest && dest !== basename) adjacency[basename].add(dest);
            }
        }

        // Common Neighbors法: 共通の隣接ノードが多いペアを予測
        const predictions = [];
        const nodes = Object.keys(nodeMap);
        for (let i = 0; i < Math.min(nodes.length, 500); i++) {
            for (let j = i + 1; j < Math.min(nodes.length, 500); j++) {
                const a = nodes[i], b = nodes[j];
                if (adjacency[a].has(b) || adjacency[b].has(a)) continue; // 既にリンク済み
                const commonNeighbors = [...adjacency[a]].filter(n => adjacency[b] && adjacency[b].has(n));
                if (commonNeighbors.length >= 2) {
                    predictions.push({ from: a, to: b, commonNeighbors: commonNeighbors.length, sharedNodes: commonNeighbors.slice(0, 5) });
                }
            }
        }
        predictions.sort((a, b) => b.commonNeighbors - a.commonNeighbors);
        return { success: true, predictions: predictions.slice(0, 50) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// グラフ差分ビュー
ipcMain.handle('get-graph-diff', async (_, { daysAgo }) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const cutoff = Date.now() - (daysAgo || 7) * 86400000;
        const newNotes = [];
        const modifiedNotes = [];
        const LINK_RE = /\[\[(.*?)\]\]/g;
        const newLinks = [];

        for (const file of allFiles) {
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            const basename = path.basename(file, '.md');
            if (stat.birthtimeMs > cutoff) {
                newNotes.push({ name: basename, file, created: stat.birthtimeMs });
                const content = await safeReadFile(file);
                if (content) {
                    let m;
                    const re = new RegExp(LINK_RE.source, 'g');
                    while ((m = re.exec(content)) !== null) {
                        const dest = m[1].split('|')[0].split('#')[0].trim();
                        if (dest) newLinks.push({ from: basename, to: dest });
                    }
                }
            } else if (stat.mtimeMs > cutoff) {
                modifiedNotes.push({ name: basename, file, modified: stat.mtimeMs });
            }
        }
        return { success: true, newNotes, modifiedNotes, newLinks, daysAgo: daysAgo || 7 };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ノート原子性チェック
ipcMain.handle('check-note-atomicity', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const issues = [];
        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            const headings = (content.match(/^#{2}\s+.+/gm) || []);
            const charCount = content.replace(/^\s*---\n[\s\S]*?\n---/, '').trim().length;

            if (headings.length >= 4 && charCount > 3000) {
                issues.push({
                    name: basename, file, charCount, headingCount: headings.length,
                    headings: headings.map(h => h.replace(/^#+\s+/, '')),
                    severity: headings.length >= 7 ? 'high' : headings.length >= 5 ? 'medium' : 'low',
                    suggestion: `${headings.length}個のセクションがあります。各見出しを独立ノートに分割することを検討してください。`,
                });
            }
        }
        issues.sort((a, b) => b.headingCount - a.headingCount);
        return { success: true, issues, count: issues.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// パフォーマンスプロファイラ
ipcMain.handle('profile-vault-performance', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH);
        let totalSize = 0;
        const largeFiles = [];
        const fileTypes = {};
        let obsidianSize = 0;

        for (const file of allFiles) {
            let stat;
            try { stat = fs.statSync(file); } catch (_) { continue; }
            totalSize += stat.size;
            const ext = path.extname(file).toLowerCase() || '(none)';
            fileTypes[ext] = (fileTypes[ext] || 0) + stat.size;

            if (stat.size > 1024 * 1024) { // 1MB以上
                largeFiles.push({ name: path.basename(file), path: file, size: stat.size, ext });
            }
        }

        // .obsidianフォルダサイズ
        const obsidianDir = path.join(VAULT_PATH, '.obsidian');
        if (fs.existsSync(obsidianDir)) {
            const obsFiles = getFilesRecursively(obsidianDir);
            for (const f of obsFiles) {
                try { obsidianSize += fs.statSync(f).size; } catch (_) {}
            }
        }

        largeFiles.sort((a, b) => b.size - a.size);
        const typeEntries = Object.entries(fileTypes).sort((a, b) => b[1] - a[1]);

        // ストレージ予測（過去3ヶ月の成長率から）
        const threeMonthsAgo = Date.now() - 90 * 86400000;
        let recentFilesSize = 0;
        for (const file of allFiles) {
            try {
                const stat = fs.statSync(file);
                if (stat.birthtimeMs > threeMonthsAgo) recentFilesSize += stat.size;
            } catch (_) {}
        }
        const monthlyGrowth = recentFilesSize / 3;

        return {
            success: true,
            totalSize,
            totalFiles: allFiles.length,
            largeFiles: largeFiles.slice(0, 20),
            fileTypeBreakdown: typeEntries.slice(0, 15).map(([ext, size]) => ({ ext, size })),
            obsidianConfigSize: obsidianSize,
            monthlyGrowthEstimate: monthlyGrowth,
            storageWarning: totalSize > 5 * 1024 * 1024 * 1024 ? '5GBを超えています。画像の圧縮を検討してください。' : null,
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Phase 5: ワークフロー自動化
// ======================================================
// スマートルール・スケジュール・復習キュー → src/handlers/smart-rules.handler.js に移動済み
require('./src/handlers/smart-rules.handler').register(ipcMain, {
    getCurrentVault,
    getConfig: () => config,
    saveConfig,
    getFilesRecursively,
    safeReadFile,
    Notification,
});

// ======================================================
// Phase 6: ツール拡充
// ======================================================

// 機密情報スキャナー
ipcMain.handle('scan-secrets', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const findings = [];
        const patterns = [
            { name: 'APIキー (Generic)', regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi, sev: 'critical' },
            { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/g, sev: 'critical' },
            { name: 'GitHub Token', regex: /gh[ps]_[A-Za-z0-9_]{36,}/g, sev: 'critical' },
            { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{20,}/g, sev: 'critical' },
            { name: 'パスワード', regex: /(?:password|passwd|pass)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi, sev: 'critical' },
            { name: 'Slack Token', regex: /xox[bprs]-[0-9A-Za-z-]+/g, sev: 'critical' },
            { name: 'クレジットカード', regex: /(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})/g, sev: 'critical' },
            { name: 'SSH秘密鍵', regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/g, sev: 'critical' },
            { name: 'Bearer Token', regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/g, sev: 'critical' },
        ];

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            for (const pattern of patterns) {
                const re = new RegExp(pattern.regex.source, pattern.regex.flags);
                let match;
                while ((match = re.exec(content)) !== null) {
                    const lineNum = content.slice(0, match.index).split('\n').length;
                    findings.push({
                        file: path.relative(VAULT_PATH, file),
                        basename,
                        type: pattern.name,
                        line: lineNum,
                        // マスキング: 先頭4文字と末尾4文字のみ表示
                        value: match[0].length > 12 ? match[0].slice(0, 4) + '...' + match[0].slice(-4) : '****',
                        severity: pattern.sev || 'critical',
                    });
                }
            }
        }
        return { success: true, findings, count: findings.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 画像圧縮・最適化
ipcMain.handle('optimize-images', async (_, params) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH);
        const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff']);
        const images = allFiles.filter(f => imageExts.has(path.extname(f).toLowerCase()));
        const stats = { totalImages: images.length, totalSize: 0, optimizable: 0, potentialSavings: 0 };
        const results = [];

        for (const img of images) {
            let stat;
            try { stat = fs.statSync(img); } catch (_) { continue; }
            stats.totalSize += stat.size;
            // 100KB以上の画像を最適化候補とする
            if (stat.size > 100 * 1024) {
                stats.optimizable++;
                const estimatedSaving = Math.floor(stat.size * 0.4); // 推定40%削減
                stats.potentialSavings += estimatedSaving;
                results.push({
                    name: path.basename(img),
                    path: img,
                    size: stat.size,
                    ext: path.extname(img).toLowerCase(),
                    estimatedNewSize: stat.size - estimatedSaving,
                });
            }
        }

        // 重複画像検出（MD5ハッシュ）
        const hashMap = {};
        const duplicates = [];
        for (const img of images) {
            try {
                const content = fs.readFileSync(img);
                const hash = crypto.createHash('md5').update(content).digest('hex');
                if (hashMap[hash]) {
                    duplicates.push({ original: hashMap[hash], duplicate: img, hash });
                } else {
                    hashMap[hash] = img;
                }
            } catch (_) {}
        }

        results.sort((a, b) => b.size - a.size);
        return { success: true, stats, optimizable: results.slice(0, 50), duplicates };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-image-stats', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH);
        const imageExts = { '.png': 0, '.jpg': 0, '.jpeg': 0, '.gif': 0, '.svg': 0, '.webp': 0, '.bmp': 0 };
        let totalSize = 0;
        let count = 0;
        for (const file of allFiles) {
            const ext = path.extname(file).toLowerCase();
            if (ext in imageExts) {
                try { const stat = fs.statSync(file); totalSize += stat.size; imageExts[ext] += stat.size; count++; } catch (_) {}
            }
        }
        return { success: true, totalSize, count, byType: imageExts };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// frontmatterスキーマ検証
ipcMain.handle('validate-frontmatter-schema', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const schema = config.frontmatterSchema || {};
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const violations = [];

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            const frontmatter = {};
            if (fmMatch) {
                for (const line of fmMatch[1].split('\n')) {
                    const kv = line.match(/^(\w+)\s*:\s*(.+)/);
                    if (kv) frontmatter[kv[1]] = kv[2].trim();
                }
            }

            // フォルダベースのスキーマチェック
            const relPath = path.relative(VAULT_PATH, file);
            const folder = path.dirname(relPath).split(path.sep)[0];
            const folderSchema = schema[folder] || schema['*'];
            if (folderSchema) {
                const missingFields = (folderSchema.required || []).filter(f => !frontmatter[f]);
                if (missingFields.length > 0) {
                    violations.push({ basename, file, folder, missingFields, existingFields: Object.keys(frontmatter) });
                }
            }
        }
        return { success: true, violations, count: violations.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('save-frontmatter-schema', (_, schema) => {
    config.frontmatterSchema = schema;
    saveConfig(config);
    return { success: true };
});

// メタデータ一括編集（スプレッドシート用データ取得）
ipcMain.handle('get-frontmatter-spreadsheet', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const rows = [];
        const allKeys = new Set();

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const basename = path.basename(file, '.md');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            const frontmatter = {};
            if (fmMatch) {
                for (const line of fmMatch[1].split('\n')) {
                    const kv = line.match(/^(\w+)\s*:\s*(.+)/);
                    if (kv) { frontmatter[kv[1]] = kv[2].trim(); allKeys.add(kv[1]); }
                }
            }
            rows.push({ basename, file, frontmatter });
        }
        return { success: true, rows: rows.slice(0, 500), columns: [...allKeys], totalFiles: rows.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// メタデータ一括編集の実行
ipcMain.handle('batch-edit-frontmatter', async (_, { edits }) => {
    // edits: [{ file: string, key: string, value: string }]
    try {
        let modified = 0;
        for (const edit of edits) {
            if (!isPathInsideVault(edit.file)) continue;
            let content = fs.readFileSync(edit.file, 'utf-8');
            const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
            if (fmMatch) {
                let fmContent = fmMatch[2];
                const keyRe = new RegExp(`^${edit.key}\\s*:.*$`, 'm');
                if (keyRe.test(fmContent)) {
                    fmContent = fmContent.replace(keyRe, `${edit.key}: ${edit.value}`);
                } else {
                    fmContent += `\n${edit.key}: ${edit.value}`;
                }
                content = fmMatch[1] + fmContent + fmMatch[3] + content.slice(fmMatch[0].length);
            } else {
                content = `---\n${edit.key}: ${edit.value}\n---\n` + content;
            }
            fs.writeFileSync(edit.file, content, 'utf-8');
            modified++;
        }
        return { success: true, modified };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Markdown Linter
ipcMain.handle('lint-markdown', async (_, params) => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const lintRules = config.lintRules || {
            headingIncrement: true,      // 見出しレベルが1段ずつ増加しているか
            trailingSpaces: true,        // 末尾の不要スペース
            emptyLinesAroundHeadings: true, // 見出しの前後に空行
            consistentListMarkers: true,  // リストマーカーの統一（-/*）
            noTabIndentation: true,       // タブではなくスペースでインデント
            frontmatterSort: false,       // frontmatterキーのソート
        };
        const files = params?.filePaths || getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const issues = [];
        let autoFixCount = 0;

        for (const file of (Array.isArray(files) ? files : [files])) {
            const filePath = path.isAbsolute(file) ? file : path.join(VAULT_PATH, file);
            if (!fs.existsSync(filePath)) continue;
            let content = fs.readFileSync(filePath, 'utf-8');
            const basename = path.basename(filePath, '.md');
            const lines = content.split('\n');
            const fileIssues = [];

            lines.forEach((line, idx) => {
                const lineNum = idx + 1;
                // 末尾スペース
                if (lintRules.trailingSpaces && /\s+$/.test(line) && !line.match(/^\s*$/)) {
                    fileIssues.push({ line: lineNum, rule: 'trailing-spaces', message: '末尾に不要なスペースがあります', autoFixable: true });
                }
                // タブインデント
                if (lintRules.noTabIndentation && /\t/.test(line)) {
                    fileIssues.push({ line: lineNum, rule: 'no-tabs', message: 'タブが使用されています（スペース推奨）', autoFixable: true });
                }
                // 見出しレベルチェック
                const headingMatch = line.match(/^(#{1,6})\s/);
                if (headingMatch && lintRules.headingIncrement) {
                    const level = headingMatch[1].length;
                    if (idx > 0) {
                        // 前の見出しとの差が2以上
                        for (let j = idx - 1; j >= 0; j--) {
                            const prevHead = lines[j].match(/^(#{1,6})\s/);
                            if (prevHead) {
                                if (level - prevHead[1].length > 1) {
                                    fileIssues.push({ line: lineNum, rule: 'heading-increment', message: `見出しレベルが${prevHead[1].length}から${level}に飛んでいます`, autoFixable: false });
                                }
                                break;
                            }
                        }
                    }
                }
            });

            if (fileIssues.length > 0) {
                issues.push({ basename, file: filePath, issues: fileIssues });
            }

            // 自動修正
            if (params?.autoFix) {
                let newContent = content;
                if (lintRules.trailingSpaces) { newContent = newContent.replace(/[ \t]+$/gm, ''); }
                if (lintRules.noTabIndentation) { newContent = newContent.replace(/\t/g, '    '); }
                if (newContent !== content) {
                    fs.writeFileSync(filePath, newContent, 'utf-8');
                    autoFixCount++;
                }
            }
        }
        return { success: true, issues, totalIssues: issues.reduce((sum, f) => sum + f.issues.length, 0), autoFixed: autoFixCount };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-lint-rules', () => {
    return { success: true, rules: config.lintRules || { headingIncrement: true, trailingSpaces: true, emptyLinesAroundHeadings: true, consistentListMarkers: true, noTabIndentation: true, frontmatterSort: false } };
});

ipcMain.handle('save-lint-rules', (_, rules) => {
    config.lintRules = rules;
    saveConfig(config);
    return { success: true };
});

// Dataviewクエリビルダー
ipcMain.handle('build-dataview-query', async (_, params) => {
    try {
        const { queryType, source, fields, sortBy, filterBy, limit } = params;
        let query = '';
        if (queryType === 'table') {
            const cols = fields && fields.length > 0 ? fields.join(', ') : 'file.name, file.mtime';
            query = `\`\`\`dataview\nTABLE ${cols}\nFROM ${source || '""'}\n`;
            if (filterBy) query += `WHERE ${filterBy}\n`;
            if (sortBy) query += `SORT ${sortBy}\n`;
            if (limit) query += `LIMIT ${limit}\n`;
            query += '```';
        } else if (queryType === 'list') {
            query = `\`\`\`dataview\nLIST\nFROM ${source || '""'}\n`;
            if (filterBy) query += `WHERE ${filterBy}\n`;
            if (sortBy) query += `SORT ${sortBy}\n`;
            if (limit) query += `LIMIT ${limit}\n`;
            query += '```';
        } else if (queryType === 'task') {
            query = `\`\`\`dataview\nTASK\nFROM ${source || '""'}\n`;
            if (filterBy) query += `WHERE ${filterBy}\n`;
            query += '```';
        }
        return { success: true, query };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Phase 7: UI/UX刷新
// ======================================================

// ダッシュボードレイアウト保存
ipcMain.handle('save-dashboard-layout', (_, layout) => {
    config.dashboardLayout = layout;
    saveConfig(config);
    return { success: true };
});

ipcMain.handle('get-dashboard-layout', () => {
    return { success: true, layout: config.dashboardLayout || null };
});

// 操作履歴（統合タイムライン）
let operationHistory = [];

ipcMain.handle('get-operation-history', () => {
    return { success: true, history: operationHistory.slice(-100) };
});

ipcMain.handle('rollback-operation', async (_, operationId) => {
    const op = operationHistory.find(h => h.id === operationId);
    if (!op) return { success: false, error: '操作が見つかりません' };
    if (!op.rollbackData) return { success: false, error: 'この操作はロールバックできません' };
    try {
        if (op.type === 'file-delete' && op.rollbackData.backupPath) {
            const vaultPath = getCurrentVault();
            const files = getFilesRecursively(op.rollbackData.backupPath);
            let restored = 0;
            for (const file of files) {
                const rel = path.relative(op.rollbackData.backupPath, file);
                const dest = path.join(vaultPath, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(file, dest);
                restored++;
            }
            return { success: true, restored };
        }
        return { success: false, error: 'ロールバック方法が不明です' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// マルチVault統合ビュー
ipcMain.handle('cross-vault-search', async (_, query) => {
    try {
        const vaults = config.vaults || [];
        const results = [];
        const queryTerms = query.toLowerCase().split(/\s+/);

        for (const vaultPath of vaults) {
            if (!fs.existsSync(vaultPath)) continue;
            const files = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
            for (const file of files) {
                const basename = path.basename(file, '.md');
                const nameMatch = queryTerms.some(t => basename.toLowerCase().includes(t));
                if (nameMatch) {
                    results.push({ vault: path.basename(vaultPath), name: basename, file, matchType: 'name' });
                    continue;
                }
                const content = await safeReadFile(file);
                if (content && queryTerms.some(t => content.toLowerCase().includes(t))) {
                    results.push({ vault: path.basename(vaultPath), name: basename, file, matchType: 'content', preview: content.slice(0, 200) });
                }
            }
        }
        return { success: true, results: results.slice(0, 100), totalResults: results.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Vault統合ウィザード
ipcMain.handle('preview-merge-vaults', async (_, { sourceVault, targetVault }) => {
    try {
        if (!fs.existsSync(sourceVault) || !fs.existsSync(targetVault)) return { success: false, error: 'Vaultが見つかりません' };
        const sourceFiles = getFilesRecursively(sourceVault).filter(f => f.endsWith('.md'));
        const targetFiles = getFilesRecursively(targetVault).filter(f => f.endsWith('.md'));
        const targetNames = new Set(targetFiles.map(f => path.basename(f)));
        const duplicates = [];
        const uniqueToSource = [];

        for (const file of sourceFiles) {
            const basename = path.basename(file);
            if (targetNames.has(basename)) {
                duplicates.push({ name: basename, sourcePath: file });
            } else {
                uniqueToSource.push({ name: basename, sourcePath: file });
            }
        }
        return { success: true, duplicates, uniqueToSource, sourceCount: sourceFiles.length, targetCount: targetFiles.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('merge-vaults', async (_, { sourceVault, targetVault, skipDuplicates }) => {
    try {
        if (!fs.existsSync(sourceVault) || !fs.existsSync(targetVault)) return { success: false, error: 'Vaultが見つかりません' };
        const sourceFiles = getFilesRecursively(sourceVault);
        const targetNames = new Set(getFilesRecursively(targetVault).map(f => path.relative(targetVault, f)));
        let copied = 0, skipped = 0;

        for (const file of sourceFiles) {
            const rel = path.relative(sourceVault, file);
            const destPath = path.join(targetVault, rel);
            if (targetNames.has(rel) && skipDuplicates) { skipped++; continue; }
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(file, destPath);
            copied++;
        }
        return { success: true, copied, skipped };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ======================================================
// Phase 8: 外部連携（v6.0 新連携）
// ======================================================

// Obsidian URI接続テスト
ipcMain.handle('test-obsidian-uri', async () => {
    try {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
        const vaultName = path.basename(vaultPath);
        const { shell } = require('electron');
        await shell.openExternal(`obsidian://open?vault=${encodeURIComponent(vaultName)}`);
        return { success: true, vaultName };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Git 統合ハンドラ → src/handlers/git.handler.js に移動済み
// getGitSettings / saveGitSettings: Vault ごとの Git 設定を config に保存 (Plan B)
function getGitSettings() {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return {};
    return ((config.gitSettings || {})[vaultPath]) || {};
}
function saveGitSettings(settings) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return;
    if (!config.gitSettings) config.gitSettings = {};
    config.gitSettings[vaultPath] = settings;
    saveConfig(config);
}
require('./src/handlers/git.handler').register(ipcMain, { getCurrentVault, getGitSettings, saveGitSettings });

// ノートエクスポート
ipcMain.handle('export-notes', async (_, { format, scope }) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const { dialog } = require('electron');
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const ext = format === 'json' ? 'json' : 'html';
        const result = await dialog.showSaveDialog({
            title: 'エクスポート先を選択',
            defaultPath: `vault-export-${new Date().toISOString().slice(0, 10)}.${ext}`,
            filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
        });
        if (result.canceled || !result.filePath) return { success: false, error: 'キャンセルされました' };

        if (format === 'json') {
            const notes = [];
            for (const file of allFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    notes.push({ path: path.relative(vaultPath, file), content });
                } catch (_) {}
            }
            fs.writeFileSync(result.filePath, JSON.stringify(notes, null, 2), 'utf-8');
        } else {
            let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Vault Export</title><style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px}article{border-bottom:1px solid #eee;padding:20px 0}h2{color:#7c6cf8}</style></head><body><h1>Vault Export</h1>';
            for (const file of allFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const relPath = path.relative(vaultPath, file);
                    const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    html += `<article><h2>${relPath}</h2><pre>${escaped}</pre></article>`;
                } catch (_) {}
            }
            html += '</body></html>';
            fs.writeFileSync(result.filePath, html, 'utf-8');
        }
        return { success: true, path: result.filePath, count: allFiles.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// クリップボード→Inboxノート作成
ipcMain.handle('clipboard-to-inbox', async (_, { text }) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const inboxDir = path.join(vaultPath, '00 Inbox');
        fs.mkdirSync(inboxDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
        const isUrl = /^https?:\/\//.test(text.trim());
        let title, content;

        if (isUrl) {
            const url = text.trim();
            title = `Web Clip ${timestamp}`;
            content = `---\ntags: [clip, web]\ncreated: ${new Date().toISOString().slice(0, 10)}\nsource: "${url}"\n---\n\n# Web Clip\n\n[元URL](${url})\n\n---\n\n${url}\n`;
        } else {
            // テキストの最初の行をタイトルに
            const firstLine = text.split('\n')[0].replace(/^#*\s*/, '').trim().substring(0, 60);
            title = firstLine || `Clip ${timestamp}`;
            content = `---\ntags: [clip]\ncreated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${title}\n\n${text}\n`;
        }

        const safeName = title.replace(/[/\\?%*:|"<>]/g, '_');
        const filePath = path.join(inboxDir, `${safeName}.md`);
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true, filePath, title };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Phase 5: Vault全体フルテキスト検索
ipcMain.handle('vault-search', async (_, { query }) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return { success: false, error: '検索クエリが空です' };
        }
        const MAX_RESULTS = 50;
        const PREVIEW_CONTEXT = 20;
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const results = [];
        const lowerQuery = query.toLowerCase();

        for (const file of allFiles) {
            if (results.length >= MAX_RESULTS) break;
            const relPath = path.relative(vaultPath, file);
            const name = path.basename(file, '.md');

            // ファイル名一致チェック
            if (name.toLowerCase().includes(lowerQuery)) {
                results.push({ path: file, relPath, name, matchType: 'filename', preview: name, lineNumber: null });
            }

            // 本文一致チェック
            const content = await safeReadFile(file);
            if (!content) continue;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (results.length >= MAX_RESULTS) break;
                const idx = lines[i].toLowerCase().indexOf(lowerQuery);
                if (idx !== -1) {
                    const start = Math.max(0, idx - PREVIEW_CONTEXT);
                    const end = Math.min(lines[i].length, idx + query.length + PREVIEW_CONTEXT);
                    const preview = (start > 0 ? '…' : '') + lines[i].substring(start, end) + (end < lines[i].length ? '…' : '');
                    results.push({ path: file, relPath, name, matchType: 'content', preview, lineNumber: i + 1 });
                }
            }
        }

        return { success: true, results };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Phase 5: 重複・類似ノート検出
ipcMain.handle('find-duplicate-notes', async () => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));

        // Levenshtein距離の計算
        const levenshtein = (a, b) => {
            const m = a.length, n = b.length;
            const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
            for (let i = 0; i <= m; i++) dp[i][0] = i;
            for (let j = 0; j <= n; j++) dp[0][j] = j;
            for (let i = 1; i <= m; i++) {
                for (let j = 1; j <= n; j++) {
                    dp[i][j] = a[i - 1] === b[j - 1]
                        ? dp[i - 1][j - 1]
                        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
                }
            }
            return dp[m][n];
        };

        // ノート情報を収集（性能のため500ファイル上限）
        const MAX_NOTES = 500;
        const targetFiles = allFiles.slice(0, MAX_NOTES);
        const notes = [];
        for (const file of targetFiles) {
            const name = path.basename(file, '.md');
            const content = await safeReadFile(file);
            const snippet = content ? content.replace(/^---[\s\S]*?---\s*/, '').substring(0, 200) : '';
            notes.push({ path: file, name, snippet });
        }

        const duplicates = [];
        for (let i = 0; i < notes.length; i++) {
            for (let j = i + 1; j < notes.length; j++) {
                const a = notes[i], b = notes[j];

                // タイトル類似度チェック（Levenshtein距離）
                const maxLen = Math.max(a.name.length, b.name.length);
                if (maxLen > 0) {
                    const dist = levenshtein(a.name.toLowerCase(), b.name.toLowerCase());
                    const titleSimilarity = 1 - dist / maxLen;
                    if (titleSimilarity >= 0.8) {
                        duplicates.push({
                            noteA: { path: a.path, name: a.name },
                            noteB: { path: b.path, name: b.name },
                            similarity: Math.round(titleSimilarity * 100),
                            reason: 'title'
                        });
                        continue;
                    }
                }

                // 内容の最初の200文字の類似度チェック
                if (a.snippet.length >= 50 && b.snippet.length >= 50) {
                    const snippetMaxLen = Math.max(a.snippet.length, b.snippet.length);
                    const snippetDist = levenshtein(a.snippet, b.snippet);
                    const contentSimilarity = 1 - snippetDist / snippetMaxLen;
                    if (contentSimilarity >= 0.8) {
                        duplicates.push({
                            noteA: { path: a.path, name: a.name },
                            noteB: { path: b.path, name: b.name },
                            similarity: Math.round(contentSimilarity * 100),
                            reason: 'content'
                        });
                    }
                }
            }
        }

        return { success: true, duplicates };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Phase 5: 一括タグ操作
ipcMain.handle('batch-tag-operation', async (_, { operation, oldTag, newTag }) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        if (!operation || !oldTag) {
            return { success: false, error: 'operation と oldTag は必須です' };
        }
        if (operation === 'rename' && !newTag) {
            return { success: false, error: 'rename操作にはnewTagが必要です' };
        }
        if (operation === 'merge' && !newTag) {
            return { success: false, error: 'merge操作にはnewTagが必要です' };
        }

        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const cleanOld = oldTag.replace(/^#/, '');
        const cleanNew = newTag ? newTag.replace(/^#/, '') : '';
        let affectedFiles = 0;

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            let modified = content;
            let changed = false;

            // 本文中の #tag を処理（単語境界を考慮）
            const tagRegex = new RegExp(`#${cleanOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,;.!?）」』\\]|$])`, 'g');
            if (tagRegex.test(modified)) {
                if (operation === 'delete') {
                    modified = modified.replace(tagRegex, '');
                } else {
                    // rename または merge
                    modified = modified.replace(tagRegex, `#${cleanNew}`);
                }
                changed = true;
            }

            // frontmatter の tags 配列を処理
            const fmMatch = modified.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
                const fmContent = fmMatch[1];
                // tags: [tag1, tag2] 形式
                const tagsArrayMatch = fmContent.match(/^(tags:\s*\[)(.*?)(\])/m);
                if (tagsArrayMatch) {
                    const tags = tagsArrayMatch[2].split(/,\s*/).map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                    const idx = tags.indexOf(cleanOld);
                    if (idx !== -1) {
                        if (operation === 'delete') {
                            tags.splice(idx, 1);
                        } else {
                            // rename または merge
                            if (tags.includes(cleanNew)) {
                                tags.splice(idx, 1); // 既にnewTagが存在する場合は削除のみ
                            } else {
                                tags[idx] = cleanNew;
                            }
                        }
                        const newFmContent = fmContent.replace(tagsArrayMatch[0], `${tagsArrayMatch[1]}${tags.join(', ')}${tagsArrayMatch[3]}`);
                        modified = modified.replace(fmMatch[1], newFmContent);
                        changed = true;
                    }
                }
                // tags:\n  - tag1\n  - tag2 形式
                const tagsListRegex = new RegExp(`^(\\s*-\\s*)${cleanOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'gm');
                if (tagsListRegex.test(fmContent)) {
                    let newFm = fmContent;
                    if (operation === 'delete') {
                        newFm = newFm.replace(tagsListRegex, '');
                    } else {
                        newFm = newFm.replace(tagsListRegex, `$1${cleanNew}`);
                    }
                    modified = modified.replace(fmMatch[1], newFm);
                    changed = true;
                }
            }

            if (changed) {
                // 空行の連続を整理
                modified = modified.replace(/\n{3,}/g, '\n\n');
                fs.writeFileSync(file, modified, 'utf-8');
                affectedFiles++;
            }
        }

        return { success: true, affectedFiles };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Phase 5: Vault変更トラッカー
ipcMain.handle('get-vault-changes', async () => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const lastScanDate = config.lastScanDate ? new Date(config.lastScanDate) : new Date(0);
        const now = new Date();
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));

        const created = [];
        const modified = [];

        for (const file of allFiles) {
            try {
                const stat = fs.statSync(file);
                const relPath = path.relative(vaultPath, file);
                const name = path.basename(file, '.md');
                const fileInfo = { path: file, relPath, name, date: stat.mtime.toISOString() };

                if (stat.birthtime > lastScanDate) {
                    created.push(fileInfo);
                } else if (stat.mtime > lastScanDate) {
                    modified.push(fileInfo);
                }
            } catch (_) {
                // statが取得できないファイルはスキップ
            }
        }

        // スキャン日時を更新
        config.lastScanDate = now.toISOString();
        saveConfig(config);

        return {
            success: true,
            created,
            modified,
            summary: {
                created: created.length,
                modified: modified.length,
                total: created.length + modified.length
            }
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// タグクラウドデータ取得
ipcMain.handle('get-tag-cloud', async () => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allMd = collectAllMdFiles(vaultPath);
        // タグ名 → { count, files(Set) } のマップ
        const tagMap = new Map();

        const FRONTMATTER_TAGS_RE = /^tags:\s*\[([^\]]*)\]/m;
        const FRONTMATTER_TAGS_LIST_RE = /^tags:\s*\n((?:\s*-\s*.+\n?)*)/m;
        const INLINE_TAG_RE = /(?:^|\s)#([a-zA-Z\u3040-\u9FFF][\w\u3040-\u9FFF/-]*)/g;

        for (const mdPath of allMd) {
            try {
                const content = safeReadFile(mdPath);
                if (!content) continue;
                const relPath = path.relative(vaultPath, mdPath);
                const foundTags = new Set();

                // frontmatterからタグを抽出
                const fm = parseFrontmatter(content);
                if (fm.exists) {
                    // tags: [tag1, tag2] 形式
                    const bracketMatch = fm.raw.match(FRONTMATTER_TAGS_RE);
                    if (bracketMatch) {
                        bracketMatch[1].split(',').forEach(t => {
                            const trimmed = t.trim().replace(/^["']|["']$/g, '');
                            if (trimmed) foundTags.add(trimmed);
                        });
                    }
                    // tags:\n  - tag1 形式
                    const listMatch = fm.raw.match(FRONTMATTER_TAGS_LIST_RE);
                    if (listMatch) {
                        listMatch[1].split('\n').forEach(line => {
                            const m = line.match(/^\s*-\s*(.+)/);
                            if (m) {
                                const trimmed = m[1].trim().replace(/^["']|["']$/g, '');
                                if (trimmed) foundTags.add(trimmed);
                            }
                        });
                    }
                }

                // 本文中のインラインタグを抽出（frontmatter部分を除外）
                const body = fm.exists ? content.slice(fm.bodyStart) : content;
                let match;
                while ((match = INLINE_TAG_RE.exec(body)) !== null) {
                    foundTags.add(match[1]);
                }

                // マップに集計
                for (const tag of foundTags) {
                    if (!tagMap.has(tag)) {
                        tagMap.set(tag, { count: 0, files: new Set() });
                    }
                    const entry = tagMap.get(tag);
                    entry.count++;
                    entry.files.add(relPath);
                }
            } catch (_) {
                // 読み取れないファイルはスキップ
            }
        }

        // countの降順でソートし、Setを配列に変換
        const tags = Array.from(tagMap.entries())
            .map(([name, data]) => ({ name, count: data.count, files: Array.from(data.files) }))
            .sort((a, b) => b.count - a.count);

        return { success: true, tags };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ノート健康診断（単一ファイル）
ipcMain.handle('note-health-check', async (_, { filePath }) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        if (!isPathInsideVault(filePath)) {
            return { success: false, error: 'Vault外のファイルは対象外です' };
        }
        const content = safeReadFile(filePath);
        if (content === null) {
            return { success: false, error: 'ファイルを読み込めませんでした' };
        }

        const MAX_SCORE = 100;
        const details = [];
        let totalScore = 0;

        // 1. frontmatterの有無（+20点）
        const fm = parseFrontmatter(content);
        const fmScore = fm.exists ? 20 : 0;
        details.push({
            name: 'Frontmatter',
            score: fmScore,
            maxScore: 20,
            advice: fm.exists ? 'Frontmatterが存在します' : 'Frontmatterを追加してメタデータを管理しましょう'
        });
        totalScore += fmScore;

        // 2. タグの有無（+15点）
        const hasInlineTag = /(?:^|\s)#[a-zA-Z\u3040-\u9FFF][\w\u3040-\u9FFF/-]*/m.test(
            fm.exists ? content.slice(fm.bodyStart) : content
        );
        const hasFmTags = fm.exists && /^tags:/m.test(fm.raw);
        const tagScore = (hasInlineTag || hasFmTags) ? 15 : 0;
        details.push({
            name: 'タグ',
            score: tagScore,
            maxScore: 15,
            advice: tagScore > 0 ? 'タグが設定されています' : 'タグを追加して検索性を向上させましょう'
        });
        totalScore += tagScore;

        // 3. 見出し構造（## があれば+15点）
        const hasHeading = /^##\s+/m.test(content);
        const headingScore = hasHeading ? 15 : 0;
        details.push({
            name: '見出し構造',
            score: headingScore,
            maxScore: 15,
            advice: headingScore > 0 ? '見出しで構造化されています' : '## 見出しを追加してノートを構造化しましょう'
        });
        totalScore += headingScore;

        // 4. 被リンク数（1以上で+15点）
        const noteName = path.basename(filePath, '.md');
        const allMd = collectAllMdFiles(vaultPath);
        let backlinks = 0;
        const backlinkRe = new RegExp(`\\[\\[${noteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]`);
        for (const mdPath of allMd) {
            if (mdPath === filePath) continue;
            try {
                const otherContent = safeReadFile(mdPath);
                if (otherContent && backlinkRe.test(otherContent)) {
                    backlinks++;
                }
            } catch (_) {
                // スキップ
            }
        }
        const backlinkScore = backlinks >= 1 ? 15 : 0;
        details.push({
            name: '被リンク',
            score: backlinkScore,
            maxScore: 15,
            advice: backlinkScore > 0
                ? `${backlinks}件の被リンクがあります`
                : '他のノートからリンクされていません。関連ノートからリンクを張りましょう'
        });
        totalScore += backlinkScore;

        // 5. 発リンク数（1以上で+10点）
        const outgoingLinks = (content.match(/\[\[[^\]]+\]\]/g) || []).length;
        const outlinkScore = outgoingLinks >= 1 ? 10 : 0;
        details.push({
            name: '発リンク',
            score: outlinkScore,
            maxScore: 10,
            advice: outlinkScore > 0
                ? `${outgoingLinks}件の発リンクがあります`
                : '他のノートへのリンクを追加してネットワークを広げましょう'
        });
        totalScore += outlinkScore;

        // 6. 適切な文字数（200-5000文字で+15点）
        const MIN_CHARS = 200;
        const MAX_CHARS = 5000;
        const charCount = content.length;
        const charScore = (charCount >= MIN_CHARS && charCount <= MAX_CHARS) ? 15 : 0;
        details.push({
            name: '文字数',
            score: charScore,
            maxScore: 15,
            advice: charCount < MIN_CHARS
                ? `${charCount}文字です。もう少し内容を充実させましょう（${MIN_CHARS}文字以上推奨）`
                : charCount > MAX_CHARS
                    ? `${charCount}文字です。ノートの分割を検討しましょう（${MAX_CHARS}文字以下推奨）`
                    : `${charCount}文字で適切な長さです`
        });
        totalScore += charScore;

        // 7. 最終更新日が1年以内（+10点）
        const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
        const stat = fs.statSync(filePath);
        const isRecent = (Date.now() - stat.mtime.getTime()) < ONE_YEAR_MS;
        const recencyScore = isRecent ? 10 : 0;
        details.push({
            name: '最終更新',
            score: recencyScore,
            maxScore: 10,
            advice: isRecent
                ? '1年以内に更新されています'
                : '1年以上更新されていません。内容を見直しましょう'
        });
        totalScore += recencyScore;

        return { success: true, score: totalScore, maxScore: MAX_SCORE, details };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ワンクリック自動整理
ipcMain.handle('auto-organize', async () => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const steps = [];

        // ステップ1: frontmatterが無いノートに基本frontmatterを追加
        const allMd = collectAllMdFiles(vaultPath);
        let fmAddedCount = 0;
        const fmAddedFiles = [];
        for (const mdPath of allMd) {
            try {
                const content = safeReadFile(mdPath);
                if (!content) continue;
                const fm = parseFrontmatter(content);
                if (!fm.exists) {
                    const stat = fs.statSync(mdPath);
                    const createdDate = stat.birthtime.toISOString().split('T')[0];
                    const newContent = `---\ncreated: ${createdDate}\ntags: []\n---\n\n${content}`;
                    fs.writeFileSync(mdPath, newContent, 'utf-8');
                    fmAddedCount++;
                    fmAddedFiles.push(path.relative(vaultPath, mdPath));
                }
            } catch (_) {
                // 書き込めないファイルはスキップ
            }
        }
        steps.push({
            name: 'Frontmatter追加',
            action: 'frontmatterが無いノートに基本frontmatterを追加',
            count: fmAddedCount,
            details: fmAddedFiles
        });

        // ステップ2: 空フォルダを削除（深い階層から順に処理）
        let emptyRemoved = 0;
        const removedDirs = [];
        const removeEmptyDirs = (dir) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const fullPath = path.join(dir, entry.name);
                        // .obsidianフォルダは除外
                        if (entry.name === '.obsidian' || entry.name === '.trash') continue;
                        removeEmptyDirs(fullPath);
                    }
                }
                // 再読み込みして空かどうか確認（vaultルートは除外）
                if (dir !== vaultPath) {
                    const remaining = fs.readdirSync(dir);
                    if (remaining.length === 0) {
                        fs.rmdirSync(dir);
                        emptyRemoved++;
                        removedDirs.push(path.relative(vaultPath, dir));
                    }
                }
            } catch (_) {
                // アクセスできないディレクトリはスキップ
            }
        };
        removeEmptyDirs(vaultPath);
        steps.push({
            name: '空フォルダ削除',
            action: '中身のないフォルダを削除',
            count: emptyRemoved,
            details: removedDirs
        });

        // ステップ3: リンクのcase mismatch修正
        // 全ノート名のマップを構築（小文字 → 正しいノート名）
        const noteNameMap = new Map();
        const currentAllMd = collectAllMdFiles(vaultPath);
        for (const mdPath of currentAllMd) {
            const name = path.basename(mdPath, '.md');
            noteNameMap.set(name.toLowerCase(), name);
        }

        let linkFixCount = 0;
        const linkFixFiles = [];
        const WIKILINK_RE = /\[\[([^\]|#]+)([#|][^\]]*)?]]/g;
        for (const mdPath of currentAllMd) {
            try {
                const content = safeReadFile(mdPath);
                if (!content) continue;
                let modified = false;
                const newContent = content.replace(WIKILINK_RE, (match, linkTarget, rest) => {
                    const trimmed = linkTarget.trim();
                    const lower = trimmed.toLowerCase();
                    const correct = noteNameMap.get(lower);
                    // 大文字小文字が一致しない場合のみ修正
                    if (correct && correct !== trimmed) {
                        modified = true;
                        return `[[${correct}${rest || ''}]]`;
                    }
                    return match;
                });
                if (modified) {
                    fs.writeFileSync(mdPath, newContent, 'utf-8');
                    linkFixCount++;
                    linkFixFiles.push(path.relative(vaultPath, mdPath));
                }
            } catch (_) {
                // スキップ
            }
        }
        steps.push({
            name: 'リンクcase修正',
            action: 'ウィキリンクの大文字小文字の不一致を修正',
            count: linkFixCount,
            details: linkFixFiles
        });

        return { success: true, steps };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// === Phase 6: 高度なノート管理 ===

// 孤立ノート検出
ipcMain.handle('find-orphan-notes', async () => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        // 全ノートの名前（拡張子なし）をMapで管理
        const noteNames = new Map();
        for (const f of allFiles) {
            const relPath = path.relative(vaultPath, f);
            const name = path.basename(f, '.md');
            noteNames.set(name, { path: f, relPath });
        }
        // 全ファイルから [[リンク]] を収集し、リンクされているノート名を集める
        const linkedNames = new Set();
        for (const f of allFiles) {
            const content = safeReadFile(f);
            if (!content) continue;
            const linkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]*?)?\]\]/g;
            let match;
            while ((match = linkRegex.exec(content)) !== null) {
                linkedNames.add(match[1].trim());
            }
        }
        // どこからもリンクされていないノートを抽出
        const orphans = [];
        for (const [name, info] of noteNames) {
            if (!linkedNames.has(name)) {
                const content = safeReadFile(info.path) || '';
                orphans.push({
                    path: info.path,
                    relPath: info.relPath,
                    name,
                    charCount: content.length
                });
            }
        }
        return { success: true, orphans };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// バッチリネーム
ipcMain.handle('batch-rename-notes', async (_, { pattern, replacement, useRegex, preview }) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const allFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
        const regex = useRegex ? new RegExp(pattern, 'g') : null;
        const renamed = [];
        for (const f of allFiles) {
            const oldName = path.basename(f, '.md');
            let newName;
            if (regex) {
                newName = oldName.replace(regex, replacement);
            } else {
                newName = oldName.split(pattern).join(replacement);
            }
            if (newName !== oldName && newName.trim() !== '') {
                renamed.push({ oldName, newName, path: f });
            }
        }
        // プレビューモードならリネーム結果のみ返す
        if (preview) {
            return { success: true, renamed, count: renamed.length };
        }
        // 実際にリネーム実行
        for (const item of renamed) {
            const dir = path.dirname(item.path);
            const newPath = path.join(dir, `${item.newName}.md`);
            if (fs.existsSync(newPath)) continue; // 衝突回避
            fs.renameSync(item.path, newPath);
            item.path = newPath;
            // 全ファイル内のリンクを更新
            const mdFiles = getFilesRecursively(vaultPath).filter(f => f.endsWith('.md'));
            for (const mdFile of mdFiles) {
                let content = safeReadFile(mdFile);
                if (!content) continue;
                const oldLink = `[[${item.oldName}]]`;
                const newLink = `[[${item.newName}]]`;
                if (content.includes(oldLink)) {
                    content = content.split(oldLink).join(newLink);
                    fs.writeFileSync(mdFile, content, 'utf-8');
                }
                // エイリアス付きリンクも更新
                const escapedOldName = item.oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const aliasRegex = new RegExp(`\\[\\[${escapedOldName}\\|`, 'g');
                if (aliasRegex.test(content)) {
                    content = content.replace(aliasRegex, `[[${item.newName}|`);
                    fs.writeFileSync(mdFile, content, 'utf-8');
                }
            }
        }
        return { success: true, renamed, count: renamed.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// デイリーノート作成
ipcMain.handle('create-daily-note', async (_, args) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const template = args && args.template ? args.template : null;
        const today = new Date();
        const dateStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
        const dailyDir = path.join(vaultPath, 'Daily Notes');
        fs.mkdirSync(dailyDir, { recursive: true });
        const filePath = path.join(dailyDir, `${dateStr}.md`);
        if (fs.existsSync(filePath)) {
            return { success: false, error: `デイリーノート ${dateStr} は既に存在します` };
        }
        // 前日の未完了タスクを検索
        const carryOverTasks = [];
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);
        const yesterdayPath = path.join(dailyDir, `${yesterdayStr}.md`);
        if (fs.existsSync(yesterdayPath)) {
            const yesterdayContent = safeReadFile(yesterdayPath) || '';
            const taskRegex = /^- \[ \] (.+)$/gm;
            let match;
            while ((match = taskRegex.exec(yesterdayContent)) !== null) {
                carryOverTasks.push(match[1]);
            }
        }
        // ノート内容を生成
        let content;
        if (template) {
            content = template
                .replace(/\{\{date\}\}/g, dateStr)
                .replace(/\{\{today\}\}/g, dateStr);
        } else {
            const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
            const dayOfWeek = dayNames[today.getDay()];
            content = `---\ntags: [daily]\ncreated: ${dateStr}\n---\n\n# ${dateStr} (${dayOfWeek})\n\n## TODO\n\n- [ ] \n\n## メモ\n\n\n\n## ふりかえり\n\n\n`;
        }
        // 未完了タスクを引き継ぎ
        if (carryOverTasks.length > 0) {
            const taskLines = carryOverTasks.map(t => `- [ ] ${t}`).join('\n');
            content += `\n## 前日からの引き継ぎ\n\n${taskLines}\n`;
        }
        fs.writeFileSync(filePath, content, 'utf-8');
        return { success: true, filePath, carryOverTasks };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ブックマーク管理
ipcMain.handle('manage-bookmarks', async (_, { action, filePath }) => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        if (!config.bookmarks) config.bookmarks = [];
        if (action === 'add') {
            if (!filePath) return { success: false, error: 'ファイルパスが必要です' };
            if (!isPathInsideVault(filePath)) return { success: false, error: 'Vault外のファイルは追加できません' };
            if (!config.bookmarks.includes(filePath)) {
                config.bookmarks.push(filePath);
                saveConfig(config);
            }
        } else if (action === 'remove') {
            if (!filePath) return { success: false, error: 'ファイルパスが必要です' };
            config.bookmarks = config.bookmarks.filter(b => b !== filePath);
            saveConfig(config);
        } else if (action !== 'list') {
            return { success: false, error: `不明なアクション: ${action}` };
        }
        // ブックマーク一覧を返す（存在するファイルのみ）
        const bookmarks = config.bookmarks
            .filter(b => fs.existsSync(b))
            .map(b => ({
                path: b,
                relPath: path.relative(vaultPath, b),
                name: path.basename(b, '.md')
            }));
        return { success: true, bookmarks };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// フォルダ構造ビジュアライザー用データ
ipcMain.handle('get-folder-tree', async () => {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return { success: false, error: 'Vaultが設定されていません' };
    try {
        const buildTree = (dirPath) => {
            const name = path.basename(dirPath);
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            let noteCount = 0;
            let size = 0;
            const children = [];
            for (const entry of entries) {
                // .obsidianや隠しフォルダをスキップ
                if (entry.name.startsWith('.')) continue;
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    const child = buildTree(fullPath);
                    children.push(child);
                    noteCount += child.noteCount;
                    size += child.size;
                } else if (entry.name.endsWith('.md')) {
                    noteCount++;
                    try {
                        const stat = fs.statSync(fullPath);
                        size += stat.size;
                    } catch (_) {
                        // statに失敗しても続行
                    }
                }
            }
            return { name, path: dirPath, noteCount, size, children };
        };
        const tree = buildTree(vaultPath);
        return { success: true, tree };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Obsidian Publish品質チェック
ipcMain.handle('check-publish-quality', async () => {
    const VAULT_PATH = getCurrentVault();
    if (!VAULT_PATH) return { success: false, error: 'Vaultが設定されていません' };
    try {
        // publish: true のノートを検索
        const allFiles = getFilesRecursively(VAULT_PATH).filter(f => f.endsWith('.md'));
        const issues = [];
        const publishFiles = [];

        for (const file of allFiles) {
            const content = await safeReadFile(file);
            if (!content) continue;
            const isPublish = /publish:\s*true/i.test(content);
            if (!isPublish) continue;
            publishFiles.push(file);
            const basename = path.basename(file, '.md');
            const fileIssues = [];

            // 壊れたリンクチェック
            const linkRe = /\[\[([^\]]+)\]\]/g;
            let m;
            while ((m = linkRe.exec(content)) !== null) {
                const dest = m[1].split('|')[0].split('#')[0].trim();
                const destFile = path.join(VAULT_PATH, dest + '.md');
                const altFile = path.join(VAULT_PATH, dest);
                if (!fs.existsSync(destFile) && !fs.existsSync(altFile)) {
                    fileIssues.push({ type: 'broken-link', detail: `[[${dest}]] が見つかりません` });
                }
            }

            // 機密情報チェック（簡易版）
            if (/(?:api[_-]?key|password|secret)\s*[:=]/i.test(content)) {
                fileIssues.push({ type: 'secret-detected', detail: '機密情報の可能性があります' });
            }

            // 未完成チェック
            if (/\bTODO\b|\bFIXME\b|\bWIP\b|^\s*- \[ \]/m.test(content)) {
                fileIssues.push({ type: 'incomplete', detail: '未完成のタスクやTODOがあります' });
            }

            if (fileIssues.length > 0) {
                issues.push({ basename, file, issues: fileIssues });
            }
        }
        return { success: true, issues, totalPublishFiles: publishFiles.length, totalIssues: issues.reduce((s, i) => s + i.issues.length, 0) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 最適化プリセット
ipcMain.handle('get-optimization-presets', () => {
    const builtInPresets = [
        { id: 'researcher', name: '📚 研究者向け', description: 'Zettelkasten + 文献MOC + タグ中心', settings: { junkRules: { minChars: 10, minBytes: 3 }, staleDays: 365, enableMoc: true } },
        { id: 'project-manager', name: '📋 プロジェクト管理向け', description: 'PARA + タスク + 週次レビュー', settings: { junkRules: { minChars: 20, minBytes: 5 }, staleDays: 90, enableMoc: true } },
        { id: 'journaler', name: '📝 日記・ジャーナル向け', description: 'Daily Note + 振り返り + 低めのゴミ判定', settings: { junkRules: { minChars: 5, minBytes: 2 }, staleDays: 365, enableMoc: false } },
        { id: 'minimalist', name: '🧹 ミニマリスト', description: '厳格なゴミ判定 + 積極的アーカイブ', settings: { junkRules: { minChars: 50, minBytes: 10 }, staleDays: 60, enableMoc: true } },
    ];
    const customPresets = config.customPresets || [];
    return { success: true, presets: [...builtInPresets, ...customPresets] };
});

ipcMain.handle('apply-optimization-preset', (_, presetId) => {
    const presets = {
        researcher: { junkRules: { minChars: 10, minBytes: 3, keywords: ['untitled', '無題'] }, staleDays: 365, enableMoc: true },
        'project-manager': { junkRules: { minChars: 20, minBytes: 5, keywords: ['untitled', '無題'] }, staleDays: 90, enableMoc: true },
        journaler: { junkRules: { minChars: 5, minBytes: 2, keywords: ['untitled'] }, staleDays: 365, enableMoc: false },
        minimalist: { junkRules: { minChars: 50, minBytes: 10, keywords: ['untitled', '無題', 'メモ', 'temp'] }, staleDays: 60, enableMoc: true },
    };
    const preset = presets[presetId];
    if (!preset) return { success: false, error: '不明なプリセットです' };
    Object.assign(config, preset);
    saveConfig(config);
    return { success: true, applied: presetId };
});

ipcMain.handle('export-preset', () => {
    const preset = {
        junkRules: config.junkRules,
        staleDays: config.staleDays,
        enableMoc: config.enableMoc,
        enableJunk: config.enableJunk,
        rules: config.rules,
        smartRules: config.smartRules,
        lintRules: config.lintRules,
    };
    return { success: true, preset: JSON.stringify(preset, null, 2) };
});

ipcMain.handle('import-preset', async () => {
    try {
        const win = BrowserWindow.getAllWindows()[0];
        const result = await dialog.showOpenDialog(win, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
        if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'キャンセルされました' };
        const content = fs.readFileSync(result.filePaths[0], 'utf-8');
        const preset = JSON.parse(content);
        Object.assign(config, preset);
        saveConfig(config);
        return { success: true, applied: path.basename(result.filePaths[0]) };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
