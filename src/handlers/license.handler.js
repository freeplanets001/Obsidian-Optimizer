'use strict';

const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

// ======================================================
// ライセンス認証・アップデートチェックハンドラ
// ======================================================

/**
 * IPC ハンドラを登録する
 * @param {Electron.IpcMain} ipcMain
 * @param {{
 *   getConfig: () => object,
 *   saveConfig: (c: object) => void,
 *   isValidLicenseKey: (key: string) => boolean,
 *   generateLicenseKey: () => string,
 *   fetchJson: (url: string) => Promise<object>,
 *   APP_VERSION: string,
 *   GITHUB_RELEASES_URL: string,
 *   compareVersions: (a: string, b: string) => number,
 * }} ctx
 */
function register(ipcMain, ctx) {
    const {
        getConfig, saveConfig,
        isValidLicenseKey, generateLicenseKey,
        fetchJson, APP_VERSION, GITHUB_RELEASES_URL, compareVersions,
    } = ctx;

    // ライセンスキー検証
    ipcMain.handle('verify-license', withErrorHandling('verify-license', (_, key) => {
        if (!key || typeof key !== 'string') return fail('ライセンスキーを入力してください', 'verify-license');
        const normalized = key.trim().toUpperCase();
        if (!/^OPT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
            return fail('キーの形式が正しくありません（OPT-XXXX-XXXX-XXXX-XXXX）', 'verify-license');
        }
        if (!isValidLicenseKey(normalized)) {
            return fail('ライセンスキーが無効です。正しいキーを入力してください。', 'verify-license');
        }
        const config = getConfig();
        config.licenseKey = normalized;
        saveConfig(config);
        return ok({ key: normalized });
    }));

    // ライセンス状態確認
    ipcMain.handle('get-license-status', () => {
        const key = getConfig().licenseKey || '';
        const isLicensed = isValidLicenseKey(key);
        const maskedKey = isLicensed ? key.slice(0, 8) + '-****-****' : '';
        return { isLicensed, maskedKey };
    });

    // ライセンスキー生成（開発者用）
    ipcMain.handle('generate-license-key', () => {
        return { key: generateLicenseKey() };
    });

    // アップデートチェック
    ipcMain.handle('check-for-updates', withErrorHandling('check-for-updates', async () => {
        const release = await fetchJson(GITHUB_RELEASES_URL);
        const latestVersion = (release.tag_name || '').replace(/^v/, '');
        const updateAvailable = compareVersions(latestVersion, APP_VERSION) > 0;

        // GitHub API の assets 配列から browser_download_url を直接取得
        // （手動URL構築はファイル名スペース等の問題が発生するため廃止）
        const platform = process.platform;
        const arch = process.arch;
        let fileName = null;
        let directDownloadUrl = null;
        if (updateAvailable) {
            const assets = release.assets || [];
            let targetAsset = null;
            if (platform === 'darwin') {
                const archSuffix = arch === 'arm64' ? 'arm64' : 'x64';
                // PKG を優先、なければ DMG にフォールバック
                targetAsset = assets.find(a => a.name.includes(`mac-${archSuffix}`) && a.name.endsWith('.pkg'))
                    || assets.find(a => a.name.includes(`mac-${archSuffix}`) && a.name.endsWith('.dmg'));
            } else if (platform === 'win32') {
                targetAsset = assets.find(a => a.name.includes('win-x64') && a.name.endsWith('.exe'));
            }
            if (targetAsset) {
                fileName = targetAsset.name;
                directDownloadUrl = targetAsset.browser_download_url;
            }
        }

        return {
            updateAvailable,
            latestVersion,
            currentVersion: APP_VERSION,
            downloadUrl: release.html_url || '',
            releaseNotes: release.body || '',
            directDownloadUrl,
            fileName,
        };
    }));
}

module.exports = { register };
