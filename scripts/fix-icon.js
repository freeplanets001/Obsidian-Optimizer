// electron-builder afterPack フック: macOSアプリのアイコン設定を確実にする
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

module.exports = async function (context) {
    if (context.electronPlatformName !== 'darwin') return;

    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const plistPath = path.join(appPath, 'Contents', 'Info.plist');
    const resourcesDir = path.join(appPath, 'Contents', 'Resources');
    const iconDest = path.join(resourcesDir, 'icon.icns');

    console.log('afterPack: Fixing macOS icon...');

    // Info.plistからCFBundleIconNameを削除（Asset Catalogを参照しようとして失敗する原因）
    try {
        execSync(`/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "${plistPath}"`, { stdio: 'pipe' });
        console.log('  Removed CFBundleIconName');
    } catch (_) {
        // キーが存在しない場合は無視
    }

    // CFBundleIconFileを確実に設定
    try {
        execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon.icns" "${plistPath}"`, { stdio: 'pipe' });
        console.log('  Set CFBundleIconFile = icon.icns');
    } catch (_) {
        execSync(`/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string icon.icns" "${plistPath}"`, { stdio: 'pipe' });
    }

    // アイコンファイルの権限を修正（全ユーザーが読み取れるようにする）
    if (fs.existsSync(iconDest)) {
        fs.chmodSync(iconDest, 0o644);
        const stat = fs.statSync(iconDest);
        console.log(`  icon.icns exists: ${stat.size} bytes, permissions fixed to 644`);
    } else {
        console.error('  WARNING: icon.icns not found in Resources!');
    }

    // ロックフラグ（immutable）を解除 — これが「一部の項目をスキップ」エラーの主因
    try {
        execSync(`chflags -R nouchg,noschg,nosappnd,noschg "${appPath}"`, { stdio: 'pipe' });
        console.log('  Cleared immutable/locked flags (chflags)');
    } catch (_) {
        console.log('  Warning: chflags failed (may need sudo)');
    }

    // アプリバンドル全体の権限を修正（ディレクトリ: 755、ファイル: 644）
    execSync(`find "${appPath}" -type d -exec chmod 755 {} \\;`, { stdio: 'pipe' });
    execSync(`find "${appPath}" -type f -exec chmod 644 {} \\;`, { stdio: 'pipe' });
    console.log('  Fixed permissions: dirs=755, files=644');

    // 実行ファイル・dylib・so には 755 を設定
    const macosDir = path.join(appPath, 'Contents', 'MacOS');
    execSync(`chmod -R 755 "${macosDir}"`, { stdio: 'pipe' });
    execSync(`find "${appPath}" -name "*.dylib" -exec chmod 755 {} \\;`, { stdio: 'pipe' });
    execSync(`find "${appPath}" -name "*.so" -exec chmod 755 {} \\;`, { stdio: 'pipe' });
    execSync(`find "${appPath}" -name "*.node" -exec chmod 755 {} \\;`, { stdio: 'pipe' });
    console.log('  Fixed executable permissions (MacOS/, dylib, so, node)');

    // Resources内の権限も再確認
    execSync(`chmod -R a+rX "${resourcesDir}"`, { stdio: 'pipe' });
    console.log('  Fixed permissions on Resources/');

    // ._ファイル（リソースフォーク）を除去 — 外付けドライブでのビルド時に「破損」エラーを防止
    try {
        execSync(`dot_clean "${appPath}"`, { stdio: 'pipe' });
        console.log('  Cleaned resource forks with dot_clean');
    } catch (_) {
        // dot_cleanが無くても続行
    }

    // quarantine属性を除去 — PKGインストール後に「破損」ダイアログを防止
    try {
        execSync(`xattr -cr "${appPath}"`, { stdio: 'pipe' });
        console.log('  Removed quarantine attributes');
    } catch (_) {
        console.log('  Warning: Could not remove quarantine attributes (may need sudo)');
    }

    // Touch the app bundle to invalidate icon cache
    execSync(`touch "${appPath}"`, { stdio: 'pipe' });
    console.log('  Touched app bundle');
};
