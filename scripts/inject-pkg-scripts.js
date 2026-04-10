// electron-builder afterAllArtifactBuild フック
// electron-builder が生成した PKG に preinstall / postinstall を注入する
// （electron-builder の pkg.scripts オプションが動作しない環境向け対策）

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

module.exports = async function (buildResult) {
    // PKG ファイルだけ処理する
    const pkgFiles = (buildResult.artifactPaths || []).filter(p => p.endsWith('.pkg'));
    if (pkgFiles.length === 0) return;

    const scriptsDir = path.join(__dirname, '..', 'assets', 'pkg-scripts');
    if (!fs.existsSync(path.join(scriptsDir, 'preinstall'))) {
        console.log('inject-pkg-scripts: scripts dir not found, skipping');
        return;
    }

    for (const pkgPath of pkgFiles) {
        console.log(`inject-pkg-scripts: injecting scripts into ${path.basename(pkgPath)}`);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-inject-'));
        const expandedDir = path.join(tmpDir, 'expanded');
        const rebuiltPkg = pkgPath + '.new';

        try {
            // PKG を展開
            execSync(`pkgutil --expand "${pkgPath}" "${expandedDir}"`, { stdio: 'pipe' });

            // Scripts ディレクトリを作成して注入
            const innerPkg = fs.readdirSync(expandedDir).find(d => d.endsWith('.pkg'));
            if (!innerPkg) throw new Error('inner .pkg not found');

            const innerPkgDir = path.join(expandedDir, innerPkg);
            const targetScripts = path.join(innerPkgDir, 'Scripts');
            fs.mkdirSync(targetScripts, { recursive: true });

            for (const script of ['preinstall', 'postinstall']) {
                const src = path.join(scriptsDir, script);
                if (fs.existsSync(src)) {
                    const dst = path.join(targetScripts, script);
                    fs.copyFileSync(src, dst);
                    fs.chmodSync(dst, 0o755);
                }
            }

            // PKG を再梱包
            execSync(`pkgutil --flatten "${expandedDir}" "${rebuiltPkg}"`, { stdio: 'pipe' });

            // 元の PKG を差し替え
            fs.renameSync(rebuiltPkg, pkgPath);
            console.log(`inject-pkg-scripts: ✅ done → ${path.basename(pkgPath)}`);
        } catch (e) {
            console.error(`inject-pkg-scripts: ❌ failed: ${e.message}`);
            // 失敗しても元ファイルは残す
            if (fs.existsSync(rebuiltPkg)) fs.unlinkSync(rebuiltPkg);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
};
