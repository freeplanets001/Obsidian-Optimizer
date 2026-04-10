'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ok, fail, withErrorHandling } = require('../utils/ipc-response');

const _execFileAsync = promisify(execFile);

// ======================================================
// Git 統合ハンドラ
// ======================================================

// git バイナリのフルパスを特定（Electron起動時にPATHが制限される環境対策）
function findGitBin() {
    const candidates = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return 'git';
}
const GIT_BIN = findGitBin();

// safe.directory=* を含む一時gitconfigを用意し GIT_CONFIG_GLOBAL で渡す。
// これにより "dubious ownership" エラーを確実に回避する。
// -c フラグ・環境変数方式はgitバージョンによって無視されるケースがあるが、
// GIT_CONFIG_GLOBAL は git 2.32 以降で確実に動作する。
const TEMP_GITCONFIG_PATH = path.join(os.tmpdir(), '.obsidian-optimizer-gitconfig');

/**
 * ユーザーの ~/.gitconfig を読み込み、safe.directory=* を追加した一時 gitconfig を生成する。
 * 重要: 単純に `[safe] directory = *` だけを書くと、ユーザーの credential.helper = osxkeychain
 * などの設定が失われて git push が認証エラーになる。そのため必ずユーザー設定を保持する。
 */
function ensureTempGitConfig() {
    try {
        const userGlobalConfig = path.join(os.homedir(), '.gitconfig');
        let userConfig = '';
        if (fs.existsSync(userGlobalConfig)) {
            userConfig = fs.readFileSync(userGlobalConfig, 'utf-8');
        }
        // ユーザー設定に safe.directory=* が既にある場合はそのまま使う
        const hasSafeWildcard = userConfig.split('\n').some(
            l => l.trim().replace(/\s/g, '').toLowerCase().startsWith('directory=*')
        );
        const finalConfig = hasSafeWildcard
            ? userConfig
            : '[safe]\n\tdirectory = *\n' + userConfig;
        fs.writeFileSync(TEMP_GITCONFIG_PATH, finalConfig, { encoding: 'utf-8', mode: 0o644 });
    } catch (_) {
        // フォールバック: 最小限の設定のみ（credential は失われるが dubious ownership は回避できる）
        try {
            fs.writeFileSync(TEMP_GITCONFIG_PATH, '[safe]\n\tdirectory = *\n', { encoding: 'utf-8', mode: 0o644 });
        } catch (_2) {}
    }
}

// 起動時に1回だけ生成する
ensureTempGitConfig();

const GIT_ENV = {
    ...process.env,
    // Homebrew git が見つかるよう PATH を補完（Electron起動時はPATHが制限される）
    PATH: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':'),
    HOME: os.homedir(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/echo',
    // 一時gitconfigをグローバル設定として注入 → safe.directory=* が確実に効く
    // ※ユーザーの ~/.gitconfig の内容もマージ済みなので credential 設定は保持される
    GIT_CONFIG_GLOBAL: TEMP_GITCONFIG_PATH,
};

/**
 * git コマンドを実行する共通ラッパー
 */
