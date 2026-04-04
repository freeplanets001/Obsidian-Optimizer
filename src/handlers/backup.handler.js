'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

// ======================================================
// バックアップ・スケジュール管理ハンドラ
// ======================================================

const BACKUP_DIR = path.join(os.homedir(), '.obsidian-optimizer-backups');
const SCAN_HISTORY_PATH = path.join(os.homedir(), '.obsidian-optimizer-scan-history.json');

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{
 *   getCurrentVault: () => string|null,
 *   getFilesRecursively: (dir: string) => string[],
 *   getWin: (event: any) => Electron.BrowserWindow,
 *   dialog: Electron.Dialog,
 *   getConfig: () => object,
 *   saveConfig: (c: object) => void,
 *   startBackupSchedule: () => void,
 *   doVaultBackup: () => Promise<object>,
 * }} ctx
 */
function register(ipcMain, ctx) {
    const { getCurrentVault, getFilesRecursively, getWin, dialog, getConfig, saveConfig, startBackupSchedule, doVaultBackup } = ctx;

    // バックアップ一覧取得
    ipcMain.handle('list-backups', withErrorHandling('list-backups', () => {
        if (!fs.existsSync(BACKUP_DIR)) return ok({ backups: [] });
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
                        try { totalSize += fs.statSync(f).size; } catch (_) {}
                    }
                } catch (_) {}
                const tsMatch = d.name.match(/(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})/);
                const dateStr = tsMatch ? `${tsMatch[1]} ${tsMatch[2].replace(/-/g, ':')}` : d.name;
                return { name: d.name, path: fullPath, dateStr, fileCount, totalSize };
            })
            .sort((a, b) => b.name.localeCompare(a.name));
        return ok({ backups: entries });
    }));

    // バックアップ復元
    ipcMain.handle('restore-backup', withErrorHandling('restore-backup', async (event, backupName) => {
        const vaultPath = getCurrentVault();
        if (!vaultPath) return fail('Vaultが設定されていません', 'restore-backup');
        const backupPath = path.join(BACKUP_DIR, backupName);
        if (!backupPath.startsWith(BACKUP_DIR)) return fail('不正なバックアップパスです', 'restore-backup');
        if (!fs.existsSync(backupPath)) return fail('バックアップが見つかりません', 'restore-backup');

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
        return ok({ restored });
    }));

    // バックアップ削除
    ipcMain.handle('delete-backup', withErrorHandling('delete-backup', async (_, backupName) => {
        const backupPath = path.join(BACKUP_DIR, backupName);
        if (!backupPath.startsWith(BACKUP_DIR)) return fail('不正なパスです', 'delete-backup');
        if (!fs.existsSync(backupPath)) return fail('見つかりません', 'delete-backup');
        fs.rmSync(backupPath, { recursive: true, force: true });
        return ok();
    }));

    // バックアップスケジュール設定
    ipcMain.handle('set-backup-schedule', withErrorHandling('set-backup-schedule', (_, { schedule }) => {
        if (!['off', 'daily', 'weekly'].includes(schedule)) return fail('無効なスケジュール', 'set-backup-schedule');
        const config = getConfig();
        config.backupSchedule = schedule;
        saveConfig(config);
        startBackupSchedule();
        return ok({ schedule });
    }));

    // 手動バックアップ実行
    ipcMain.handle('run-vault-backup', withErrorHandling('run-vault-backup', async () => {
        return await doVaultBackup();
    }));

    // バックアップスケジュール取得
    ipcMain.handle('get-backup-schedule', () => {
        return ok({ schedule: getConfig().backupSchedule || 'off' });
    });

    // スキャン履歴取得
    ipcMain.handle('get-last-scan', withErrorHandling('get-last-scan', () => {
        if (!fs.existsSync(SCAN_HISTORY_PATH)) return ok({ lastScan: null });
        const data = JSON.parse(fs.readFileSync(SCAN_HISTORY_PATH, 'utf-8'));
        return ok({ lastScan: data });
    }));

    // スキャンスナップショット保存
    ipcMain.handle('save-scan-snapshot', withErrorHandling('save-scan-snapshot', (_, snapshot) => {
        fs.writeFileSync(SCAN_HISTORY_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');
        return ok();
    }));
}

module.exports = { register, BACKUP_DIR, SCAN_HISTORY_PATH };
