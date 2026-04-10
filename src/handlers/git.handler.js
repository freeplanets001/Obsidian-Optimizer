'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

const _execFileAsync = promisify(execFile);

// ======================================================
// Git 統合ハンドラ
// execSync → execFileAsync (非同期) に変更してUIフリーズを防止
// ======================================================

// Electronプロセスではターミナル認証プロンプトが出せないため無効化
// GIT_TERMINAL_PROMPT=0 で認証待ちの無音ハングを防止
const GIT_ENV = {
    ...process.env,
    // Homebrew git が見つかるよう PATH を補完（Electron起動時はPATHが制限される）
    PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/echo',
};

// git バイナリのフルパスを特定（Electron起動時にPATHが制限される環境対策）
function findGitBin() {
    const candidates = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return 'git';
}
const GIT_BIN = findGitBin();

/**
 * git コマンドを実行する共通ラッパー
 */
function gitExec(args, opts = {}) {
    const execOpts = { env: GIT_ENV, ...opts };
    return _execFileAsync(GIT_BIN, args, execOpts);
}

/**
 * Vault パスを git の global safe.directory に登録する。
 * git 2.35.2 以降、所有者が異なるディレクトリでは "dubious ownership" エラーになる。
 * -c フラグや環境変数での回避は git バージョンによって効かないため、
 * グローバル設定への直接登録が最も確実な対処法（git公式推奨）。
 */
async function ensureSafeDirectory(vaultPath) {
    try {
        // 既に登録済みか確認
        const { stdout } = await gitExec(
            ['config', '--global', '--get-all', 'safe.directory'],
            { encoding: 'utf-8', timeout: 5000 }
        ).catch(() => ({ stdout: '' }));
        const registered = (stdout || '').split('\n').map(s => s.trim());
        if (registered.includes(vaultPath) || registered.includes('*')) return;
        // 未登録なら追加
        await gitExec(
            ['config', '--global', '--add', 'safe.directory', vaultPath],
            { timeout: 5000 }
        );
    } catch (_) {
        // 失敗しても続行（最悪の場合は git コマンド自体がエラーを出す）
    }
}

/**
 * execFileAsync のラッパー: git以外のコマンド用（後方互換）
 */
function execFileAsync(cmd, args, opts = {}) {
    if (cmd === 'git') return gitExec(args, opts);
    return _execFileAsync(cmd, args, opts);
}

async function isGitAvailable() {
    try {
        await gitExec(['--version'], { timeout: 5000 });
        return true;
    } catch (_) { return false; }
}

/**
 * ローカル git config に user.name / user.email を適用する
 * 設定値がなければフォールバック値を使う (Plan A)
 */
async function applyGitUserConfig(vaultPath, settings = {}) {
    const userName  = (settings.userName  || '').trim() || 'Optimizer Backup';
    const userEmail = (settings.userEmail || '').trim() || 'optimizer@local.backup';
    await gitExec(['config', '--local', 'user.name',  userName],  { cwd: vaultPath, timeout: 5000 });
    await gitExec(['config', '--local', 'user.email', userEmail], { cwd: vaultPath, timeout: 5000 });
}