function gitExec(args, opts = {}) {
    return _execFileAsync(GIT_BIN, args, { env: GIT_ENV, ...opts });
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

    const runStatus = async () => {
        const { stdout: statusOut } = await gitExec(['status', '--porcelain'], { cwd: vaultPath, encoding: 'utf-8', timeout: 15000 });
        const { stdout: branchOut } = await gitExec(['branch', '--show-current'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        const lines = statusOut.trim().split('\n').filter(l => l.trim());
        const branch = branchOut.trim();
        return ok({ initialized: true, branch, changedFiles: lines.length, changes: lines.slice(0, 20) });
    };
    try {
        return await runStatus();
    } catch (e) {
        const detail = [e.stderr, e.stdout, e.message].filter(s => s && String(s).trim()).join('\n').trim();
        // iCloud Drive退避エラーの場合は強制ダウンロードしてリトライ
        if (isICloudEvictError(detail)) {
            await downloadICloudGitObjects(vaultPath);
            try { return await runStatus(); } catch (e2) {
                const d2 = [e2.stderr, e2.stdout, e2.message].filter(s => s && String(s).trim()).join('\n').trim();
                if (isICloudEvictError(d2)) {
                    return fail(
                        'iCloud DriveがVaultのgitファイルをクラウドに退避しています。\n' +
                        'Finderでこのフォルダを開き、.gitフォルダを右クリック→「ダウンロード」してから再試行してください:\n' +
                        vaultPath,
                        'git-status'
                    );
                }
                return fail(`git status 失敗:\n${d2}`, 'git-status');
            }
        }
        // index破損の場合は修復してリトライ
        if (repairGitIndexIfCorrupted(vaultPath, detail)) {
            try { return await runStatus(); } catch (e2) {
                const d2 = [e2.stderr, e2.stdout, e2.message].filter(s => s && String(s).trim()).join('\n').trim();
                return fail(`git status 失敗:\n${d2}`, 'git-status');
            }
        }
        return fail(`git status 失敗:\n${detail}`, 'git-status');
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

/**
 * git index の破損を検知・修復する。
 * "index file smaller than expected" エラーは index ファイルが壊れた場合に発生する。
 * index を削除すると git が自動で再生成する（ステージング内容は失われるが作業ファイルは無事）。
 */
function repairGitIndexIfCorrupted(vaultPath, errorDetail) {
    if (!errorDetail || !errorDetail.includes('index file smaller than expected')) return false;
    try {
        const indexPath = path.join(vaultPath, '.git', 'index');
        if (fs.existsSync(indexPath)) {
            fs.unlinkSync(indexPath);
            console.log('[git-handler] 破損したgit indexを削除しました（自動再生成されます）');
            return true;
        }
    } catch (_) {}
    return false;
}

/**
 * iCloud Drive による "Stale NFS file handle" / "mmap failed" エラーを検知する。
 * VaultがiCloud Driveに保存されていると、.git/objectsがクラウドに退避されてgitが失敗する。
 */
function isICloudEvictError(errorDetail) {
    if (!errorDetail) return false;
    return errorDetail.includes('mmap failed') ||
           errorDetail.includes('Stale NFS') ||
           errorDetail.includes('stale NFS');
}

/**
 * iCloud Driveに退避された.git/objectsを強制ダウンロードする。
 * 1) packファイルを個別にダウンロード（優先度高）
 * 2) .git 全体を brctl download キューに追加
 * 3) git cat-file -t HEAD で最大30秒ポーリングしてダウンロード完了を確認
 */
async function downloadICloudGitObjects(vaultPath) {
    const gitDir = path.join(vaultPath, '.git');
    if (!fs.existsSync(gitDir)) return;
    console.log('[git-handler] iCloud退避ファイルをダウンロード中...');

    // pack ファイルを個別にダウンロード（ loose objects より優先）
    const packDir = path.join(gitDir, 'objects', 'pack');
    if (fs.existsSync(packDir)) {
        try {
            const packFiles = fs.readdirSync(packDir).map(f => path.join(packDir, f));
            for (const f of packFiles) {
                try { await _execFileAsync('brctl', ['download', f], { timeout: 10000 }); } catch (_) {}
            }
        } catch (_) {}
    }

    // .git 全体をダウンロードキューに追加（brctl は非同期なのですぐ返る）
    try {
        await _execFileAsync('brctl', ['download', gitDir], { timeout: 30000 });
    } catch (_) {}

    // ダウンロード完了を最大30秒待つ（3秒間隔で git オブジェクト読み取りを試行）
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            // HEAD オブジェクトが読める = pack ファイルが使える
            await gitExec(['cat-file', '-t', 'HEAD'], { cwd: vaultPath, timeout: 5000 });
            console.log(`[git-handler] iCloudダウンロード完了 (${(i + 1) * 3}秒後)`);
            return;
        } catch (_) {}
    }
    console.log('[git-handler] iCloudダウンロードタイムアウト（30秒）');
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

    const runBackup = async () => {
        await gitExec(['add', '-A'], { cwd: vaultPath, timeout: 60000 });
        await gitExec(['commit', '-m', buildCommitMsg(), '--allow-empty'], { cwd: vaultPath, timeout: 30000 });
        const { stdout: logOut } = await gitExec(['log', '-1', '--oneline'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        return ok({ commit: logOut.trim() });
    };
    try {
        return await runBackup();
    } catch (e) {
        const errDetail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
        // iCloud Drive退避エラーの場合は強制ダウンロードしてリトライ
        if (isICloudEvictError(errDetail)) {
            await downloadICloudGitObjects(vaultPath);
            try { return await runBackup(); } catch (e2) {
                const d2 = [e2.stderr, e2.stdout, e2.message].filter(Boolean).join('\n').trim();
                if (isICloudEvictError(d2)) {
                    return fail(
                        'iCloud DriveがVaultのgitファイルをクラウドに退避しています。\n' +
                        'Finderでこのフォルダを開き、.gitフォルダを右クリック→「ダウンロード」してから再試行してください:\n' +
                        vaultPath,
                        'git-backup'
                    );
                }
                return fail(d2 || e2, 'git-backup');
            }
        }
        // index破損の場合は修復してリトライ
        if (repairGitIndexIfCorrupted(vaultPath, errDetail)) {
            try { return await runBackup(); } catch (e2) {
                return fail([e2.stderr, e2.stdout, e2.message].filter(Boolean).join('\n').trim() || e2, 'git-backup');
            }
        }
        // ロックファイルエラーの場合、除去して1回リトライ
        if (errDetail.includes('index.lock') || errDetail.includes('Another git process')) {
            clearGitLocks(vaultPath);
            try { return await runBackup(); } catch (retryErr) {
                return fail([retryErr.stderr, retryErr.stdout, retryErr.message].filter(Boolean).join('\n').trim() || retryErr, 'git-backup');
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

    const runLog = async () => {
        const { stdout } = await gitExec(['log', '--format=%h\x1f%ci\x1f%s', '-30'], { cwd: vaultPath, encoding: 'utf-8', timeout: 15000 });
        const entries = stdout.trim().split('\n').filter(l => l.trim()).map(l => {
            const [hash, date, ...rest] = l.split('\x1f');
            return { hash: hash.trim(), date: date ? date.trim().slice(0, 16) : '', message: rest.join(' ').trim() };
        });
        return ok({ entries });
    };

    try {
        return await runLog();
    } catch (e) {
        const detail = [e.stderr, e.stdout, e.message].filter(s => s && String(s).trim()).join('\n').trim();
        // iCloud Drive退避エラーの場合は強制ダウンロードしてリトライ
        if (isICloudEvictError(detail)) {
            await downloadICloudGitObjects(vaultPath);
            try { return await runLog(); } catch (e2) {
                const d2 = [e2.stderr, e2.stdout, e2.message].filter(s => s && String(s).trim()).join('\n').trim();
                return fail(`git log 失敗 (iCloud退避):\n${d2}`, 'git-log');
            }
        }
        return fail(`git log 失敗:\n${detail}`, 'git-log');
    }
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

    // リモートURL設定（push 前に1回だけ確認）
    try {
        const { stdout: currentUrl } = await gitExec(['remote', 'get-url', 'origin'], { cwd: vaultPath, encoding: 'utf-8', timeout: 5000 });
        if (currentUrl.trim() !== settings.remoteUrl) {
            await gitExec(['remote', 'set-url', 'origin', settings.remoteUrl], { cwd: vaultPath, timeout: 5000 });
        }
    } catch (_) {
        await gitExec(['remote', 'add', 'origin', settings.remoteUrl], { cwd: vaultPath, timeout: 5000 });
    }

    const runPush = async () => {
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
    };

    try {
        return await runPush();
    } catch (e) {
        const errDetail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
        // iCloud Drive退避エラーの場合は強制ダウンロードしてリトライ
        if (isICloudEvictError(errDetail)) {
            await downloadICloudGitObjects(vaultPath);
            try {
                return await runPush();
            } catch (e2) {
                const d2 = [e2.stderr, e2.stdout, e2.message].filter(Boolean).join('\n').trim();
                if (isICloudEvictError(d2)) {
                    return fail(
                        'iCloud DriveがVaultのgitファイルをクラウドに退避しています。\n' +
                        'Finderでこのフォルダを開き、.gitフォルダを右クリック→「ダウンロード」してから再試行してください:\n' +
                        vaultPath,
                        'git-push'
                    );
                }
                return fail(d2 || String(e2), 'git-push');
            }
        }
        return fail(errDetail || String(e), 'git-push');
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
