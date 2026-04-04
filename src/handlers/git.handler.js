'use strict';

const path = require('path');
const fs = require('fs');
const { execFile, execSync } = require('child_process');
const { promisify } = require('util');
const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

const execFileAsync = promisify(execFile);

// ======================================================
// Git 統合ハンドラ
// execSync → execFileAsync (非同期) に変更してUIフリーズを防止
// ======================================================

async function isGitAvailable() {
    try {
        await execFileAsync('git', ['--version'], { timeout: 5000 });
        return true;
    } catch (_) { return false; }
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

    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: vaultPath, encoding: 'utf-8', timeout: 15000 });
    const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
    const lines = statusOut.trim().split('\n').filter(l => l.trim());
    const branch = branchOut.trim();
    return ok({ initialized: true, branch, changedFiles: lines.length, changes: lines.slice(0, 20) });
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
                // 5秒以上前に作られたロックファイルのみ除去（現在進行中のプロセスは保護）
                const stat = fs.statSync(lockFile);
                const ageMs = Date.now() - stat.mtimeMs;
                if (ageMs > 5000) {
                    fs.unlinkSync(lockFile);
                }
            } catch (_) {}
        }
    }
}

/** git-backup ハンドラ実装 */
async function handleGitBackup(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-backup');
    if (!await isGitAvailable()) return fail('Gitがインストールされていません', 'git-backup');
    if (!fs.existsSync(path.join(vaultPath, '.git'))) return fail('Git初期化が必要です', 'git-backup');

    // 古いロックファイルを除去（5秒以上前のもの）
    clearGitLocks(vaultPath);

    // .gitignoreが無ければ作成
    const gitignorePath = path.join(vaultPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/\n', 'utf-8');
    }
    try {
        await execFileAsync('git', ['add', '-A'], { cwd: vaultPath, timeout: 60000 });
        const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
        await execFileAsync('git', ['commit', '-m', `Vault backup ${timestamp}`, '--allow-empty'], { cwd: vaultPath, timeout: 30000 });
        const { stdout: logOut } = await execFileAsync('git', ['log', '-1', '--oneline'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        return ok({ commit: logOut.trim() });
    } catch (e) {
        const errDetail = [e.message, e.stderr].filter(Boolean).join('\n').trim();
        // ロックファイルエラーの場合、除去して1回リトライ
        if (errDetail.includes('index.lock') || errDetail.includes('Another git process')) {
            clearGitLocks(vaultPath);
            try {
                await execFileAsync('git', ['add', '-A'], { cwd: vaultPath, timeout: 60000 });
                const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
                await execFileAsync('git', ['commit', '-m', `Vault backup ${timestamp}`, '--allow-empty'], { cwd: vaultPath, timeout: 30000 });
                const { stdout: logOut } = await execFileAsync('git', ['log', '-1', '--oneline'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
                return ok({ commit: logOut.trim() });
            } catch (retryErr) {
                const retryDetail = [retryErr.message, retryErr.stderr].filter(Boolean).join('\n').trim();
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

    const { stdout } = await execFileAsync('git', ['log', '--oneline', '-20'], { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
    const entries = stdout.trim().split('\n').filter(l => l.trim()).map(l => {
        const [hash, ...rest] = l.split(' ');
        return { hash, message: rest.join(' ') };
    });
    return ok({ entries });
}

/** git-init ハンドラ実装 */
async function handleGitInit(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-init');
    if (!await isGitAvailable()) return fail(
        'Gitがインストールされていません。\nMac: ターミナルで xcode-select --install\nWindows: https://git-scm.com からインストール',
        'git-init'
    );
    if (fs.existsSync(path.join(vaultPath, '.git'))) return ok({ message: '既にGitリポジトリです' });

    await execFileAsync('git', ['init'], { cwd: vaultPath, timeout: 10000 });
    const gitignorePath = path.join(vaultPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/\n', 'utf-8');
    }
    await execFileAsync('git', ['add', '-A'], { cwd: vaultPath, timeout: 60000 });
    await execFileAsync('git', ['commit', '-m', 'Initial vault backup'], { cwd: vaultPath, timeout: 30000 });
    return ok({ message: 'Gitリポジトリを初期化しました' });
}

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{ getCurrentVault: () => string|null }} ctx - 共有コンテキスト
 */
function register(ipcMain, ctx) {
    const { getCurrentVault } = ctx;
    ipcMain.handle('git-status', withErrorHandling('git-status', () => handleGitStatus(getCurrentVault)));
    ipcMain.handle('git-backup', withErrorHandling('git-backup', () => handleGitBackup(getCurrentVault)));
    ipcMain.handle('git-log',    withErrorHandling('git-log',    () => handleGitLog(getCurrentVault)));
    ipcMain.handle('git-init',   withErrorHandling('git-init',   () => handleGitInit(getCurrentVault)));
}

module.exports = { register };