/** git-status ハンドラ実装 */
async function handleGitStatus(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-status');
    if (!await isGitAvailable()) return fail(
        'Gitがインストールされていません。\nMac: Xcode Command Line Tools（ターミナルで xcode-select --install）\nWindows: https://git-scm.com からインストールしてください。',
        'git-status'
    );
    const isGit = fs.existsSync(path.join(vaultPath, '.git'));
    if (!isGit) return ok({ initialized: false, message: 'Gitリポジトリではありません。「Git初期化」をクリックしてください。' });

    // safe.directory をグローバル設定に登録（"dubious ownership" エラーを確実に回避）
    await ensureSafeDirectory(vaultPath);

    try {
        const { stdout: statusOut } = await gitExec(['status', '--porcelain'], { cwd: vaultPath, encoding: 'utf-8', timeout: 15000 });
        const { stdout: branchOut } = await gitExec(['branch', '--show-current'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        const lines = statusOut.trim().split('\n').filter(l => l.trim());
        const branch = branchOut.trim();
        return ok({ initialized: true, branch, changedFiles: lines.length, changes: lines.slice(0, 20) });
    } catch (e) {
        const detail = [e.stderr, e.stdout, e.message].filter(s => s && String(s).trim()).join('\n').trim();
        return fail(`git status 失敗 [${vaultPath}]:\n${detail}`, 'git-status');
    }
}

/** ロックファイルを安全に除去 (他プロセスが動いていない場合のみ) */
function clearGitLocks(vaultPath) {
    const lockFiles = [
        path.join(vaultPath, '.git', 'index.lock'),
        path.join(vaultPath, '.git', 'HEAD.lock'),
        path.join(vaultPath, '.git', 'MERGE_HEAD.lock'),
    ];
    for (const lockFile of lockFiles) {
        if (fs.existsSync(lockFile)) {
            try {
                const stat = fs.statSync(lockFile);
                const ageMs = Date.now() - stat.mtimeMs;
                if (ageMs > 5000) {
                    fs.unlinkSync(lockFile);
                }
            } catch (_) {}
        }
    }
}

/** git-backup ハンドラ実装
 * @param {Function} getCurrentVault
 * @param {Function} getGitSettings
 * @param {string} [commitMsg] - カスタムコミットメッセージ（省略時は自動生成）
 */
async function handleGitBackup(getCurrentVault, getGitSettings, commitMsg) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-backup');
    if (!await isGitAvailable()) return fail('Gitがインストールされていません', 'git-backup');
    if (!fs.existsSync(path.join(vaultPath, '.git'))) return fail('Git初期化が必要です', 'git-backup');

    // safe.directory をグローバル設定に登録（"dubious ownership" エラーを確実に回避）
    await ensureSafeDirectory(vaultPath);

    // 古いロックファイルを除去（5秒以上前のもの）
    clearGitLocks(vaultPath);

    // Plan A: user.name / user.email をローカルに確実に設定
    const settings = getGitSettings ? getGitSettings() : {};
    await applyGitUserConfig(vaultPath, settings);

    // .gitignoreが無ければ作成
    const gitignorePath = path.join(vaultPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/\n', 'utf-8');
    }

    // コミットメッセージを決定（カスタム > 自動生成）
    const buildCommitMsg = () => {
        const ts = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
        return commitMsg && commitMsg.trim() ? commitMsg.trim() : `Vault backup ${ts}`;
    };

    try {
        await gitExec(['add', '-A'], { cwd: vaultPath, timeout: 60000 });
        await gitExec(['commit', '-m', buildCommitMsg(), '--allow-empty'], { cwd: vaultPath, timeout: 30000 });
        const { stdout: logOut } = await gitExec(['log', '-1', '--oneline'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        return ok({ commit: logOut.trim() });
    } catch (e) {
        const errDetail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
        // ロックファイルエラーの場合、除去して1回リトライ
        if (errDetail.includes('index.lock') || errDetail.includes('Another git process')) {
            clearGitLocks(vaultPath);
            try {
                await gitExec(['add', '-A'], { cwd: vaultPath, timeout: 60000 });
                await gitExec(['commit', '-m', buildCommitMsg(), '--allow-empty'], { cwd: vaultPath, timeout: 30000 });
                const { stdout: logOut } = await gitExec(['log', '-1', '--oneline'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
                return ok({ commit: logOut.trim() });
            } catch (retryErr) {
                const retryDetail = [retryErr.stderr, retryErr.stdout, retryErr.message].filter(Boolean).join('\n').trim();
                return fail(retryDetail || retryErr, 'git-backup');
            }
        }
        if (errDetail.includes('nothing to commit')) {
            return ok({ commit: '変更なし（最新の状態です）' });
        }
        return fail(errDetail || e, 'git-backup');
    }
}

/** git-log ハンドラ実装 */
async function handleGitLog(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-log');
    if (!await isGitAvailable()) return fail('Gitがインストールされていません', 'git-log');
    if (!fs.existsSync(path.join(vaultPath, '.git'))) return fail('Gitリポジトリではありません', 'git-log');

    const { stdout } = await gitExec(['log', '--format=%h\x1f%ci\x1f%s', '-30'], { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
    const entries = stdout.trim().split('\n').filter(l => l.trim()).map(l => {
        const [hash, date, ...rest] = l.split('\x1f');
        return { hash: hash.trim(), date: date ? date.trim().slice(0, 16) : '', message: rest.join(' ').trim() };
    });
    return ok({ entries });
}

/** git-restore ハンドラ: 指定コミットの状態にVaultを復元 */
async function handleGitRestore(getCurrentVault, getGitSettings, hash) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-restore');
    if (!await isGitAvailable()) return fail('Gitがインストールされていません', 'git-restore');
    if (!fs.existsSync(path.join(vaultPath, '.git'))) return fail('Git初期化が必要です', 'git-restore');
    if (!hash || !/^[0-9a-f]{4,40}$/.test(hash)) return fail('無効なコミットハッシュです', 'git-restore');

    clearGitLocks(vaultPath);
    const settings = getGitSettings ? getGitSettings() : {};
    await applyGitUserConfig(vaultPath, settings);
    try {
        const { stdout: st } = await gitExec(['status', '--porcelain'], { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
        if (st.trim()) {
            await gitExec(['add', '-A'], { cwd: vaultPath, timeout: 60000 });
            const ts = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
            await gitExec(['commit', '-m', `Auto-save before restore ${ts}`], { cwd: vaultPath, timeout: 30000 });
        }
    } catch (_) {}

    await gitExec(['checkout', hash, '--', '.'], { cwd: vaultPath, timeout: 30000 });

    const { stdout: diffAfter } = await gitExec(['status', '--porcelain'], { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
    if (diffAfter.trim()) {
        await gitExec(['add', '-A'], { cwd: vaultPath, timeout: 60000 });
        await gitExec(['commit', '-m', `Restore to ${hash}`], { cwd: vaultPath, timeout: 30000 });
    }
    return ok({ message: `${hash} の状態に復元しました` });
}

/** git-init ハンドラ実装 */
async function handleGitInit(getCurrentVault, getGitSettings) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-init');
    if (!await isGitAvailable()) return fail(
        'Gitがインストールされていません。\nMac: ターミナルで xcode-select --install\nWindows: https://git-scm.com からインストール',
        'git-init'
    );
    if (fs.existsSync(path.join(vaultPath, '.git'))) return ok({ message: '既にGitリポジトリです' });

    await gitExec(['init'], { cwd: vaultPath, timeout: 10000 });

    const settings = getGitSettings ? getGitSettings() : {};
    await applyGitUserConfig(vaultPath, settings);

    if (settings.remoteUrl) {
        await gitExec(['remote', 'add', 'origin', settings.remoteUrl], { cwd: vaultPath, timeout: 5000 });
    }

    const gitignorePath = path.join(vaultPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/\n', 'utf-8');
    }
    await gitExec(['add', '-A'], { cwd: vaultPath, timeout: 60000 });
    await gitExec(['commit', '-m', 'Initial vault backup'], { cwd: vaultPath, timeout: 30000 });
    return ok({ message: 'Gitリポジトリを初期化しました' });
}

// ======================================================
// Plan B: Git設定 取得 / 保存 / Push
// ======================================================

/** git-get-config ハンドラ: 現在のVaultのGit設定を返す */
async function handleGitGetConfig(getCurrentVault, getGitSettings) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-get-config');
    const settings = getGitSettings ? getGitSettings() : {};
    return ok({ settings });
}

/** git-save-config ハンドラ: Git設定を保存し、既存リポジトリに即座に適用 */
async function handleGitSaveConfig(getCurrentVault, saveGitSettings, params) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-save-config');

    const { userName = '', userEmail = '', remoteUrl = '' } = params || {};
    saveGitSettings({ userName: userName.trim(), userEmail: userEmail.trim(), remoteUrl: remoteUrl.trim() });

    if (fs.existsSync(path.join(vaultPath, '.git'))) {
        await applyGitUserConfig(vaultPath, { userName, userEmail });

        if (remoteUrl.trim()) {
            try {
                await gitExec(['remote', 'get-url', 'origin'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
                await gitExec(['remote', 'set-url', 'origin', remoteUrl.trim()], { cwd: vaultPath, timeout: 5000 });
            } catch (_) {
                await gitExec(['remote', 'add', 'origin', remoteUrl.trim()], { cwd: vaultPath, timeout: 5000 });
            }
        }
    }
    return ok({ message: 'Git設定を保存しました' });
}

/** git-push ハンドラ: origin にプッシュ */
async function handleGitPush(getCurrentVault, getGitSettings) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-push');
    if (!await isGitAvailable()) return fail('Gitがインストールされていません', 'git-push');
    if (!fs.existsSync(path.join(vaultPath, '.git'))) return fail('Git初期化が必要です', 'git-push');

    const settings = getGitSettings ? getGitSettings() : {};
    if (!settings.remoteUrl) {
        return fail('リモートURLが設定されていません。Git設定でリモートURLを入力し「設定保存」してください。', 'git-push');
    }

    try {
        const { stdout: currentUrl } = await gitExec(['remote', 'get-url', 'origin'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        if (currentUrl.trim() !== settings.remoteUrl) {
            await gitExec(['remote', 'set-url', 'origin', settings.remoteUrl], { cwd: vaultPath, timeout: 5000 });
        }
    } catch (_) {
        await gitExec(['remote', 'add', 'origin', settings.remoteUrl], { cwd: vaultPath, timeout: 5000 });
    }

    try {
        const { stdout: branchOut } = await gitExec(['branch', '--show-current'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        const branch = branchOut.trim() || 'main';

        clearGitLocks(vaultPath);
        await applyGitUserConfig(vaultPath, settings);

        const { stdout: diffOut } = await gitExec(['status', '--porcelain'], { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
        if (diffOut.trim()) {
            await gitExec(['add', '-A'], { cwd: vaultPath, timeout: 60000 });
            const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
            await gitExec(['commit', '-m', `Vault backup ${timestamp}`], { cwd: vaultPath, timeout: 30000 });
        }

        let stashed = false;
        try {
            const { stdout: afterCommit } = await gitExec(['status', '--porcelain'], { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
            if (afterCommit.trim()) {
                await gitExec(['stash', '--include-untracked'], { cwd: vaultPath, timeout: 30000 });
                stashed = true;
            }
        } catch (_) {}

        if (stashed) {
            try { await gitExec(['stash', 'pop'], { cwd: vaultPath, timeout: 30000 }); } catch (_) {}
        }

        try {
            await gitExec(['push', '-u', 'origin', branch], { cwd: vaultPath, encoding: 'utf-8', timeout: 60000 });
        } catch (pushErr) {
            const pushDetail = [pushErr.stderr, pushErr.stdout, pushErr.message].filter(Boolean).join('\n').trim();
            if (pushDetail.includes('non-fast-forward') || pushDetail.includes('rejected') || pushDetail.includes('fetch first')) {
                await gitExec(['fetch', 'origin'], { cwd: vaultPath, encoding: 'utf-8', timeout: 60000 });
                await gitExec(['push', '--force-with-lease', '-u', 'origin', branch], { cwd: vaultPath, encoding: 'utf-8', timeout: 60000 });
            } else {
                throw pushErr;
            }
        }
        return ok({ message: `Push完了 (origin/${branch})` });
    } catch (e) {
        const errDetail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
        return fail(errDetail || e, 'git-push');
    }
}

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{ getCurrentVault: () => string|null, getGitSettings: () => object, saveGitSettings: (s: object) => void }} ctx
 */
function register(ipcMain, ctx) {
    const { getCurrentVault, getGitSettings, saveGitSettings } = ctx;
    ipcMain.handle('git-status',     withErrorHandling('git-status',     () => handleGitStatus(getCurrentVault)));
    ipcMain.handle('git-backup',     withErrorHandling('git-backup',     (_, { commitMsg } = {}) => handleGitBackup(getCurrentVault, getGitSettings, commitMsg)));
    ipcMain.handle('git-log',        withErrorHandling('git-log',        () => handleGitLog(getCurrentVault)));
    ipcMain.handle('git-init',       withErrorHandling('git-init',       () => handleGitInit(getCurrentVault, getGitSettings)));
    ipcMain.handle('git-get-config', withErrorHandling('git-get-config', () => handleGitGetConfig(getCurrentVault, getGitSettings)));
    ipcMain.handle('git-save-config',withErrorHandling('git-save-config',(_, params) => handleGitSaveConfig(getCurrentVault, saveGitSettings, params)));
    ipcMain.handle('git-push',       withErrorHandling('git-push',       () => handleGitPush(getCurrentVault, getGitSettings)));
    ipcMain.handle('git-restore',    withErrorHandling('git-restore',    (_, hash) => handleGitRestore(getCurrentVault, getGitSettings, hash)));
}

module.exports = { register };
