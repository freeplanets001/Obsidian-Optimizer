'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

// ======================================================
// Git 統合ハンドラ
// 依存: getCurrentVault (コンテキスト経由で注入)
// ======================================================

function isGitAvailable() {
    try {
        execSync('git --version', { encoding: 'utf-8', timeout: 5000 });
        return true;
    } catch (_) { return false; }
}

/** git-status ハンドラ実装 */
async function handleGitStatus(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-status');
    if (!isGitAvailable()) return fail(
        'Gitがインストールされていません。\nMac: Xcode Command Line Tools（ターミナルで xcode-select --install）\nWindows: https://git-scm.com からインストールしてください。',
        'git-status'
    );
    const isGit = fs.existsSync(path.join(vaultPath, '.git'));
    if (!isGit) return ok({ initialized: false, message: 'Gitリポジトリではありません。「Git初期化」をクリックしてください。' });
    const status = execSync('git status --porcelain', { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
    const lines = status.trim().split('\n').filter(l => l.trim());
    const branch = execSync('git branch --show-current', { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 }).trim();
    return ok({ initialized: true, branch, changedFiles: lines.length, changes: lines.slice(0, 20) });
}

/** git-backup ハンドラ実装 */
async function handleGitBackup(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-backup');
    if (!isGitAvailable()) return fail('Gitがインストールされていません', 'git-backup');
    if (!fs.existsSync(path.join(vaultPath, '.git'))) return fail('Git初期化が必要です', 'git-backup');

    // .gitignoreが無ければ作成
    const gitignorePath = path.join(vaultPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/\n', 'utf-8');
    }
    try {
        execSync('git add -A', { cwd: vaultPath, timeout: 30000 });
        const timestamp = new Date().toISOString().replace(/[T:]/g, '-').slice(0, 19);
        execSync(`git commit -m "Vault backup ${timestamp}" --allow-empty`, { cwd: vaultPath, timeout: 30000 });
        const log = execSync('git log -1 --oneline', { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 }).trim();
        return ok({ commit: log });
    } catch (e) {
        if (e.message && e.message.includes('nothing to commit')) {
            return ok({ commit: '変更なし（最新の状態です）' });
        }
        return fail(e, 'git-backup');
    }
}

/** git-log ハンドラ実装 */
async function handleGitLog(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-log');
    if (!isGitAvailable()) return fail('Gitがインストールされていません', 'git-log');
    if (!fs.existsSync(path.join(vaultPath, '.git'))) return fail('Gitリポジトリではありません', 'git-log');
    const log = execSync('git log --oneline -20', { cwd: vaultPath, encoding: 'utf-8', timeout: 10000 });
    const entries = log.trim().split('\n').filter(l => l.trim()).map(l => {
        const [hash, ...rest] = l.split(' ');
        return { hash, message: rest.join(' ') };
    });
    return ok({ entries });
}

/** git-init ハンドラ実装 */
async function handleGitInit(getCurrentVault) {
    const vaultPath = getCurrentVault();
    if (!vaultPath) return fail('Vaultが設定されていません', 'git-init');
    if (!isGitAvailable()) return fail(
        'Gitがインストールされていません。\nMac: ターミナルで xcode-select --install\nWindows: https://git-scm.com からインストール',
        'git-init'
    );
    if (fs.existsSync(path.join(vaultPath, '.git'))) return ok({ message: '既にGitリポジトリです' });
    execSync('git init', { cwd: vaultPath, timeout: 10000 });
    const gitignorePath = path.join(vaultPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '.obsidian/workspace.json\n.obsidian/workspace-mobile.json\n.trash/\n', 'utf-8');
    }
    execSync('git add -A', { cwd: vaultPath, timeout: 30000 });
    execSync('git commit -m "Initial vault backup"', { cwd: vaultPath, timeout: 30000 });
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
