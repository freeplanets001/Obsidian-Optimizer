/* ============================================================
   renderer.js – v4.3 Ultimate Edition
   ============================================================ */
'use strict';

let scanData = null;
let logCount = 0;
let isScanning = false;
let isOptimizing = false;
let isTrialMode = false;
let isLicensed = false;

const $ = id => document.getElementById(id);

// HTMLエスケープ（XSS対策）
function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// 統一プレビューモーダル API
// ============================================================
function showPreviewModal(options) {
    // options: { title, subtitle, content (HTML), rawText, actions: [{label, onClick, className}], footer: HTML }
    const overlay = $('preview-modal');
    const titleEl = $('preview-modal-title');
    const subtitleEl = $('preview-modal-subtitle');
    const bodyEl = $('preview-modal-body');
    const footerEl = $('preview-modal-footer');
    const actionsEl = $('preview-modal-actions');
    const closeBtn = $('preview-modal-close');

    if (!overlay) return;

    titleEl.textContent = options.title || 'プレビュー';
    subtitleEl.textContent = options.subtitle || '';

    if (options.content) {
        bodyEl.innerHTML = options.content;
    } else if (options.rawText) {
        bodyEl.innerHTML = '<pre>' + esc(options.rawText) + '</pre>';
    }

    // Actions (ヘッダーのボタン)
    actionsEl.innerHTML = '';
    if (options.actions) {
        options.actions.forEach(function(a) {
            const btn = document.createElement('button');
            btn.className = a.className || 'ghost-btn small-btn';
            btn.textContent = a.label;
            btn.addEventListener('click', a.onClick);
            actionsEl.appendChild(btn);
        });
    }

    // Footer
    footerEl.innerHTML = options.footer || '';
    footerEl.style.display = options.footer ? '' : 'none';

    overlay.style.display = 'flex';

    // 閉じるハンドラ
    const close = function() { overlay.style.display = 'none'; };
    closeBtn.onclick = close;
    overlay.onclick = function(e) { if (e.target === overlay) close(); };

    // Escapeキーで閉じる
    const escHandler = function(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);

    return { close: close, bodyEl: bodyEl, footerEl: footerEl, actionsEl: actionsEl };
}

function closePreviewModal() {
    const overlay = $('preview-modal');
    if (overlay) overlay.style.display = 'none';
}

// ============================================================
// 起動: ボタンを同期的にバインド → 非同期初期化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    bindAllButtons();
    bindTabNav();
    bindProgressListeners();
    bindHelpAccordions();
    initAsync();
});

function bindAllButtons() {
    const safe = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

    safe('btn-quick-scan', runScan);
    safe('btn-scan-now', runScan);
    safe('btn-cancel-scan', cancelScan);
    safe('btn-undo', runUndo);
    safe('btn-preview', runPreview);
    safe('btn-run-dryrun', runPreview);
    safe('btn-quick-optimize', () => activateTab('optimize'));
    safe('btn-run-optimize', runOptimize);
    safe('btn-open-vault', () => window.api.openVaultFolder().catch(console.error));
    safe('btn-export', runExport);
    safe('btn-export-data', runExportData);
    safe('btn-clear-log', clearLog);

    // Feature 1: ライセンス認証ボタン
    safe('btn-verify-license', () => verifyLicenseFromInput('license-key-input', 'license-error'));
    safe('btn-skip-license', () => {
        const modal = $('license-modal');
        if (modal) modal.style.display = 'none';
        isTrialMode = true;
        applyTrialRestrictions();
        showToast('トライアルモードで起動しました。スキャン機能のみ使用できます。', 'warn', 5000);
    });
    safe('btn-settings-verify-license', () => verifyLicenseFromInput('settings-license-key', 'settings-license-error'));

    // Feature 2: 更新チェック
    safe('btn-check-updates', () => checkForUpdates(false));

    // Feature 4: テーマ切り替え
    safe('btn-theme-toggle', toggleTheme);

    // ライセンスキー入力のオートフォーマット
    formatLicenseKeyInput($('license-key-input'));
    formatLicenseKeyInput($('settings-license-key'));

    // Vault スイッチャー / 追加 / 削除
    const vs = $('vault-switcher');
    if (vs) vs.addEventListener('change', e => { switchVault(parseInt(e.target.value, 10)); });
    safe('btn-add-vault', async () => {
        try {
            const vaults = await window.api.addVault();
            if (vaults) {
                await initAsync(); // 再読み込みして反映
                resetDashboard();
            }
        } catch (e) { addLog(`❌ Vault追加エラー: ${e.message}`, 'error'); }
    });
    safe('btn-remove-vault', async () => {
        const vs = $('vault-switcher');
        if (vs) {
            try {
                const result = await window.api.removeVault(parseInt(vs.value, 10));
                if (result && result.error) {
                    addLog(`⚠️ ${result.error}`, 'warn');
                } else if (result && result.vaults) {
                    await initAsync();
                    resetDashboard();
                }
            } catch (e) { addLog(`❌ Vault削除エラー: ${e.message}`, 'error'); }
        }
    });

    // スキャンタブ: 全選択 & 個別アクション
    safe('btn-select-all-orphan', () => selectAll('orphan-list', 'btn-delete-selected-orphan'));
    safe('btn-select-all-junk', () => selectAll('junk-list', 'btn-delete-selected-junk'));
    safe('btn-select-all-stale', () => selectAll('stale-list', ['btn-archive-stale', 'btn-preview-selected-stale']));
    safe('btn-select-all-broken', () => selectAll('broken-list', 'btn-fix-selected-broken'));
    safe('btn-delete-selected-orphan', () => deleteSelectedFromList('orphan-list'));
    safe('btn-delete-selected-junk', () => deleteSelectedFromList('junk-list'));
    safe('btn-archive-stale', () => moveSelectedToArchive('stale-list'));
    safe('btn-preview-selected-stale', () => previewSelectedNotes('stale-list', '放置ノート'));
    safe('btn-fix-selected-broken', fixSelectedBrokenLinks);
    safe('btn-fix-all-broken', fixAllSuggestedBrokenLinks);

    // プレビュータブ: 個別削除
    safe('btn-select-all-preview-junk', () => selectAll('preview-junk-list', 'btn-delete-preview-selected'));
    safe('btn-delete-preview-selected', () => deleteSelectedFromList('preview-junk-list'));

    // 設定: バックアップ・ゴミルール保存
    const optBackup = $('opt-backup');
    if (optBackup) optBackup.addEventListener('change', async e => {
        try { await window.api.saveConfigPartial({ backupBeforeDelete: e.target.checked }); } catch (e2) { addLog('設定保存エラー: ' + e2.message, 'error'); }
    });

    const optEnableJunk = $('opt-enable-junk');
    if (optEnableJunk) optEnableJunk.addEventListener('change', async e => {
        try { await window.api.saveConfigPartial({ enableJunk: e.target.checked }); } catch (e2) { addLog('設定保存エラー: ' + e2.message, 'error'); }
    });

    const junkAction = $('junk-action');
    if (junkAction) junkAction.addEventListener('change', async e => {
        try { await window.api.saveConfigPartial({ junkAction: e.target.value }); } catch (e2) { addLog('設定保存エラー: ' + e2.message, 'error'); }
    });

    const optEnableMoc = $('opt-enable-moc');
    if (optEnableMoc) optEnableMoc.addEventListener('change', async e => {
        try { await window.api.saveConfigPartial({ enableMoc: e.target.checked }); } catch (e2) { addLog('設定保存エラー: ' + e2.message, 'error'); }
    });
    safe('btn-save-junk-rules', saveJunkRules);

    // MOC生成（最適化タブ内の既存機能）
    safe('btn-gen-moc', runGenMoc);

    // MOC作成タブ（通常モード）
    safe('btn-create-moc', createMocFromUI);
    safe('btn-refresh-preview', async function() { await updateMocPreview(); showMocPreviewModal(); });
    safe('btn-save-as-template', saveCurrentAsTemplate);
    const advToggle = $('moc-advanced-toggle');
    if (advToggle) advToggle.addEventListener('click', toggleAdvancedSettings);

    // v4.2 MOC強化機能
    safe('btn-wizard-prev', prevWizardStep);
    safe('btn-wizard-next', nextWizardStep);
    safe('btn-wizard-create', createMocFromWizard);
    safe('btn-fetch-suggestions', fetchSmartSuggestions);

    // 既存MOCリフレッシュ
    const refreshToggle = $('moc-refresh-toggle');
    if (refreshToggle) refreshToggle.addEventListener('click', () => toggleCollapsible('moc-refresh-panel', 'moc-refresh-arrow'));
    safe('btn-refresh-check', refreshExistingMoc);
    safe('btn-refresh-apply', applyMocRefresh);

    // タグベースMOC候補
    const tagSuggestToggle = $('moc-tag-suggest-toggle');
    if (tagSuggestToggle) tagSuggestToggle.addEventListener('click', () => toggleCollapsible('moc-tag-suggest-panel', 'moc-tag-suggest-arrow'));
    safe('btn-load-tag-suggestions', loadTagMocSuggestions);

    // MOCマップ
    const mapToggle = $('moc-map-toggle');
    if (mapToggle) mapToggle.addEventListener('click', () => toggleCollapsible('moc-map-panel', 'moc-map-arrow'));
    safe('btn-load-moc-map', loadMocMap);

    // 一括生成
    safe('btn-batch-select-all', batchSelectAll);
    safe('btn-batch-generate', runBatchGenerate);

    // v4.3 新機能
    safe('btn-load-backups', loadBackupList);
    safe('btn-rename-tag', runRenameTag);
    safe('btn-select-all-orphan-image', () => selectAll('orphan-image-list', 'btn-delete-orphan-images'));
    safe('btn-delete-orphan-images', () => deleteSelectedFromList('orphan-image-list'));

    // Feature 3: ヘルスレポート出力
    safe('btn-health-report', runHealthReport);

    // Feature 9: ノートインポーター
    safe('btn-import-select-folder', selectImportFolder);
    safe('btn-import-select-file', selectImportFile);
    safe('btn-import-execute', executeImport);
    const importPathEl = $('import-path');
    if (importPathEl) importPathEl.addEventListener('input', () => {
        const btn = $('btn-import-execute');
        if (btn) btn.disabled = !importPathEl.value;
    });

    // Feature 11: MOCテンプレート共有
    safe('btn-import-moc-template', importMocTemplate);

    // 自動レポート設定
    const optAutoReport = $('opt-auto-report');
    if (optAutoReport) optAutoReport.addEventListener('change', async e => {
        try { await window.api.saveConfigPartial({ autoReportEnabled: e.target.checked }); } catch (e2) { addLog('設定保存エラー: ' + e2.message, 'error'); }
    });

    // Feature 4: ノートスコア
    safe('btn-load-note-scores', loadNoteScores);

    // Feature 10: 自動スキャンスケジュール
    const autoScanSel = $('auto-scan-schedule');
    if (autoScanSel) autoScanSel.addEventListener('change', async e => {
        try {
            const res = await window.api.setAutoScanSchedule(e.target.value);
            if (res.success) addLog(`⏰ 自動スキャン: ${e.target.value === 'off' ? 'オフ' : e.target.value === 'daily' ? '毎日' : '毎週'}`, 'success');
        } catch (e2) { addLog('設定保存エラー: ' + e2.message, 'error'); }
    });

    // Feature 12: ウィジェット設定
    safe('btn-widget-settings', openWidgetSettings);
    safe('btn-widget-settings-close', closeWidgetSettings);

    // MOCフォーム入力変更時にプレビュー自動更新（デバウンス付き）
    let mocPreviewTimer = null;
    const debouncedPreview = () => {
        if (mocPreviewTimer) clearTimeout(mocPreviewTimer);
        mocPreviewTimer = setTimeout(updateMocPreview, 400);
    };
    ['moc-name', 'moc-tags', 'moc-type', 'moc-dest-folder', 'moc-description',
     'moc-auto-tags', 'moc-css-classes'].forEach(id => {
        const el = $(id);
        if (el) el.addEventListener('input', debouncedPreview);
    });
    // MOC名の入力で作成ボタンの有効状態を更新
    const mocNameEl = $('moc-name');
    if (mocNameEl) mocNameEl.addEventListener('input', updateMocCreateBtnState);
    ['moc-auto-folders', 'moc-related-mocs'].forEach(id => {
        const el = $(id);
        if (el) el.addEventListener('change', debouncedPreview);
    });

    // スライダー表示
    const slider = $('junk-min-chars');
    if (slider) slider.addEventListener('input', e => {
        const d = $('junk-char-display'); if (d) d.textContent = e.target.value;
    });

    // 検索フィルター
    const so = $('search-orphan'); if (so) so.addEventListener('input', e => filterList('orphan-list', e.target.value));
    const sj = $('search-junk'); if (sj) sj.addEventListener('input', e => filterList('junk-list', e.target.value));
    const ss = $('search-stale'); if (ss) ss.addEventListener('input', e => filterList('stale-list', e.target.value));
    const sb = $('search-broken'); if (sb) sb.addEventListener('input', e => filterList('broken-list', e.target.value));

    // キーボードショートカット（拡張版）
    document.addEventListener('keydown', e => {
        // オンボーディング中はショートカット無効
        const onb = $('onboarding-overlay');
        if (onb && onb.style.display !== 'none') return;

        if (e.metaKey || e.ctrlKey) {
            switch (e.key) {
                case 's': e.preventDefault(); runScan(); break;
                case '1': e.preventDefault(); activateTab('dashboard'); break;
                case '2': e.preventDefault(); activateTab('scan-optimize'); break;
                case '3': e.preventDefault(); activateTab('moc-create'); break;
                case '4': e.preventDefault(); activateTab('analytics'); break;
                case '5': e.preventDefault(); activateTab('tools'); break;
                case '6': e.preventDefault(); activateTab('tasks'); break;
                case ',': e.preventDefault(); activateTab('settings'); break;
                case 'o': e.preventDefault(); activateTab('scan-optimize'); break;
                case 't': e.preventDefault(); activateTab('tasks'); break;
                case 'r': e.preventDefault(); runScan(); break;
                case 'e': e.preventDefault(); runExport(); break;
            }
        }
        // Escapeで全モーダルを閉じる
        if (e.key === 'Escape') {
            const widgetModal = $('widget-settings-modal');
            if (widgetModal && widgetModal.style.display !== 'none') {
                widgetModal.style.display = 'none';
            }
        }
    });

    // オンボーディングウィザード
    safe('onboarding-next-1', () => goOnboardingStep(2));
    safe('onboarding-select-vault', onboardingSelectVault);
    safe('onboarding-next-2', () => goOnboardingStep(3));
    safe('onboarding-run-scan', onboardingRunScan);
    safe('onboarding-next-3', () => goOnboardingStep(4));
    safe('onboarding-finish', finishOnboarding);

    // 整理ツール ボタンバインド
    safe('btn-org-scan-titles', orgScanTitles);
    safe('btn-org-scan-frontmatter', orgScanFrontmatter);
    safe('btn-org-fix-frontmatter-all', orgFixFrontmatterAll);
    safe('btn-org-scan-inbox', orgScanInbox);
    safe('btn-org-scan-split', orgScanSplit);
    safe('btn-org-scan-empty', orgScanEmpty);
    safe('btn-org-delete-empty', orgDeleteEmpty);
    safe('btn-org-scan-todos', orgScanTodos);
    safe('btn-org-scan-links', orgScanLinks);
    safe('btn-org-normalize-links', orgNormalizeLinks);
    safe('btn-org-scan-all', orgScanAll);
}

function bindTabNav() {
    document.querySelectorAll('.nav-item').forEach(btn =>
        btn.addEventListener('click', () => activateTab(btn.dataset.tab))
    );
    // サブタブのクリックイベント
    document.querySelectorAll('.sub-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const parentTab = btn.dataset.parent;
            const subTabId = btn.dataset.subtab;
            switchSubTab(parentTab, subTabId);
        });
    });
}

function bindProgressListeners() {
    try {
        window.api.onScanProgress(msg => { const el = $('loading-sub'); if (el) el.textContent = msg; });
        window.api.onOptimizeProgress(msg => setProgressMsg(msg));
    } catch (e) { console.warn('Progress listeners:', e); }
}

async function initAsync() {
    try {
        const cfg = await window.api.getConfig();
        applyConfig(cfg);
        // vault selector の更新
        const vs = $('vault-switcher');
        if (vs && cfg.vaults) {
            vs.innerHTML = '';
            cfg.vaults.forEach((v, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = v;
                if (i === cfg.currentVaultIndex) opt.selected = true;
                vs.appendChild(opt);
            });
        }
    } catch (e) { console.warn('getConfig failed:', e); }

    try {
        const check = await window.api.checkVault();
        // vaultPath表示の更新はもう必要ないか、設定画面用にある場合は更新
        updateVaultStatus(check);
        if (!check.valid) { showVaultWarning(check.vaultPath, check.noVault); activateTab('settings'); }
    } catch (e) { console.warn('checkVault failed:', e); }

    if (logCount === 0) addLog('アプリを起動しました (v4.3 — AI寺子屋 CraftLab)', 'info');
    checkUndoAvailability();

    // Feature 4: テーマ復元
    try {
        const cfg2 = await window.api.getConfig();
        if (cfg2.appTheme) applyTheme(cfg2.appTheme);
    } catch (_) { /* ignore */ }

    // Feature 1: ライセンス確認
    await checkLicenseStatus();

    // Feature 2: 起動5秒後にサイレント更新チェック
    setTimeout(() => { checkForUpdates(true); }, 5000);

    // オンボーディング: 初回起動チェック
    try {
        const cfg = await window.api.getConfig();
        if (!cfg.onboardingCompleted) {
            showOnboarding();
        }
    } catch (e) { /* ignore */ }
}

// ============================================================
// ユーティリティ
// ============================================================
let mocTabInitialized = false;

// 旧タブID → 新タブIDへのマッピング（タブ統合の後方互換性）
const TAB_MIGRATION_MAP = {
    'scan': 'scan-optimize',
    'preview': 'scan-optimize',
    'optimize': 'scan-optimize',
    'stats': 'analytics',
    'knowledge-graph': 'analytics',
    'graph': 'analytics',
    'archive': 'tools',
    'merge': 'tools',
    'structure': 'tools',
    'organize': 'tools',
    'log': 'settings'
};

// 旧タブID → 対応するサブタブID
const SUBTAB_MAP = {
    'scan': 'scan-results',
    'preview': 'preview',
    'optimize': 'optimize',
    'stats': 'stats',
    'knowledge-graph': 'knowledge-graph',
    'graph': 'graph-view',
    'archive': 'archive',
    'merge': 'merge',
    'structure': 'structure',
    'organize': 'organize-main',
    'log': null
};

function activateTab(tab) {
    // 旧タブIDを新タブIDにマッピング
    const originalTab = tab;
    if (TAB_MIGRATION_MAP[tab]) {
        const subTabId = SUBTAB_MAP[tab];
        tab = TAB_MIGRATION_MAP[tab];
        // サブタブも切り替え
        if (subTabId) {
            setTimeout(() => switchSubTab(tab, subTabId), 0);
        }
    }

    document.querySelectorAll('.nav-item').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (btn) { btn.classList.add('active'); btn.setAttribute('aria-selected', 'true'); }
    const el = $(`tab-${tab}`); if (el) el.classList.add('active');

    // MOC作成タブの遅延初期化
    if (tab === 'moc-create' && !mocTabInitialized) {
        mocTabInitialized = true;
        initMocTab();
    }
}

// サブタブ切り替え
function switchSubTab(parentTab, subTabId) {
    const parent = $(`tab-${parentTab}`);
    if (!parent) return;
    parent.querySelectorAll('.sub-tab').forEach(t => t.classList.toggle('active', t.dataset.subtab === subTabId));
    parent.querySelectorAll('.sub-tab-content').forEach(c => c.classList.toggle('active', c.id === 'subtab-' + subTabId));
}

function showLoading(msg, sub = '') {
    const ov = $('loading-overlay'); if (ov) ov.style.display = 'flex';
    const lm = $('loading-msg'); if (lm) lm.textContent = msg;
    const ls = $('loading-sub'); if (ls) ls.textContent = sub;
}
function hideLoading() { const ov = $('loading-overlay'); if (ov) ov.style.display = 'none'; }
function setProgressMsg(msg) { const el = $('progress-msg'); if (el) el.textContent = msg; }

function applyConfig(cfg) {
    const ob = $('opt-backup');
    if (ob) ob.checked = cfg.backupBeforeDelete !== false;

    // enableJunk / enableMoc はデフォルト true（main側の loadConfig で保証済み）
    const enableJunk = cfg.enableJunk !== false;
    const enableMoc = cfg.enableMoc !== false;

    const oj = $('opt-enable-junk');
    if (oj) oj.checked = enableJunk;
    const ja = $('junk-action');
    if (ja) ja.value = cfg.junkAction || 'delete';
    const om = $('opt-enable-moc');
    if (om) om.checked = enableMoc;

    const optJunk = $('opt-junk');
    if (optJunk) optJunk.checked = enableJunk;
    const optOrphan = $('opt-orphan');
    if (optOrphan) optOrphan.checked = enableMoc;
    const optAutoReport = $('opt-auto-report');
    if (optAutoReport) optAutoReport.checked = cfg.autoReportEnabled || false;
    if (cfg.junkRules) {
        const sl = $('junk-min-chars'); if (sl) { sl.value = cfg.junkRules.minChars ?? 20; const d = $('junk-char-display'); if (d) d.textContent = sl.value; }
        const nb = $('junk-min-bytes'); if (nb) nb.value = cfg.junkRules.minBytes ?? 5;
        const kw = $('junk-keywords'); if (kw) kw.value = (cfg.junkRules.keywords || ['untitled', '無題']).join('\n');
    }
    // Feature 10: 自動スキャンスケジュール
    const autoScanSel = $('auto-scan-schedule');
    if (autoScanSel) autoScanSel.value = cfg.autoScanSchedule || 'off';
    // Feature 12: ウィジェット設定の復元
    if (cfg.dashboardWidgets) {
        applyWidgetVisibility(cfg.dashboardWidgets);
    }
}

async function switchVault(index) {
    try {
        const newPath = await window.api.switchVault(index);
        addLog(`📂 Vault 切り替え: ${newPath}`, 'info');
        const check = await window.api.checkVault();
        updateVaultStatus(check);
        resetDashboard();
    } catch (e) { addLog(`❌ Vault 切り替えエラー: ${e.message}`, 'error'); }
}

function updateVaultStatus(check) {
    const el = $('vault-status-text');
    if (!el) return;
    if (check.valid) {
        el.className = 'vault-status-ok';
        el.textContent = `✅ Vault を確認 (${(check.foundFolders || []).join(', ')})`;
    } else {
        el.className = 'vault-status-err';
        el.textContent = '⚠️ 有効な Obsidian Vault が見つかりません。「追加」で指定してください。';
    }
}

function showVaultWarning(vaultPath, noVault) {
    const settingsTab = $('tab-settings'); if (!settingsTab) return;
    const old = document.getElementById('vault-warn-banner'); if (old) old.remove();
    const b = document.createElement('div');
    b.id = 'vault-warn-banner';
    b.style.cssText = 'background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.35);border-radius:14px;padding:14px 18px;margin-bottom:16px;color:#f87171;font-size:.84rem;line-height:1.7';
    if (noVault) {
        b.innerHTML = `⚠️ <strong>Vault が設定されていません</strong><br>「➕ 追加」ボタンから Obsidian の Vault フォルダを選択してください。<br><span style="font-size:.76rem;opacity:.7">Vault フォルダとは、Obsidian で管理しているノートが入っているフォルダです（中に .obsidian フォルダがあります）。</span>`;
    } else {
        b.innerHTML = `⚠️ <strong>Vault が見つかりません</strong><br>パス: <code style="font-size:.76rem">${esc(vaultPath)}</code><br>フォルダが存在しないか、Obsidian Vault として認識できません。「➕ 追加」ボタンで正しい Vault を選択してください。`;
    }
    settingsTab.insertBefore(b, settingsTab.children[1] || null);
}

function resetDashboard() {
    scanData = null;
    ['h-orphans', 'h-junk', 'h-stale', 'h-total', 'h-mocs', 'h-links', 'h-broken'].forEach(id => { const el = $(id); if (el) el.textContent = '-'; });
    const hs = $('health-score'); if (hs) hs.textContent = '--';
    setHealthRing(0);
    const fc = $('folder-chart'); if (fc) fc.innerHTML = '';
    const hm = $('heatmap-container'); if (hm) hm.innerHTML = '';
    ['btn-quick-optimize', 'btn-run-optimize', 'btn-preview', 'btn-export', 'btn-export-data', 'export-format'].forEach(id => { const el = $(id); if (el) el.disabled = true; });
    // お気に入りを再読み込み
    if (typeof loadFavorites === 'function') loadFavorites();
}

function showScanError(errorMsg) {
    // ダッシュボード上にエラーバナーを表示
    const dashboard = $('tab-dashboard');
    if (!dashboard) return;
    const old = document.getElementById('scan-error-banner');
    if (old) old.remove();
    const banner = document.createElement('div');
    banner.id = 'scan-error-banner';
    banner.style.cssText = 'background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.35);border-radius:14px;padding:14px 18px;margin-bottom:16px;color:#f87171;font-size:.84rem;line-height:1.7';
    const isNoVault = (errorMsg || '').includes('設定されていません');
    if (isNoVault) {
        banner.innerHTML = `❌ <strong>スキャンできません</strong> — Vault が設定されていません。<br><button class="ghost-btn small-btn" onclick="activateTab('settings')" style="margin-top:6px">⚙️ 設定タブでVaultを追加する</button>`;
    } else {
        banner.innerHTML = `❌ <strong>スキャン失敗</strong>: ${esc(errorMsg)}`;
    }
    // ヒートマップカードの前に挿入
    const heatmapCard = $('heatmap-card');
    if (heatmapCard) {
        dashboard.insertBefore(banner, heatmapCard);
    } else {
        dashboard.appendChild(banner);
    }
}

async function saveJunkRules() {
    const minChars = parseInt($('junk-min-chars')?.value || '20', 10);
    const minBytes = parseInt($('junk-min-bytes')?.value || '5', 10);
    const kwRaw = $('junk-keywords')?.value || 'untitled\n無題';
    const keywords = kwRaw.split('\n').map(k => k.trim()).filter(Boolean);
    try {
        await window.api.saveConfigPartial({ junkRules: { minChars, minBytes, keywords } });
        addLog(`💾 ゴミ判定ルールを保存しました`, 'success', 'CONFIG');
    } catch (e) { addLog(`❌ 保存失敗: ${e.message}`, 'error', 'CONFIG'); }
}

// ============================================================
// ヘルスリング
// ============================================================
function setHealthRing(score) {
    const ring = $('health-ring-fg'); if (!ring) return;
    ring.style.strokeDashoffset = 314 - (score / 100) * 314;
    const color = score >= 80 ? '#34d399' : score >= 50 ? '#f59e0b' : '#f87171';
    ring.style.stroke = color;
    const hs = $('health-score'); if (hs) { hs.textContent = score; hs.style.color = color; }
}

// ============================================================
// スキャン
// ============================================================
// 元に戻すボタンの表示状態を更新
async function checkUndoAvailability() {
    try {
        const res = await window.api.checkUndo();
        const btn = $('btn-undo');
        if (btn) {
            btn.style.display = res.available ? 'inline-block' : 'none';
        }
    } catch (_) { /* ignore */ }
}

async function runUndo() {
    if (!await showConfirmModal('確認', '最後の操作を元に戻しますか？\n削除されたファイルがバックアップから復元されます。', '元に戻す')) return;
    showLoading('操作を元に戻しています...', 'バックアップからファイルを復元しています');
    try {
        const res = await window.api.undoLastOperation();
        hideLoading();
        if (res.success) {
            addLog(`↩ 元に戻す完了: ${res.restored}ファイルを復元しました`, 'success', 'OPT');
            const btn = $('btn-undo');
            if (btn) btn.style.display = 'none';
            await runScan();
        } else {
            addLog(`❌ 元に戻す失敗: ${res.error}`, 'error', 'OPT');
        }
    } catch (e) {
        hideLoading();
        addLog(`❌ 元に戻すエラー: ${e.message}`, 'error', 'OPT');
    }
}

async function cancelScan() {
    try {
        await window.api.cancelScan();
        addLog('スキャンをキャンセルしました', 'warn', 'SCAN');
    } catch (e) {
        console.warn('キャンセル失敗:', e);
    }
}

async function runScan() {
    if (isScanning) return;
    isScanning = true;
    showLoading('Vault をスキャン中...', 'ファイルを解析しています');
    // キャンセルボタンを表示
    const cancelBtn = $('btn-cancel-scan');
    if (cancelBtn) cancelBtn.style.display = 'inline-block';
    addLog('🔍 スキャン開始', 'info', 'SCAN');
    ['btn-quick-scan', 'btn-scan-now'].forEach(id => { const el = $(id); if (el) el.disabled = true; });

    let res;
    try { res = await window.api.scanVault(); }
    catch (e) { res = { success: false, error: e.message }; }

    hideLoading();
    if (cancelBtn) cancelBtn.style.display = 'none';
    isScanning = false;
    ['btn-quick-scan', 'btn-scan-now'].forEach(id => { const el = $(id); if (el) el.disabled = false; });

    if (!res.success) {
        addLog(`❌ スキャン失敗: ${res.error}`, 'error', 'SCAN');
        // ダッシュボードにエラーを視覚表示（Vault未設定の場合は設定タブへ誘導）
        showScanError(res.error);
        return;
    }

    // スキャン成功時はエラーバナーを消す
    const errBanner = document.getElementById('scan-error-banner');
    if (errBanner) errBanner.remove();

    scanData = res.stats;
    const st = $('last-scan-time'); if (st) st.textContent = new Date().toLocaleTimeString('ja-JP');

    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('h-total', scanData.totalMDFiles);
    set('h-mocs', scanData.mocsCount);
    set('h-orphans', scanData.orphanNotes);
    set('h-junk', scanData.junkFiles);
    set('h-links', scanData.totalLinks);
    set('h-broken', scanData.brokenLinksCount || 0);
    set('h-stale', scanData.staleList ? scanData.staleList.length : 0);

    const dupCount = (scanData.duplicateList || []).length;
    const staleCount = (scanData.staleList || []).length;
    const penalty = Math.min(scanData.orphanNotes * 0.35, 35)
        + Math.min(scanData.junkFiles * 2, 25)
        + Math.min((scanData.brokenLinksCount || 0) * 0.5, 15)
        + Math.min(dupCount, 10)
        + Math.min(staleCount * 0.1, 10);
    setHealthRing(Math.max(0, Math.round(100 - penalty)));

    const problems = scanData.orphanNotes + scanData.junkFiles + (scanData.brokenLinksCount || 0);
    const sb = $('nav-badge-scan');
    if (sb) { sb.style.display = problems > 0 ? 'inline' : 'none'; sb.textContent = problems; }

    renderFolderChart(scanData.folderStructure);
    // MOCプルダウンの更新
    const mocSel = $('moc-folder-select');
    const destSel = $('moc-dest-select');
    if (scanData.folderStructure) {
        // (root) はファイルシステム上の実フォルダではないためMOC操作プルダウンから除外
        const folders = Object.keys(scanData.folderStructure).filter(f => f !== '(root)');
        if (mocSel) {
            mocSel.innerHTML = '';
            folders.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f; opt.textContent = f;
                mocSel.appendChild(opt);
            });
        }
        if (destSel) {
            destSel.innerHTML = '<option value="">（対象フォルダと同じ場所）</option>';
            folders.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f; opt.textContent = f;
                destSel.appendChild(opt);
            });
        }
    }

    set('badge-orphan', scanData.orphanNotes);
    set('badge-junk', scanData.junkFiles);
    set('badge-stale', scanData.staleList ? scanData.staleList.length : 0);

    renderCheckableList('orphan-list', 'orphan-empty', scanData.orphanList, 'orphan', 'btn-delete-selected-orphan');
    renderCheckableList('junk-list', 'junk-empty', scanData.junkList, 'junk', 'btn-delete-selected-junk');
    renderCheckableList('stale-list', 'stale-empty', scanData.staleList, 'stale', ['btn-archive-stale', 'btn-preview-selected-stale']);

    renderBrokenLinks(scanData.brokenLinkList || []);
    renderDupList(scanData.duplicateList || []);
    renderTagChart(scanData.topTags || []);
    renderRareTags(scanData.rareTags || []);
    renderSummary(scanData);
    renderHeatmap(scanData.heatmap || {});

    // v4.3 新機能
    renderOrphanImages(scanData.orphanImages || []);
    renderRecommendedActions(scanData);
    renderScanDiff(scanData);

    // Feature 5: スナップショット保存 & 推移グラフ
    saveVaultSnapshotAndRenderTrends(scanData);
    // Feature 8: 実績更新
    updateAchievementsAfterScan(scanData);
    // Feature 8: 実績バッジ表示
    renderAchievements();

    ['btn-quick-optimize', 'btn-run-optimize', 'btn-preview', 'btn-export', 'btn-export-data', 'export-format'].forEach(id => { const el = $(id); if (el) el.disabled = false; });
    const rh = $('run-btn-hint'); if (rh) rh.textContent = `孤立:${scanData.orphanNotes}件 / ゴミ:${scanData.junkFiles}件`;
    const optHint = $('btn-run-optimize-hint'); if (optHint) optHint.style.display = 'none';

    addLog(`✅ スキャン完了 — ノート:${scanData.totalMDFiles} / 孤立:${scanData.orphanNotes} / 放置:${scanData.staleList ? scanData.staleList.length : 0}`, 'success', 'SCAN');
}

// ============================================================
// レンダリング: Heatmap
// ============================================================
function renderHeatmap(heatmapData) {
    const container = $('heatmap-container');
    if (!container) return;
    container.innerHTML = ''; // clear

    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const now = new Date();
    // GitHub草風ヒートマップ: 過去1年分を日曜始まりの週単位で描画
    // 開始日を「約52週前の日曜日」に揃える
    const rawStart = new Date(now.getTime() - 52 * 7 * MS_PER_DAY);
    const startDate = new Date(rawStart.getTime() - rawStart.getDay() * MS_PER_DAY); // 直前の日曜日
    const totalDays = Math.floor((now.getTime() - startDate.getTime()) / MS_PER_DAY) + 1;
    const totalWeeks = Math.ceil(totalDays / 7);

    // SVG構築 (GitHub草風)
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    const cellSize = 13;
    const gap = 3;
    svg.setAttribute('width', (totalWeeks * (cellSize + gap)) + "px");
    svg.setAttribute('height', (7 * (cellSize + gap)) + "px");

    let g = document.createElementNS(svgNS, "g");

    for (let i = 0; i < totalDays; i++) {
        const d = new Date(startDate.getTime() + i * MS_PER_DAY);
        const iso = d.toISOString().split('T')[0];
        const count = heatmapData[iso] || 0;

        const day = d.getDay(); // 0(Sun) - 6(Sat) → 行
        const week = Math.floor(i / 7); // 日曜始まりなので i/7 で正しい週列になる

        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute('class', 'heatmap-cell');
        rect.setAttribute('x', week * (cellSize + gap));
        rect.setAttribute('y', day * (cellSize + gap));
        rect.setAttribute('width', cellSize);
        rect.setAttribute('height', cellSize);

        // 色付け
        let fill = 'rgba(255,255,255,0.03)';
        if (count > 0) fill = 'rgba(124, 108, 248, 0.2)';
        if (count > 2) fill = 'rgba(124, 108, 248, 0.5)';
        if (count > 5) fill = 'rgba(124, 108, 248, 0.8)';
        if (count > 10) fill = '#7c6cf8';
        rect.setAttribute('fill', fill);

        // ツールチップ用
        const title = document.createElementNS(svgNS, "title");
        title.textContent = `${iso}: ${count}件更新`;
        rect.appendChild(title);

        g.appendChild(rect);
    }
    svg.appendChild(g);
    container.appendChild(svg);
}


// ============================================================
// チェックボックス付きリスト (Orphan, Junk, Stale)
// ============================================================
function renderCheckableList(listId, emptyId, items, type, actionBtnId) {
    const listEl = $(listId);
    const emptyEl = $(emptyId);
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!items || items.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        setActionButtonsDisabled(actionBtnId, true);
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    items.slice(0, 300).forEach(item => {
        const div = document.createElement('div');
        div.className = 'list-item-check';
        div.setAttribute('data-name', (item.name || '').toLowerCase());
        div.setAttribute('data-path', item.path || '');

        // ツールチップ: パス、サイズ、最終更新日
        const tooltipParts = [];
        if (item.path) tooltipParts.push(`パス: ${item.path}`);
        if (item.size != null) {
            const sizeStr = item.size > 1024 * 1024
                ? `${(item.size / 1024 / 1024).toFixed(1)} MB`
                : `${(item.size / 1024).toFixed(1)} KB`;
            tooltipParts.push(`サイズ: ${sizeStr}`);
        }
        if (item.days != null) tooltipParts.push(`最終更新: ${item.days}日前`);
        const tooltip = tooltipParts.join('\n');

        let chip = '';
        let meta = '';
        if (type === 'junk') {
            chip = `<span class="tag-chip chip-junk">${esc(item.reason || 'ゴミ')}</span>`;
        } else if (type === 'orphan') {
            chip = `<span class="tag-chip chip-orphan">孤立</span>`;
        } else if (type === 'stale') {
            chip = `<span class="tag-chip count-badge stale" style="border:1px solid rgba(96,165,250,.28)">放置</span>`;
            meta = `<span class="item-meta">${esc(String(item.days))}日前</span>`;
        }

        div.innerHTML = `
            <input type="checkbox" class="item-cb">
            <div class="item-body" title="${esc(tooltip)}">
                ${chip}
                <span class="item-name" title="${esc(item.name)}">${esc(item.name)}</span>
                ${meta}
            </div>
        `;
        // チェックボックスのイベント（inline onchange を排除）
        const cb = div.querySelector('.item-cb');
        if (cb) cb.addEventListener('change', () => onCheckChange(listId, actionBtnId));
        // Feature 3: プレビューボタン
        if (item.path) {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'obsidian-btn';
            previewBtn.textContent = '👁️';
            previewBtn.title = 'プレビュー';
            previewBtn.addEventListener('click', () => toggleNotePreview(div, item.path));
            div.appendChild(previewBtn);
        }
        // 「開く」ボタン（addEventListener で安全にパスを渡す）
        const openBtn = document.createElement('button');
        openBtn.className = 'obsidian-btn';
        openBtn.textContent = '🔗 開く';
        openBtn.addEventListener('click', () => window.api.openInObsidian(item.path || ''));
        div.appendChild(openBtn);
        listEl.appendChild(div);
    });
}

function normalizeActionButtons(actionBtnIds) {
    if (Array.isArray(actionBtnIds)) return actionBtnIds.filter(Boolean);
    return actionBtnIds ? [actionBtnIds] : [];
}

function setActionButtonsDisabled(actionBtnIds, disabled) {
    normalizeActionButtons(actionBtnIds).forEach(id => {
        const btn = $(id);
        if (btn) btn.disabled = disabled;
    });
}

function onCheckChange(listId, actionBtnIds) {
    const checked = document.querySelectorAll(`#${listId} .item-cb:checked`).length;
    setActionButtonsDisabled(actionBtnIds, checked === 0);
}

function selectAll(listId, actionBtnIds) {
    const boxes = Array.from(document.querySelectorAll(`#${listId} .item-cb`)).filter(b => !b.disabled);
    if (boxes.length === 0) {
        setActionButtonsDisabled(actionBtnIds, true);
        return;
    }
    const allChecked = boxes.every(b => b.checked);
    boxes.forEach(b => b.checked = !allChecked);
    onCheckChange(listId, actionBtnIds);
}

// 削除
async function deleteSelectedFromList(listId) {
    const checked = Array.from(document.querySelectorAll(`#${listId} .item-cb:checked`));
    if (checked.length === 0) return;
    const paths = checked.map(cb => cb.closest('.list-item-check')?.getAttribute('data-path')).filter(Boolean);
    if (paths.length === 0) return;

    if (!await showConfirmModal('削除の確認', `ファイル ${paths.length}件 を削除します。\n\n⚡ バックアップについて\n設定で『削除前にバックアップを作成』がオンの場合、自動的にバックアップが保存されます。`, '削除する')) return;

    showLoading(`${paths.length} 件を削除中...`, 'ファイルを安全に削除しています');
    let res;
    try { res = await window.api.deleteSelected(paths); }
    catch (e) { res = { success: false, error: e.message }; }
    hideLoading();

    if (!res.success) { addLog(`❌ 削除失敗: ${res.error}`, 'error'); return; }
    addLog(`🗑️ 削除完了: ${res.results.deleted}件`, 'success', 'OPT');
    await checkUndoAvailability();
    await runScan();
}

// 移動・アーカイブ
async function moveSelectedToArchive(listId) {
    const checked = Array.from(document.querySelectorAll(`#${listId} .item-cb:checked`));
    if (checked.length === 0) return;
    const filePaths = checked.map(cb => cb.closest('.list-item-check')?.getAttribute('data-path')).filter(Boolean);
    if (filePaths.length === 0) return;

    if (!await showConfirmModal('アーカイブの確認', `ファイル ${filePaths.length}件 をアーカイブに移動します。\n\n⚡ バックアップについて\n設定で『削除前にバックアップを作成』がオンの場合、自動的にバックアップが保存されます。`, '移動する')) return;

    showLoading(`${filePaths.length} 件をアーカイブに移動中...`, 'ファイルをアーカイブフォルダへ移動しています');
    try {
        const res = await window.api.moveSelected({ filePaths, targetFolder: '99 Archive' });
        hideLoading();
        if (res.success) {
            addLog(`📦 99 Archive へ移動完了: ${res.moved}件`, 'success');
            await runScan();
        } else {
            addLog(`❌ 移動失敗: ${res.error}`, 'error');
        }
    } catch (e) {
        hideLoading();
        addLog(`❌ 移動エラー: ${e.message}`, 'error');
    }
}


function filterList(listId, query) {
    const items = document.querySelectorAll(`#${listId} .list-item-check`);
    const q = (query || '').toLowerCase();
    items.forEach(item => { item.style.display = (item.getAttribute('data-name') || '').includes(q) ? '' : 'none'; });
}

async function previewSelectedNotes(listId, label = 'ノート') {
    const checked = Array.from(document.querySelectorAll(`#${listId} .item-cb:checked`));
    if (checked.length === 0) {
        addLog(`⚠️ ${label}を選択してください`, 'warn');
        return;
    }
    // 最初の選択ノートをモーダルでプレビュー
    const firstRow = checked[0].closest('.list-item-check');
    if (firstRow) {
        const fp = firstRow.getAttribute('data-path');
        if (fp) {
            await toggleNotePreview(firstRow, fp);
            addLog(`👁️ ${label}のプレビューを表示 (選択: ${checked.length}件)`, 'success');
        }
    }
}

// ============================================================
// 壊れたリンク一覧 (ファジー修復付き)
// ============================================================
function isMarkdownPath(p) {
    return typeof p === 'string' && /\.md$/i.test(p);
}

async function openItemPath(filePath) {
    if (!filePath) return;
    try {
        if (isMarkdownPath(filePath)) {
            await window.api.openInObsidian(filePath);
        } else {
            await window.api.openPath(filePath);
        }
    } catch (e) {
        addLog(`❌ 開く操作に失敗: ${e.message}`, 'error');
    }
}

window.fixBroken = async function (srcFile, oldTarget, newTarget, options = {}) {
    const { refresh = true } = options;
    try {
        const res = await window.api.fixBrokenLink({ srcFile, oldTarget, newTarget });
        if (res.success) {
            addLog(`✨ リンク修復: [[${oldTarget}]] → [[${newTarget}]]`, 'success');
            if (refresh) await runScan();
            return true;
        } else {
            addLog(`❌ 修復エラー: ${res.error}`, 'error');
            return false;
        }
    } catch (e) {
        addLog(`❌ リンク修復エラー: ${e.message}`, 'error');
        return false;
    }
}

function getBrokenRows({ selectedOnly = false, fixableOnly = false } = {}) {
    const rows = Array.from(document.querySelectorAll('#broken-list .broken-link-row'));
    return rows.filter(row => {
        if (selectedOnly) {
            const cb = row.querySelector('.item-cb');
            if (!cb || !cb.checked) return false;
        }
        if (fixableOnly && row.getAttribute('data-fixable') !== '1') return false;
        return true;
    });
}

async function runBatchBrokenFix(rows) {
    let fixed = 0;
    let failed = 0;
    const seen = new Set();
    for (const row of rows) {
        const srcFile = row.getAttribute('data-src-file') || '';
        const oldTarget = row.getAttribute('data-old-target') || '';
        const newTarget = row.getAttribute('data-new-target') || '';
        if (!srcFile || !oldTarget || !newTarget) continue;

        const key = `${srcFile}::${oldTarget}::${newTarget}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const ok = await window.fixBroken(srcFile, oldTarget, newTarget, { refresh: false });
        if (ok) fixed++;
        else failed++;
    }
    return { fixed, failed };
}

async function fixSelectedBrokenLinks() {
    const rows = getBrokenRows({ selectedOnly: true, fixableOnly: true });
    if (rows.length === 0) {
        addLog('⚠️ 修復候補のある壊れたリンクを選択してください', 'warn');
        return;
    }
    showLoading(`壊れたリンクを修復中... (${rows.length}件)`, 'リンク先を候補に置換しています');
    const result = await runBatchBrokenFix(rows);
    hideLoading();
    addLog(`🛠️ 一括修復結果: 成功${result.fixed}件 / 失敗${result.failed}件`, result.failed ? 'warn' : 'success');
    if (result.fixed > 0) await runScan();
}

async function fixAllSuggestedBrokenLinks() {
    const rows = getBrokenRows({ fixableOnly: true });
    if (rows.length === 0) {
        addLog('ℹ️ 自動修復候補のある壊れたリンクはありません', 'info');
        return;
    }
    showLoading(`壊れたリンクを一括修復中... (${rows.length}件)`, 'リンク先を候補に置換しています');
    const result = await runBatchBrokenFix(rows);
    hideLoading();
    addLog(`🛠️ 一括修復結果: 成功${result.fixed}件 / 失敗${result.failed}件`, result.failed ? 'warn' : 'success');
    if (result.fixed > 0) await runScan();
}

function renderBrokenLinks(list) {
    const card = $('broken-card');
    const container = $('broken-list');
    const badge = $('badge-broken');
    const fixSelectedBtn = $('btn-fix-selected-broken');
    const fixAllBtn = $('btn-fix-all-broken');
    if (!container) return;
    container.innerHTML = '';
    if (list.length === 0) {
        if (card) card.style.display = 'none';
        if (fixSelectedBtn) fixSelectedBtn.disabled = true;
        if (fixAllBtn) fixAllBtn.disabled = true;
        return;
    }
    if (card) card.style.display = 'block';
    if (badge) badge.textContent = list.length;

    const seen = new Set();
    let fixableCount = 0;
    list.forEach(({ src, dest, suggestions, srcFile }) => {
        const key = `${srcFile || src}::${dest}`;
        if (seen.has(key)) return;
        seen.add(key);

        const allSuggestions = (suggestions && suggestions.length > 0) ? suggestions.slice(0, 3) : [];
        const defaultSuggestion = allSuggestions.length > 0 ? allSuggestions[0] : '';
        if (defaultSuggestion) fixableCount++;

        const div = document.createElement('div');
        div.className = 'list-item-check broken-link-row';
        div.setAttribute('data-name', `${src || ''} ${dest || ''}`.toLowerCase());
        div.setAttribute('data-src-file', srcFile || '');
        div.setAttribute('data-old-target', dest || '');
        div.setAttribute('data-new-target', defaultSuggestion);
        div.setAttribute('data-fixable', defaultSuggestion ? '1' : '0');
        div.innerHTML = `
            <input type="checkbox" class="item-cb">
            <div class="item-body">
                <span class="tag-chip chip-junk">切れ</span>
                <span class="broken-src" title="${esc(src)}">[[${esc(src)}]]</span>
                <span class="broken-arrow">→</span>
                <span class="broken-dest" title="${esc(dest)}">[[${esc(dest)}]]</span>
            </div>
        `;

        const cb = div.querySelector('.item-cb');
        if (cb && !defaultSuggestion) {
            cb.disabled = true;
            cb.title = '修復候補がないため選択できません';
        }
        if (cb) cb.addEventListener('change', () => onCheckChange('broken-list', 'btn-fix-selected-broken'));

        if (srcFile) {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'obsidian-btn';
            previewBtn.textContent = '👁️';
            previewBtn.title = 'ソースノートをプレビュー';
            previewBtn.addEventListener('click', () => toggleNotePreview(div, srcFile));
            div.appendChild(previewBtn);

            const openBtn = document.createElement('button');
            openBtn.className = 'obsidian-btn';
            openBtn.textContent = '🔗 開く';
            openBtn.title = 'ソースノートを開く';
            openBtn.addEventListener('click', () => openItemPath(srcFile));
            div.appendChild(openBtn);
        }

        if (allSuggestions.length > 0) {
            const fixDiv = document.createElement('div');
            fixDiv.className = 'broken-link-fix broken-link-candidates';
            const candidateLabel = document.createElement('span');
            candidateLabel.className = 'broken-sug-label';
            candidateLabel.textContent = '修復候補:';
            fixDiv.appendChild(candidateLabel);

            allSuggestions.forEach((sug, idx) => {
                const sugBtn = document.createElement('button');
                sugBtn.className = 'broken-candidate-btn' + (idx === 0 ? ' selected' : '');
                sugBtn.textContent = sug;
                sugBtn.title = `[[${dest}]] → [[${sug}]]`;
                sugBtn.addEventListener('click', () => {
                    // 選択状態を更新
                    fixDiv.querySelectorAll('.broken-candidate-btn').forEach(b => b.classList.remove('selected'));
                    sugBtn.classList.add('selected');
                    div.setAttribute('data-new-target', sug);
                });
                fixDiv.appendChild(sugBtn);
            });

            const fixBtn = document.createElement('button');
            fixBtn.className = 'obsidian-btn';
            fixBtn.textContent = '✨ 修復';
            fixBtn.addEventListener('click', async () => {
                const selectedTarget = div.getAttribute('data-new-target');
                const ok = await window.fixBroken(srcFile, dest, selectedTarget, { refresh: false });
                if (ok) await runScan();
            });
            fixDiv.appendChild(fixBtn);
            div.appendChild(fixDiv);
        } else {
            const noFix = document.createElement('span');
            noFix.className = 'item-meta';
            noFix.textContent = '候補なし';
            div.appendChild(noFix);
        }

        container.appendChild(div);
    });

    if (fixAllBtn) fixAllBtn.disabled = fixableCount === 0;
    if (fixSelectedBtn) fixSelectedBtn.disabled = true;
}

// ============================================================
// 重複ノート
// ============================================================
function renderDupList(groups) {
    const dupCard = $('dup-card');
    const container = $('dup-list');
    const badge = $('badge-dup');
    if (!container) return;
    container.innerHTML = '';
    if (groups.length === 0) { if (dupCard) dupCard.style.display = 'none'; return; }
    if (dupCard) dupCard.style.display = 'block';
    if (badge) badge.textContent = groups.length;
    groups.forEach(group => {
        const isArray = Array.isArray(group);
        const type = isArray ? '名前重複' : group.type;
        const files = isArray ? group : group.files;
        const div = document.createElement('div');
        div.className = 'list-item-check';
        div.innerHTML = `<span class="tag-chip chip-dup">${esc(type)}</span><span class="item-name">${files.map(esc).join(' ↔ ')}</span>`;
        container.appendChild(div);
    });
}

// ============================================================
// レアタグ / タグチャート
// ============================================================
function renderTagChart(topTags) {
    const container = $('tag-chart');
    const empty = $('tags-empty');
    if (!container) return;
    container.innerHTML = '';
    if (!topTags || topTags.length === 0) { if (empty) empty.style.display = 'block'; return; }
    if (empty) empty.style.display = 'none';
    const max = topTags[0].count;
    topTags.forEach(({ tag, count }) => {
        const pct = Math.round((count / max) * 100);
        const row = document.createElement('div');
        row.className = 'tag-row';
        row.innerHTML = `<span class="tag-name" title="#${esc(tag)}">#${esc(tag)}</span><div class="tag-bar-bg"><div class="tag-bar-fill" style="width:0" data-pct="${pct}"></div></div><span class="tag-count">${count}</span>`;
        container.appendChild(row);
    });
    requestAnimationFrame(() => { document.querySelectorAll('.tag-bar-fill').forEach(b => { b.style.width = b.dataset.pct + '%'; }); });
}

function renderRareTags(rareTags) {
    const container = $('rare-tags-list');
    const badge = $('badge-rare-tags');
    const empty = $('rare-tags-empty');
    if (!container) return;
    container.innerHTML = '';
    if (!rareTags || rareTags.length === 0) {
        if (empty) empty.style.display = 'block';
        if (badge) badge.textContent = 0;
        return;
    }
    if (empty) empty.style.display = 'none';
    if (badge) badge.textContent = rareTags.length;

    rareTags.forEach(({ tag, count }) => {
        const el = document.createElement('span');
        el.className = 'rare-tag';
        el.textContent = `#${tag || ''} (${count ?? 0})`;
        container.appendChild(el);
    });
}

function renderFolderChart(structure) {
    const container = $('folder-chart'); if (!container) return;
    container.innerHTML = '';
    const max = Math.max(...Object.values(structure).filter(v => v > 0), 1);
    for (const [folder, count] of Object.entries(structure)) {
        if (count === 0) continue;
        const pct = Math.round((count / max) * 100);
        const row = document.createElement('div');
        row.className = 'folder-row';
        row.innerHTML = `<span class="folder-name" title="${esc(folder)}">${esc(folder)}</span><div class="bar-track"><div class="bar-fill" style="width:0" data-pct="${pct}"></div></div><span class="folder-count">${count}</span>`;
        container.appendChild(row);
    }
    requestAnimationFrame(() => { document.querySelectorAll('.bar-fill').forEach(b => { b.style.width = b.dataset.pct + '%'; }); });
    const empty = $('folder-chart-empty'); if (empty) empty.textContent = '';
}

function renderSummary(s) {
    const container = $('summary-list'); if (!container) return;
    container.innerHTML = '';
    const rows = [
        ['総ファイル数', `${s.totalFilesScanned} ファイル`],
        ['Markdown ノート', `${s.totalMDFiles} 件`],
        ['MOC 数', `${s.mocsCount} 件`],
        ['総リンク数', `${s.totalLinks} リンク`],
        ['壊れたリンク', `${s.brokenLinksCount || 0} 件`],
        ['孤立ノート', `${s.orphanNotes} 件`],
        ['ゴミファイル', `${s.junkFiles} 件`],
        ['推定単語数', s.totalWords ? `${s.totalWords.toLocaleString('ja-JP')} 語` : '-'],
        ['重複候補', `${(s.duplicateList || []).length} グループ`],
    ];
    rows.forEach(([label, value]) => {
        const div = document.createElement('div');
        div.className = 'summary-item';
        div.innerHTML = `<span class="summary-item-label">${label}</span><span class="summary-item-value">${value}</span>`;
        container.appendChild(div);
    });
}

// ============================================================
// アクション: MOC 自動生成
// ============================================================
async function runGenMoc() {
    const folder = $('moc-folder-select')?.value;
    if (!folder) return;
    const destFolder = $('moc-dest-select')?.value || '';
    try {
        showLoading(`MOCを生成中... (${folder})`, 'フォルダ内のノートを集約しています');
        const res = await window.api.generateFolderMoc({ folderName: folder, destFolder: destFolder || undefined });
        hideLoading();
        const lbl = $('moc-gen-result');
        if (res.success) {
            addLog(`🗺️ MOC作成完了: ${folder}`, 'success', 'MOC');
            const fileName = res.mocPath ? res.mocPath.split('/').pop() : folder;
            if (lbl) { lbl.style.color = 'var(--green)'; lbl.textContent = `✅ MOCを生成しました: ${fileName}`; }
        } else {
            addLog(`❌ MOC作成エラー: ${res.error}`, 'error', 'MOC');
            if (lbl) { lbl.style.color = 'var(--danger)'; lbl.textContent = `❌ エラー: ${res.error}`; }
        }
    } catch (e) {
        hideLoading();
        addLog(`❌ MOC作成エラー: ${e.message}`, 'error', 'MOC');
    }
}

// ============================================================
// ドライラン（プレビュー）
// ============================================================
async function runPreview() {
    if (!scanData) { addLog('⚠️ 先にスキャンを実行してください', 'warn'); showToast('先にスキャンを実行してください', 'warn'); return; }
    showLoading('プレビューを生成中...', '変更内容をシミュレーションしています');
    let res;
    try { res = await window.api.dryRun(); }
    catch (e) { res = { success: false, error: e.message }; }
    hideLoading();

    if (!res.success) { addLog(`❌ プレビュー失敗: ${res.error || ''}`, 'error'); return; }
    const p = res.preview;

    // ゴミ削除プレビュー
    const junkListEl = $('preview-junk-list');
    const junkEmpty = $('preview-junk-empty');
    if (junkListEl) {
        junkListEl.innerHTML = '';
        if (!p.junkToDelete || p.junkToDelete.length === 0) {
            if (junkEmpty) junkEmpty.style.display = 'block';
            const db = $('btn-delete-preview-selected'); if (db) db.disabled = true;
        } else {
            if (junkEmpty) junkEmpty.style.display = 'none';
            p.junkToDelete.forEach(item => {
                const div = document.createElement('div');
                div.className = 'list-item-check';
                div.setAttribute('data-path', item.path || '');
                div.setAttribute('data-name', (item.name || '').toLowerCase());
                div.innerHTML = `
                    <input type="checkbox" class="item-cb">
                    <div class="item-body"><span class="tag-chip chip-junk">${esc(item.reason)}</span><span class="item-name">${esc(item.name)}</span></div>
                `;
                const cb = div.querySelector('.item-cb');
                if (cb) cb.addEventListener('change', () => onCheckChange('preview-junk-list', 'btn-delete-preview-selected'));

                if (item.path) {
                    const previewBtn = document.createElement('button');
                    previewBtn.className = 'obsidian-btn';
                    previewBtn.textContent = '👁️';
                    previewBtn.title = 'プレビュー';
                    previewBtn.addEventListener('click', () => toggleNotePreview(div, item.path));
                    div.appendChild(previewBtn);

                    const openBtn = document.createElement('button');
                    openBtn.className = 'obsidian-btn';
                    openBtn.textContent = '🔗 開く';
                    openBtn.addEventListener('click', () => openItemPath(item.path));
                    div.appendChild(openBtn);
                }
                junkListEl.appendChild(div);
            });
        }
    }

    // MOCリンクプレビュー
    const orphanListEl = $('preview-orphan-list');
    const orphanEmpty = $('preview-orphan-empty');
    if (orphanListEl) {
        orphanListEl.innerHTML = '';
        if (!p.orphansToLink || p.orphansToLink.length === 0) {
            if (orphanEmpty) orphanEmpty.style.display = 'block';
        } else {
            if (orphanEmpty) orphanEmpty.style.display = 'none';
            p.orphansToLink.forEach(item => {
                const div = document.createElement('div');
                div.className = 'list-item-check';
                div.setAttribute('data-name', (item.name || '').toLowerCase());
                div.innerHTML = `<div class="item-body"><span class="tag-chip chip-preview">${esc(item.category)}</span><span class="item-name">${esc(item.name)}</span><span class="item-meta">→ ${esc(item.targetMoc)}</span></div>`;

                if (item.path) {
                    const previewBtn = document.createElement('button');
                    previewBtn.className = 'obsidian-btn';
                    previewBtn.textContent = '👁️';
                    previewBtn.title = 'プレビュー';
                    previewBtn.addEventListener('click', () => toggleNotePreview(div, item.path));
                    div.appendChild(previewBtn);

                    const openBtn = document.createElement('button');
                    openBtn.className = 'obsidian-btn';
                    openBtn.textContent = '🔗 開く';
                    openBtn.addEventListener('click', () => openItemPath(item.path));
                    div.appendChild(openBtn);
                }
                orphanListEl.appendChild(div);
            });
        }
    }

    activateTab('preview');
    addLog(`👁️ プレビュー — 削除予定:${(p.junkToDelete || []).length} / リンク予定:${(p.orphansToLink || []).length}`, 'info');
}

// ============================================================
// 最適化
// ============================================================
async function runOptimize() {
    if (!scanData) { addLog('⚠️ 先にスキャンを実行してください', 'warn'); return; }
    if (isOptimizing) return;

    const deleteJunk = $('opt-junk')?.checked ?? true;
    const linkOrphans = $('opt-orphan')?.checked ?? true;

    const confirmParts = [];
    if (deleteJunk && scanData.junkFiles > 0) confirmParts.push(`ゴミファイル ${scanData.junkFiles}件 を削除`);
    if (linkOrphans && scanData.orphanNotes > 0) confirmParts.push(`孤立ノート ${scanData.orphanNotes}件 をMOC接続`);
    if (confirmParts.length > 0) {
        if (!await showConfirmModal('最適化の確認', `以下の最適化を実行しますか？\n\n${confirmParts.join('\n')}\n\n⚡ バックアップについて\n設定で『削除前にバックアップを作成』がオンの場合、自動的にバックアップが保存されます。`, '最適化を実行する')) return;
    }

    isOptimizing = true;
    showLoading('Vault を最適化中...', '最適化処理を実行しています');
    addLog('✨ 最適化開始', 'info', 'OPT');
    const rb = $('btn-run-optimize'); if (rb) rb.disabled = true;
    const pr = $('progress-result'); if (pr) pr.style.display = 'none';

    let progress = 0;
    const timer = setInterval(() => {
        progress = Math.min(progress + 1.5, 88);
        const pb = $('progress-bar'); if (pb) pb.style.width = `${progress}%`;
    }, 180);

    let res;
    try { res = await window.api.optimizeVault({ deleteJunk, linkOrphans }); }
    catch (e) { res = { success: false, error: e.message }; }

    clearInterval(timer);
    const pb = $('progress-bar'); if (pb) pb.style.width = '100%';
    hideLoading();
    isOptimizing = false;
    if (rb) rb.disabled = false;

    if (!res.success) { addLog(`❌ 最適化失敗: ${res.error || ''}`, 'error'); setProgressMsg('❌ 失敗。ログを確認してください。'); return; }

    const r = res.results;
    setProgressMsg(`完了 — 削除:${r.deletedJunk}件 / リンク:${r.linkedOrphans}件`);
    if (pr) {
        pr.style.display = 'block';
        let txt = `✅ 最適化完了！\n削除: ${r.deletedJunk} 件\nMOC 接続: ${r.linkedOrphans} 件`;
        if (r.backupPath) txt += `\n💾 バックアップ: ${r.backupPath}`;
        pr.textContent = txt;
    }
    (r.log || []).forEach(line => addLog(line, line.startsWith('🗑️') ? 'warn' : line.startsWith('💾') ? 'info' : 'success'));
    addLog(`✅ 完了 — 削除:${r.deletedJunk} / リンク:${r.linkedOrphans}`, 'success', 'OPT');
    await checkUndoAvailability();
    await runScan();
}

// ============================================================
// レポートエクスポート
// ============================================================
async function runExport() {
    if (!scanData) { addLog('⚠️ スキャンを先に実行してください', 'warn'); return; }
    try {
        const res = await window.api.exportReport(scanData);
        if (res.success) {
            addLog(`✅ レポートを ${res.filePath} に出力しました`, 'success');
        } else if (!res.canceled) {
            addLog(`❌ 出力失敗: ${res.error}`, 'error');
        }
    } catch (e) {
        addLog(`❌ エクスポートエラー: ${e.message}`, 'error');
    }
}

async function runExportData() {
    if (!scanData) return;
    const formatEl = $('export-format');
    if (!formatEl) return;
    const format = formatEl.value;
    addLog(`📊 データ書出要求（${format}形式）...`, 'info');
    try {
        const res = await window.api.exportData(scanData, format);
        if (res.success) {
            addLog(`✅ データを ${res.filePath} に出力しました`, 'success');
        } else if (!res.canceled) {
            addLog(`❌ データ書出失敗: ${res.error}`, 'error');
        }
    } catch (e) {
        addLog(`❌ データ書出エラー: ${e.message}`, 'error');
    }
}

// ============================================================
// Notification Helpers
// ============================================================
// トースト通知システム
function showToast(message, type = 'info', duration = 4000) {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${esc(message)}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function addLog(msg, type = 'info', category = '') {
    // トースト通知（成功・エラー時に自動表示）
    if (type === 'success' || type === 'error') {
        showToast(msg, type === 'success' ? 'success' : 'error');
    }
    logCount++;
    const badge = $('nav-badge-log');
    if (badge) { badge.style.display = 'inline'; badge.textContent = logCount; }
    const logEl = $('full-log');
    if (!logEl) return;
    if (logCount === 1) logEl.innerHTML = '';
    const time = new Date().toLocaleTimeString('ja-JP');
    const prefix = category ? `[${category}] ` : '';
    const line = document.createElement('div');
    line.className = `log-${type}`;
    line.textContent = `[${time}] ${prefix}${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
    const logEl = $('full-log'); if (logEl) logEl.innerHTML = '';
    logCount = 0;
    const badge = $('nav-badge-log'); if (badge) badge.style.display = 'none';
}

// ============================================================
// MOC作成タブ
// ============================================================
let mocTemplates = [];
let selectedTemplateId = null;
let mocVaultFolders = [];
let mocExistingMocs = [];

async function initMocTab() {
    try {
        const [tplResult, folderResult, mocResult] = await Promise.allSettled([
            window.api.getMocTemplates(),
            window.api.getVaultFolders(),
            window.api.getExistingMocs(),
        ]);

        if (tplResult.status === 'fulfilled' && tplResult.value && tplResult.value.success) {
            mocTemplates = tplResult.value.templates || [];
            renderTemplateCards(mocTemplates);
        } else {
            console.warn('テンプレート取得失敗:', tplResult.status === 'rejected' ? tplResult.reason : tplResult.value?.error);
        }

        if (folderResult.status === 'fulfilled' && folderResult.value && folderResult.value.success) {
            mocVaultFolders = folderResult.value.folders || [];
            populateFolderSelects(mocVaultFolders);
        }

        if (mocResult.status === 'fulfilled' && mocResult.value && mocResult.value.success) {
            mocExistingMocs = mocResult.value.mocs || [];
            populateRelatedMocs(mocExistingMocs);
            populateRefreshMocSelect(mocExistingMocs);
        }

        renderCustomTemplatesList();
        // デフォルトはウィザードモード
        setMocMode('wizard');
    } catch (e) {
        console.warn('MOCタブ初期化エラー:', e);
    }
}

function renderTemplateCards(templates) {
    // 通常モードとウィザードモード両方にレンダリング
    const containers = [
        $('moc-template-cards'),
        $('wizard-template-cards'),
    ].filter(Boolean);

    containers.forEach(container => {
        container.innerHTML = '';
        if (!templates || !Array.isArray(templates) || templates.length === 0) {
            container.innerHTML = '<p class="muted-hint">利用可能なテンプレートがありません</p>';
            return;
        }

        templates.forEach(tpl => {
            const card = document.createElement('div');
            card.className = 'moc-template-card';
            card.setAttribute('data-tpl-id', tpl.id);

            let sourceLabel = '';
            if (tpl.builtin) sourceLabel = '内蔵';
            else if (tpl.source === 'vault') sourceLabel = 'Vault';
            else if (tpl.source === 'config') sourceLabel = 'カスタム';

            card.innerHTML = `
                <div class="tpl-name">${esc(tpl.name)}</div>
                <div class="tpl-desc">${esc(tpl.description || '')}</div>
                <span class="tpl-source">${esc(sourceLabel)}</span>
            `;

            card.addEventListener('click', () => selectTemplate(tpl.id));
            container.appendChild(card);
        });
    });
}

function updateMocCreateBtnState() {
    const name = ($('moc-name') || {}).value?.trim();
    const btn = $('btn-create-moc');
    if (btn) btn.disabled = !name || !selectedTemplateId;
}

function selectTemplate(id) {
    selectedTemplateId = id;

    // カードのハイライトを更新
    document.querySelectorAll('.moc-template-card').forEach(card => {
        card.classList.toggle('selected', card.getAttribute('data-tpl-id') === id);
    });

    // MOC作成ボタンの有効状態を更新
    updateMocCreateBtnState();

    // プレビュー自動更新
    updateMocPreview();
}

function populateFolderSelects(folders) {
    // 保存先フォルダセレクト（通常モード・ウィザード・一括）
    ['moc-dest-folder', 'wizard-dest-folder', 'batch-dest-folder'].forEach(id => {
        const sel = $(id);
        if (!sel) return;
        const isBatch = id === 'batch-dest-folder';
        sel.innerHTML = isBatch ? '<option value="">（各フォルダ直下）</option>' : '';
        folders.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            if (!isBatch && f === '10 Atlas') opt.selected = true;
            sel.appendChild(opt);
        });
    });

    // 自動集約フォルダ（通常モード・ウィザード）
    ['moc-auto-folders', 'wizard-auto-folders'].forEach(id => {
        const sel = $(id);
        if (!sel) return;
        sel.innerHTML = '';
        folders.forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            sel.appendChild(opt);
        });
    });

    // 一括生成フォルダリスト
    populateBatchFolderList(folders);
}

function populateRelatedMocs(mocs) {
    const sel = $('moc-related-mocs');
    if (!sel) return;
    sel.innerHTML = '';
    mocs.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        sel.appendChild(opt);
    });
}

function getMocFormParams() {
    const name = ($('moc-name')?.value || '').trim();
    const destFolder = $('moc-dest-folder')?.value || '10 Atlas';
    const tagsRaw = $('moc-tags')?.value || '';
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const type = $('moc-type')?.value || 'moc';

    // 詳細設定
    const description = ($('moc-description')?.value || '').trim();
    const autoFoldersEl = $('moc-auto-folders');
    const autoFolders = autoFoldersEl ? Array.from(autoFoldersEl.selectedOptions).map(o => o.value) : [];
    const autoTagsRaw = $('moc-auto-tags')?.value || '';
    const autoTags = autoTagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const relatedMocsEl = $('moc-related-mocs');
    const relatedMocs = relatedMocsEl ? Array.from(relatedMocsEl.selectedOptions).map(o => o.value) : [];
    const cssRaw = $('moc-css-classes')?.value || '';
    const cssClasses = cssRaw.split(',').map(c => c.trim()).filter(Boolean);

    return {
        templateId: selectedTemplateId,
        name,
        destFolder,
        tags,
        type,
        description,
        autoFolders,
        autoTags,
        relatedMocs,
        cssClasses,
    };
}

let lastMocPreviewContent = '';

async function updateMocPreview() {
    const preview = $('moc-preview-content');
    if (!preview) return;

    const params = getMocFormParams();

    if (!params.templateId) {
        preview.innerHTML = '<span class="muted-hint">テンプレートを選択してください</span>';
        lastMocPreviewContent = '';
        return;
    }
    if (!params.name) {
        preview.innerHTML = '<span class="muted-hint">MOC名を入力してください</span>';
        lastMocPreviewContent = '';
        return;
    }

    try {
        const res = await window.api.previewMoc(params);
        if (res.success) {
            preview.innerHTML = renderMocPreviewWithFrontmatter(res.content);
            lastMocPreviewContent = res.content;
        } else {
            preview.innerHTML = `<span style="color:var(--danger)">${esc(res.error)}</span>`;
            lastMocPreviewContent = '';
        }
    } catch (e) {
        preview.innerHTML = `<span style="color:var(--danger)">プレビューエラー: ${esc(e.message)}</span>`;
        lastMocPreviewContent = '';
    }
}

function showMocPreviewModal() {
    if (!lastMocPreviewContent) {
        showToast('プレビューするMOCがありません。テンプレートと名前を入力してください。', 'warn');
        return;
    }
    var params = getMocFormParams();
    showPreviewModal({
        title: (params.name || 'MOC') + ' プレビュー',
        subtitle: 'MOCテンプレートプレビュー',
        content: '<pre>' + esc(lastMocPreviewContent) + '</pre>'
    });
}

// MOCプレビュー: フロントマターをハイライト表示
function renderMocPreviewWithFrontmatter(content) {
    const fmRegex = /^(---\n[\s\S]*?\n---)/;
    const match = content.match(fmRegex);
    if (match) {
        const frontmatter = match[1];
        const body = content.substring(frontmatter.length);
        return `<div class="moc-preview-frontmatter">${esc(frontmatter)}</div><div class="moc-preview-body">${esc(body)}</div>`;
    }
    return `<div class="moc-preview-body">${esc(content)}</div>`;
}

async function createMocFromUI() {
    const params = getMocFormParams();
    const resultEl = $('moc-create-result');

    if (!params.templateId) {
        if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = 'テンプレートを選択してください'; }
        return;
    }
    if (!params.name) {
        if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = 'MOC名を入力してください'; }
        return;
    }

    showLoading('MOCを作成中...', 'テンプレートを適用しています');
    try {
        const res = await window.api.createMocFromTemplate(params);
        hideLoading();

        if (res.success) {
            addLog(`🗺️ MOC作成完了: ${res.fileName}`, 'success');
            if (resultEl) {
                resultEl.className = 'moc-result-msg success';
                resultEl.textContent = `MOCを作成しました: ${res.relativePath}`;
            }
            // MOC一覧を更新
            const mocRes = await window.api.getExistingMocs();
            if (mocRes.success) {
                mocExistingMocs = mocRes.mocs;
                populateRelatedMocs(mocExistingMocs);
            }
        } else {
            addLog(`MOC作成エラー: ${res.error}`, 'error');
            if (resultEl) {
                resultEl.className = 'moc-result-msg error';
                resultEl.textContent = res.error;
            }
        }
    } catch (e) {
        hideLoading();
        addLog(`MOC作成エラー: ${e.message}`, 'error');
        if (resultEl) {
            resultEl.className = 'moc-result-msg error';
            resultEl.textContent = e.message;
        }
    }
}

function toggleAdvancedSettings() {
    const panel = $('moc-advanced-panel');
    const arrow = $('moc-advanced-arrow');
    const toggle = $('moc-advanced-toggle');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (arrow) arrow.classList.toggle('open', !isOpen);
    if (toggle) toggle.setAttribute('aria-expanded', String(!isOpen));
}

// Electronではprompt()が動作しないため、カスタムモーダルを使用
function showInputModal(title, defaultValue) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
        const modal = document.createElement('div');
        modal.style.cssText = 'background:var(--card);border:1px solid rgba(124,108,248,.3);border-radius:16px;padding:28px;width:400px;max-width:90vw';
        modal.innerHTML = `
            <h3 style="margin:0 0 16px;font-size:1rem;color:#fff">${title}</h3>
            <input type="text" value="${defaultValue || ''}" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#fff;font-size:.9rem;outline:none;box-sizing:border-box" autofocus />
            <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
                <button class="ghost-btn" id="_modal_cancel">キャンセル</button>
                <button class="primary-btn" id="_modal_ok">OK</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        const input = modal.querySelector('input');
        input.focus();
        input.select();
        const cleanup = (val) => { document.body.removeChild(overlay); resolve(val); };
        modal.querySelector('#_modal_cancel').addEventListener('click', () => cleanup(null));
        modal.querySelector('#_modal_ok').addEventListener('click', () => cleanup(input.value.trim() || null));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') cleanup(input.value.trim() || null);
            if (e.key === 'Escape') cleanup(null);
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
    });
}

// カスタム確認モーダル（confirm()の代替）
function showConfirmModal(title, message, confirmLabel = '実行', cancelLabel = 'キャンセル') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
        const modal = document.createElement('div');
        modal.style.cssText = 'background:var(--card);border:1px solid rgba(124,108,248,.3);border-radius:16px;padding:28px;width:440px;max-width:90vw';
        modal.innerHTML = `
            <h3 style="margin:0 0 12px;font-size:1rem;color:#fff">${title}</h3>
            <p style="margin:0 0 20px;font-size:.88rem;color:rgba(255,255,255,.7);line-height:1.6;white-space:pre-line">${message}</p>
            <div style="display:flex;gap:10px;justify-content:flex-end">
                <button class="ghost-btn" id="_confirm_cancel">${cancelLabel}</button>
                <button class="danger-btn" id="_confirm_ok">${confirmLabel}</button>
            </div>
        `;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        const handleKey = (e) => { if (e.key === 'Escape') cleanup(false); if (e.key === 'Enter') cleanup(true); };
        document.addEventListener('keydown', handleKey);
        function cleanup(val) { document.removeEventListener('keydown', handleKey); document.body.removeChild(overlay); resolve(val); }
        modal.querySelector('#_confirm_cancel').addEventListener('click', () => cleanup(false));
        modal.querySelector('#_confirm_ok').addEventListener('click', () => cleanup(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    });
}

async function saveCurrentAsTemplate() {
    const params = getMocFormParams();

    // テンプレートのbodyを取得（選択中テンプレート or プレビュー結果 or デフォルト）
    let templateBody = '';
    if (params.templateId) {
        const tpl = mocTemplates.find(t => t.id === params.templateId);
        if (tpl) templateBody = tpl.body;
    }
    if (!templateBody) {
        try {
            const previewParams = { ...params, templateId: params.templateId || 'builtin-standard' };
            const res = await window.api.previewMoc(previewParams);
            if (res.success) templateBody = res.content;
        } catch (previewErr) { console.warn('テンプレートプレビュー取得失敗:', previewErr.message); }
    }
    if (!templateBody) {
        templateBody = [
            '---', 'type: {{TYPE}}', 'created: "{{DATE}}"', 'tags: [{{TAGS}}]', '---',
            '', '# MOC - {{NAME}}', '', '> {{DESCRIPTION}}', '', '## Notes', '', '', '## Related MOCs', '{{RELATED_MOCS}}',
        ].join('\n');
    }

    const defaultName = `${params.name || 'カスタム'}テンプレート`;
    const name = await showInputModal('テンプレート名を入力してください', defaultName);
    if (!name) return;

    const desc = await showInputModal('テンプレートの説明（任意）', '') || '';

    try {
        const res = await window.api.saveMocTemplate({
            name,
            description: desc,
            body: templateBody,
        });
        if (res.success) {
            addLog(`テンプレート「${name}」を保存しました`, 'success');
            const tplRes = await window.api.getMocTemplates();
            if (tplRes.success) {
                mocTemplates = tplRes.templates;
                renderTemplateCards(mocTemplates);
                renderCustomTemplatesList();
            }
        } else {
            addLog(`テンプレート保存エラー: ${res.error}`, 'error');
        }
    } catch (e) {
        addLog(`テンプレート保存エラー: ${e.message}`, 'error');
    }
}

async function deleteCustomTemplate(id) {
    if (!await showConfirmModal('テンプレート削除の確認', 'このテンプレートを削除しますか？', '削除する')) return;
    try {
        const res = await window.api.deleteMocTemplate(id);
        if (res.success) {
            addLog('テンプレートを削除しました', 'success');
            const tplRes = await window.api.getMocTemplates();
            if (tplRes.success) {
                mocTemplates = tplRes.templates;
                renderTemplateCards(mocTemplates);
                renderCustomTemplatesList();
            }
        }
    } catch (e) {
        addLog(`テンプレート削除エラー: ${e.message}`, 'error');
    }
}

function renderCustomTemplatesList() {
    const container = $('moc-custom-templates-list');
    if (!container) return;
    const customs = mocTemplates.filter(t => t.source === 'config');
    if (customs.length === 0) {
        container.innerHTML = '<p class="muted-hint">カスタムテンプレートはまだありません</p>';
        return;
    }
    container.innerHTML = '';
    customs.forEach(tpl => {
        const item = document.createElement('div');
        item.className = 'moc-custom-tpl-item';
        item.innerHTML = `
            <div class="tpl-info">
                <span class="tpl-name">${esc(tpl.name)}</span>
                <span class="tpl-desc">${esc(tpl.description || '')}</span>
            </div>
        `;
        const btnWrap = document.createElement('div');
        btnWrap.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
        const exportBtn = document.createElement('button');
        exportBtn.className = 'ghost-btn small-btn';
        exportBtn.textContent = '📤 書き出し';
        exportBtn.addEventListener('click', () => window.exportMocTemplate(tpl.id));
        btnWrap.appendChild(exportBtn);
        const delBtn = document.createElement('button');
        delBtn.className = 'ghost-btn small-btn danger-btn';
        delBtn.textContent = '削除';
        delBtn.addEventListener('click', () => deleteCustomTemplate(tpl.id));
        btnWrap.appendChild(delBtn);
        item.appendChild(btnWrap);
        container.appendChild(item);
    });
}

// ── ヘルプタブ：アコーディオン制御 ──
function bindHelpAccordions() {
    const headers = document.querySelectorAll('.help-section-header');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const targetId = header.getAttribute('data-help');
            const body = document.getElementById(`help-${targetId}`);
            const arrow = header.querySelector('.help-toggle-arrow');
            if (!body) return;

            const isOpen = body.style.display !== 'none';
            body.style.display = isOpen ? 'none' : 'block';
            if (arrow) {
                arrow.textContent = isOpen ? '▶' : '▼';
            }
        });
    });

    // 初期状態: 最初のセクションだけ開く、残りは閉じる
    const allBodies = document.querySelectorAll('.help-section-body');
    allBodies.forEach((body, index) => {
        if (index === 0) {
            body.style.display = 'block';
        } else {
            body.style.display = 'none';
            const card = body.closest('.help-card');
            if (card) {
                const arrow = card.querySelector('.help-toggle-arrow');
                if (arrow) arrow.textContent = '▶';
            }
        }
    });
}

// ============================================================
// v4.2 MOC強化機能
// ============================================================

// ── 汎用トグル ──
function toggleCollapsible(panelId, arrowId) {
    const panel = $(panelId);
    const arrow = $(arrowId);
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (arrow) arrow.classList.toggle('open', !isOpen);
    // aria-expanded更新（トグルボタンの親要素）
    if (arrow) {
        const toggleBtn = arrow.closest('button[aria-expanded]');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(!isOpen));
    }
}

// ── モード切替 ──
let currentMocMode = 'wizard';

function setMocMode(mode) {
    currentMocMode = mode;
    ['wizard', 'normal', 'batch'].forEach(m => {
        const el = $(`moc-mode-${m}`);
        if (el) el.style.display = m === mode ? 'block' : 'none';
    });
    // カードのactive状態を更新
    document.querySelectorAll('.moc-mode-card').forEach(card => {
        card.classList.toggle('active', card.getAttribute('data-mode') === mode);
    });
}

// ── ウィザード ──
let wizardStep = 1;
const WIZARD_TOTAL_STEPS = 5;

function updateWizardUI() {
    // ステップパネルの表示切替
    for (let i = 1; i <= WIZARD_TOTAL_STEPS; i++) {
        const panel = $(`wizard-step-${i}`);
        if (panel) panel.classList.toggle('active', i === wizardStep);
    }
    // インジケーターの更新
    document.querySelectorAll('.wizard-step-indicator').forEach(ind => {
        const step = parseInt(ind.getAttribute('data-step'), 10);
        ind.classList.toggle('active', step === wizardStep);
        ind.classList.toggle('completed', step < wizardStep);
    });
    // ナビゲーションボタン
    const prevBtn = $('btn-wizard-prev');
    const nextBtn = $('btn-wizard-next');
    const createBtn = $('btn-wizard-create');
    const info = $('wizard-nav-info');
    if (prevBtn) prevBtn.disabled = wizardStep <= 1;
    if (nextBtn) nextBtn.style.display = wizardStep < WIZARD_TOTAL_STEPS ? '' : 'none';
    if (createBtn) createBtn.style.display = wizardStep === WIZARD_TOTAL_STEPS ? '' : 'none';
    if (info) info.textContent = `ステップ ${wizardStep} / ${WIZARD_TOTAL_STEPS}`;
}

function nextWizardStep() {
    if (wizardStep >= WIZARD_TOTAL_STEPS) return;
    // ステップ1: テンプレート選択必須
    if (wizardStep === 1 && !selectedTemplateId) {
        addLog('テンプレートを選択してください', 'warn');
        return;
    }
    // ステップ2: MOC名必須
    if (wizardStep === 2) {
        const name = ($('wizard-moc-name')?.value || '').trim();
        if (!name) { addLog('MOC名を入力してください', 'warn'); return; }
    }
    wizardStep++;
    updateWizardUI();
    // ステップ4: スマートノート候補を自動取得
    if (wizardStep === 4) fetchWizardSmartSuggestions();
    // ステップ5: プレビューを自動更新
    if (wizardStep === 5) updateWizardPreview();
}

function prevWizardStep() {
    if (wizardStep <= 1) return;
    wizardStep--;
    updateWizardUI();
}

function getWizardFormParams() {
    const name = ($('wizard-moc-name')?.value || '').trim();
    const destFolder = $('wizard-dest-folder')?.value || '10 Atlas';
    const description = ($('wizard-description')?.value || '').trim();
    const tagsRaw = $('wizard-tags')?.value || '';
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean);
    const autoFoldersEl = $('wizard-auto-folders');
    const autoFolders = autoFoldersEl ? Array.from(autoFoldersEl.selectedOptions).map(o => o.value) : [];
    const autoTagsRaw = $('wizard-auto-tags')?.value || '';
    const autoTags = autoTagsRaw.split(',').map(t => t.trim()).filter(Boolean);

    return {
        templateId: selectedTemplateId,
        name,
        destFolder,
        tags,
        type: 'moc',
        description,
        autoFolders,
        autoTags,
        relatedMocs: [],
        cssClasses: [],
    };
}

async function fetchWizardSmartSuggestions() {
    const container = $('wizard-smart-suggestions');
    if (!container) return;
    const name = ($('wizard-moc-name')?.value || '').trim();
    if (!name) {
        container.innerHTML = '<p class="muted-hint">MOC名が入力されていません</p>';
        return;
    }
    container.innerHTML = '<p class="muted-hint">分析中...</p>';
    try {
        const tags = ($('wizard-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
        const autoFoldersEl = $('wizard-auto-folders');
        const folders = autoFoldersEl ? Array.from(autoFoldersEl.selectedOptions).map(o => o.value) : [];
        const res = await window.api.analyzeVaultForMoc({ topic: name, tags, folders });
        if (res.success && res.notes && res.notes.length > 0) {
            renderSmartSuggestions(container, res.notes);
        } else {
            container.innerHTML = '<p class="muted-hint">関連するノートが見つかりませんでした</p>';
        }
    } catch (e) {
        container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">エラー: ${esc(e.message)}</p>`;
    }
}

async function updateWizardPreview() {
    const preview = $('wizard-preview-content');
    if (!preview) return;
    const params = getWizardFormParams();
    if (!params.templateId || !params.name) {
        preview.innerHTML = '<span class="muted-hint">テンプレートとMOC名が必要です</span>';
        return;
    }
    try {
        const res = await window.api.previewMoc(params);
        if (res.success) {
            preview.innerHTML = renderMocPreviewWithFrontmatter(res.content);
        } else {
            preview.innerHTML = `<span style="color:var(--danger)">${esc(res.error)}</span>`;
        }
    } catch (e) {
        preview.innerHTML = `<span style="color:var(--danger)">プレビューエラー: ${esc(e.message)}</span>`;
    }
}

async function createMocFromWizard() {
    const params = getWizardFormParams();
    const resultEl = $('wizard-create-result');
    if (!params.templateId || !params.name) {
        if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = 'テンプレートとMOC名を入力してください'; }
        return;
    }
    showLoading('MOCを作成中...', 'テンプレートを適用しています');
    try {
        const res = await window.api.createMocFromTemplate(params);
        hideLoading();
        if (res.success) {
            addLog(`🗺️ MOC作成完了: ${res.fileName}`, 'success');
            if (resultEl) { resultEl.className = 'moc-result-msg success'; resultEl.textContent = `MOCを作成しました: ${res.relativePath}`; }
            const mocRes = await window.api.getExistingMocs();
            if (mocRes.success) { mocExistingMocs = mocRes.mocs; populateRelatedMocs(mocExistingMocs); populateRefreshMocSelect(mocExistingMocs); }
        } else {
            addLog(`MOC作成エラー: ${res.error}`, 'error');
            if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = res.error; }
        }
    } catch (e) {
        hideLoading();
        addLog(`MOC作成エラー: ${e.message}`, 'error');
        if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = e.message; }
    }
}

// ── プリセット ──
function applyPreset(presetId) {
    // 通常モードに切り替え（プリセットは通常モード内にある）
    const nameEl = $('moc-name');
    const tagsEl = $('moc-tags');
    const typeEl = $('moc-type');

    if (presetId === 'folder') {
        if (nameEl) nameEl.value = '';
        if (tagsEl) tagsEl.value = '';
        if (typeEl) typeEl.value = 'moc';
        // フォルダMOCテンプレートを選択
        const folderTpl = mocTemplates.find(t => t.id === 'builtin-folder' || t.id === 'builtin-standard');
        if (folderTpl) selectTemplate(folderTpl.id);
        addLog('📁 フォルダ別MOCプリセットを適用しました', 'info');
    } else if (presetId === 'tag') {
        if (nameEl) nameEl.value = '';
        if (tagsEl) tagsEl.value = '';
        if (typeEl) typeEl.value = 'moc';
        const tagTpl = mocTemplates.find(t => t.id === 'builtin-standard');
        if (tagTpl) selectTemplate(tagTpl.id);
        addLog('🏷️ タグ別MOCプリセットを適用しました', 'info');
    } else if (presetId === 'project') {
        if (nameEl) nameEl.value = '';
        if (tagsEl) tagsEl.value = 'type/project';
        if (typeEl) typeEl.value = 'project-moc';
        const projTpl = mocTemplates.find(t => t.id === 'builtin-standard');
        if (projTpl) selectTemplate(projTpl.id);
        addLog('📝 プロジェクトMOCプリセットを適用しました', 'info');
    }
    // プレビュー更新
    updateMocPreview();
}

// ── スマートノート候補 ──
async function fetchSmartSuggestions() {
    const container = $('smart-suggestions-list');
    if (!container) return;
    const name = ($('moc-name')?.value || '').trim();
    if (!name) {
        container.innerHTML = '<p class="muted-hint">MOC名を入力してから「分析」ボタンを押してください</p>';
        return;
    }
    container.innerHTML = '<p class="muted-hint">分析中...</p>';
    try {
        const tags = ($('moc-tags')?.value || '').split(',').map(t => t.trim()).filter(Boolean);
        const autoFoldersEl = $('moc-auto-folders');
        const folders = autoFoldersEl ? Array.from(autoFoldersEl.selectedOptions).map(o => o.value) : [];
        const res = await window.api.analyzeVaultForMoc({ topic: name, tags, folders });
        if (res.success && res.notes && res.notes.length > 0) {
            renderSmartSuggestions(container, res.notes);
        } else {
            container.innerHTML = '<p class="muted-hint">関連するノートが見つかりませんでした</p>';
        }
    } catch (e) {
        container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">エラー: ${esc(e.message)}</p>`;
    }
}

function renderSmartSuggestions(container, notes) {
    container.innerHTML = '';
    notes.forEach(note => {
        const div = document.createElement('div');
        div.className = 'smart-suggestion-item';
        div.innerHTML = `
            <input type="checkbox" checked>
            <span class="suggestion-name" title="${esc(note.relPath || note.path)}">${esc(note.name)}</span>
            <span class="suggestion-score">スコア ${note.score}</span>
            <span class="suggestion-reason">${esc(note.matchReason || '')}</span>
        `;
        container.appendChild(div);
    });
}

// ── 既存MOCリフレッシュ ──
let refreshCandidates = [];

function populateRefreshMocSelect(mocs) {
    const sel = $('refresh-moc-select');
    if (!sel) return;
    sel.innerHTML = '<option value="">MOCを選択...</option>';
    mocs.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.path;
        opt.textContent = m.name;
        sel.appendChild(opt);
    });
}

async function refreshExistingMoc() {
    const sel = $('refresh-moc-select');
    const previewList = $('refresh-preview-list');
    const applyBtn = $('btn-refresh-apply');
    if (!sel || !sel.value) {
        addLog('更新するMOCを選択してください', 'warn');
        return;
    }
    if (previewList) previewList.innerHTML = '<p class="muted-hint">検出中...</p>';
    if (applyBtn) applyBtn.disabled = true;

    try {
        const res = await window.api.refreshMoc({ mocPath: sel.value, strategy: 'preview' });
        if (res.success) {
            refreshCandidates = res.newNotes || [];
            if (refreshCandidates.length === 0) {
                if (previewList) previewList.innerHTML = '<p class="muted-hint">追加すべき新しいノートはありません</p>';
            } else {
                if (previewList) {
                    previewList.innerHTML = '';
                    refreshCandidates.forEach(note => {
                        const div = document.createElement('div');
                        div.className = 'refresh-note-item';
                        div.textContent = note.name || note;
                        previewList.appendChild(div);
                    });
                }
                if (applyBtn) applyBtn.disabled = false;
                addLog(`🔍 ${refreshCandidates.length}件の新規ノートを検出`, 'info');
            }
        } else {
            if (previewList) previewList.innerHTML = `<p class="muted-hint" style="color:var(--danger)">${esc(res.error)}</p>`;
        }
    } catch (e) {
        if (previewList) previewList.innerHTML = `<p class="muted-hint" style="color:var(--danger)">エラー: ${esc(e.message)}</p>`;
    }
}

async function applyMocRefresh() {
    const sel = $('refresh-moc-select');
    const previewList = $('refresh-preview-list');
    const applyBtn = $('btn-refresh-apply');
    if (!sel || !sel.value) return;

    showLoading('MOCを更新中...', '新しいノートをMOCに追加しています');
    try {
        const res = await window.api.refreshMoc({ mocPath: sel.value, strategy: 'append' });
        hideLoading();
        if (res.success) {
            addLog(`✅ MOC更新完了: ${res.added}件のノートを追加`, 'success');
            if (previewList) previewList.innerHTML = `<p class="muted-hint" style="color:var(--green)">✅ ${res.added}件のノートを追加しました</p>`;
            if (applyBtn) applyBtn.disabled = true;
            refreshCandidates = [];
        } else {
            addLog(`❌ MOC更新エラー: ${res.error}`, 'error');
            if (previewList) previewList.innerHTML = `<p class="muted-hint" style="color:var(--danger)">${esc(res.error)}</p>`;
        }
    } catch (e) {
        hideLoading();
        addLog(`❌ MOC更新エラー: ${e.message}`, 'error');
    }
}

// ── 一括MOC生成 ──
function populateBatchFolderList(folders) {
    const container = $('batch-folder-list');
    if (!container) return;
    container.innerHTML = '';
    if (!folders || folders.length === 0) {
        container.innerHTML = '<p class="muted-hint">フォルダが見つかりません</p>';
        return;
    }
    folders.forEach(f => {
        const div = document.createElement('div');
        div.className = 'batch-folder-item';
        div.innerHTML = `
            <input type="checkbox" data-folder="${esc(f)}">
            <span class="folder-path">${esc(f)}</span>
        `;
        container.appendChild(div);
    });
}

function batchSelectAll() {
    const boxes = document.querySelectorAll('#batch-folder-list input[type="checkbox"]');
    const allChecked = Array.from(boxes).every(b => b.checked);
    boxes.forEach(b => b.checked = !allChecked);
}

async function runBatchGenerate() {
    const checked = Array.from(document.querySelectorAll('#batch-folder-list input[type="checkbox"]:checked'));
    if (checked.length === 0) {
        addLog('一括生成するフォルダを選択してください', 'warn');
        return;
    }
    const folders = checked.map(cb => cb.getAttribute('data-folder')).filter(Boolean);
    const destFolder = $('batch-dest-folder')?.value || '';

    showLoading(`${folders.length}フォルダのMOCを一括生成中...`, 'テンプレートを適用しています');
    try {
        const res = await window.api.batchGenerateMocs({ folders, destFolder });
        hideLoading();
        const resultsEl = $('batch-results');
        if (res.success && resultsEl) {
            resultsEl.innerHTML = '';
            (res.results || []).forEach(r => {
                const div = document.createElement('div');
                div.className = `batch-result-item ${r.success ? 'success' : 'error'}`;
                div.textContent = r.success
                    ? `✅ ${r.folder} → ${r.mocPath || 'MOC作成済み'}`
                    : `❌ ${r.folder}: ${r.error}`;
                resultsEl.appendChild(div);
            });
            addLog(`📦 一括生成完了: ${res.totalCreated || 0}件作成`, 'success');
            // MOC一覧を更新
            const mocRes = await window.api.getExistingMocs();
            if (mocRes.success) { mocExistingMocs = mocRes.mocs; populateRelatedMocs(mocExistingMocs); populateRefreshMocSelect(mocExistingMocs); }
        } else {
            addLog(`❌ 一括生成エラー: ${res.error || '不明なエラー'}`, 'error');
        }
    } catch (e) {
        hideLoading();
        addLog(`❌ 一括生成エラー: ${e.message}`, 'error');
    }
}

// ── タグベースMOC候補 ──
async function loadTagMocSuggestions() {
    const container = $('tag-suggestions-list');
    if (!container) return;
    container.innerHTML = '<p class="muted-hint">タグを分析中...</p>';

    try {
        const res = await window.api.suggestTagMocs();
        if (res.success && res.suggestions && res.suggestions.length > 0) {
            container.innerHTML = '';
            res.suggestions.forEach(s => {
                const div = document.createElement('div');
                div.className = 'tag-suggest-item';
                const hasExisting = s.existingMoc;
                div.innerHTML = `
                    <span class="tag-suggest-name">#${esc(s.tag)}</span>
                    <span class="tag-suggest-count">${s.count}件</span>
                    <span class="tag-suggest-moc-name">${esc(s.suggestedName)}</span>
                    <span class="tag-suggest-action">
                        ${hasExisting ? '<span class="tag-chip chip-preview">MOCあり</span>' : ''}
                    </span>
                `;
                if (!hasExisting) {
                    const btn = document.createElement('button');
                    btn.className = 'ghost-btn small-btn';
                    btn.textContent = '作成';
                    btn.addEventListener('click', () => window.createMocFromTag(s.tag, s.suggestedName));
                    div.querySelector('.tag-suggest-action').appendChild(btn);
                }
                container.appendChild(div);
            });
            addLog(`🏷️ ${res.suggestions.length}件のタグベースMOC候補を検出`, 'info');
        } else {
            container.innerHTML = '<p class="muted-hint">MOC化の候補となるタグが見つかりませんでした</p>';
        }
    } catch (e) {
        container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">エラー: ${esc(e.message)}</p>`;
    }
}

async function createMocFromTag(tag, suggestedName) {
    // 通常モードに切り替えてフォームに値を設定
    setMocMode('normal');
    const nameEl = $('moc-name');
    const tagsEl = $('moc-tags');
    const autoTagsEl = $('moc-auto-tags');
    if (nameEl) nameEl.value = suggestedName.replace('MOC - ', '');
    if (tagsEl) tagsEl.value = tag;
    if (autoTagsEl) autoTagsEl.value = tag;
    // 標準テンプレートを選択
    const stdTpl = mocTemplates.find(t => t.id === 'builtin-standard');
    if (stdTpl) selectTemplate(stdTpl.id);
    updateMocPreview();
    addLog(`🏷️ タグ「${tag}」のMOC作成をフォームに設定しました`, 'info');
}

// ── MOCマップ ──
async function loadMocMap() {
    const container = $('moc-map-container');
    if (!container) return;
    container.innerHTML = '<p class="muted-hint">マップを生成中...</p>';

    try {
        const res = await window.api.getMocGraph();
        if (res.success && res.nodes && res.nodes.length > 0) {
            renderMocMap(container, res.nodes, res.edges || []);
            addLog(`🗺️ MOCマップ: ${res.nodes.length}ノード / ${(res.edges || []).length}エッジ`, 'info');
        } else {
            container.innerHTML = '<p class="muted-hint">MOCが見つかりません。先にスキャンを実行してください。</p>';
        }
    } catch (e) {
        container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">エラー: ${esc(e.message)}</p>`;
    }
}

function renderMocMap(container, nodes, edges) {
    container.innerHTML = '';
    const svgNS = 'http://www.w3.org/2000/svg';
    const width = container.clientWidth || 600;
    const height = Math.max(350, nodes.length * 20);

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    // 円形レイアウト
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) - 60;
    const positions = {};

    nodes.forEach((node, i) => {
        const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
        positions[node.id] = {
            x: cx + radius * Math.cos(angle),
            y: cy + radius * Math.sin(angle),
        };
    });

    // エッジを描画
    edges.forEach(edge => {
        const from = positions[edge.from];
        const to = positions[edge.to];
        if (!from || !to) return;
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', from.x);
        line.setAttribute('y1', from.y);
        line.setAttribute('x2', to.x);
        line.setAttribute('y2', to.y);
        line.setAttribute('class', 'moc-map-edge');
        svg.appendChild(line);
    });

    // ノードを描画
    nodes.forEach(node => {
        const pos = positions[node.id];
        if (!pos) return;
        const g = document.createElementNS(svgNS, 'g');
        g.setAttribute('class', 'moc-map-node');
        g.setAttribute('transform', `translate(${pos.x},${pos.y})`);

        const nodeRadius = Math.max(8, Math.min(20, 8 + (node.noteCount || 0)));
        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('r', nodeRadius);
        g.appendChild(circle);

        const text = document.createElementNS(svgNS, 'text');
        text.setAttribute('dy', nodeRadius + 14);
        const displayName = (node.name || '').replace('MOC - ', '').substring(0, 16);
        text.textContent = displayName;
        g.appendChild(text);

        const title = document.createElementNS(svgNS, 'title');
        title.textContent = `${node.name} (${node.noteCount || 0}ノート)`;
        g.appendChild(title);

        svg.appendChild(g);
    });

    container.appendChild(svg);
}

// ============================================================
// v4.3 Feature 7: 孤立画像/添付ファイル
// ============================================================
function renderOrphanImages(orphanImages) {
    const card = $('orphan-image-card');
    const list = $('orphan-image-list');
    const badge = $('badge-orphan-image');
    const summary = $('orphan-image-summary');
    if (!list) return;
    list.innerHTML = '';

    if (!orphanImages || orphanImages.length === 0) {
        if (card) card.style.display = 'none';
        return;
    }
    if (card) card.style.display = 'block';
    if (badge) badge.textContent = orphanImages.length;
    const totalSize = orphanImages.reduce((sum, i) => sum + (i.size || 0), 0);
    if (summary) summary.textContent = `${orphanImages.length}件 / 合計 ${(totalSize / 1024 / 1024).toFixed(1)} MB — 削除すると容量を節約できます`;

    orphanImages.slice(0, 300).forEach(item => {
        const div = document.createElement('div');
        div.className = 'list-item-check';
        div.setAttribute('data-name', (item.name || '').toLowerCase());
        div.setAttribute('data-path', item.path || '');
        const sizeStr = item.size > 1024 * 1024
            ? `${(item.size / 1024 / 1024).toFixed(1)} MB`
            : `${(item.size / 1024).toFixed(1)} KB`;
        div.innerHTML = `
            <input type="checkbox" class="item-cb">
            <div class="item-body">
                <span class="tag-chip" style="background:rgba(168,85,247,.15);color:#c084fc">${esc(item.ext)}</span>
                <span class="item-name" title="${esc(item.name)}">${esc(item.name)}</span>
                <span class="item-meta">${sizeStr}</span>
            </div>
        `;
        const cb = div.querySelector('.item-cb');
        if (cb) cb.addEventListener('change', () => onCheckChange('orphan-image-list', 'btn-delete-orphan-images'));

        if (item.path) {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'obsidian-btn';
            previewBtn.textContent = '👁️';
            previewBtn.title = 'プレビュー';
            previewBtn.addEventListener('click', () => openItemPath(item.path));
            div.appendChild(previewBtn);

            const openBtn = document.createElement('button');
            openBtn.className = 'obsidian-btn';
            openBtn.textContent = '📂 開く';
            openBtn.title = 'ファイルを開く';
            openBtn.addEventListener('click', () => openItemPath(item.path));
            div.appendChild(openBtn);
        }
        list.appendChild(div);
    });
}

// ============================================================
// v4.3 Feature 4: 推奨アクション
// ============================================================
function renderRecommendedActions(data) {
    const card = $('recommended-actions-card');
    const container = $('recommended-actions');
    if (!card || !container) return;
    container.innerHTML = '';

    const actions = [];
    if (data.junkFiles > 0) {
        actions.push({ label: `🗑️ ゴミファイル ${data.junkFiles}件を削除`, action: () => { activateTab('scan'); } });
    }
    if (data.orphanNotes > 0) {
        actions.push({ label: `🔗 孤立ノート ${data.orphanNotes}件をMOC接続`, action: () => { activateTab('optimize'); } });
    }
    if ((data.brokenLinksCount || 0) > 0) {
        actions.push({ label: `💔 壊れたリンク ${data.brokenLinksCount}件を確認`, action: () => { activateTab('scan'); } });
    }
    if ((data.staleList || []).length > 20) {
        actions.push({ label: `📦 放置ノート ${data.staleList.length}件をアーカイブ`, action: () => { activateTab('scan'); } });
    }
    if ((data.orphanImageCount || 0) > 0) {
        actions.push({ label: `🖼️ 孤立画像 ${data.orphanImageCount}件を確認`, action: () => { activateTab('scan'); } });
    }

    if (actions.length === 0) {
        card.style.display = 'block';
        container.innerHTML = '<span style="color:var(--green);font-size:.88rem">✅ Vault は健全です！問題は見つかりませんでした。</span>';
        return;
    }
    card.style.display = 'block';
    actions.forEach(a => {
        const btn = document.createElement('button');
        btn.className = 'ghost-btn small-btn';
        btn.textContent = a.label;
        btn.addEventListener('click', a.action);
        container.appendChild(btn);
    });
}

// ============================================================
// v4.3 Feature 2: スキャンDiff（前回比較）
// ============================================================
async function renderScanDiff(currentData) {
    try {
        const res = await window.api.getLastScan();
        const last = res?.lastScan;

        // 現在のスナップショットを保存
        await window.api.saveScanSnapshot({
            timestamp: new Date().toISOString(),
            totalMDFiles: currentData.totalMDFiles,
            orphanNotes: currentData.orphanNotes,
            junkFiles: currentData.junkFiles,
            brokenLinksCount: currentData.brokenLinksCount || 0,
            staleCount: (currentData.staleList || []).length,
            orphanImageCount: currentData.orphanImageCount || 0,
            mocsCount: currentData.mocsCount,
        });

        if (!last) return; // 初回スキャンは比較なし

        const diffMap = {
            'h-total': currentData.totalMDFiles - (last.totalMDFiles || 0),
            'h-orphans': currentData.orphanNotes - (last.orphanNotes || 0),
            'h-junk': currentData.junkFiles - (last.junkFiles || 0),
            'h-broken': (currentData.brokenLinksCount || 0) - (last.brokenLinksCount || 0),
            'h-stale': (currentData.staleList || []).length - (last.staleCount || 0),
            'h-mocs': currentData.mocsCount - (last.mocsCount || 0),
        };

        for (const [id, diff] of Object.entries(diffMap)) {
            const el = $(id);
            if (!el || diff === 0) continue;
            const existing = el.querySelector('.diff-badge');
            if (existing) existing.remove();
            const badge = document.createElement('span');
            badge.className = `diff-badge ${diff > 0 ? 'negative' : 'positive'}`;
            // 孤立/ゴミ/壊れたリンクは減少が良い（positive）、増加が悪い（negative）
            // ノート総数/MOCは増加が良い
            const invertIds = ['h-total', 'h-mocs'];
            if (invertIds.includes(id)) {
                badge.className = `diff-badge ${diff > 0 ? 'positive' : 'negative'}`;
            }
            badge.textContent = diff > 0 ? `+${diff}` : `${diff}`;
            el.appendChild(badge);
        }
    } catch (e) { console.warn('Scan diff error:', e); }
}

// ============================================================
// v4.3 Feature 3: ノートプレビュー（インライン展開）
// ============================================================
const previewCache = {};

async function toggleNotePreview(itemEl, filePath) {
    // AI版がロード済みの場合はそちらを使用
    if (window.toggleNotePreviewWithAI) {
        return window.toggleNotePreviewWithAI(itemEl, filePath);
    }

    const existing = itemEl.querySelector('.note-preview');
    if (existing) {
        existing.remove();
        return;
    }

    let content = previewCache[filePath];
    if (!content) {
        try {
            const res = await window.api.readNotePreview(filePath);
            if (res.success) {
                content = res.preview;
                previewCache[filePath] = content;
            } else {
                content = `(読み込み失敗: ${res.error})`;
            }
        } catch (e) {
            content = `(エラー: ${e.message})`;
        }
    }

    const preview = document.createElement('div');
    preview.className = 'note-preview';
    preview.textContent = content;
    itemEl.appendChild(preview);
}

// ============================================================
// v4.3 Feature 1: バックアップ管理
// ============================================================
async function loadBackupList() {
    const container = $('backup-list');
    if (!container) return;
    container.innerHTML = '<p class="muted-hint">読み込み中...</p>';

    try {
        const res = await window.api.listBackups();
        if (!res.success || !res.backups || res.backups.length === 0) {
            container.innerHTML = '<p class="muted-hint">バックアップがありません</p>';
            return;
        }
        container.innerHTML = '';
        res.backups.forEach(bk => {
            const sizeStr = bk.totalSize > 1024 * 1024
                ? `${(bk.totalSize / 1024 / 1024).toFixed(1)} MB`
                : `${(bk.totalSize / 1024).toFixed(1)} KB`;
            const div = document.createElement('div');
            div.className = 'list-item-check';
            div.innerHTML = `
                <div class="item-body" style="flex:1">
                    <span class="item-name">${esc(bk.dateStr)}</span>
                    <span class="item-meta">${bk.fileCount}ファイル / ${sizeStr}</span>
                </div>
            `;
            const restoreBtn = document.createElement('button');
            restoreBtn.className = 'ghost-btn small-btn';
            restoreBtn.textContent = '🔄 復元';
            restoreBtn.addEventListener('click', async () => {
                const res = await window.api.restoreBackup(bk.name);
                if (res.success) {
                    addLog(`🔄 バックアップ復元完了: ${res.restored}ファイル`, 'success');
                    await runScan();
                } else if (!res.canceled) {
                    addLog(`❌ 復元失敗: ${res.error}`, 'error');
                }
            });
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'ghost-btn small-btn danger-btn';
            deleteBtn.textContent = '🗑️';
            deleteBtn.addEventListener('click', async () => {
                if (!await showConfirmModal('バックアップ削除の確認', `バックアップ「${bk.dateStr}」を削除しますか？`, '削除する')) return;
                const res = await window.api.deleteBackup(bk.name);
                if (res.success) {
                    addLog('バックアップを削除しました', 'success');
                    loadBackupList();
                } else {
                    addLog(`❌ ${res.error}`, 'error');
                }
            });
            div.appendChild(restoreBtn);
            div.appendChild(deleteBtn);
            container.appendChild(div);
        });
    } catch (e) {
        container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">エラー: ${esc(e.message)}</p>`;
    }
}

// ============================================================
// v4.3 Feature 5: タグ名変更/マージ
// ============================================================
async function runRenameTag() {
    const oldEl = $('tag-rename-old');
    const newEl = $('tag-rename-new');
    const resultEl = $('tag-rename-result');
    if (!oldEl || !newEl) return;

    const oldTag = oldEl.value.replace(/^#/, '').trim();
    const newTag = newEl.value.replace(/^#/, '').trim();

    if (!oldTag || !newTag) {
        if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = '変更元と変更先の両方を入力してください'; }
        return;
    }

    try {
        const res = await window.api.renameTag({ oldTag, newTag });
        if (res.success) {
            addLog(`✏️ タグ名変更完了: #${oldTag} → #${newTag} (${res.changedFiles}ファイル)`, 'success');
            if (resultEl) {
                resultEl.className = 'moc-result-msg success';
                resultEl.textContent = `✅ ${res.changedFiles}ファイルのタグを変更しました`;
            }
            oldEl.value = '';
            newEl.value = '';
            await runScan();
        } else if (!res.canceled) {
            if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = res.error; }
        }
    } catch (e) {
        if (resultEl) { resultEl.className = 'moc-result-msg error'; resultEl.textContent = e.message; }
    }
}

// ============================================================
// Feature A: ナレッジグラフ分析
// ============================================================
async function runKnowledgeGraphAnalysis() {
    showLoading('ナレッジグラフを分析中...', 'ノート間のリンク関係を分析しています');
    try {
        const res = await window.api.analyzeKnowledgeGraph();
        hideLoading();
        if (!res.success) { addLog(`分析エラー: ${res.error}`, 'error'); return; }

        const resultArea = $('kg-result-area');
        if (resultArea) resultArea.style.display = 'block';

        const cl = $('kg-cluster-list');
        if (cl) cl.innerHTML = res.clusters.length === 0 ? '<p class="muted-hint">クラスターなし</p>' :
            res.clusters.map(c => `<div style="padding:10px;border:1px solid rgba(124,108,248,.15);border-radius:8px;margin-bottom:6px;background:rgba(124,108,248,.04)"><strong>${esc(c.name)}</strong> <span class="count-badge">${c.notes.length}</span><div style="margin-top:4px;font-size:.76rem;opacity:.7">${c.notes.slice(0, 8).map(n => esc(n)).join(', ')}${c.notes.length > 8 ? '...' : ''}</div></div>`).join('');

        const wl = $('kg-weak-list');
        const wb = $('badge-weak-notes');
        if (wb) wb.textContent = res.weakNotes.length;
        if (wl) wl.innerHTML = res.weakNotes.length === 0 ? '<p class="muted-hint">弱接続ノートなし</p>' :
            res.weakNotes.slice(0, 100).map(n => `<div class="list-item-check"><span class="item-name">${esc(n.name)}</span><span class="item-meta">リンク${n.linkCount}</span></div>`).join('');

        const sl = $('kg-suggestion-list');
        const sb = $('badge-suggestions');
        if (sb) sb.textContent = res.suggestions.length;
        if (sl) sl.innerHTML = res.suggestions.length === 0 ? '<p class="muted-hint">提案なし</p>' :
            res.suggestions.map(s => `<div style="padding:8px;border-bottom:1px solid rgba(255,255,255,.05)"><span style="color:#6ee7b7">${esc(s.source)}</span> ↔ <span style="color:#6ee7b7">${esc(s.target)}</span><br><span class="muted-hint">${esc(s.reason)}</span> <span style="background:rgba(124,108,248,.2);padding:2px 8px;border-radius:8px;font-size:.72rem">${s.score}点</span></div>`).join('');

        addLog(`ナレッジグラフ分析完了: クラスター${res.clusters.length} / 弱接続${res.weakNotes.length} / 提案${res.suggestions.length}`, 'success');
    } catch (e) { hideLoading(); addLog(`分析エラー: ${e.message}`, 'error'); }
}

// ============================================================
// Feature E: スマートアーカイブ提案
// ============================================================
async function runArchiveSuggestions() {
    showLoading('アーカイブ候補を分析中...', 'アーカイブすべきノートを検出しています');
    try {
        const res = await window.api.suggestArchives();
        hideLoading();
        if (!res.success) { addLog(`アーカイブ提案エラー: ${res.error}`, 'error'); return; }

        const badge = $('badge-archive');
        if (badge) badge.textContent = res.suggestions.length;
        const empty = $('archive-suggestion-empty');
        const list = $('archive-suggestion-list');
        if (!list) return;

        if (res.suggestions.length === 0) {
            list.innerHTML = '';
            if (empty) { empty.style.display = 'block'; empty.textContent = 'アーカイブ候補なし'; }
            return;
        }
        if (empty) empty.style.display = 'none';

        list.innerHTML = res.suggestions.map(s => {
            const cls = s.archiveScore >= 80 ? 'color:#f87171' : s.archiveScore >= 70 ? 'color:#fbbf24' : 'color:#6ee7b7';
            const previewBtn = s.path ? `<button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(s.path)}')" title="プレビュー" style="margin-right:6px">👁️</button>` : '';
            return `<div class="list-item-check" style="justify-content:space-between"><div><span class="item-name">${esc(s.name)}</span><div style="margin-top:2px">${s.reasons.map(r => `<span style="font-size:.68rem;background:rgba(251,191,36,.15);color:#fbbf24;padding:1px 6px;border-radius:8px;margin-right:4px">${esc(r)}</span>`).join('')}</div></div><div style="display:flex;align-items:center">${previewBtn}<span style="font-weight:700;font-size:.88rem;${cls}">${s.archiveScore}</span></div></div>`;
        }).join('');
        addLog(`アーカイブ提案: ${res.suggestions.length}件`, 'success');
    } catch (e) { hideLoading(); addLog(`エラー: ${e.message}`, 'error'); }
}

// ============================================================
// Feature F: ノート統合
// ============================================================
let mergePreviewData = null;

async function runMergePreview() {
    const fileA = $('merge-file-a')?.value?.trim();
    const fileB = $('merge-file-b')?.value?.trim();
    if (!fileA || !fileB) { addLog('両方のファイルパスを入力してください', 'warn'); return; }

    showLoading('マージプレビュー生成中...', 'ノートの統合プレビューを作成しています');
    try {
        const res = await window.api.previewMerge({ fileA, fileB });
        hideLoading();
        if (!res.success) { addLog(`エラー: ${res.error}`, 'error'); return; }

        mergePreviewData = { fileA, fileB, mergedContent: res.mergedContent };

        // インラインエリアも更新（実行ボタン用）
        const area = $('merge-preview-area'); if (area) area.style.display = 'block';
        const inlinePreview = $('merge-preview-content'); if (inlinePreview) inlinePreview.textContent = res.mergedContent.split('\n').slice(0, 200).join('\n');
        const links = $('merge-incoming-links');
        if (links) links.innerHTML = res.incomingLinks.length === 0 ? '<p class="muted-hint">被リンクなし</p>' :
            res.incomingLinks.map(l => `<div class="list-item-check"><span class="item-name">${esc(l.file)}</span></div>`).join('');
        const btn = $('btn-execute-merge'); if (btn) btn.disabled = false;

        // モーダルでプレビュー表示
        var linksHtml = res.incomingLinks.length === 0 ? '<p class="muted-hint">被リンクなし</p>' :
            '<h4 style="margin:12px 0 6px;font-size:.85rem">被リンク (' + res.incomingLinks.length + '件)</h4>' +
            res.incomingLinks.map(function(l) { return '<div style="font-size:.82rem;padding:2px 0">' + esc(l.file) + '</div>'; }).join('');

        showPreviewModal({
            title: 'マージプレビュー',
            subtitle: esc(res.nameB) + ' → ' + esc(res.nameA),
            content: '<pre>' + esc(res.mergedContent) + '</pre>' + linksHtml,
            actions: [
                { label: '🔀 マージ実行', className: 'ghost-btn small-btn danger-btn', onClick: function() { closePreviewModal(); executeMerge(); } }
            ]
        });

        addLog(`マージプレビュー: ${esc(res.nameB)} → ${esc(res.nameA)} (被リンク${res.incomingLinks.length}件)`, 'info');
    } catch (e) { hideLoading(); addLog(`エラー: ${e.message}`, 'error'); }
}

async function executeMerge() {
    if (!mergePreviewData) return;
    showLoading('マージ実行中...', 'ノートを統合しています');
    try {
        const res = await window.api.executeMerge(mergePreviewData);
        hideLoading();
        if (!res.success) { addLog(`マージエラー: ${res.error}`, 'error'); return; }
        addLog(`マージ完了: ${res.updatedFiles}件のリンク更新`, 'success');
        const msg = $('merge-result-msg');
        if (msg) { msg.className = 'moc-result-msg success'; msg.textContent = `マージ完了: ${res.updatedFiles}件更新`; }
        const area = $('merge-preview-area'); if (area) area.style.display = 'none';
        const btn = $('btn-execute-merge'); if (btn) btn.disabled = true;
        mergePreviewData = null;
    } catch (e) { hideLoading(); addLog(`エラー: ${e.message}`, 'error'); }
}

// ============================================================
// Feature B: ライティング分析
// ============================================================
async function loadWritingAnalytics() {
    const container = $('writing-analytics-content');
    if (!container) return;
    container.innerHTML = '<div class="list-empty" style="text-align:center"><div style="font-size:1.5rem;margin-bottom:8px">⏳</div>ライティング分析中...<br><span style="font-size:.75rem;opacity:.5">ノート数が多い場合は時間がかかります</span></div>';
    try {
        const res = await window.api.getWritingAnalytics();
        if (!res.success) { container.innerHTML = `<div class="list-empty">${esc(res.error)}</div>`; return; }
        let html = '';
        // ストリーク
        html += `<div style="display:flex;gap:16px;margin-bottom:16px"><div style="flex:1;text-align:center;padding:16px;background:rgba(124,108,248,.08);border:1px solid rgba(124,108,248,.2);border-radius:12px"><div style="font-size:2rem;font-weight:700;color:#7c6cf8">${res.streak.current}</div><div style="font-size:.76rem;opacity:.6">現在の連続日数</div></div><div style="flex:1;text-align:center;padding:16px;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.2);border-radius:12px"><div style="font-size:2rem;font-weight:700;color:#34d399">${res.streak.longest}</div><div style="font-size:.76rem;opacity:.6">最長連続日数</div></div></div>`;
        // 週次バー
        const maxW = Math.max(...res.weeklyTrend.map(w => w.words), 1);
        html += '<h4 style="font-size:.86rem;margin-bottom:8px">📈 週次トレンド</h4><div style="display:flex;align-items:flex-end;gap:3px;height:100px">';
        for (const w of res.weeklyTrend) {
            const pct = Math.round((w.words / maxW) * 100);
            html += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;height:100%;justify-content:flex-end" title="${esc(w.week)}: ${w.words}語"><div style="width:100%;min-height:2px;height:${pct}%;background:linear-gradient(to top,rgba(124,108,248,.6),rgba(124,108,248,.9));border-radius:3px 3px 0 0"></div><span style="font-size:.58rem;opacity:.5;margin-top:2px">${esc(w.week.slice(5))}</span></div>`;
        }
        html += '</div>';
        // トピック活動
        if (res.topicActivity.length > 0) {
            html += '<h4 style="font-size:.86rem;margin:16px 0 8px">🏷️ アクティブなトピック（30日）</h4>';
            const maxT = res.topicActivity[0].count;
            for (const t of res.topicActivity) {
                const pct = Math.round((t.count / maxT) * 100);
                html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="min-width:100px;font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.topic)}</span><div style="flex:1;height:8px;background:rgba(255,255,255,.04);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(to right,#7c6cf8,#34d399);border-radius:4px"></div></div><span style="font-size:.72rem;opacity:.5;min-width:35px;text-align:right">${t.count}件</span></div>`;
            }
        }
        // 下書き
        if (res.drafts.length > 0) {
            html += `<h4 style="font-size:.86rem;margin:16px 0 8px">📝 下書き (${res.drafts.length}件)</h4>`;
            for (const d of res.drafts.slice(0, 20)) {
                html += `<div style="display:flex;justify-content:space-between;padding:4px 8px;background:rgba(255,255,255,.03);border-radius:6px;margin-bottom:3px"><span style="font-size:.78rem;color:#67e8f9;cursor:pointer" data-draft-path="${esc(d.path)}">${esc(d.name)}</span><span style="font-size:.68rem;color:#fbbf24;background:rgba(245,158,11,.1);padding:1px 6px;border-radius:4px">${esc(d.reason)}</span></div>`;
            }
        }
        container.innerHTML = html;
        container.querySelectorAll('[data-draft-path]').forEach(el => el.addEventListener('click', () => window.api.openInObsidian(el.dataset.draftPath)));
        addLog(`ライティング分析完了: ストリーク${res.streak.current}日 / 下書き${res.drafts.length}件`, 'success');
    } catch (e) { container.innerHTML = `<div class="list-empty">エラー: ${esc(e.message)}</div>`; }
}

// ============================================================
// Feature D: リアルタイムVault監視
// ============================================================
let vaultWatchActive = false;

function toggleVaultWatch() {
    if (vaultWatchActive) {
        window.api.stopVaultWatch().then(() => { vaultWatchActive = false; updateWatchUI(false); addLog('⏹️ Vault監視停止', 'info'); });
    } else {
        window.api.startVaultWatch().then(res => {
            if (res.success) { vaultWatchActive = true; updateWatchUI(true); addLog('👁️ Vault監視開始', 'info'); }
            else addLog(`監視エラー: ${res.error}`, 'error');
        });
    }
}

function updateWatchUI(active) {
    const btn = $('btn-toggle-vault-watch');
    const ind = $('vault-watch-indicator');
    if (btn) btn.textContent = active ? '⏹️ 監視停止' : '👁️ 監視開始';
    if (ind) ind.style.display = active ? 'inline' : 'none';
}

// ============================================================
// Feature G: Vaultタイムマシン
// ============================================================
async function loadVaultTimeline(dateStr) {
    const container = $('timeline-results');
    const label = $('timeline-date-label');
    if (!container) return;
    container.innerHTML = '<div class="list-empty">読み込み中...</div>';
    if (label) label.textContent = dateStr;
    try {
        const res = await window.api.getVaultTimeline(dateStr);
        if (!res.success) { container.innerHTML = `<div class="list-empty">${esc(res.error)}</div>`; return; }
        if (res.files.length === 0) { container.innerHTML = '<div class="list-empty">この日に更新されたノートはありません</div>'; return; }
        container.innerHTML = `<div style="font-size:.84rem;opacity:.6;margin-bottom:8px">${esc(dateStr)} に更新: <strong style="color:#7c6cf8">${res.files.length}件</strong></div>` +
            res.files.map(f => `<div style="padding:8px 12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;margin-bottom:6px;cursor:pointer" data-tl-path="${esc(f.path)}"><div style="display:flex;justify-content:space-between"><span style="font-size:.84rem;font-weight:600;color:#67e8f9">${esc(f.name)}</span><span style="font-size:.7rem;opacity:.5">${new Date(f.mtime).toLocaleTimeString('ja-JP')} / ${(f.size/1024).toFixed(1)}KB</span></div><div style="font-size:.74rem;opacity:.4;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.snippet || '')}</div></div>`).join('');
        container.querySelectorAll('[data-tl-path]').forEach(el => el.addEventListener('click', () => window.api.openInObsidian(el.dataset.tlPath)));
    } catch (e) { container.innerHTML = `<div class="list-empty">エラー: ${esc(e.message)}</div>`; }
}

// Feature B/D/G ボタンバインド + ヒートマップクリック連携
(function() {
    const safe = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    safe('btn-load-analytics', loadWritingAnalytics);
    safe('btn-toggle-vault-watch', toggleVaultWatch);
    safe('btn-timeline-search', () => { const el = $('timeline-date-input'); if (el && el.value) loadVaultTimeline(el.value); });

    // 監視イベントリスナー
    try {
        window.api.onVaultWatchEvent((data) => {
            const feed = $('vault-watch-feed');
            if (!feed) return;
            if (feed.querySelector('.list-empty')) feed.innerHTML = '';
            const time = new Date().toLocaleTimeString('ja-JP');
            const typeLabels = { change: '変更', rename: 'リネーム', delete: '削除', error: 'エラー' };
            const typeColors = { change: 'rgba(124,108,248,.15)', rename: 'rgba(6,182,212,.15)', delete: 'rgba(248,113,113,.15)', error: 'rgba(245,158,11,.15)' };
            const item = document.createElement('div');
            item.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.05);font-size:.76rem;animation:vw-fadein .3s';
            let issueHtml = data.issues && data.issues.length > 0 ? data.issues.map(i => `<span style="font-size:.68rem;padding:1px 5px;border-radius:4px;background:rgba(248,113,113,.1);color:#f87171">${esc(i.message)}</span>`).join('') : '';
            item.innerHTML = `<span style="opacity:.5;font-size:.68rem;min-width:55px">${esc(time)}</span><span style="font-size:.66rem;padding:1px 5px;border-radius:4px;font-weight:600;background:${typeColors[data.type] || 'transparent'}">${esc(typeLabels[data.type] || data.type)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:250px">${esc(data.file || '')}</span>${issueHtml}`;
            feed.insertBefore(item, feed.firstChild);
            while (feed.children.length > 50) feed.removeChild(feed.lastChild);
            if (data.issues && data.issues.length > 0) addLog(`👁️ ${data.file}: ${data.issues.map(i => i.message).join(', ')}`, 'warn');
        });
    } catch (_) { }

    // ヒートマップクリックでタイムマシン表示
    const hc = $('heatmap-container');
    if (hc) {
        const obs = new MutationObserver(() => {
            hc.addEventListener('click', (e) => {
                const rect = e.target.closest('rect');
                if (!rect) return;
                const title = rect.querySelector('title');
                if (!title) return;
                const match = title.textContent.match(/^(\d{4}-\d{2}-\d{2})/);
                if (match) { const card = $('time-machine-card'); if (card) card.style.display = 'block'; loadVaultTimeline(match[1]); }
            }, { once: false });
        });
        obs.observe(hc, { childList: true });
    }
})();

// Feature A/E/F ボタンバインド
(function() {
    const safe = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    safe('btn-analyze-kg', runKnowledgeGraphAnalysis);
    safe('btn-suggest-archives', runArchiveSuggestions);
    safe('btn-preview-merge', runMergePreview);
    safe('btn-execute-merge', executeMerge);
})();

// ============================================================
// Feature I: i18n
// ============================================================
const LANG = {
    ja: { 'graph.loading': 'グラフを生成中...', 'graph.empty': 'ノードがありません', 'structure.fitScore': 'フィットスコア', 'structure.missingFolders': '不足フォルダ' },
    en: { 'graph.loading': 'Generating graph...', 'graph.empty': 'No nodes found', 'structure.fitScore': 'Fit Score', 'structure.missingFolders': 'Missing Folders' },
    zh: { 'graph.loading': '生成图表中...', 'graph.empty': '没有节点', 'structure.fitScore': '适合度', 'structure.missingFolders': '缺少文件夹' },
};
let currentLang = 'ja';
function t(key) { return (LANG[currentLang] || LANG.ja)[key] || key; }
async function initI18n() { try { const r = await window.api.getAppLanguage(); if (r.success) currentLang = r.language; const s = $('language-select'); if (s) s.value = currentLang; } catch (_) { } }

// ============================================================
// Feature C: 構造テンプレート
// ============================================================
let structureTabInitialized = false;

async function loadStructureTemplates() {
    const container = $('structure-template-list');
    if (!container) return;
    container.innerHTML = '<p class="muted-hint">読み込み中...</p>';
    try {
        const res = await window.api.getStructureTemplates();
        if (!res.success) { container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">${esc(res.error)}</p>`; return; }
        container.innerHTML = '';
        res.templates.forEach(tpl => {
            const card = document.createElement('div');
            card.className = 'glass-card';
            card.style.marginBottom = '12px';
            card.innerHTML = `<h4 style="font-size:1.05rem;font-weight:700;margin:0 0 4px">${esc(tpl.name)}</h4><p style="font-size:.82rem;opacity:.6;margin:0 0 10px">${esc(tpl.description)}</p><div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">${tpl.folders.map(f => `<span class="tag-chip">${esc(f)}</span>`).join('')}</div><div id="structure-score-${esc(tpl.id)}"></div><div id="structure-actions-${esc(tpl.id)}" style="margin-top:8px"></div>`;
            container.appendChild(card);
        });
    } catch (e) { container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">${esc(e.message)}</p>`; }
}

async function analyzeVaultStructure() {
    try {
        const res = await window.api.analyzeVaultStructure();
        if (!res.success) { addLog(`構造分析エラー: ${res.error}`, 'error'); return; }
        for (const r of res.results) {
            const scoreEl = $(`structure-score-${r.templateId}`);
            const color = r.fitScore >= 60 ? '#34d399' : r.fitScore >= 30 ? '#f59e0b' : '#f87171';
            if (scoreEl) scoreEl.innerHTML = `<div style="width:100%;height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden;margin-bottom:4px"><div style="height:100%;width:${r.fitScore}%;background:${color};border-radius:4px"></div></div><span style="font-size:.85rem;font-weight:600;color:${color}">${t('structure.fitScore')}: ${r.fitScore}%</span>${r.missingFolders.length > 0 ? `<p style="font-size:.78rem;opacity:.6;margin-top:4px">${t('structure.missingFolders')}: ${r.missingFolders.map(f => esc(f)).join(', ')}</p>` : '<p style="font-size:.78rem;color:#34d399;margin-top:4px">全フォルダ存在</p>'}`;
            const actEl = $(`structure-actions-${r.templateId}`);
            if (actEl) {
                actEl.innerHTML = '';
                const prevBtn = document.createElement('button'); prevBtn.className = 'ghost-btn small-btn'; prevBtn.textContent = '👁️ プレビュー';
                prevBtn.addEventListener('click', async () => {
                    showLoading('プレビュー中...', '構造テンプレートの変更点をプレビューしています');
                    try {
                        const pr = await window.api.applyStructureTemplate({ templateId: r.templateId, preview: true });
                        hideLoading();
                        if (!pr.success) { addLog(`エラー: ${pr.error}`, 'error'); return; }
                        // インライン表示も維持
                        const preEl = $('structure-preview-result'); if (preEl) { preEl.style.display = 'block';
                        preEl.innerHTML = `<h4>${esc(pr.template.name)} プレビュー</h4>` + (pr.foldersToCreate.length > 0 ? `<p><strong>📁 作成フォルダ (${pr.foldersToCreate.length}):</strong> ${pr.foldersToCreate.map(f => esc(f)).join(', ')}</p>` : '<p style="color:#34d399">全フォルダ存在</p>') + (pr.moveSuggestions.length > 0 ? `<p><strong>📝 移動候補 (${pr.moveSuggestions.length}):</strong></p><div class="scrollable-list" style="max-height:250px">${pr.moveSuggestions.slice(0, 50).map(s => `<div class="list-item-check"><span class="item-name">${esc(s.name)}</span><span class="item-meta">${esc(s.from)} → ${esc(s.to)}</span></div>`).join('')}</div>` : '<p class="muted-hint">移動候補なし</p>'); }
                        // モーダルでもプレビュー表示
                        var modalContent = (pr.foldersToCreate.length > 0 ? '<p><strong>📁 作成フォルダ (' + pr.foldersToCreate.length + '):</strong> ' + pr.foldersToCreate.map(function(f) { return esc(f); }).join(', ') + '</p>' : '<p style="color:#34d399">全フォルダ存在</p>') + (pr.moveSuggestions.length > 0 ? '<p style="margin-top:10px"><strong>📝 移動候補 (' + pr.moveSuggestions.length + '):</strong></p><div style="max-height:350px;overflow-y:auto">' + pr.moveSuggestions.slice(0, 50).map(function(s) { return '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.82rem"><span style="color:var(--green)">' + esc(s.name) + '</span> <span style="opacity:.5">' + esc(s.from) + ' → ' + esc(s.to) + '</span></div>'; }).join('') + '</div>' : '<p class="muted-hint">移動候補なし</p>');
                        showPreviewModal({
                            title: esc(pr.template.name) + ' プレビュー',
                            subtitle: 'フォルダ' + pr.foldersToCreate.length + '件, 移動' + pr.moveSuggestions.length + '件',
                            content: modalContent
                        });
                        addLog(`構造プレビュー: フォルダ${pr.foldersToCreate.length}件, 移動${pr.moveSuggestions.length}件`, 'info');
                    } catch (e) { hideLoading(); addLog(`エラー: ${e.message}`, 'error'); }
                });
                const applyBtn = document.createElement('button'); applyBtn.className = 'ghost-btn small-btn'; applyBtn.textContent = '✨ 適用'; applyBtn.style.marginLeft = '8px';
                applyBtn.addEventListener('click', async () => {
                    if (!await showConfirmModal('構造テンプレート適用の確認', '構造テンプレートを適用しますか？\nフォルダの作成やノートの移動が実行されます。', '適用する')) return;
                    showLoading('適用中...', '構造テンプレートを適用しています');
                    try {
                        const ar = await window.api.applyStructureTemplate({ templateId: r.templateId, preview: false });
                        hideLoading();
                        if (ar.success) { addLog(`✅ ${ar.template.name} 適用完了: フォルダ${ar.foldersCreated}件, ノート${ar.notesMoved}件移動`, 'success'); analyzeVaultStructure(); }
                        else addLog(`エラー: ${ar.error}`, 'error');
                    } catch (e) { hideLoading(); addLog(`エラー: ${e.message}`, 'error'); }
                });
                actEl.appendChild(prevBtn); actEl.appendChild(applyBtn);
            }
        }
    } catch (e) { addLog(`構造分析エラー: ${e.message}`, 'error'); }
}

// ============================================================
// Feature H: Force-directed グラフビュー
// ============================================================
let graphTabInitialized = false;
let graphAnimationId = null;
// グラフ状態を外部から操作するためのハンドル
let _graphState = null;

async function loadFullGraph() {
    const container = $('graph-container');
    if (!container) return;
    container.innerHTML = `<p class="muted-hint">${t('graph.loading')}</p>`;
    // UIリセット
    const statsBar = $('graph-stats-bar');
    const folderPanel = $('graph-folder-panel');
    const infoPanel = $('graph-info-panel');
    const egoBtn = $('btn-graph-ego');
    const egoResetBtn = $('btn-graph-ego-reset');
    if (statsBar) statsBar.style.display = 'none';
    if (folderPanel) { folderPanel.style.display = 'none'; folderPanel.innerHTML = ''; }
    if (infoPanel) infoPanel.style.display = 'none';
    if (egoBtn) egoBtn.style.display = 'none';
    if (egoResetBtn) egoResetBtn.style.display = 'none';
    try {
        const res = await window.api.getFullGraph();
        if (!res.success || !res.nodes || res.nodes.length === 0) { container.innerHTML = `<p class="muted-hint">${t('graph.empty')}</p>`; return; }
        renderForceGraph(container, res.nodes, res.edges);
        addLog(`🕸️ グラフ: ${res.nodes.length}ノード / ${res.edges.length}エッジ`, 'info', 'GRAPH');
    } catch (e) { container.innerHTML = `<p class="muted-hint" style="color:var(--danger)">${esc(e.message)}</p>`; }
}

function renderForceGraph(container, nodes, edges) {
    if (graphAnimationId) { cancelAnimationFrame(graphAnimationId); graphAnimationId = null; }
    const containerW = container.clientWidth || 900;
    const SIZE = Math.max(600, Math.min(containerW, 900));
    const W = SIZE, H = SIZE;
    const CX = W / 2, CY = H / 2, CR = SIZE / 2 - 4; // 円の中心と半径
    const svgNS = 'http://www.w3.org/2000/svg';
    container.innerHTML = '';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.style.cssText = 'overflow:hidden;display:block;margin:0 auto';
    container.appendChild(svg);

    // 円形クリップパスと背景
    const defs = document.createElementNS(svgNS, 'defs');
    const clipPath = document.createElementNS(svgNS, 'clipPath');
    clipPath.setAttribute('id', 'graph-circle-clip');
    const clipCircle = document.createElementNS(svgNS, 'circle');
    clipCircle.setAttribute('cx', CX); clipCircle.setAttribute('cy', CY); clipCircle.setAttribute('r', CR);
    clipPath.appendChild(clipCircle);
    // 背景グラデーション
    const radGrad = document.createElementNS(svgNS, 'radialGradient');
    radGrad.setAttribute('id', 'graph-bg-grad'); radGrad.setAttribute('cx', '50%'); radGrad.setAttribute('cy', '50%'); radGrad.setAttribute('r', '50%');
    const stop1 = document.createElementNS(svgNS, 'stop'); stop1.setAttribute('offset', '0%'); stop1.setAttribute('stop-color', 'rgba(40,30,80,0.5)');
    const stop2 = document.createElementNS(svgNS, 'stop'); stop2.setAttribute('offset', '70%'); stop2.setAttribute('stop-color', 'rgba(12,16,32,0.7)');
    const stop3 = document.createElementNS(svgNS, 'stop'); stop3.setAttribute('offset', '100%'); stop3.setAttribute('stop-color', 'rgba(6,8,20,0.9)');
    radGrad.appendChild(stop1); radGrad.appendChild(stop2); radGrad.appendChild(stop3);
    defs.appendChild(clipPath); defs.appendChild(radGrad);
    svg.appendChild(defs);

    // 背景円 + 枠線
    const bgCircle = document.createElementNS(svgNS, 'circle');
    bgCircle.setAttribute('cx', CX); bgCircle.setAttribute('cy', CY); bgCircle.setAttribute('r', CR);
    bgCircle.setAttribute('fill', 'url(#graph-bg-grad)');
    bgCircle.setAttribute('stroke', 'rgba(124,108,248,0.15)'); bgCircle.setAttribute('stroke-width', '2');
    svg.appendChild(bgCircle);

    // 同心円ガイドライン（Obsidian風の薄いリング）
    [0.25, 0.5, 0.75].forEach(ratio => {
        const guide = document.createElementNS(svgNS, 'circle');
        guide.setAttribute('cx', CX); guide.setAttribute('cy', CY); guide.setAttribute('r', CR * ratio);
        guide.setAttribute('fill', 'none'); guide.setAttribute('stroke', 'rgba(124,108,248,0.06)'); guide.setAttribute('stroke-width', '1');
        svg.appendChild(guide);
    });

    // ズーム・パン用グループ（円形クリップ適用）
    const rootG = document.createElementNS(svgNS, 'g');
    rootG.setAttribute('clip-path', 'url(#graph-circle-clip)');
    svg.appendChild(rootG);
    let zoomScale = 1, panX = 0, panY = 0;
    function updateTransform() { rootG.setAttribute('transform', `translate(${panX},${panY}) scale(${zoomScale})`); }
    updateTransform();

    const folders = [...new Set(nodes.map(n => n.folder))];
    const COLORS = ['#7c6cf8','#34d399','#f59e0b','#f87171','#60a5fa','#a78bfa','#fb923c','#4ade80','#38bdf8','#e879f9','#facc15','#2dd4bf','#c084fc','#fb7185'];
    const fColor = {}; folders.forEach((f, i) => fColor[f] = COLORS[i % COLORS.length]);
    const maxL = Math.max(1, ...nodes.map(n => n.linkCount));
    const nodeCount = nodes.length;

    // ノード数に応じた物理パラメータ
    const scaleFactor = Math.sqrt(W * H / nodeCount);
    const REPULSION = scaleFactor * scaleFactor * 0.8;
    const SPRING_LEN = scaleFactor * 0.9;
    const SPRING_K = 0.004;
    const CENTER_GRAVITY = 0.002;
    const DAMPING = 0.85;

    // 隣接リスト構築
    const adjacency = {};
    nodes.forEach(n => adjacency[n.id] = new Set());

    // 初期配置: MOCを中心近く、その他はクラスタ別に配置
    const mocNodes = nodes.filter(n => n.isMoc);
    const otherNodes = nodes.filter(n => !n.isMoc);
    const orderedNodes = [...mocNodes, ...otherNodes];

    const sim = orderedNodes.map((n, i) => {
        let x, y;
        if (n.isMoc) {
            const angle = (2 * Math.PI * i) / Math.max(1, mocNodes.length);
            const r = CR * 0.2;
            x = CX + Math.cos(angle) * r;
            y = CY + Math.sin(angle) * r;
        } else {
            const fi = folders.indexOf(n.folder);
            const clusterAngle = (2 * Math.PI * fi) / Math.max(1, folders.length);
            const clusterR = CR * 0.55;
            const cx = CX + Math.cos(clusterAngle) * clusterR;
            const cy = CY + Math.sin(clusterAngle) * clusterR;
            x = cx + (Math.random() - 0.5) * clusterR * 0.4;
            y = cy + (Math.random() - 0.5) * clusterR * 0.4;
        }
        return { ...n, x, y, vx: 0, vy: 0, r: Math.max(3, 2.5 + (n.linkCount / maxL) * 16) };
    });
    const byId = {}; sim.forEach(n => byId[n.id] = n);
    const sEdges = edges.map(e => ({ s: byId[e.source], t: byId[e.target] })).filter(e => e.s && e.t);

    // 隣接リスト完成
    sEdges.forEach(e => {
        if (adjacency[e.s.id]) adjacency[e.s.id].add(e.t.id);
        if (adjacency[e.t.id]) adjacency[e.t.id].add(e.s.id);
    });

    // エッジアニメーション用グループ（エッジグループの上に配置）
    const eGroup = document.createElementNS(svgNS, 'g'); rootG.appendChild(eGroup);
    const flowGroup = document.createElementNS(svgNS, 'g'); rootG.appendChild(flowGroup);
    const nGroup = document.createElementNS(svgNS, 'g'); rootG.appendChild(nGroup);
    const lGroup = document.createElementNS(svgNS, 'g'); rootG.appendChild(lGroup);

    // エッジ描画（接続の重要度で太さ・透明度を変える）
    const maxDeg = Math.max(1, ...sim.map(n => n.linkCount));
    const lines = sEdges.map(e => {
        const l = document.createElementNS(svgNS, 'line');
        const importance = (e.s.linkCount + e.t.linkCount) / (maxDeg * 2);
        const alpha = 0.04 + importance * 0.15;
        const width = 0.3 + importance * 1.2;
        l.setAttribute('stroke', `rgba(255,255,255,${alpha})`);
        l.setAttribute('stroke-width', width);
        l.dataset.si = e.s.id; l.dataset.ti = e.t.id;
        eGroup.appendChild(l);
        return l;
    });

    // ノード描画（グロー効果付き）— 改善5: 孤立ノードの視覚的区別
    const circles = sim.map(n => {
        const g = document.createElementNS(svgNS, 'g');
        g.style.cursor = 'pointer';
        // MOCノードにグロー
        if (n.isMoc) {
            const glow = document.createElementNS(svgNS, 'circle');
            glow.setAttribute('r', n.r + 6);
            glow.setAttribute('fill', 'none');
            glow.setAttribute('stroke', fColor[n.folder] || '#7c6cf8');
            glow.setAttribute('stroke-width', '3');
            glow.setAttribute('opacity', '0.3');
            g.appendChild(glow);
        }
        const c = document.createElementNS(svgNS, 'circle');
        c.setAttribute('r', n.r);
        c.setAttribute('fill', fColor[n.folder] || '#7c6cf8');
        // 改善5: 孤立ノード（linkCount===0）は破線ストローク＋低透明度
        if (n.linkCount === 0) {
            c.classList.add('orphan-node');
            c.setAttribute('stroke', fColor[n.folder] || '#7c6cf8');
            c.setAttribute('stroke-width', '1.5');
            c.setAttribute('stroke-dasharray', '3 2');
            c.setAttribute('opacity', '0.4');
        } else {
            c.setAttribute('opacity', n.isMoc ? '1' : '0.8');
        }
        if (n.isMoc) { c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '2'); }
        g.appendChild(c);
        nGroup.appendChild(g);
        return g;
    });

    // ラベル
    const LABEL_THR = Math.max(2, maxL * 0.08);
    let labelsVisible = true;
    const labels = sim.map(n => {
        if (n.linkCount < LABEL_THR && !n.isMoc) return null;
        const t = document.createElementNS(svgNS, 'text');
        const maxLen = n.isMoc ? 24 : 16;
        t.textContent = n.name.length > maxLen ? n.name.slice(0, maxLen - 2) + '…' : n.name;
        t.setAttribute('fill', n.isMoc ? '#fff' : 'rgba(255,255,255,.8)');
        t.setAttribute('font-size', n.isMoc ? '12' : '9');
        t.setAttribute('font-weight', n.isMoc ? 'bold' : 'normal');
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('pointer-events', 'none');
        t.setAttribute('stroke', 'rgba(0,0,0,.7)');
        t.setAttribute('stroke-width', '3');
        t.setAttribute('paint-order', 'stroke');
        lGroup.appendChild(t);
        return t;
    });

    // 改善6: エッジアニメーション（ホバー時に流れるドット）
    let flowAnimId = null;
    let flowDots = [];
    function clearFlowDots() {
        if (flowAnimId) { cancelAnimationFrame(flowAnimId); flowAnimId = null; }
        flowDots.forEach(d => { if (d.el && d.el.parentNode) d.el.parentNode.removeChild(d.el); });
        flowDots = [];
    }
    function createFlowDots(nodeIdx) {
        clearFlowDots();
        const n = sim[nodeIdx];
        const color = fColor[n.folder] || '#7c6cf8';
        sEdges.forEach((e, ei) => {
            const isConn = e.s.id === n.id || e.t.id === n.id;
            if (!isConn) return;
            // 各エッジに2つのドットを配置（時差をつける）
            for (let d = 0; d < 2; d++) {
                const dot = document.createElementNS(svgNS, 'circle');
                dot.setAttribute('r', '2.5');
                dot.setAttribute('fill', color);
                dot.setAttribute('opacity', '0.9');
                dot.classList.add('edge-flow-dot');
                flowGroup.appendChild(dot);
                // ソースからターゲットに向かって流れる（ノードが起点）
                const fromS = e.s.id === n.id;
                flowDots.push({ el: dot, ei, fromS, progress: d * 0.5, speed: 0.012 + Math.random() * 0.008 });
            }
        });
        function animateFlow() {
            for (const fd of flowDots) {
                fd.progress += fd.speed;
                if (fd.progress > 1) fd.progress -= 1;
                const e = sEdges[fd.ei];
                const sx = fd.fromS ? e.s.x : e.t.x;
                const sy = fd.fromS ? e.s.y : e.t.y;
                const tx = fd.fromS ? e.t.x : e.s.x;
                const ty = fd.fromS ? e.t.y : e.s.y;
                const px = sx + (tx - sx) * fd.progress;
                const py = sy + (ty - sy) * fd.progress;
                fd.el.setAttribute('cx', px);
                fd.el.setAttribute('cy', py);
                // フェードアウト効果（端に近づくと薄く）
                const fade = Math.min(fd.progress, 1 - fd.progress) * 4;
                fd.el.setAttribute('opacity', Math.min(0.9, fade));
            }
            if (flowDots.length > 0) flowAnimId = requestAnimationFrame(animateFlow);
        }
        if (flowDots.length > 0) animateFlow();
    }

    // ホバー時のハイライト
    let hoverNode = null;
    function setHover(nodeIdx) {
        if (nodeIdx === hoverNode) return;
        hoverNode = nodeIdx;
        if (nodeIdx === null) {
            clearFlowDots();
            // リセット
            circles.forEach((g, i) => {
                if (g.style.display === 'none') return; // フィルターで非表示
                const isOrphan = sim[i].linkCount === 0;
                g.querySelector('circle:last-child').setAttribute('opacity', isOrphan ? '0.4' : (sim[i].isMoc ? '1' : '0.8'));
            });
            lines.forEach((l, i) => {
                if (l.style.display === 'none') return;
                const importance = (sEdges[i].s.linkCount + sEdges[i].t.linkCount) / (maxDeg * 2);
                l.setAttribute('stroke', `rgba(255,255,255,${0.04 + importance * 0.15})`);
                l.setAttribute('stroke-width', 0.3 + importance * 1.2);
            });
            labels.forEach((t, i) => { if (t && t.style.display !== 'none') t.setAttribute('opacity', '1'); });
        } else {
            const n = sim[nodeIdx];
            const neighbors = adjacency[n.id] || new Set();
            circles.forEach((g, i) => {
                if (g.style.display === 'none') return;
                const isActive = i === nodeIdx || neighbors.has(sim[i].id);
                g.querySelector('circle:last-child').setAttribute('opacity', isActive ? '1' : '0.15');
            });
            lines.forEach((l, i) => {
                if (l.style.display === 'none') return;
                const e = sEdges[i];
                const isActive = e.s.id === n.id || e.t.id === n.id;
                if (isActive) {
                    l.setAttribute('stroke', fColor[n.folder] || '#7c6cf8');
                    l.setAttribute('stroke-width', '2');
                } else {
                    l.setAttribute('stroke', 'rgba(255,255,255,0.02)');
                    l.setAttribute('stroke-width', '0.3');
                }
            });
            labels.forEach((t, i) => {
                if (!t || t.style.display === 'none') return;
                const isActive = i === nodeIdx || neighbors.has(sim[i].id);
                t.setAttribute('opacity', isActive ? '1' : '0.15');
            });
            // 改善6: 流れるドットアニメーション
            createFlowDots(nodeIdx);
        }
    }
    circles.forEach((g, i) => {
        g.addEventListener('mouseenter', () => setHover(i));
        g.addEventListener('mouseleave', () => setHover(null));
    });

    // ツールチップ
    const tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:absolute;background:rgba(20,15,40,.92);border:1px solid rgba(124,108,248,.4);border-radius:8px;padding:8px 12px;color:#fff;font-size:12px;pointer-events:none;display:none;z-index:100;backdrop-filter:blur(8px);max-width:250px;line-height:1.4';
    container.style.position = 'relative';
    container.appendChild(tooltip);
    circles.forEach((g, i) => {
        g.addEventListener('mouseenter', (ev) => {
            const n = sim[i];
            const neighbors = adjacency[n.id] || new Set();
            tooltip.innerHTML = `<strong style="color:${fColor[n.folder]}">${esc(n.name)}</strong><br>` +
                `<span style="opacity:.6">${esc(n.folder)}</span> &nbsp; リンク: <strong>${n.linkCount}</strong> &nbsp; 接続: <strong>${neighbors.size}</strong>` +
                (n.isMoc ? '<br><span style="color:#60a5fa">📌 MOC</span>' : '');
            tooltip.style.display = 'block';
        });
        g.addEventListener('mousemove', (ev) => {
            const cr = container.getBoundingClientRect();
            tooltip.style.left = (ev.clientX - cr.left + 15) + 'px';
            tooltip.style.top = (ev.clientY - cr.top - 10) + 'px';
        });
        g.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    });

    // 改善3: シングルクリックで情報パネル表示
    let selectedNodeIdx = null;
    const infoPanel = $('graph-info-panel');
    const infoName = $('graph-info-name');
    const infoBody = $('graph-info-body');
    const egoBtn = $('btn-graph-ego');
    const egoResetBtn = $('btn-graph-ego-reset');

    function showInfoPanel(nodeIdx) {
        selectedNodeIdx = nodeIdx;
        const n = sim[nodeIdx];
        const neighbors = adjacency[n.id] || new Set();
        if (infoPanel) infoPanel.style.display = 'block';
        if (egoBtn) egoBtn.style.display = 'inline-flex';
        if (infoName) infoName.textContent = n.name;
        if (infoBody) {
            const tagsCount = n.tags ? n.tags.length : 0;
            let html = '';
            html += `<div class="info-row"><span class="info-label">フォルダ</span><span class="info-value" style="color:${fColor[n.folder]}">${esc(n.folder)}</span></div>`;
            html += `<div class="info-row"><span class="info-label">リンク数</span><span class="info-value">${n.linkCount}</span></div>`;
            html += `<div class="info-row"><span class="info-label">接続数</span><span class="info-value">${neighbors.size}</span></div>`;
            html += `<div class="info-row"><span class="info-label">タグ数</span><span class="info-value">${tagsCount}</span></div>`;
            html += `<div class="info-row"><span class="info-label">MOC</span><span class="info-value">${n.isMoc ? '<span class="moc-badge">📌 MOC</span>' : 'いいえ'}</span></div>`;
            if (neighbors.size > 0) {
                html += `<div class="info-connections"><h4>接続ノート (${neighbors.size})</h4>`;
                for (const nId of neighbors) {
                    const nb = byId[nId];
                    if (nb) {
                        html += `<span class="conn-link" data-node-id="${esc(nId)}">${esc(nb.name)}</span>`;
                    }
                }
                html += '</div>';
            }
            infoBody.innerHTML = html;
            // 接続ノートクリックでハイライト＋ズーム
            infoBody.querySelectorAll('.conn-link').forEach(el => {
                el.addEventListener('click', () => {
                    const targetId = el.dataset.nodeId;
                    const targetIdx = sim.findIndex(s => s.id === targetId);
                    if (targetIdx >= 0) {
                        zoomToNode(targetIdx);
                        showInfoPanel(targetIdx);
                    }
                });
            });
        }
    }

    function hideInfoPanel() {
        selectedNodeIdx = null;
        if (infoPanel) infoPanel.style.display = 'none';
        if (egoBtn) egoBtn.style.display = 'none';
    }

    // シングルクリックとダブルクリックの区別
    let clickTimer = null;
    circles.forEach((g, i) => {
        g.addEventListener('click', (ev) => {
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
            clickTimer = setTimeout(() => {
                clickTimer = null;
                showInfoPanel(i);
            }, 250);
        });
    });

    // 情報パネル閉じる
    const infoCloseBtn = $('btn-graph-info-close');
    if (infoCloseBtn) infoCloseBtn.addEventListener('click', hideInfoPanel);

    // 凡例（SVG外のHTML要素として）
    const legDiv = document.createElement('div');
    legDiv.style.cssText = 'position:absolute;top:20px;right:20px;background:rgba(10,8,20,.8);border-radius:10px;padding:10px 14px;backdrop-filter:blur(8px);border:1px solid rgba(124,108,248,.15);max-height:300px;overflow-y:auto';
    folders.slice(0, 14).forEach(f => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:10px;color:rgba(255,255,255,.7)';
        const dot = document.createElement('span');
        dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${fColor[f]};flex-shrink:0`;
        row.appendChild(dot);
        row.appendChild(document.createTextNode(f));
        legDiv.appendChild(row);
    });
    container.appendChild(legDiv);

    // 改善8: 統計バー
    const statsBar = $('graph-stats-bar');
    if (statsBar) {
        const mocCount = sim.filter(n => n.isMoc).length;
        const orphanCount = sim.filter(n => n.linkCount === 0).length;
        statsBar.innerHTML = `<span class="stat-item"><span class="stat-value">${sim.length}</span> ノード</span>` +
            `<span class="stat-item"><span class="stat-value">${sEdges.length}</span> エッジ</span>` +
            `<span class="stat-item"><span class="stat-value">${mocCount}</span> MOC</span>` +
            `<span class="stat-item"><span class="stat-value">${orphanCount}</span> 孤立</span>`;
        statsBar.style.display = 'flex';
    }

    // 改善2: フォルダフィルターパネル構築
    const folderPanel = $('graph-folder-panel');
    const hiddenFolders = new Set();
    if (folderPanel) {
        folderPanel.innerHTML = '';
        folders.forEach(f => {
            const lbl = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = true; cb.dataset.folder = f;
            const dotSpan = document.createElement('span');
            dotSpan.className = 'folder-dot';
            dotSpan.style.background = fColor[f];
            lbl.appendChild(cb);
            lbl.appendChild(dotSpan);
            lbl.appendChild(document.createTextNode(f));
            folderPanel.appendChild(lbl);
            cb.addEventListener('change', () => {
                if (cb.checked) { hiddenFolders.delete(f); } else { hiddenFolders.add(f); }
                applyFolderFilter();
            });
        });
    }

    function applyFolderFilter() {
        sim.forEach((n, i) => {
            const hidden = hiddenFolders.has(n.folder);
            circles[i].style.display = hidden ? 'none' : '';
            if (labels[i]) labels[i].style.display = hidden ? 'none' : '';
        });
        sEdges.forEach((e, i) => {
            const hidden = hiddenFolders.has(e.s.folder) || hiddenFolders.has(e.t.folder);
            lines[i].style.display = hidden ? 'none' : '';
        });
    }

    // フォルダフィルタートグルボタン
    const folderToggleBtn = $('btn-graph-folder-toggle');
    if (folderToggleBtn && folderPanel) {
        folderToggleBtn.addEventListener('click', () => {
            const isOpen = folderPanel.style.display !== 'none';
            folderPanel.style.display = isOpen ? 'none' : 'flex';
            folderToggleBtn.textContent = isOpen ? '📂 フォルダフィルター ▶' : '📂 フォルダフィルター ▼';
        });
    }

    // 物理シミュレーション
    let iter = 0; const MAX_ITER = 600;
    function tick() {
        const cooling = 1 - iter / MAX_ITER * 0.7;
        for (let i = 0; i < sim.length; i++) {
            for (let j = i + 1; j < sim.length; j++) {
                let dx = sim[i].x - sim[j].x, dy = sim[i].y - sim[j].y;
                let d2 = dx * dx + dy * dy;
                if (d2 < 1) d2 = 1;
                let d = Math.sqrt(d2);
                if (d < 30) d = 30;
                const f = REPULSION / (d * d) * cooling;
                const fx = (dx / d) * f, fy = (dy / d) * f;
                sim[i].vx += fx; sim[i].vy += fy;
                sim[j].vx -= fx; sim[j].vy -= fy;
            }
        }
        for (const e of sEdges) {
            let dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
            let d = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = SPRING_K * (d - SPRING_LEN) * cooling;
            e.s.vx += (dx / d) * f; e.s.vy += (dy / d) * f;
            e.t.vx -= (dx / d) * f; e.t.vy -= (dy / d) * f;
        }
        for (const n of sim) {
            // 中心への引力
            n.vx += (CX - n.x) * CENTER_GRAVITY;
            n.vy += (CY - n.y) * CENTER_GRAVITY;
            // 円形ソフト境界
            const _dx = n.x - CX, _dy = n.y - CY;
            const _dist = Math.sqrt(_dx * _dx + _dy * _dy);
            const _boundR = CR - 40 - n.r;
            if (_dist > _boundR && _dist > 0) {
                const _push = (_dist - _boundR) * 0.08;
                n.vx -= (_dx / _dist) * _push;
                n.vy -= (_dy / _dist) * _push;
            }
            n.vx *= DAMPING; n.vy *= DAMPING;
            n.x += n.vx; n.y += n.vy;
        }
        // DOM更新
        sEdges.forEach((e, i) => { lines[i].setAttribute('x1', e.s.x); lines[i].setAttribute('y1', e.s.y); lines[i].setAttribute('x2', e.t.x); lines[i].setAttribute('y2', e.t.y); });
        sim.forEach((n, i) => {
            circles[i].setAttribute('transform', `translate(${n.x},${n.y})`);
            if (labels[i]) { labels[i].setAttribute('x', n.x); labels[i].setAttribute('y', n.y - n.r - 6); }
        });
        if (++iter < MAX_ITER) graphAnimationId = requestAnimationFrame(tick);
    }

    // ドラッグ
    let dragN = null;
    svg.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const r = svg.getBoundingClientRect();
        const mx = (e.clientX - r.left - panX) / zoomScale;
        const my = (e.clientY - r.top - panY) / zoomScale;
        for (const n of sim) if ((mx - n.x) ** 2 + (my - n.y) ** 2 < (n.r + 8) ** 2) { dragN = n; e.preventDefault(); break; }
    });
    svg.addEventListener('mousemove', e => {
        if (!dragN) return;
        const r = svg.getBoundingClientRect();
        dragN.x = (e.clientX - r.left - panX) / zoomScale;
        dragN.y = (e.clientY - r.top - panY) / zoomScale;
        dragN.vx = 0; dragN.vy = 0;
        if (iter >= MAX_ITER) { iter = MAX_ITER - 60; tick(); }
    });
    svg.addEventListener('mouseup', () => dragN = null);
    svg.addEventListener('mouseleave', () => dragN = null);

    // ズーム（マウスホイール）
    svg.addEventListener('wheel', e => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const newScale = Math.max(0.1, Math.min(5, zoomScale * factor));
        const r = svg.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        panX = mx - (mx - panX) * (newScale / zoomScale);
        panY = my - (my - panY) * (newScale / zoomScale);
        zoomScale = newScale;
        updateTransform();
    }, { passive: false });

    // ダブルクリックでObsidian起動
    circles.forEach((g, i) => g.addEventListener('dblclick', () => {
        // ダブルクリック時にシングルクリックタイマーをキャンセル（上のclickイベントで処理済み）
        const filePath = sim[i].path || (sim[i].name + '.md');
        window.api.openInObsidian(filePath).catch(() => {});
    }));

    // === 改善1: ノード検索 ===
    function zoomToNode(nodeIdx) {
        const n = sim[nodeIdx];
        const targetScale = 1.8;
        zoomScale = targetScale;
        panX = W / 2 - n.x * targetScale;
        panY = H / 2 - n.y * targetScale;
        updateTransform();
        // ハイライト: ノードを一時的にパルスさせる
        const circle = circles[nodeIdx].querySelector('circle:last-child');
        const origR = parseFloat(circle.getAttribute('r'));
        circle.setAttribute('r', origR + 5);
        circle.setAttribute('stroke', '#fff');
        circle.setAttribute('stroke-width', '3');
        setTimeout(() => {
            circle.setAttribute('r', origR);
            if (!sim[nodeIdx].isMoc) { circle.removeAttribute('stroke'); circle.removeAttribute('stroke-width'); }
            else { circle.setAttribute('stroke', '#fff'); circle.setAttribute('stroke-width', '2'); }
        }, 1200);
    }

    const searchInput = $('graph-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim().toLowerCase();
            if (!q) return;
            const found = sim.findIndex(n => n.name.toLowerCase().includes(q));
            if (found >= 0) {
                zoomToNode(found);
                showInfoPanel(found);
            }
        });
        // Enterキーで次の一致へ
        let lastSearchIdx = -1;
        searchInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                const q = searchInput.value.trim().toLowerCase();
                if (!q) return;
                let startIdx = lastSearchIdx + 1;
                if (startIdx >= sim.length) startIdx = 0;
                let found = -1;
                for (let i = 0; i < sim.length; i++) {
                    const idx = (startIdx + i) % sim.length;
                    if (sim[idx].name.toLowerCase().includes(q)) { found = idx; break; }
                }
                if (found >= 0) {
                    lastSearchIdx = found;
                    zoomToNode(found);
                    showInfoPanel(found);
                }
            }
        });
    }

    // === 改善4: フィット/リセットボタン ===
    function fitAll() {
        // 表示中の全ノードが収まるようにズーム・パンを計算
        const visibleNodes = sim.filter((n, i) => circles[i].style.display !== 'none');
        if (visibleNodes.length === 0) return;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        visibleNodes.forEach(n => {
            if (n.x < minX) minX = n.x;
            if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.y > maxY) maxY = n.y;
        });
        const graphW = maxX - minX + 100;
        const graphH = maxY - minY + 100;
        const scaleX = W / graphW;
        const scaleY = H / graphH;
        zoomScale = Math.min(scaleX, scaleY, 2);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        panX = W / 2 - cx * zoomScale;
        panY = H / 2 - cy * zoomScale;
        updateTransform();
    }

    const fitBtn = $('btn-graph-fit');
    if (fitBtn) fitBtn.addEventListener('click', fitAll);

    // === 改善7: ラベル切替 ===
    const labelBtn = $('btn-graph-labels');
    if (labelBtn) {
        labelBtn.addEventListener('click', () => {
            labelsVisible = !labelsVisible;
            lGroup.style.display = labelsVisible ? '' : 'none';
            labelBtn.textContent = labelsVisible ? '🏷️ ラベル切替' : '🏷️ ラベル表示';
        });
    }

    // === 改善9: PNG出力 ===
    const exportBtn = $('btn-graph-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            try {
                // SVGをシリアライズ
                const svgClone = svg.cloneNode(true);
                const serializer = new XMLSerializer();
                const svgStr = serializer.serializeToString(svgClone);
                const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(svgBlob);
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const scale = 2; // 高解像度
                    canvas.width = W * scale;
                    canvas.height = H * scale;
                    const ctx = canvas.getContext('2d');
                    // 背景を描画
                    ctx.fillStyle = '#0a0c1a';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.scale(scale, scale);
                    ctx.drawImage(img, 0, 0, W, H);
                    URL.revokeObjectURL(url);
                    // ダウンロード
                    const link = document.createElement('a');
                    link.download = `vault-graph-${new Date().toISOString().slice(0,10)}.png`;
                    link.href = canvas.toDataURL('image/png');
                    link.click();
                };
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    addLog('PNG出力に失敗しました', 'warn');
                };
                img.src = url;
            } catch (err) {
                addLog(`PNG出力エラー: ${err.message}`, 'warn');
            }
        });
    }

    // === 改善10: Egoグラフモード ===
    let egoModeActive = false;

    function getNodesWithinHops(startId, maxHops) {
        const visited = new Set([startId]);
        let frontier = new Set([startId]);
        for (let hop = 0; hop < maxHops; hop++) {
            const nextFrontier = new Set();
            for (const nId of frontier) {
                const neighbors = adjacency[nId] || new Set();
                for (const nbId of neighbors) {
                    if (!visited.has(nbId)) {
                        visited.add(nbId);
                        nextFrontier.add(nbId);
                    }
                }
            }
            frontier = nextFrontier;
        }
        return visited;
    }

    function activateEgoGraph(nodeIdx) {
        const n = sim[nodeIdx];
        const egoNodes = getNodesWithinHops(n.id, 2);
        egoModeActive = true;
        if (egoResetBtn) egoResetBtn.style.display = 'inline-flex';
        // ノードの表示/非表示
        sim.forEach((sn, i) => {
            const visible = egoNodes.has(sn.id);
            circles[i].style.display = visible ? '' : 'none';
            if (labels[i]) labels[i].style.display = visible ? '' : 'none';
        });
        // エッジの表示/非表示
        sEdges.forEach((e, i) => {
            const visible = egoNodes.has(e.s.id) && egoNodes.has(e.t.id);
            lines[i].style.display = visible ? '' : 'none';
        });
        // フィットしてズーム
        setTimeout(fitAll, 100);
    }

    function deactivateEgoGraph() {
        egoModeActive = false;
        if (egoResetBtn) egoResetBtn.style.display = 'none';
        // 全ノード・エッジを表示に戻す（フォルダフィルターも再適用）
        sim.forEach((sn, i) => {
            circles[i].style.display = '';
            if (labels[i]) labels[i].style.display = '';
        });
        sEdges.forEach((e, i) => {
            lines[i].style.display = '';
        });
        // フォルダフィルターの再適用
        applyFolderFilter();
        fitAll();
    }

    if (egoBtn) {
        egoBtn.addEventListener('click', () => {
            if (selectedNodeIdx !== null) activateEgoGraph(selectedNodeIdx);
        });
    }
    if (egoResetBtn) {
        egoResetBtn.addEventListener('click', deactivateEgoGraph);
    }

    // グラフ状態をグローバルに公開（再生成ボタン等で使用）
    _graphState = { sim, circles, labels, lines, sEdges, svg, W, H, zoomScale, panX, panY, updateTransform, fitAll, zoomToNode };

    tick();
}

// Feature J: レポートノート生成
async function generateReportNote() {
    showLoading('レポートノート生成中...', 'Dataviewクエリ付きレポートを作成しています');
    try {
        const res = await window.api.generateOptimizerReportNote();
        hideLoading();
        if (res.success) { addLog(`📊 レポートノート生成: ${res.reportName}`, 'success'); if (res.reportPath) window.api.openInObsidian(res.reportPath); }
        else addLog(`エラー: ${res.error}`, 'error');
    } catch (e) { hideLoading(); addLog(`エラー: ${e.message}`, 'error'); }
}

// activateTabをオーバーライドして構造/グラフ/タスクタブの遅延初期化
let taskTabInitialized = false;
const _origActivateTab = activateTab;
window.activateTab = function(tab) {
    _origActivateTab(tab);
    // タブ統合対応: tools タブにはstructureサブタブが含まれる
    if ((tab === 'structure' || tab === 'tools') && !structureTabInitialized) { structureTabInitialized = true; loadStructureTemplates(); }
    // analytics タブにはgraphサブタブが含まれる
    if ((tab === 'graph' || tab === 'analytics') && !graphTabInitialized) { graphTabInitialized = true; loadFullGraph(); }
    if (tab === 'tasks' && !taskTabInitialized) { taskTabInitialized = true; loadTaskTab(); }
};

// ============================================================
// Obsidianダッシュボード生成（ウィザード形式）
// ============================================================
const DASHBOARD_TYPE_INFO = {
    full: {
        label: '🖥️ フルダッシュボード',
        fileName: '🖥️ Dashboard.md',
        sections: [
            '📊 Vault概要（総ノート数・タスク数）',
            '✅ 今日のタスク / 今週の期限 / 期限切れ',
            '📝 最近更新したノート TOP15',
            '🏷️ タグ別ノート数 TOP20',
            '📂 フォルダ別ノート数',
            '🔗 被リンク数TOP10',
            '🗓️ 今月作成したノート',
            '🌱 孤立ノート一覧',
        ],
        plugins: ['Dataview（必須）', 'Tasks（タスク表示に必要）'],
    },
    tasks: {
        label: '✅ タスクボード',
        fileName: '✅ Task Board.md',
        sections: [
            '🔴 期限切れタスク',
            '🟡 今日のタスク',
            '🔵 今週のタスク',
            '🟢 来週以降のタスク',
            '✅ 最近完了したタスク',
            '📊 プロジェクト別タスク集計',
            '📌 優先度高タスク',
        ],
        plugins: ['Dataview（必須）', 'Tasks（必須）'],
    },
    weekly: {
        label: '📅 週次レビュー',
        fileName: '📅 Weekly Review [日付].md',
        sections: [
            '📝 今週書いたノート一覧',
            '✅ 今週完了したタスク',
            '⏳ 持ち越しタスク',
            '📊 振り返りセクション（手動記入）',
            '🔗 今週リンクしたノート',
        ],
        plugins: ['Dataview（必須）', 'Tasks（タスク表示に必要）'],
    },
    projects: {
        label: '📋 プロジェクトボード',
        fileName: '📋 Projects.md',
        sections: [
            '🔥 アクティブプロジェクト（進捗率付き）',
            '📅 期限が近いプロジェクト',
            '✅ 完了プロジェクト',
            '📊 プロジェクト概要',
        ],
        plugins: ['Dataview（必須）'],
    },
};

let selectedDashType = null;

function selectDashboardType(type) {
    selectedDashType = type;
    const info = DASHBOARD_TYPE_INFO[type];
    if (!info) return;

    // カードのハイライト
    document.querySelectorAll('.dashboard-gen-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.dashType === type);
    });

    // プレビュー表示
    const area = $('dash-preview-area');
    if (area) area.style.display = 'block';

    const titleEl = $('dash-preview-title');
    if (titleEl) titleEl.textContent = `${info.label} のプレビュー`;

    const locEl = $('dash-preview-location');
    if (locEl) locEl.textContent = `📄 ${info.fileName}`;

    const sectionsEl = $('dash-preview-sections');
    if (sectionsEl) {
        let html = '<div style="margin-bottom:10px"><strong style="font-size:.82rem">含まれるセクション:</strong></div>';
        html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">';
        info.sections.forEach(s => {
            html += `<span style="padding:4px 10px;background:rgba(124,108,248,.1);border:1px solid rgba(124,108,248,.2);border-radius:6px;font-size:.78rem">${s}</span>`;
        });
        html += '</div>';
        html += '<div style="font-size:.78rem;opacity:.6"><strong>必要プラグイン:</strong> ' + info.plugins.join('、') + '</div>';
        sectionsEl.innerHTML = html;
    }
}

function cancelDashboardSelection() {
    selectedDashType = null;
    document.querySelectorAll('.dashboard-gen-card').forEach(card => card.classList.remove('selected'));
    const area = $('dash-preview-area');
    if (area) area.style.display = 'none';
}

async function confirmGenerateDashboard() {
    if (!selectedDashType) return;
    const info = DASHBOARD_TYPE_INFO[selectedDashType];
    const resultEl = $('dashboard-gen-result');

    if (resultEl) { resultEl.innerHTML = `<span style="color:var(--cyan)">⏳ ${info.label} を生成中...</span>`; resultEl.className = 'moc-result-msg info'; }

    try {
        const res = await window.api.generateObsidianDashboard({ type: selectedDashType });
        if (res.success) {
            addLog(`✅ ${info.label} を生成しました: ${res.name}`, 'success');
            if (resultEl) {
                resultEl.innerHTML = `<div style="display:flex;align-items:center;gap:10px">` +
                    `<span style="color:var(--green);font-size:1.2rem">✅</span>` +
                    `<div><strong>${res.name}</strong> を生成しました！<br>` +
                    `<span style="font-size:.78rem;opacity:.6">Obsidianで自動的に開きます。開かない場合はサイドバーからノートを探してください。</span></div></div>`;
                resultEl.className = 'moc-result-msg success';
            }
            if (res.path) window.api.openInObsidian(res.path);
            cancelDashboardSelection();
        } else {
            addLog(`❌ ${info.label} 生成エラー: ${res.error}`, 'error');
            if (resultEl) { resultEl.textContent = `❌ エラー: ${res.error}`; resultEl.className = 'moc-result-msg error'; }
        }
    } catch (e) {
        addLog(`❌ ${info.label} 生成エラー: ${e.message}`, 'error');
        if (resultEl) { resultEl.textContent = `❌ エラー: ${e.message}`; resultEl.className = 'moc-result-msg error'; }
    }
}

// Feature C/H/I/J ボタンバインド
(function() {
    const safe = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    safe('btn-analyze-structure', analyzeVaultStructure);
    safe('btn-load-graph', loadFullGraph);
    safe('btn-generate-report-note', generateReportNote);
    // ダッシュボード生成ボタン（ウィザード形式: 選択→プレビュー→確認）
    safe('btn-gen-dash-full', () => selectDashboardType('full'));
    safe('btn-gen-dash-tasks', () => selectDashboardType('tasks'));
    safe('btn-gen-dash-weekly', () => selectDashboardType('weekly'));
    safe('btn-gen-dash-projects', () => selectDashboardType('projects'));
    safe('btn-dash-confirm', confirmGenerateDashboard);
    safe('btn-dash-cancel', cancelDashboardSelection);
    const langSel = $('language-select');
    if (langSel) langSel.addEventListener('change', e => {
        window.api.setAppLanguage(e.target.value).then(r => { if (r.success) { currentLang = r.language; addLog(`🌐 言語変更: ${r.language}`, 'info'); } });
    });
    initI18n();
})();

// ============================================================
// Feature 3: Vault ヘルスレポート出力
// ============================================================
async function runHealthReport() {
    addLog('📋 ヘルスレポートを生成中...', 'info');
    try {
        const res = await window.api.exportHealthReport();
        if (res.success) {
            addLog(`✅ ヘルスレポートを出力しました: ${res.filePath}`, 'success');
        } else if (res.canceled) {
            addLog('ℹ️ レポート出力をキャンセルしました', 'info');
        } else {
            addLog(`❌ レポート出力失敗: ${res.error}`, 'error');
        }
    } catch (e) {
        addLog(`❌ レポート出力エラー: ${e.message}`, 'error');
    }
}

// ============================================================
// Feature 9: ノートインポーター
// ============================================================
async function selectImportFolder() {
    try {
        const result = await window.api.selectImportPath({ type: 'folder' });
        if (result) {
            const pathEl = $('import-path');
            if (pathEl) pathEl.value = result;
            const btn = $('btn-import-execute');
            if (btn) btn.disabled = false;
        }
    } catch (e) {
        addLog(`❌ フォルダ選択エラー: ${e.message}`, 'error');
    }
}

async function selectImportFile() {
    try {
        const result = await window.api.selectImportPath({ type: 'file' });
        if (result) {
            const pathEl = $('import-path');
            if (pathEl) pathEl.value = result;
            const btn = $('btn-import-execute');
            if (btn) btn.disabled = false;
        }
    } catch (e) {
        addLog(`❌ ファイル選択エラー: ${e.message}`, 'error');
    }
}

async function executeImport() {
    const sourceEl = $('import-source');
    const pathEl = $('import-path');
    const resultEl = $('import-result');
    if (!sourceEl || !pathEl) return;

    const source = sourceEl.value;
    const inputPath = pathEl.value.trim();
    if (!inputPath) {
        if (resultEl) { resultEl.textContent = '⚠️ インポート元のパスを指定してください'; resultEl.style.color = 'var(--warn)'; }
        return;
    }

    const sourceLabels = { notion: 'Notion', evernote: 'Evernote', bear: 'Bear' };
    addLog(`📥 ${sourceLabels[source] || source} からインポート開始...`, 'info');
    if (resultEl) { resultEl.textContent = 'インポート中...'; resultEl.style.color = 'var(--muted)'; }

    const btn = $('btn-import-execute');
    if (btn) btn.disabled = true;

    try {
        const res = await window.api.importNotes({ source, inputPath });
        if (res.success) {
            const msg = `✅ ${res.imported}件のノートをインポートしました`;
            addLog(msg, 'success');
            if (resultEl) { resultEl.style.color = 'var(--green)'; }
            let displayMsg = msg;
            if (res.errors && res.errors.length > 0) {
                displayMsg += `\n⚠️ ${res.errors.length}件の警告:\n${res.errors.slice(0, 5).join('\n')}`;
                if (res.errors.length > 5) displayMsg += `\n...他 ${res.errors.length - 5} 件`;
                addLog(`⚠️ インポート警告: ${res.errors.length}件`, 'warn');
            }
            if (resultEl) resultEl.textContent = displayMsg;
        } else {
            const errMsg = `❌ インポート失敗: ${res.error}`;
            addLog(errMsg, 'error');
            if (resultEl) { resultEl.textContent = errMsg; resultEl.style.color = 'var(--danger)'; }
        }
    } catch (e) {
        const errMsg = `❌ インポートエラー: ${e.message}`;
        addLog(errMsg, 'error');
        if (resultEl) { resultEl.textContent = errMsg; resultEl.style.color = 'var(--danger)'; }
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ============================================================
// Feature 11: MOCテンプレート共有
// ============================================================
async function exportMocTemplate(templateId) {
    try {
        const res = await window.api.exportMocTemplate(templateId);
        if (res.success) {
            addLog(`📤 テンプレートを書き出しました: ${res.filePath}`, 'success');
        } else if (res.canceled) {
            // キャンセル — 何もしない
        } else {
            addLog(`❌ テンプレート書き出し失敗: ${res.error}`, 'error');
        }
    } catch (e) {
        addLog(`❌ テンプレート書き出しエラー: ${e.message}`, 'error');
    }
}

async function importMocTemplate() {
    try {
        const res = await window.api.importMocTemplate();
        if (res.success) {
            addLog(`📥 テンプレート "${res.template.name}" を読み込みました`, 'success');
            // テンプレート一覧を更新
            const tplRes = await window.api.getMocTemplates();
            if (tplRes.success) {
                mocTemplates = tplRes.templates;
                renderTemplateCards(mocTemplates);
                renderCustomTemplatesList();
            }
        } else if (res.canceled) {
            // キャンセル — 何もしない
        } else {
            addLog(`❌ テンプレート読み込み失敗: ${res.error}`, 'error');
        }
    } catch (e) {
        addLog(`❌ テンプレート読み込みエラー: ${e.message}`, 'error');
    }
}

// グローバル関数の公開（onclick用）
window.deleteCustomTemplate = deleteCustomTemplate;
window.exportMocTemplate = exportMocTemplate;
window.activateTab = window.activateTab; // オーバーライド済みを再公開
window.onCheckChange = onCheckChange;
window.setMocMode = setMocMode;
window.applyPreset = applyPreset;
window.createMocFromTag = createMocFromTag;

// ============================================================
// AI統合機能
// ============================================================

// AI設定のモデル定義
const AI_MODEL_OPTIONS = {
    claude: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    openai: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4o'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
};

// プロバイダー変更時にモデルリストを更新
function updateAiModelOptions() {
    const providerSel = $('ai-provider');
    const modelSel = $('ai-model');
    if (!providerSel || !modelSel) return;
    const provider = providerSel.value;
    const models = AI_MODEL_OPTIONS[provider] || [];
    modelSel.innerHTML = '';
    models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSel.appendChild(opt);
    });
}

// AI設定の保存
async function saveAiConfig() {
    const provider = $('ai-provider')?.value || 'claude';
    const apiKey = $('ai-api-key')?.value || '';
    const model = $('ai-model')?.value || '';
    const statusEl = $('ai-status');

    try {
        const res = await window.api.saveAiConfig({ provider, apiKey, model });
        if (res.success) {
            if (statusEl) { statusEl.textContent = '✅ 保存しました'; statusEl.className = 'ai-status-indicator ai-status-ok'; }
            addLog('🤖 AI設定を保存しました', 'success');
        } else {
            if (statusEl) { statusEl.textContent = '❌ ' + res.error; statusEl.className = 'ai-status-indicator ai-status-error'; }
        }
    } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.className = 'ai-status-indicator ai-status-error'; }
    }
}

// AI接続テスト
async function testAiConnection() {
    const statusEl = $('ai-status');
    if (statusEl) { statusEl.textContent = '⏳ テスト中...'; statusEl.className = 'ai-status-indicator ai-status-loading'; }

    // テスト前にまず保存
    await saveAiConfig();

    try {
        const res = await window.api.testAiConnection();
        if (res.success) {
            if (statusEl) { statusEl.textContent = '✅ ' + res.message; statusEl.className = 'ai-status-indicator ai-status-ok'; }
            addLog('🤖 AI接続テスト成功: ' + res.message, 'success');
        } else {
            if (statusEl) { statusEl.textContent = '❌ ' + res.error; statusEl.className = 'ai-status-indicator ai-status-error'; }
            addLog('🤖 AI接続テスト失敗: ' + res.error, 'error');
        }
    } catch (e) {
        if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.className = 'ai-status-indicator ai-status-error'; }
        addLog('🤖 AI接続テストエラー: ' + e.message, 'error');
    }
}

// ノート要約
async function aiSummarizeNote(filePath, targetEl) {
    if (!filePath || !targetEl) return;
    targetEl.innerHTML = '<span class="ai-loading">⏳ AI要約を生成中...</span>';
    try {
        const res = await window.api.aiSummarizeNote(filePath);
        if (res.success) {
            targetEl.innerHTML = '<div class="ai-result-box"><strong>✨ AI要約:</strong><br>' + esc(res.summary) + '</div>';
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// タグ提案
async function aiSuggestTags(filePath, targetEl) {
    if (!filePath || !targetEl) return;
    targetEl.innerHTML = '<span class="ai-loading">⏳ AIタグ提案を生成中...</span>';
    try {
        const res = await window.api.aiSuggestTags(filePath);
        if (res.success) {
            const tagsHtml = (res.tags || []).map(function(t) { return '<span class="tag-chip ai-tag-chip">' + esc(t) + '</span>'; }).join(' ');
            targetEl.innerHTML = '<div class="ai-result-box"><strong>🏷️ AIタグ提案:</strong><br>' + (tagsHtml || '(提案なし)') + '</div>';
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// リンク提案
async function aiSuggestLinks(filePath, targetEl) {
    if (!filePath || !targetEl) return;
    targetEl.innerHTML = '<span class="ai-loading">⏳ AIリンク提案を生成中...</span>';
    try {
        const res = await window.api.aiSuggestLinks(filePath);
        if (res.success) {
            const items = (res.suggestions || []);
            if (items.length === 0) {
                targetEl.innerHTML = '<div class="ai-result-box">🔗 関連ノートが見つかりませんでした</div>';
            } else {
                const linksHtml = items.map(function(s) {
                    return '<div class="ai-link-item"><strong>[[' + esc(s.title) + ']]</strong> — ' + esc(s.reason) + '</div>';
                }).join('');
                targetEl.innerHTML = '<div class="ai-result-box"><strong>🔗 AIリンク提案:</strong><br>' + linksHtml + '</div>';
            }
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// AI重複検出
async function aiFindDuplicates() {
    const resultEl = $('ai-duplicates-result');
    const emptyEl = $('ai-duplicates-empty');
    if (!resultEl) return;

    showLoading('AI重複検出中...', 'LLMにノートを送信しています（最大60秒）');
    resultEl.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    resultEl.innerHTML = '<p class="ai-loading">⏳ AIが意味的な重複を分析中...</p>';

    try {
        const res = await window.api.aiFindDuplicates();
        hideLoading();
        if (res.success) {
            if (!res.duplicates || res.duplicates.length === 0) {
                resultEl.innerHTML = '<p class="muted-hint">✅ 意味的な重複は検出されませんでした</p>';
                if (res.message) resultEl.innerHTML += '<p class="muted-hint">' + esc(res.message) + '</p>';
                addLog('🤖 AI重複検出完了: 重複なし (' + (res.totalChecked || 0) + '件チェック)', 'success');
            } else {
                let html = '<p class="muted-hint">🔍 ' + (res.totalChecked || 0) + '件のノートを分析し、' + res.duplicates.length + '組の重複を検出しました</p>';
                res.duplicates.forEach(function(d, i) {
                    html += '<div class="ai-duplicate-pair">'
                        + '<div class="ai-dup-header">重複ペア ' + (i + 1) + '</div>'
                        + '<div class="ai-dup-notes">'
                        + '<span class="ai-dup-note" title="' + esc(d.noteA?.path || '') + '">' + esc(d.noteA?.name || '?') + '</span>'
                        + '<span class="ai-dup-arrow">↔</span>'
                        + '<span class="ai-dup-note" title="' + esc(d.noteB?.path || '') + '">' + esc(d.noteB?.name || '?') + '</span>'
                        + '</div>'
                        + '<div class="ai-dup-reason">' + esc(d.reason) + '</div>'
                        + '</div>';
                });
                resultEl.innerHTML = html;
                addLog('🤖 AI重複検出完了: ' + res.duplicates.length + '組の重複 (' + res.totalChecked + '件チェック)', 'warn');
            }
        } else {
            resultEl.innerHTML = '<p class="ai-error">❌ ' + esc(res.error) + '</p>';
            addLog('🤖 AI重複検出エラー: ' + res.error, 'error');
        }
    } catch (e) {
        hideLoading();
        resultEl.innerHTML = '<p class="ai-error">❌ ' + esc(e.message) + '</p>';
        addLog('🤖 AI重複検出エラー: ' + e.message, 'error');
    }
}

// toggleNotePreview をAIボタン付きに拡張
const _origToggleNotePreview = typeof toggleNotePreview === 'function' ? toggleNotePreview : null;
async function toggleNotePreviewWithAI(itemEl, filePath) {
    const existing = itemEl.querySelector('.note-preview');
    if (existing) { existing.remove(); return; }

    let content = previewCache[filePath];
    if (!content) {
        try {
            const res = await window.api.readNotePreview(filePath);
            if (res.success) { content = res.preview; previewCache[filePath] = content; }
            else { content = '(読み込み失敗: ' + res.error + ')'; }
        } catch (e) { content = '(エラー: ' + e.message + ')'; }
    }

    const preview = document.createElement('div');
    preview.className = 'note-preview';

    const contentDiv = document.createElement('div');
    contentDiv.textContent = content;
    preview.appendChild(contentDiv);

    // AIボタン行
    const aiRow = document.createElement('div');
    aiRow.className = 'ai-action-row';

    const aiResultDiv = document.createElement('div');
    aiResultDiv.className = 'ai-inline-result';

    const summaryBtn = document.createElement('button');
    summaryBtn.className = 'ghost-btn small-btn ai-btn';
    summaryBtn.textContent = '✨ AI要約';
    summaryBtn.addEventListener('click', function() { aiSummarizeNote(filePath, aiResultDiv); });

    const tagBtn = document.createElement('button');
    tagBtn.className = 'ghost-btn small-btn ai-btn';
    tagBtn.textContent = '🏷️ AIタグ提案';
    tagBtn.addEventListener('click', function() { aiSuggestTags(filePath, aiResultDiv); });

    const linkBtn = document.createElement('button');
    linkBtn.className = 'ghost-btn small-btn ai-btn';
    linkBtn.textContent = '🔗 AIリンク提案';
    linkBtn.addEventListener('click', function() { aiSuggestLinks(filePath, aiResultDiv); });

    aiRow.appendChild(summaryBtn);
    aiRow.appendChild(tagBtn);
    aiRow.appendChild(linkBtn);
    preview.appendChild(aiRow);
    preview.appendChild(aiResultDiv);

    itemEl.appendChild(preview);
}

// AI設定の初期読み込み
async function loadAiConfig() {
    try {
        const cfg = await window.api.getConfig();
        const providerSel = $('ai-provider');
        const modelSel = $('ai-model');
        const apiKeyInput = $('ai-api-key');

        if (providerSel && cfg.aiProvider) providerSel.value = cfg.aiProvider;
        updateAiModelOptions();
        if (modelSel && cfg.aiModel) modelSel.value = cfg.aiModel;
        if (apiKeyInput && cfg.aiApiKey) {
            apiKeyInput.placeholder = '(設定済み) 変更する場合は新しいキーを入力';
        }
    } catch (_) { /* 初回起動時のエラーは無視 */ }
}

// AIボタンのバインド
(function bindAiButtons() {
    const safe = function(id, fn) { const el = $(id); if (el) el.addEventListener('click', fn); };

    const providerSel = $('ai-provider');
    if (providerSel) providerSel.addEventListener('change', updateAiModelOptions);

    const toggleKeyBtn = $('btn-toggle-api-key');
    if (toggleKeyBtn) {
        toggleKeyBtn.addEventListener('click', function() {
            const input = $('ai-api-key');
            if (input) { input.type = input.type === 'password' ? 'text' : 'password'; }
        });
    }

    safe('btn-save-ai-config', saveAiConfig);
    safe('btn-test-ai', testAiConnection);
    safe('btn-ai-find-duplicates', aiFindDuplicates);

    // Feature 1: Vault Q&A
    safe('btn-ai-ask', aiAskVault);
    var chatInput = $('ai-chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing) { aiAskVault(); }
        });
    }

    // Feature 2: 週次インサイト
    safe('btn-ai-weekly-insight', aiWeeklyInsight);

    // Feature 3: AI MOC構成
    safe('btn-ai-compose-moc', aiComposeMoc);

    // Feature 7: 知識ギャップ検出
    safe('btn-ai-detect-gaps', aiDetectGaps);

    // Feature 8: AI利用状況
    safe('btn-reset-ai-usage', resetAiUsage);
    loadAiUsage();

    loadAiConfig();
})();

// toggleNotePreviewをAI版で上書き
window.toggleNotePreviewWithAI = toggleNotePreviewWithAI;
window.aiSummarizeNote = aiSummarizeNote;
window.aiSuggestTags = aiSuggestTags;
window.aiSuggestLinks = aiSuggestLinks;

// ======================================================
// AI拡張機能 (Feature 1-8 新規)
// ======================================================

// Feature 1: Ask Your Vault
async function aiAskVault() {
    const input = $('ai-chat-input');
    const messagesEl = $('ai-chat-messages');
    if (!input || !messagesEl) return;
    const question = input.value.trim();
    if (!question) return;

    // ユーザーメッセージを表示
    const userMsg = document.createElement('div');
    userMsg.style.cssText = 'margin-bottom:8px;padding:8px 12px;border-radius:8px;background:rgba(99,102,241,.2);text-align:right';
    userMsg.textContent = question;
    messagesEl.appendChild(userMsg);

    // ローディング表示
    const loadingMsg = document.createElement('div');
    loadingMsg.style.cssText = 'margin-bottom:8px;padding:8px 12px;border-radius:8px;background:rgba(255,255,255,.06)';
    loadingMsg.innerHTML = '<span class="ai-loading">⏳ AIが回答を生成中...</span>';
    messagesEl.appendChild(loadingMsg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    input.value = '';

    try {
        const res = await window.api.aiAskVault({ question: question });
        if (res.success) {
            var html = '<div style="white-space:pre-wrap">' + esc(res.answer) + '</div>';
            if (res.sources && res.sources.length > 0) {
                html += '<div style="margin-top:8px;font-size:.78rem;opacity:.7">参照ノート: ';
                html += res.sources.map(function(s) {
                    return '<a href="#" class="ai-source-link" data-path="' + esc(s.path) + '" style="color:var(--accent);text-decoration:underline;cursor:pointer">' + esc(s.name) + '</a>';
                }).join(', ');
                html += '</div>';
            }
            loadingMsg.innerHTML = html;
            loadingMsg.querySelectorAll('.ai-source-link').forEach(function(link) {
                link.addEventListener('click', function(e) {
                    e.preventDefault();
                    var p = this.getAttribute('data-path');
                    if (p && window.api.openPath) window.api.openPath(p);
                });
            });
        } else {
            loadingMsg.innerHTML = '<div class="ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        loadingMsg.innerHTML = '<div class="ai-error">❌ ' + esc(e.message) + '</div>';
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Feature 2: Weekly AI Insight
async function aiWeeklyInsight() {
    var resultEl = $('ai-weekly-insight-result');
    if (!resultEl) return;
    resultEl.innerHTML = '<span class="ai-loading">⏳ AI週次インサイトを生成中...</span>';
    showLoading('AI週次インサイト生成中...', 'LLMにデータを送信しています');

    try {
        var res = await window.api.aiWeeklyInsight();
        hideLoading();
        if (res.success) {
            resultEl.innerHTML = '<div class="ai-result-box"><strong>📊 週次インサイト</strong> (' + (res.notesAnalyzed || 0) + '件のノートを分析)<div style="white-space:pre-wrap;margin-top:8px">' + esc(res.insight) + '</div></div>';
            addLog('📊 AI週次インサイト生成完了 (' + (res.notesAnalyzed || 0) + '件分析)', 'success');
        } else {
            resultEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        hideLoading();
        resultEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// Feature 3: AI MOC Auto-composition
async function aiComposeMoc() {
    var resultEl = $('ai-moc-compose-result');
    if (!resultEl) return;

    var topicInput = $('wizard-moc-name');
    var topic = topicInput ? topicInput.value.trim() : '';
    if (!topic) {
        showToast('先にMOC名（トピック）を入力してください', 'warn');
        return;
    }

    resultEl.style.display = 'block';
    resultEl.innerHTML = '<span class="ai-loading">⏳ AIがMOC構成を生成中...</span>';
    showLoading('AI MOC構成を生成中...', '「' + topic + '」に関連するノートを分析しています');

    try {
        var res = await window.api.aiComposeMoc({ topic: topic });
        hideLoading();
        if (res.success && res.mocData) {
            var html = '<div class="ai-result-box"><strong>🤖 AI MOC構成提案: ' + esc(res.mocData.title || topic) + '</strong>';
            if (res.mocData.description) {
                html += '<p style="margin:8px 0;opacity:.8">' + esc(res.mocData.description) + '</p>';
            }
            if (res.mocData.sections && res.mocData.sections.length > 0) {
                res.mocData.sections.forEach(function(sec) {
                    html += '<div style="margin-top:10px"><strong>' + esc(sec.heading) + '</strong><ul style="margin:4px 0 0 16px;list-style:disc">';
                    (sec.noteLinks || []).forEach(function(link) {
                        html += '<li>[[' + esc(link) + ']]</li>';
                    });
                    html += '</ul></div>';
                });
            }
            html += '</div>';
            resultEl.innerHTML = html;
            addLog('🤖 AI MOC構成完了: ' + topic, 'success');
        } else if (res.success && res.raw) {
            resultEl.innerHTML = '<div class="ai-result-box"><strong>🤖 AI MOC構成提案:</strong><div style="white-space:pre-wrap;margin-top:8px">' + esc(res.raw) + '</div></div>';
        } else {
            resultEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error || 'MOC構成の生成に失敗しました') + '</div>';
        }
    } catch (e) {
        hideLoading();
        resultEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// Feature 4: Note Quality Review
async function aiReviewNote(filePath, targetEl) {
    if (!filePath || !targetEl) return;
    targetEl.innerHTML = '<span class="ai-loading">⏳ AIレビューを生成中...</span>';
    try {
        var res = await window.api.aiReviewNote({ filePath: filePath });
        if (res.success) {
            var scoreHtml = '';
            if (res.score !== null && res.score !== undefined) {
                var color = res.score >= 70 ? 'var(--green)' : res.score >= 40 ? 'var(--yellow)' : 'var(--danger)';
                scoreHtml = ' <span style="color:' + color + ';font-weight:bold">(' + res.score + '/100)</span>';
            }
            targetEl.innerHTML = '<div class="ai-result-box"><strong>📝 AIレビュー' + scoreHtml + ':</strong><div style="white-space:pre-wrap;margin-top:6px">' + esc(res.review) + '</div></div>';
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// Feature 5: Flashcard Generation
async function aiGenerateFlashcards(filePath, targetEl) {
    if (!filePath || !targetEl) return;
    targetEl.innerHTML = '<span class="ai-loading">⏳ フラッシュカードを生成中...</span>';
    try {
        var res = await window.api.aiGenerateFlashcards({ filePath: filePath });
        if (res.success) {
            if (!res.cards || res.cards.length === 0) {
                targetEl.innerHTML = '<div class="ai-result-box">🎴 フラッシュカードを生成できませんでした</div>';
                return;
            }
            var html = '<div class="ai-result-box"><strong>🎴 フラッシュカード (' + res.cards.length + '枚)</strong><p style="font-size:.78rem;opacity:.7;margin:4px 0">MDファイルにも保存されました</p>';
            res.cards.forEach(function(c, i) {
                html += '<div style="margin-top:10px;padding:8px 12px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1)">';
                html += '<div style="font-weight:bold;color:var(--accent)">Q' + (i + 1) + ': ' + esc(c.question) + '</div>';
                html += '<div style="margin-top:4px;opacity:.85">A: ' + esc(c.answer) + '</div>';
                html += '</div>';
            });
            html += '</div>';
            targetEl.innerHTML = html;
            addLog('🎴 フラッシュカード生成完了 (' + res.cards.length + '枚)', 'success');
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// Feature 6: Bullet Point Expansion
async function aiExpandNote(filePath, targetEl) {
    if (!filePath || !targetEl) return;
    targetEl.innerHTML = '<span class="ai-loading">⏳ 文章を展開中...</span>';
    try {
        var res = await window.api.aiExpandNote({ filePath: filePath });
        if (res.success) {
            targetEl.innerHTML = '<div class="ai-result-box"><strong>📝 文章化結果:</strong><div style="white-space:pre-wrap;margin-top:6px">' + esc(res.expanded) + '</div></div>';
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// Feature 7: Knowledge Gap Detection
async function aiDetectGaps() {
    var resultEl = $('ai-gaps-result');
    if (!resultEl) return;
    resultEl.innerHTML = '<span class="ai-loading">⏳ 知識ギャップを分析中...</span>';
    showLoading('知識ギャップ検出中...', 'Vault全体をAIが分析しています');

    try {
        var res = await window.api.aiDetectGaps();
        hideLoading();
        if (res.success) {
            if (!res.gaps || res.gaps.length === 0) {
                resultEl.innerHTML = '<div class="ai-result-box">✅ 知識ギャップは検出されませんでした</div>';
                return;
            }
            var html = '<div class="ai-result-box"><strong>🔍 提案されたトピック (' + res.gaps.length + '件)</strong>';
            res.gaps.forEach(function(g) {
                html += '<div style="margin-top:8px;padding:8px 12px;border-radius:6px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1)">';
                html += '<div style="font-weight:bold;color:var(--accent)">' + esc(g.topic) + '</div>';
                html += '<div style="margin-top:4px;font-size:.85rem;opacity:.8">' + esc(g.reason) + '</div>';
                html += '</div>';
            });
            html += '</div>';
            resultEl.innerHTML = html;
            addLog('🔍 知識ギャップ検出完了: ' + res.gaps.length + '件の提案', 'success');
        } else {
            resultEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        hideLoading();
        resultEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// Feature 8: AI Usage Stats
async function loadAiUsage() {
    var statsEl = $('ai-usage-stats');
    if (!statsEl) return;
    try {
        var res = await window.api.getAiUsage();
        if (res.success && res.usage && res.usage.totalCalls > 0) {
            var u = res.usage;
            var USD_TO_JPY = 150;
            var costJpy = Math.round(u.totalEstimatedCost * USD_TO_JPY);
            var html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:8px">';
            html += '<div style="text-align:center;padding:10px;border-radius:8px;background:rgba(255,255,255,.04)"><div style="font-size:1.4rem;font-weight:bold">' + u.totalCalls + '</div><div style="font-size:.78rem;opacity:.7">総呼び出し回数</div></div>';
            html += '<div style="text-align:center;padding:10px;border-radius:8px;background:rgba(255,255,255,.04)"><div style="font-size:1.4rem;font-weight:bold">' + (u.totalInputTokens + u.totalOutputTokens).toLocaleString() + '</div><div style="font-size:.78rem;opacity:.7">総トークン数</div></div>';
            html += '<div style="text-align:center;padding:10px;border-radius:8px;background:rgba(255,255,255,.04)"><div style="font-size:1.4rem;font-weight:bold">$' + u.totalEstimatedCost.toFixed(4) + '</div><div style="font-size:.78rem;opacity:.7">推定コスト (USD)</div></div>';
            html += '<div style="text-align:center;padding:10px;border-radius:8px;background:rgba(255,255,255,.04)"><div style="font-size:1.4rem;font-weight:bold">約' + costJpy.toLocaleString() + '円</div><div style="font-size:.78rem;opacity:.7">推定コスト (JPY)</div></div>';
            html += '</div>';

            if (u.history && u.history.length > 0) {
                html += '<div style="margin-top:12px"><strong style="font-size:.85rem">直近の利用履歴:</strong>';
                html += '<div style="margin-top:6px;font-size:.8rem">';
                var recentHistory = u.history.slice(-5).reverse();
                recentHistory.forEach(function(h) {
                    var d = new Date(h.date);
                    var dateStr = d.toLocaleDateString('ja-JP') + ' ' + d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
                    html += '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">';
                    html += '<span style="opacity:.6">' + esc(dateStr) + '</span> ';
                    html += '<span style="color:var(--accent)">' + esc(h.feature) + '</span> ';
                    html += '<span style="opacity:.5">(' + ((h.inputTokens || 0) + (h.outputTokens || 0)) + 'tok)</span>';
                    html += '</div>';
                });
                html += '</div></div>';
            }
            statsEl.innerHTML = html;
        }
    } catch (_) { /* 初回起動時のエラーは無視 */ }
}

async function resetAiUsage() {
    try {
        await window.api.resetAiUsage();
        showToast('AI利用状況をリセットしました', 'success');
        var statsEl = $('ai-usage-stats');
        if (statsEl) statsEl.innerHTML = '<div class="list-empty">AI機能を使うと利用状況がここに表示されます</div>';
    } catch (e) {
        showToast('リセットに失敗: ' + e.message, 'error');
    }
}

window.aiReviewNote = aiReviewNote;
window.aiGenerateFlashcards = aiGenerateFlashcards;
window.aiExpandNote = aiExpandNote;

// ============================================================
// Feature 8: AI翻訳
// ============================================================
async function aiTranslateNote(filePath, targetLang, targetEl) {
    if (!filePath || !targetEl) return;
    const LANG_NAMES = { en: '英語', ja: '日本語', zh: '中国語' };
    targetEl.innerHTML = '<span class="ai-loading">⏳ ' + esc(LANG_NAMES[targetLang] || targetLang) + 'に翻訳中...</span>';
    try {
        const res = await window.api.aiTranslateNote({ filePath, targetLang });
        if (res.success) {
            targetEl.innerHTML = '<div class="ai-result-box"><strong>🌐 翻訳完了:</strong> <a href="#" onclick="window.api.openPath(\'' + esc(res.translatedPath).replace(/'/g, "\\'") + '\');return false;" style="color:var(--accent)">' + esc(res.translatedPath.split('/').pop()) + '</a><br><pre style="white-space:pre-wrap;margin-top:8px;max-height:200px;overflow:auto;font-size:.8rem">' + esc(res.content.slice(0, 500)) + (res.content.length > 500 ? '\n...(省略)' : '') + '</pre></div>';
            addLog('🌐 翻訳完了: ' + res.translatedPath.split('/').pop(), 'success');
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// ============================================================
// Feature 9: 会議メモ構造化
// ============================================================
async function aiStructureMeeting(filePath, targetEl) {
    if (!filePath || !targetEl) return;
    targetEl.innerHTML = '<span class="ai-loading">⏳ 議事録を構造化中...</span>';
    try {
        const res = await window.api.aiStructureMeeting({ filePath });
        if (res.success) {
            targetEl.innerHTML = '<div class="ai-result-box"><strong>📋 構造化された議事録:</strong><pre style="white-space:pre-wrap;margin-top:8px;max-height:400px;overflow:auto;font-size:.82rem">' + esc(res.structured) + '</pre></div>';
            addLog('📋 議事録構造化完了', 'success');
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// ============================================================
// Feature 10: 文体変換
// ============================================================
async function aiConvertTone(filePath, tone, targetEl) {
    if (!filePath || !targetEl) return;
    const TONE_NAMES = { formal: 'フォーマル', casual: 'カジュアル', academic: '学術的', blog: 'ブログ風' };
    targetEl.innerHTML = '<span class="ai-loading">⏳ ' + esc(TONE_NAMES[tone] || tone) + 'に変換中...</span>';
    try {
        const res = await window.api.aiConvertTone({ filePath, tone });
        if (res.success) {
            targetEl.innerHTML = '<div class="ai-result-box"><strong>✍️ 文体変換結果 (' + esc(TONE_NAMES[tone] || tone) + '):</strong><pre style="white-space:pre-wrap;margin-top:8px;max-height:300px;overflow:auto;font-size:.82rem">' + esc(res.converted) + '</pre></div>';
            addLog('✍️ 文体変換完了: ' + (TONE_NAMES[tone] || tone), 'success');
        } else {
            targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(res.error) + '</div>';
        }
    } catch (e) {
        targetEl.innerHTML = '<div class="ai-result-box ai-error">❌ ' + esc(e.message) + '</div>';
    }
}

// ============================================================
// Feature 11: AIスマート検索
// ============================================================
async function aiSmartSearch() {
    const queryInput = $('ai-search-query');
    const resultsEl = $('ai-search-results');
    if (!queryInput || !resultsEl) return;

    const query = queryInput.value.trim();
    if (!query) { resultsEl.innerHTML = '<p class="muted-hint">検索キーワードを入力してください</p>'; resultsEl.style.display = 'block'; return; }

    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<p class="ai-loading">⏳ AIが関連ノートを検索中...</p>';

    try {
        const res = await window.api.aiSmartSearch({ query });
        if (res.success) {
            if (!res.results || res.results.length === 0) {
                resultsEl.innerHTML = '<p class="muted-hint">関連するノートが見つかりませんでした</p>'
                    + (res.raw ? '<details style="margin-top:8px"><summary style="font-size:.75rem;opacity:.4;cursor:pointer">AI応答を表示</summary><pre style="font-size:.72rem;opacity:.5;white-space:pre-wrap;margin-top:4px">' + esc(res.raw.slice(0, 500)) + '</pre></details>' : '');
            } else {
                const RELEVANCE_COLORS = { '高': 'var(--green)', '中': 'var(--accent)', '低': 'var(--text-muted)' };
                let html = '<p class="muted-hint" style="margin-bottom:8px">🔍 ' + res.results.length + '件の関連ノートが見つかりました</p>';
                res.results.forEach(function(r) {
                    const color = RELEVANCE_COLORS[r.relevance] || 'var(--text-muted)';
                    html += '<div class="result-item" style="padding:8px 12px;margin-bottom:6px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)">'
                        + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
                        + '<span style="font-weight:600;font-size:.88rem">' + esc(r.name) + '</span>'
                        + '<span style="font-size:.72rem;padding:2px 8px;border-radius:10px;background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44">' + esc(r.relevance) + '</span>'
                        + '</div>'
                        + '<div style="font-size:.78rem;opacity:.7">' + esc(r.reason) + '</div>'
                        + (r.path ? '<a href="#" onclick="window.api.openPath(\'' + esc(r.path).replace(/'/g, "\\'") + '\');return false;" style="font-size:.72rem;color:var(--accent);margin-top:4px;display:inline-block">📂 開く</a>' : '')
                        + '</div>';
                });
                resultsEl.innerHTML = html;
            }
            addLog('🔍 AI検索完了: 「' + query + '」で ' + (res.results ? res.results.length : 0) + '件', 'success');
        } else {
            resultsEl.innerHTML = '<p class="ai-error">❌ ' + esc(res.error) + '</p>';
        }
    } catch (e) {
        resultsEl.innerHTML = '<p class="ai-error">❌ ' + esc(e.message) + '</p>';
    }
}

// ============================================================
// Feature 12: 感情分析トレンド
// ============================================================
async function aiSentimentAnalysis() {
    const chartEl = $('ai-sentiment-chart');
    const resultsEl = $('ai-sentiment-results');
    if (!chartEl || !resultsEl) return;

    chartEl.style.display = 'block';
    resultsEl.style.display = 'block';
    chartEl.innerHTML = '<p class="ai-loading">⏳ AIが感情分析中...</p>';
    resultsEl.innerHTML = '';

    try {
        const res = await window.api.aiSentimentAnalysis();
        if (res.success) {
            if (!res.results || res.results.length === 0) {
                chartEl.innerHTML = '<p class="muted-hint">' + (res.message || '分析対象のノートが見つかりません') + '</p>';
                return;
            }

            // 円グラフ（SVG）
            const trend = res.trend || { positive: 0, negative: 0, neutral: 0 };
            const total = trend.positive + trend.negative + trend.neutral;
            if (total > 0) {
                const COLORS = { positive: '#4ade80', negative: '#f87171', neutral: '#94a3b8' };
                const LABELS = { positive: 'ポジティブ', negative: 'ネガティブ', neutral: 'ニュートラル' };
                let pieHtml = '<div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">';
                pieHtml += '<svg viewBox="0 0 100 100" style="width:120px;height:120px">';

                let startAngle = 0;
                ['positive', 'neutral', 'negative'].forEach(function(key) {
                    const val = trend[key] || 0;
                    if (val === 0) return;
                    const slice = (val / total) * 360;
                    const endAngle = startAngle + slice;
                    const largeArc = slice > 180 ? 1 : 0;
                    const startRad = (startAngle - 90) * Math.PI / 180;
                    const endRad = (endAngle - 90) * Math.PI / 180;
                    const x1 = 50 + 40 * Math.cos(startRad);
                    const y1 = 50 + 40 * Math.sin(startRad);
                    const x2 = 50 + 40 * Math.cos(endRad);
                    const y2 = 50 + 40 * Math.sin(endRad);

                    if (val === total) {
                        pieHtml += '<circle cx="50" cy="50" r="40" fill="' + COLORS[key] + '"/>';
                    } else {
                        pieHtml += '<path d="M50,50 L' + x1 + ',' + y1 + ' A40,40 0 ' + largeArc + ',1 ' + x2 + ',' + y2 + ' Z" fill="' + COLORS[key] + '"/>';
                    }
                    startAngle = endAngle;
                });
                pieHtml += '</svg>';

                pieHtml += '<div style="display:flex;flex-direction:column;gap:6px">';
                ['positive', 'neutral', 'negative'].forEach(function(key) {
                    const val = trend[key] || 0;
                    const pct = total > 0 ? Math.round(val / total * 100) : 0;
                    pieHtml += '<div style="display:flex;align-items:center;gap:8px;font-size:.82rem">'
                        + '<span style="width:12px;height:12px;border-radius:3px;background:' + COLORS[key] + ';display:inline-block"></span>'
                        + '<span>' + LABELS[key] + ': ' + val + '件 (' + pct + '%)</span>'
                        + '</div>';
                });
                pieHtml += '</div></div>';
                chartEl.innerHTML = pieHtml;
            } else {
                chartEl.innerHTML = '';
            }

            // ノートリスト
            const SENTIMENT_BADGES = {
                positive: { label: 'ポジティブ', color: '#4ade80', bg: 'rgba(74,222,128,.12)' },
                negative: { label: 'ネガティブ', color: '#f87171', bg: 'rgba(248,113,113,.12)' },
                neutral: { label: 'ニュートラル', color: '#94a3b8', bg: 'rgba(148,163,184,.12)' },
            };
            let listHtml = '';
            res.results.forEach(function(r) {
                const badge = SENTIMENT_BADGES[r.sentiment] || SENTIMENT_BADGES.neutral;
                listHtml += '<div style="padding:6px 10px;margin-bottom:4px;border-radius:6px;background:rgba(255,255,255,.03);display:flex;align-items:center;gap:8px;justify-content:space-between">'
                    + '<span style="font-size:.82rem;flex:1">' + esc(r.name) + '</span>'
                    + '<span style="font-size:.72rem;opacity:.5">' + esc(r.date) + '</span>'
                    + '<span style="font-size:.72rem;padding:2px 8px;border-radius:10px;background:' + badge.bg + ';color:' + badge.color + ';border:1px solid ' + badge.color + '33">' + badge.label + '</span>'
                    + '<span style="font-size:.72rem;opacity:.6">スコア: ' + r.score + '</span>'
                    + '</div>';
            });
            resultsEl.innerHTML = listHtml;
            addLog('😊 感情分析完了: P=' + trend.positive + ' / N=' + trend.negative + ' / Neu=' + trend.neutral, 'success');
        } else {
            chartEl.innerHTML = '<p class="ai-error">❌ ' + esc(res.error) + '</p>';
        }
    } catch (e) {
        chartEl.innerHTML = '<p class="ai-error">❌ ' + esc(e.message) + '</p>';
    }
}

// ============================================================
// Feature 13: AIタイトル自動提案
// ============================================================
async function aiAutoTitles() {
    const loadingEl = $('org-auto-title-loading');
    const resultsEl = $('org-auto-title-results');
    const summaryEl = $('org-auto-title-summary');
    const listEl = $('org-auto-title-list');
    if (!resultsEl || !listEl) return;

    if (loadingEl) loadingEl.style.display = 'flex';
    if (resultsEl) resultsEl.style.display = 'none';

    try {
        const res = await window.api.aiAutoTitles();
        if (loadingEl) loadingEl.style.display = 'none';
        if (resultsEl) resultsEl.style.display = 'block';

        if (res.success) {
            if (!res.suggestions || res.suggestions.length === 0) {
                if (summaryEl) summaryEl.textContent = res.message || '無題のノートが見つかりません';
                listEl.innerHTML = '';
                return;
            }

            if (summaryEl) summaryEl.textContent = res.suggestions.length + '件の無題ノートにタイトルを提案';
            let html = '';
            res.suggestions.forEach(function(s, i) {
                html += '<div class="org-list-item" style="padding:8px 12px;margin-bottom:6px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)">'
                    + '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">'
                    + '<div style="flex:1">'
                    + '<div style="font-size:.78rem;opacity:.5">現在: ' + esc(s.currentName) + '</div>'
                    + '<div style="font-size:.88rem;font-weight:600;margin-top:2px">→ ' + esc(s.suggestedTitle) + '</div>'
                    + '</div>'
                    + '<button class="ghost-btn small-btn" data-auto-title-idx="' + i + '" onclick="window.applyAutoTitle(' + i + ')" style="white-space:nowrap">✨ 適用</button>'
                    + '</div></div>';
            });
            listEl.innerHTML = html;

            // 提案データを保存
            window._aiAutoTitleSuggestions = res.suggestions;
            addLog('🏷️ AIタイトル提案: ' + res.suggestions.length + '件', 'success');
        } else {
            if (summaryEl) summaryEl.textContent = 'エラー: ' + (res.error || '不明なエラー');
            listEl.innerHTML = '';
        }
    } catch (e) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (resultsEl) resultsEl.style.display = 'block';
        if (summaryEl) summaryEl.textContent = 'エラー: ' + e.message;
        listEl.innerHTML = '';
    }
}

// AIタイトル適用
window.applyAutoTitle = async function(idx) {
    const suggestions = window._aiAutoTitleSuggestions;
    if (!suggestions || !suggestions[idx]) return;
    const s = suggestions[idx];
    try {
        const res = await window.api.renameNote({ filePath: s.path, newTitle: s.suggestedTitle });
        if (res.success) {
            addLog('🏷️ リネーム成功: ' + s.currentName + ' → ' + s.suggestedTitle + '.md', 'success');
            showToast('リネーム完了: ' + s.suggestedTitle, 'success');
            // ボタンを無効化
            const btns = document.querySelectorAll('[data-auto-title-idx="' + idx + '"]');
            btns.forEach(function(b) { b.textContent = '✅ 適用済み'; b.disabled = true; });
        } else {
            addLog('❌ リネーム失敗: ' + (res.error || '不明なエラー'), 'error');
        }
    } catch (e) {
        addLog('❌ リネームエラー: ' + e.message, 'error');
    }
};

// ============================================================
// Feature 14: AIライティング提案
// ============================================================
async function aiWritingPrompt() {
    const resultsEl = $('ai-writing-prompts');
    if (!resultsEl) return;

    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<p class="ai-loading">⏳ AIがライティング提案を生成中...</p>';

    try {
        const res = await window.api.aiWritingPrompt();
        if (res.success) {
            if (!res.prompts || res.prompts.length === 0) {
                resultsEl.innerHTML = '<p class="muted-hint">提案を生成できませんでした</p>'
                    + (res.raw ? '<details style="margin-top:8px"><summary style="font-size:.75rem;opacity:.4;cursor:pointer">AI応答を表示</summary><pre style="font-size:.72rem;opacity:.5;white-space:pre-wrap;margin-top:4px">' + esc(res.raw.slice(0, 500)) + '</pre></details>' : '');
                return;
            }

            let html = '';
            res.prompts.forEach(function(p, i) {
                html += '<div style="padding:12px;margin-bottom:8px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)">'
                    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">'
                    + '<div style="flex:1">'
                    + '<div style="font-weight:600;font-size:.9rem;margin-bottom:4px">💡 ' + esc(p.title) + '</div>'
                    + '<div style="font-size:.8rem;opacity:.7;margin-bottom:4px">' + esc(p.description) + '</div>'
                    + (p.suggestedFolder ? '<div style="font-size:.72rem;opacity:.5">📁 ' + esc(p.suggestedFolder) + '</div>' : '')
                    + '</div>'
                    + '<button class="ghost-btn small-btn" onclick="window.createNoteFromPrompt(' + i + ')" style="white-space:nowrap">📝 ノートを作成</button>'
                    + '</div></div>';
            });
            resultsEl.innerHTML = html;
            window._aiWritingPrompts = res.prompts;
            addLog('💡 ライティング提案: ' + res.prompts.length + '件生成', 'success');
        } else {
            resultsEl.innerHTML = '<p class="ai-error">❌ ' + esc(res.error) + '</p>';
        }
    } catch (e) {
        resultsEl.innerHTML = '<p class="ai-error">❌ ' + esc(e.message) + '</p>';
    }
}

// ライティング提案からノートを作成
window.createNoteFromPrompt = async function(idx) {
    const prompts = window._aiWritingPrompts;
    if (!prompts || !prompts[idx]) return;
    const p = prompts[idx];
    try {
        const res = await window.api.aiCreateNoteFromPrompt({
            title: p.title,
            content: p.description || '',
            folder: p.suggestedFolder || '',
        });
        if (res.success) {
            addLog('📝 ノート作成: ' + p.title, 'success');
            showToast('ノート作成完了: ' + p.title, 'success');
            // Obsidianで開く
            try { await window.api.openInObsidian(res.filePath); } catch (_) { /* 無視 */ }
        } else {
            addLog('❌ ノート作成失敗: ' + (res.error || '不明なエラー'), 'error');
        }
    } catch (e) {
        addLog('❌ ノート作成エラー: ' + e.message, 'error');
    }
};

// ============================================================
// Feature 15: AIコスト表示
// ============================================================
// APIコスト追跡用ローカルストレージ
const AI_COST_STORAGE_KEY = 'obsidian-optimizer-ai-cost-history';
const AI_PRICING_PER_1M = {
    'claude-opus-4-6': { input: 15, output: 75 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5-20251001': { input: 0.80, output: 4 },
    'gpt-5.4': { input: 2.50, output: 10 },
    'gpt-5.4-mini': { input: 0.40, output: 1.60 },
    'gpt-5.4-nano': { input: 0.10, output: 0.40 },
    'gpt-4o': { input: 2.50, output: 10 },
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.5-pro': { input: 1.25, output: 10 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
};
const JPY_RATE = 150;

function getAiCostHistory() {
    try {
        const raw = localStorage.getItem(AI_COST_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

function saveAiCostEntry(feature, model, inputTokensEstimate, outputTokensEstimate) {
    const history = getAiCostHistory();
    const pricing = AI_PRICING_PER_1M[model] || { input: 1, output: 5 };
    const costUsd = (inputTokensEstimate / 1000000 * pricing.input) + (outputTokensEstimate / 1000000 * pricing.output);
    const costJpy = Math.round(costUsd * JPY_RATE * 100) / 100;

    history.push({
        date: new Date().toISOString(),
        feature: feature,
        model: model,
        inputTokens: inputTokensEstimate,
        outputTokens: outputTokensEstimate,
        costUsd: Math.round(costUsd * 10000) / 10000,
        costJpy: costJpy,
    });

    // 最大1000件保持
    if (history.length > 1000) history.splice(0, history.length - 1000);
    localStorage.setItem(AI_COST_STORAGE_KEY, JSON.stringify(history));
}

async function renderAiCostDisplay() {
    const container = $('ai-cost-display');
    if (!container) return;

    // サーバーからAI利用状況を取得
    let usage;
    try {
        const res = await window.api.getAiUsage();
        if (!res.success || !res.usage) { container.innerHTML = '<p class="muted-hint">AI利用データを取得できませんでした</p>'; return; }
        usage = res.usage;
    } catch (e) { container.innerHTML = '<p class="muted-hint">エラー: ' + esc(e.message) + '</p>'; return; }

    const history = usage.history || [];
    const now = new Date();
    const thisMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    const monthEntries = history.filter(function(h) { return h.date && h.date.startsWith(thisMonth); });
    const totalCalls = monthEntries.length;
    const totalCostJpy = monthEntries.reduce(function(sum, h) { return sum + ((h.cost || 0) * 150); }, 0);

    // 機能別集計
    const featureCosts = {};
    monthEntries.forEach(function(h) {
        const key = h.feature || '不明';
        featureCosts[key] = (featureCosts[key] || 0) + ((h.cost || 0) * 150);
    });

    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">';
    html += '<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center">'
        + '<div style="font-size:1.2rem;font-weight:700">' + totalCalls + '</div>'
        + '<div style="font-size:.72rem;opacity:.5">今月のAPI呼び出し</div></div>';
    html += '<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center">'
        + '<div style="font-size:1.2rem;font-weight:700">¥' + Math.round(totalCostJpy) + '</div>'
        + '<div style="font-size:.72rem;opacity:.5">今月の推定コスト</div></div>';
    html += '</div>';

    // 機能別内訳
    if (Object.keys(featureCosts).length > 0) {
        html += '<div style="margin-bottom:12px"><strong style="font-size:.82rem">機能別コスト内訳</strong>';
        const sorted = Object.entries(featureCosts).sort(function(a, b) { return b[1] - a[1]; });
        const maxCost = sorted[0] ? sorted[0][1] : 1;
        sorted.forEach(function(entry) {
            const pct = maxCost > 0 ? Math.round(entry[1] / maxCost * 100) : 0;
            html += '<div style="display:flex;align-items:center;gap:8px;margin-top:6px">'
                + '<span style="font-size:.78rem;min-width:100px">' + esc(entry[0]) + '</span>'
                + '<div style="flex:1;height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden">'
                + '<div style="height:100%;width:' + pct + '%;background:var(--accent);border-radius:4px"></div></div>'
                + '<span style="font-size:.72rem;opacity:.6">¥' + Math.round(entry[1]) + '</span>'
                + '</div>';
        });
        html += '</div>';
    }

    // 最近10件の履歴
    const last10 = history.slice(-10).reverse();
    if (last10.length > 0) {
        html += '<div style="margin-bottom:12px"><strong style="font-size:.82rem">直近のAPI呼び出し</strong>'
            + '<div style="margin-top:6px;max-height:200px;overflow:auto">';
        last10.forEach(function(h) {
            const d = new Date(h.date);
            const dateStr = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
            html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.75rem;border-bottom:1px solid rgba(255,255,255,.04)">'
                + '<span style="opacity:.5;min-width:70px">' + dateStr + '</span>'
                + '<span style="flex:1">' + esc(h.feature) + '</span>'
                + '<span style="opacity:.5">' + esc(h.model || '') + '</span>'
                + '<span style="min-width:50px;text-align:right">¥' + ((h.cost || 0) * 150).toFixed(2) + '</span>'
                + '</div>';
        });
        html += '</div></div>';
    }

    // 料金参照テーブル
    html += '<details style="margin-top:8px"><summary style="font-size:.78rem;cursor:pointer;opacity:.6">💰 プロバイダー料金一覧（1Mトークンあたり）</summary>'
        + '<div style="margin-top:8px;overflow-x:auto"><table style="width:100%;font-size:.72rem;border-collapse:collapse">'
        + '<tr style="border-bottom:1px solid rgba(255,255,255,.1)"><th style="text-align:left;padding:4px">モデル</th><th style="text-align:right;padding:4px">入力($)</th><th style="text-align:right;padding:4px">出力($)</th><th style="text-align:right;padding:4px">入力(¥)</th><th style="text-align:right;padding:4px">出力(¥)</th></tr>';
    Object.entries(AI_PRICING_PER_1M).forEach(function(entry) {
        html += '<tr style="border-bottom:1px solid rgba(255,255,255,.04)">'
            + '<td style="padding:3px 4px">' + esc(entry[0]) + '</td>'
            + '<td style="text-align:right;padding:3px 4px">$' + entry[1].input + '</td>'
            + '<td style="text-align:right;padding:3px 4px">$' + entry[1].output + '</td>'
            + '<td style="text-align:right;padding:3px 4px">¥' + Math.round(entry[1].input * JPY_RATE) + '</td>'
            + '<td style="text-align:right;padding:3px 4px">¥' + Math.round(entry[1].output * JPY_RATE) + '</td>'
            + '</tr>';
    });
    html += '</table></div></details>';

    container.innerHTML = html;
}

// ============================================================
// Feature 8-14 ボタンバインド
// ============================================================
(function bindAiFeatureBatch2() {
    const safe = function(id, fn) { const el = $(id); if (el) el.addEventListener('click', fn); };

    // Feature 11: AI検索
    safe('btn-ai-smart-search', aiSmartSearch);
    const searchInput = $('ai-search-query');
    if (searchInput) {
        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing) aiSmartSearch();
        });
    }

    // Feature 12: 感情分析
    safe('btn-ai-sentiment', aiSentimentAnalysis);

    // Feature 13: AIタイトル提案
    safe('btn-ai-auto-titles', aiAutoTitles);

    // Feature 14: ライティング提案
    safe('btn-ai-writing-prompt', aiWritingPrompt);

    // Feature 15: コスト表示
    safe('btn-ai-cost-refresh', renderAiCostDisplay);
    renderAiCostDisplay();
})();

// ============================================================
// toggleNotePreview拡張: モーダルプレビュー（AI機能付き）
// ============================================================
const _origToggleNotePreviewWithAI = toggleNotePreviewWithAI;
async function toggleNotePreviewWithAIv2(itemEl, filePath) {
    // コンテンツ取得
    let content = previewCache[filePath];
    if (!content) {
        try {
            const res = await window.api.readNotePreview(filePath);
            if (res.success) { content = res.preview; previewCache[filePath] = content; }
            else { content = '(読み込み失敗: ' + res.error + ')'; }
        } catch (e) { content = '(エラー: ' + e.message + ')'; }
    }

    // ノート名を取得（パスの最後の部分）
    const noteName = filePath.split('/').pop().replace(/\.md$/i, '');

    // AI結果表示用div
    const aiResultDiv = document.createElement('div');
    aiResultDiv.className = 'preview-modal-ai-result';
    aiResultDiv.style.display = 'none';

    // AIボタン行を構築
    function buildAiRowsHtml() {
        const container = document.createElement('div');
        container.className = 'preview-modal-ai-rows';

        // 第1行: AI要約・タグ提案・リンク提案
        const aiRow1 = document.createElement('div');
        aiRow1.className = 'ai-action-row';
        var summaryBtn = document.createElement('button');
        summaryBtn.className = 'ghost-btn small-btn ai-btn';
        summaryBtn.textContent = '✨ AI要約';
        summaryBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiSummarizeNote(filePath, aiResultDiv); });
        var tagBtn = document.createElement('button');
        tagBtn.className = 'ghost-btn small-btn ai-btn';
        tagBtn.textContent = '🏷️ AIタグ提案';
        tagBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiSuggestTags(filePath, aiResultDiv); });
        var linkBtn = document.createElement('button');
        linkBtn.className = 'ghost-btn small-btn ai-btn';
        linkBtn.textContent = '🔗 AIリンク提案';
        linkBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiSuggestLinks(filePath, aiResultDiv); });
        aiRow1.appendChild(summaryBtn);
        aiRow1.appendChild(tagBtn);
        aiRow1.appendChild(linkBtn);
        container.appendChild(aiRow1);

        // 第2行: 翻訳・議事録整理・文体変換
        const aiRow2 = document.createElement('div');
        aiRow2.className = 'ai-action-row';
        var translateWrap = document.createElement('span');
        translateWrap.style.cssText = 'display:inline-flex;gap:2px;align-items:center';
        var translateSelect = document.createElement('select');
        translateSelect.className = 'vault-select';
        translateSelect.style.cssText = 'width:70px;font-size:.72rem;padding:3px 4px;height:auto';
        [{ v: 'en', l: '英語' }, { v: 'ja', l: '日本語' }, { v: 'zh', l: '中国語' }].forEach(function(opt) {
            var o = document.createElement('option'); o.value = opt.v; o.textContent = opt.l; translateSelect.appendChild(o);
        });
        var translateBtn = document.createElement('button');
        translateBtn.className = 'ghost-btn small-btn ai-btn';
        translateBtn.textContent = '🌐 翻訳';
        translateBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiTranslateNote(filePath, translateSelect.value, aiResultDiv); });
        translateWrap.appendChild(translateSelect);
        translateWrap.appendChild(translateBtn);
        aiRow2.appendChild(translateWrap);
        var meetingBtn = document.createElement('button');
        meetingBtn.className = 'ghost-btn small-btn ai-btn';
        meetingBtn.textContent = '📋 議事録整理';
        meetingBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiStructureMeeting(filePath, aiResultDiv); });
        aiRow2.appendChild(meetingBtn);
        var toneWrap = document.createElement('span');
        toneWrap.style.cssText = 'display:inline-flex;gap:2px;align-items:center';
        var toneSelect = document.createElement('select');
        toneSelect.className = 'vault-select';
        toneSelect.style.cssText = 'width:90px;font-size:.72rem;padding:3px 4px;height:auto';
        [{ v: 'formal', l: 'フォーマル' }, { v: 'casual', l: 'カジュアル' }, { v: 'academic', l: '学術的' }, { v: 'blog', l: 'ブログ風' }].forEach(function(opt) {
            var o = document.createElement('option'); o.value = opt.v; o.textContent = opt.l; toneSelect.appendChild(o);
        });
        var toneBtn = document.createElement('button');
        toneBtn.className = 'ghost-btn small-btn ai-btn';
        toneBtn.textContent = '✍️ 文体変換';
        toneBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiConvertTone(filePath, toneSelect.value, aiResultDiv); });
        toneWrap.appendChild(toneSelect);
        toneWrap.appendChild(toneBtn);
        aiRow2.appendChild(toneWrap);
        container.appendChild(aiRow2);

        // 第3行: レビュー・フラッシュカード・文章化
        var aiRow3 = document.createElement('div');
        aiRow3.className = 'ai-action-row';
        var reviewBtn = document.createElement('button');
        reviewBtn.className = 'ghost-btn small-btn ai-btn';
        reviewBtn.textContent = '📝 AIレビュー';
        reviewBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiReviewNote(filePath, aiResultDiv); });
        aiRow3.appendChild(reviewBtn);
        var flashcardBtn = document.createElement('button');
        flashcardBtn.className = 'ghost-btn small-btn ai-btn';
        flashcardBtn.textContent = '🎴 フラッシュカード';
        flashcardBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiGenerateFlashcards(filePath, aiResultDiv); });
        aiRow3.appendChild(flashcardBtn);
        var expandBtn = document.createElement('button');
        expandBtn.className = 'ghost-btn small-btn ai-btn';
        expandBtn.textContent = '📝 文章化';
        expandBtn.addEventListener('click', function() { aiResultDiv.style.display = ''; aiExpandNote(filePath, aiResultDiv); });
        aiRow3.appendChild(expandBtn);
        container.appendChild(aiRow3);

        container.appendChild(aiResultDiv);
        return container;
    }

    // モーダルのbody用HTML構築
    var bodyHtml = '<pre>' + esc(content) + '</pre>';

    var modal = showPreviewModal({
        title: noteName,
        subtitle: filePath,
        content: bodyHtml,
        actions: [
            { label: '⭐ お気に入り', className: 'ghost-btn small-btn', onClick: function() {
                window.api.toggleFavorite({ notePath: filePath }).then(function(res) {
                    if (res.success) {
                        var nowFav = res.favorites.includes(filePath);
                        showToast(nowFav ? 'お気に入りに追加しました' : 'お気に入りから削除しました', 'info');
                        if (typeof loadFavorites === 'function') loadFavorites();
                    }
                }).catch(function(err) { showToast('エラー: ' + err.message, 'error'); });
            }},
            { label: '📂 Obsidianで開く', className: 'ghost-btn small-btn', onClick: function() {
                window.api.openInObsidian(filePath).catch(console.error);
            }},
        ]
    });

    // AIボタン行をモーダルbodyに追加
    if (modal && modal.bodyEl) {
        modal.bodyEl.appendChild(buildAiRowsHtml());
    }
}

// v2版で上書き
window.toggleNotePreviewWithAI = toggleNotePreviewWithAIv2;

// グローバルヘルパー: パスを渡してノートプレビューモーダルを開く（onclick属性から呼び出し用）
async function openNotePreviewModal(filePath) {
    // toggleNotePreviewWithAIv2は内部でモーダルを開くので、ダミーelementで呼び出す
    // ただし引数のitemElは不要になったため、直接モーダルを開く
    let content = previewCache[filePath];
    if (!content) {
        try {
            const res = await window.api.readNotePreview(filePath);
            if (res.success) { content = res.preview; previewCache[filePath] = content; }
            else { content = '(読み込み失敗: ' + res.error + ')'; }
        } catch (e) { content = '(エラー: ' + e.message + ')'; }
    }
    var noteName = filePath.split('/').pop().replace(/\.md$/i, '');
    showPreviewModal({
        title: noteName,
        subtitle: filePath,
        rawText: content,
        actions: [
            { label: '📂 Obsidianで開く', className: 'ghost-btn small-btn', onClick: function() {
                window.api.openInObsidian(filePath).catch(console.error);
            }}
        ]
    });
}
window.openNotePreviewModal = openNotePreviewModal;

// 整理ツールのグローバル公開（inline onclick用）
window.orgRenameNote = orgRenameNote;
window.orgMoveNote = orgMoveNote;
window.orgFixSingleFrontmatter = async function(path) {
    try {
        const res = await window.api.fixFrontmatter({ filePath: path, addFields: {} });
        if (res.success) { addLog(`📝 Frontmatter補完: ${path}`, 'success', 'ORGANIZE'); orgScanFrontmatter(); }
        else addLog(`❌ エラー: ${res.error}`, 'error', 'ORGANIZE');
    } catch (e) { addLog(`❌ エラー: ${e.message}`, 'error', 'ORGANIZE'); }
};

// ============================================================
// Feature 4: ノートスコアリングシステム
// ============================================================
async function loadNoteScores() {
    const container = $('note-scores-content');
    if (!container) return;
    container.innerHTML = '<p class="muted-hint">計算中...</p>';

    try {
        const res = await window.api.getNoteScores();
        if (!res.success) {
            container.innerHTML = '<p class="muted-hint" style="color:var(--danger)">エラー: ' + esc(res.error) + '</p>';
            return;
        }
        const scores = res.scores || [];
        if (scores.length === 0) {
            container.innerHTML = '<p class="muted-hint">ノートが見つかりません</p>';
            return;
        }

        const avgScore = Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length);
        const top20 = scores.slice(0, 20);
        const bottom20 = scores.slice(-20).reverse();

        const BUCKET_COUNT = 10;
        const buckets = Array(BUCKET_COUNT).fill(0);
        scores.forEach(s => {
            const idx = Math.min(Math.floor(s.score / BUCKET_COUNT), BUCKET_COUNT - 1);
            buckets[idx]++;
        });
        const maxBucket = Math.max(...buckets, 1);

        let html = '<div class="note-score-section">';
        html += '<div class="note-score-header"><span>平均スコア: <span class="note-score-avg">' + avgScore + '</span> / 100</span><span class="muted-hint">' + scores.length + 'ノート</span></div>';

        html += '<div class="score-histogram">';
        buckets.forEach((count, i) => {
            const pct = Math.round((count / maxBucket) * 100);
            const label = '' + (i * BUCKET_COUNT) + '-' + ((i + 1) * BUCKET_COUNT) + ': ' + count + '件';
            html += '<div class="score-histogram-bar" style="height:' + Math.max(pct, 2) + '%" title="' + label + '"></div>';
        });
        html += '</div>';
        html += '<div class="score-histogram-labels"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>';

        html += '<h4 style="margin:16px 0 8px;font-size:.82rem;color:var(--green)">🏆 TOP 20 (高スコアノート)</h4>';
        html += '<div class="note-score-list">';
        top20.forEach((s, i) => {
            const color = s.score >= 70 ? 'var(--green)' : s.score >= 40 ? 'var(--warn)' : 'var(--danger)';
            html += '<div class="note-score-item"><span class="score-rank">#' + (i + 1) + '</span><span class="score-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span><span class="score-value" style="color:' + color + '">' + s.score + '</span><div class="score-bar"><div class="score-bar-fill" style="width:' + s.score + '%;background:' + color + '"></div></div></div>';
        });
        html += '</div>';

        html += '<h4 style="margin:16px 0 8px;font-size:.82rem;color:var(--warn)">📉 改善候補 (低スコアノート)</h4>';
        html += '<div class="note-score-list">';
        bottom20.forEach((s, i) => {
            const color = s.score >= 70 ? 'var(--green)' : s.score >= 40 ? 'var(--warn)' : 'var(--danger)';
            html += '<div class="note-score-item"><span class="score-rank" style="color:var(--warn)">#' + (scores.length - i) + '</span><span class="score-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span><span class="score-value" style="color:' + color + '">' + s.score + '</span><div class="score-bar"><div class="score-bar-fill" style="width:' + s.score + '%;background:' + color + '"></div></div></div>';
        });
        html += '</div></div>';

        container.innerHTML = html;
        addLog('📊 ノートスコア計算完了: ' + scores.length + 'ノート / 平均' + avgScore + '点', 'success');
    } catch (e) {
        container.innerHTML = '<p class="muted-hint" style="color:var(--danger)">エラー: ' + esc(e.message) + '</p>';
    }
}

// ============================================================
// Feature 5: Vault比較 — 推移グラフ
// ============================================================
async function saveVaultSnapshotAndRenderTrends(currentData) {
    try {
        const penalty = Math.min(currentData.orphanNotes * 0.35, 35)
            + Math.min(currentData.junkFiles * 2, 25)
            + Math.min((currentData.brokenLinksCount || 0) * 0.5, 15)
            + Math.min((currentData.duplicateList || []).length, 10)
            + Math.min((currentData.staleList || []).length * 0.1, 10);
        const healthScore = Math.max(0, Math.round(100 - penalty));

        const snapshot = {
            timestamp: new Date().toISOString(),
            totalMDFiles: currentData.totalMDFiles,
            orphanNotes: currentData.orphanNotes,
            junkFiles: currentData.junkFiles,
            brokenLinksCount: currentData.brokenLinksCount || 0,
            staleCount: (currentData.staleList || []).length,
            mocsCount: currentData.mocsCount,
            healthScore: healthScore,
        };
        await window.api.saveVaultSnapshot(snapshot);

        const res = await window.api.getVaultHistory();
        const history = (res && res.history) ? res.history : [];
        renderTrendsChart(history);
    } catch (e) {
        console.warn('Vault snapshot/trends error:', e);
    }
}

function renderTrendsChart(history) {
    const chartEl = $('trends-chart');
    const compEl = $('trends-comparison');
    const emptyEl = $('trends-empty');
    if (!chartEl) return;

    if (!history || history.length < 2) {
        chartEl.innerHTML = '';
        if (compEl) compEl.innerHTML = '';
        if (emptyEl) emptyEl.textContent = 'スキャン履歴が2回以上必要です';
        return;
    }
    if (emptyEl) emptyEl.textContent = '';

    const MAX_POINTS = 20;
    const data = history.slice(-MAX_POINTS);
    const scores = data.map(function(d) { return d.healthScore || 0; });
    const maxScore = 100;
    const W = 600, H = 150, PADDING = 30;
    const chartW = W - PADDING * 2;
    const chartH = H - PADDING * 2;

    const points = scores.map(function(s, i) {
        const x = PADDING + (i / Math.max(scores.length - 1, 1)) * chartW;
        const y = PADDING + (1 - s / maxScore) * chartH;
        return { x: x, y: y, score: s, date: data[i].timestamp ? data[i].timestamp.split('T')[0] : '' };
    });

    const pathD = points.map(function(p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    const areaD = pathD + ' L' + points[points.length - 1].x.toFixed(1) + ',' + (H - PADDING).toFixed(1) + ' L' + PADDING + ',' + (H - PADDING).toFixed(1) + ' Z';

    let svg = '<svg class="trend-line-chart" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
    for (let i = 0; i <= 4; i++) {
        const y = PADDING + (i / 4) * chartH;
        const label = 100 - (i * 25);
        svg += '<line x1="' + PADDING + '" y1="' + y + '" x2="' + (W - PADDING) + '" y2="' + y + '" stroke="rgba(255,255,255,.06)" stroke-width="1"/>';
        svg += '<text x="' + (PADDING - 4) + '" y="' + (y + 4) + '" fill="rgba(255,255,255,.3)" font-size="9" text-anchor="end">' + label + '</text>';
    }
    svg += '<path d="' + areaD + '" fill="url(#trendGrad)" opacity=".3"/>';
    svg += '<defs><linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#7c6cf8"/><stop offset="100%" stop-color="transparent"/></linearGradient></defs>';
    svg += '<path d="' + pathD + '" fill="none" stroke="#7c6cf8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>';
    points.forEach(function(p) {
        const color = p.score >= 80 ? '#34d399' : p.score >= 50 ? '#f59e0b' : '#f87171';
        svg += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="4" fill="' + color + '" stroke="#0b0f1e" stroke-width="2"><title>' + p.date + ': ' + p.score + '点</title></circle>';
    });
    if (points.length > 1) {
        svg += '<text x="' + points[0].x + '" y="' + (H - 4) + '" fill="rgba(255,255,255,.3)" font-size="8" text-anchor="start">' + points[0].date + '</text>';
        svg += '<text x="' + points[points.length - 1].x + '" y="' + (H - 4) + '" fill="rgba(255,255,255,.3)" font-size="8" text-anchor="end">' + points[points.length - 1].date + '</text>';
    }
    svg += '</svg>';
    chartEl.innerHTML = svg;

    if (compEl && data.length >= 2) {
        compEl.innerHTML = '';
        const prev = data[data.length - 2];
        const curr = data[data.length - 1];
        const comparisons = [
            { label: '孤立ノート', prev: prev.orphanNotes || 0, curr: curr.orphanNotes || 0, invertBetter: true },
            { label: 'ゴミファイル', prev: prev.junkFiles || 0, curr: curr.junkFiles || 0, invertBetter: true },
            { label: '壊れたリンク', prev: prev.brokenLinksCount || 0, curr: curr.brokenLinksCount || 0, invertBetter: true },
            { label: '健全度', prev: prev.healthScore || 0, curr: curr.healthScore || 0, invertBetter: false },
        ];
        comparisons.forEach(function(c) {
            const diff = c.curr - c.prev;
            if (diff === 0) return;
            const isBetter = c.invertBetter ? diff < 0 : diff > 0;
            const cls = isBetter ? 'improved' : 'worsened';
            const sign = diff > 0 ? '+' : '';
            const emoji = isBetter ? '✅' : '⚠️';
            const item = document.createElement('div');
            item.className = 'trend-comparison-item ' + cls;
            item.textContent = emoji + ' 前回比: ' + c.label + ' ' + sign + diff + (isBetter ? ' (改善!)' : '');
            compEl.appendChild(item);
        });
    }
}

// ============================================================
// Feature 8: ゲーミフィケーション
// ============================================================
async function updateAchievementsAfterScan(data) {
    try {
        const penalty = Math.min(data.orphanNotes * 0.35, 35)
            + Math.min(data.junkFiles * 2, 25)
            + Math.min((data.brokenLinksCount || 0) * 0.5, 15)
            + Math.min((data.duplicateList || []).length, 10)
            + Math.min((data.staleList || []).length * 0.1, 10);
        const healthScore = Math.max(0, Math.round(100 - penalty));
        await window.api.updateAchievementProgress({
            scansCompleted: 1,
            bestScore: healthScore,
        });
    } catch (e) {
        console.warn('Achievement update error:', e);
    }
}

async function renderAchievements() {
    const container = $('achievements-grid');
    if (!container) return;

    try {
        const res = await window.api.getAchievements();
        if (!res.success || !res.achievements) return;

        container.innerHTML = '';
        res.achievements.forEach(function(a) {
            const div = document.createElement('div');
            div.className = 'achievement-badge ' + (a.earned ? 'earned' : 'unearned');
            div.innerHTML = '<span class="badge-emoji">' + a.emoji + '</span><span class="badge-name">' + esc(a.name) + '</span><span class="badge-desc">' + esc(a.description) + '</span>';
            div.title = a.earned ? ('達成済み: ' + a.description) : ('未達成: ' + a.description);
            container.appendChild(div);
        });
    } catch (e) {
        console.warn('Achievements render error:', e);
    }
}

// ============================================================
// Feature 12: ダッシュボードウィジェット設定
// ============================================================
let currentWidgetSettings = null;

function applyWidgetVisibility(widgets) {
    currentWidgetSettings = widgets || {};
    document.querySelectorAll('.widget-card[data-widget]').forEach(function(card) {
        const key = card.getAttribute('data-widget');
        if (key && widgets[key] === false) {
            card.style.display = 'none';
        }
    });
    document.querySelectorAll('[data-widget-key]').forEach(function(cb) {
        const key = cb.getAttribute('data-widget-key');
        if (key) cb.checked = widgets[key] !== false;
    });
}

function openWidgetSettings() {
    const modal = $('widget-settings-modal');
    if (modal) modal.style.display = 'flex';
}

function closeWidgetSettings() {
    const modal = $('widget-settings-modal');
    if (modal) modal.style.display = 'none';

    const widgets = {};
    document.querySelectorAll('[data-widget-key]').forEach(function(cb) {
        const key = cb.getAttribute('data-widget-key');
        if (key) widgets[key] = cb.checked;
    });

    document.querySelectorAll('.widget-card[data-widget]').forEach(function(card) {
        const key = card.getAttribute('data-widget');
        if (key) {
            if (widgets[key] === false) {
                card.style.display = 'none';
            } else {
                if (key !== 'timeMachine') {
                    card.style.display = '';
                }
            }
        }
    });

    window.api.saveConfigPartial({ dashboardWidgets: widgets }).catch(function(e) {
        console.warn('Widget settings save error:', e);
    });
    currentWidgetSettings = widgets;
}

// ============================================================
// 整理ツール (Organize Tools)
// ============================================================

/** 整理ツール共通: ローディング表示切替 */
function orgShowLoading(prefix) {
    const loading = $(`org-${prefix}-loading`);
    const results = $(`org-${prefix}-results`);
    if (loading) loading.style.display = 'flex';
    if (results) results.style.display = 'none';
}

function orgHideLoading(prefix) {
    const loading = $(`org-${prefix}-loading`);
    if (loading) loading.style.display = 'none';
}

function orgShowResults(prefix) {
    const results = $(`org-${prefix}-results`);
    if (results) results.style.display = '';
}

// ── Feature 1: タイトル変更 ──

/** タイトル不一致ノートのスキャンデータ（renameに利用） */
// 全ツール一括スキャン
async function orgScanAll() {
    const btn = $('btn-org-scan-all');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 一括スキャン中...'; }
    const summaryEl = $('org-all-summary');
    const contentEl = $('org-all-summary-content');
    if (summaryEl) summaryEl.style.display = 'block';
    if (contentEl) contentEl.innerHTML = '<div class="org-loading"><div class="spinner-sm"></div><span>全ツールをスキャン中...</span></div>';

    const results = [];
    const tools = [
        { name: 'メタデータ補完', icon: '📝', fn: orgScanFrontmatter, id: 'fm' },
        { name: 'Inbox整理', icon: '📂', fn: orgScanInbox, id: 'inbox' },
        { name: 'タイトル修正', icon: '✏️', fn: orgScanTitles, id: 'title' },
        { name: 'リンク修正', icon: '🔗', fn: orgScanLinks, id: 'links' },
        { name: '空フォルダ', icon: '🗑️', fn: orgScanEmpty, id: 'empty' },
        { name: 'TODO抽出', icon: '☑️', fn: orgScanTodos, id: 'todo' },
        { name: '長文分割', icon: '✂️', fn: orgScanSplit, id: 'split' },
    ];

    for (const tool of tools) {
        try { await tool.fn(); } catch (_) { /* individual errors handled inside */ }
        // 各ツールの結果サマリーを収集
        const summaryP = $(`org-${tool.id}-summary`);
        const text = summaryP ? summaryP.textContent : '';
        results.push({ ...tool, summary: text });
    }

    // サマリーカード表示
    if (contentEl) {
        let html = '<div class="org-summary-items">';
        for (const r of results) {
            const hasIssue = r.summary && !r.summary.includes('✅') && !r.summary.includes('ありません') && !r.summary.includes('0件');
            const status = hasIssue ? '⚠️' : '✅';
            html += `<div class="org-summary-item ${hasIssue ? 'has-issue' : 'ok'}">
                <span class="org-summary-icon">${r.icon}</span>
                <span class="org-summary-name">${r.name}</span>
                <span class="org-summary-status">${status}</span>
                <span class="org-summary-text">${esc(r.summary || '完了')}</span>
            </div>`;
        }
        html += '</div>';
        contentEl.innerHTML = html;
    }

    if (btn) { btn.disabled = false; btn.textContent = '🔍 全ツールを一括スキャン'; }
    addLog('🧹 整理ツール一括スキャン完了', 'success');
}

let orgTitleData = [];

async function orgScanTitles() {
    orgShowLoading('title');
    orgTitleData = [];
    try {
        // scan-title-mismatches IPC を使ってタイトル不一致を一括検出
        const res = await window.api.scanTitleMismatches();
        if (!res.success) throw new Error(res.error);

        orgTitleData = res.mismatches;
        orgHideLoading('title');
        orgShowResults('title');
        orgRenderTitles(res.mismatches);
    } catch (e) {
        orgHideLoading('title');
        orgShowResults('title');
        const summary = $('org-title-summary');
        if (summary) summary.textContent = `エラー: ${e.message}`;
        const list = $('org-title-list');
        if (list) list.innerHTML = '';
    }
}

function orgRenderTitles(items) {
    const summary = $('org-title-summary');
    const list = $('org-title-list');
    if (!list) return;

    if (items.length === 0) {
        if (summary) summary.textContent = 'タイトル不一致のノートは見つかりませんでした。';
        list.innerHTML = '<div class="org-empty-state">全てのノートのタイトルが一致しています</div>';
        return;
    }

    if (summary) summary.textContent = `${items.length}件のタイトル不一致ノートが見つかりました`;

    list.innerHTML = items.map((item, idx) => `
        <div class="org-item" id="org-title-item-${idx}">
            <div class="org-item-row">
                <span class="org-item-title" onclick="window.api.openInObsidian('${esc(item.path)}')">${esc(item.currentTitle)}</span>
                <div class="org-item-actions">
                    <button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(item.path)}')" title="プレビュー">👁️</button>
                    <button class="org-btn" onclick="orgRenameNote(${idx}, 'heuristic')">変更</button>
                    ${item.aiTitle ? `<button class="org-btn" onclick="orgRenameNote(${idx}, 'ai')">AI提案で変更</button>` : ''}
                </div>
            </div>
            <div class="org-item-detail">
                提案: <strong>${esc(item.heuristicTitle)}</strong>
                ${item.aiTitle ? ` | AI: <strong>${esc(item.aiTitle)}</strong>` : ''}
            </div>
        </div>
    `).join('');
}

async function orgRenameNote(idx, type) {
    const item = orgTitleData[idx];
    if (!item) return;

    const newTitle = type === 'ai' && item.aiTitle ? item.aiTitle : item.heuristicTitle;
    try {
        const res = await window.api.renameNote({ filePath: item.path, newTitle });
        if (res.success) {
            addLog(`✏️ リネーム: ${item.currentTitle} → ${newTitle} (リンク更新: ${res.linksUpdated}件)`, 'info', 'ORGANIZE');
            const el = $(`org-title-item-${idx}`);
            if (el) el.style.opacity = '0.4';
        } else {
            addLog(`❌ リネームエラー: ${res.error}`, 'error', 'ORGANIZE');
        }
    } catch (e) {
        addLog(`❌ リネームエラー: ${e.message}`, 'error', 'ORGANIZE');
    }
}

// ── Feature 2: Frontmatter標準化 ──

let orgFmData = { notesWithoutFrontmatter: [], notesMissingFields: [] };

async function orgScanFrontmatter() {
    orgShowLoading('fm');
    try {
        const res = await window.api.scanFrontmatter();
        if (!res.success) throw new Error(res.error);

        orgFmData = res;
        orgHideLoading('fm');
        orgShowResults('fm');
        orgRenderFrontmatter(res);
    } catch (e) {
        orgHideLoading('fm');
        orgShowResults('fm');
        const summary = $('org-fm-summary');
        if (summary) summary.textContent = `エラー: ${e.message}`;
    }
}

function orgRenderFrontmatter(data) {
    const summary = $('org-fm-summary');
    const list = $('org-fm-list');
    const fixBtn = $('btn-org-fix-frontmatter-all');
    if (!list) return;

    const totalIssues = data.notesWithoutFrontmatter.length + data.notesMissingFields.length;
    if (totalIssues === 0) {
        if (summary) summary.textContent = '全てのノートにFrontmatterが正しく設定されています。';
        list.innerHTML = '<div class="org-empty-state">問題なし</div>';
        if (fixBtn) fixBtn.style.display = 'none';
        return;
    }

    if (summary) summary.textContent = `Frontmatter未設定: ${data.notesWithoutFrontmatter.length}件 / フィールド不足: ${data.notesMissingFields.length}件`;
    if (fixBtn) fixBtn.style.display = totalIssues > 0 ? '' : 'none';

    let html = '';
    if (data.notesWithoutFrontmatter.length > 0) {
        html += '<div class="org-todo-date">Frontmatter未設定</div>';
        html += data.notesWithoutFrontmatter.slice(0, 50).map(item => `
            <div class="org-item">
                <div class="org-item-row">
                    <span class="org-item-title" onclick="window.api.openInObsidian('${esc(item.path)}')">${esc(item.name)}</span>
                    <div class="org-item-actions">
                        <button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(item.path)}')" title="プレビュー">👁️</button>
                        <button class="org-btn" onclick="window.orgFixSingleFrontmatter('${esc(item.path)}')">補完</button>
                    </div>
                </div>
                <div class="org-item-detail">${esc(item.relPath)}</div>
            </div>
        `).join('');
    }
    if (data.notesMissingFields.length > 0) {
        html += '<div class="org-todo-date">フィールド不足</div>';
        html += data.notesMissingFields.slice(0, 50).map(item => `
            <div class="org-item">
                <div class="org-item-row">
                    <span class="org-item-title" onclick="window.api.openInObsidian('${esc(item.path)}')">${esc(item.name)}</span>
                    <div class="org-item-actions">
                        <button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(item.path)}')" title="プレビュー">👁️</button>
                        <span class="org-item-badge warn">不足: ${esc(item.missing.join(', '))}</span>
                        <button class="org-btn" onclick="window.orgFixSingleFrontmatter('${esc(item.path)}')">補完</button>
                    </div>
                </div>
                <div class="org-item-detail">${esc(item.relPath)}</div>
            </div>
        `).join('');
    }
    list.innerHTML = html;
}

async function orgFixFrontmatterAll() {
    const total = orgFmData.notesWithoutFrontmatter.length + orgFmData.notesMissingFields.length;
    if (total === 0) return;

    if (!await showConfirmModal('Frontmatter補完の確認', `${total}件のノートのFrontmatterを補完します。\n\n⚡ バックアップについて\n設定で『削除前にバックアップを作成』がオンの場合、自動的にバックアップが保存されます。`, '補完する')) return;

    let fixed = 0;
    let errors = 0;

    // Frontmatter未設定のノート
    for (const item of orgFmData.notesWithoutFrontmatter) {
        try {
            const res = await window.api.fixFrontmatter({ filePath: item.path, addFields: {} });
            if (res.success) fixed++;
            else errors++;
        } catch (_) { errors++; }
    }

    // フィールド不足のノート
    for (const item of orgFmData.notesMissingFields) {
        try {
            const addFields = {};
            for (const field of item.missing) {
                if (field === 'tags') addFields.tags = '[]';
                // createdはfix-frontmatter側でデフォルト設定される
            }
            const res = await window.api.fixFrontmatter({ filePath: item.path, addFields });
            if (res.success) fixed++;
            else errors++;
        } catch (_) { errors++; }
    }

    addLog(`📝 Frontmatter補完: 成功${fixed}件 / エラー${errors}件`, fixed > 0 ? 'info' : 'error', 'ORGANIZE');

    // 再スキャン
    orgScanFrontmatter();
}

// ── Feature 3: Inbox整理 ──

let orgInboxData = [];

async function orgScanInbox() {
    orgShowLoading('inbox');
    try {
        const res = await window.api.suggestFolderMoves();
        if (!res.success) throw new Error(res.error);

        orgInboxData = res.suggestions;
        orgHideLoading('inbox');
        orgShowResults('inbox');
        orgRenderInbox(res);
    } catch (e) {
        orgHideLoading('inbox');
        orgShowResults('inbox');
        const summary = $('org-inbox-summary');
        if (summary) summary.textContent = `エラー: ${e.message}`;
    }
}

function orgRenderInbox(data) {
    const summary = $('org-inbox-summary');
    const list = $('org-inbox-list');
    if (!list) return;

    if (data.suggestions.length === 0) {
        if (summary) summary.textContent = `${data.inboxPath} に振り分け候補のノートはありません。`;
        list.innerHTML = '<div class="org-empty-state">Inbox内のノートは整理済みです</div>';
        return;
    }

    if (summary) summary.textContent = `${data.inboxPath} から ${data.suggestions.length}件の振り分け候補が見つかりました`;

    list.innerHTML = data.suggestions.map((item, idx) => `
        <div class="org-item" id="org-inbox-item-${idx}">
            <div class="org-item-row">
                <span class="org-item-title" onclick="window.api.openInObsidian('${esc(item.path)}')">${esc(item.name)}</span>
                <div class="org-item-actions">
                    <button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(item.path)}')" title="プレビュー">👁️</button>
                    <button class="org-btn" onclick="orgMoveNote(${idx})">移動</button>
                </div>
            </div>
            <div class="org-item-detail">
                移動先: <strong>${esc(item.suggestedFolder)}</strong> — ${esc(item.reason)}
            </div>
        </div>
    `).join('');
}

async function orgMoveNote(idx) {
    const item = orgInboxData[idx];
    if (!item) return;

    try {
        const res = await window.api.moveNoteToFolder({ filePath: item.path, targetFolder: item.suggestedFolder });
        if (res.success) {
            addLog(`📂 移動: ${item.name} → ${item.suggestedFolder}`, 'info', 'ORGANIZE');
            const el = $(`org-inbox-item-${idx}`);
            if (el) el.style.opacity = '0.4';
        } else {
            addLog(`❌ 移動エラー: ${res.error}`, 'error', 'ORGANIZE');
        }
    } catch (e) {
        addLog(`❌ 移動エラー: ${e.message}`, 'error', 'ORGANIZE');
    }
}

// ── Feature 4: 長文ノート分割提案 ──

async function orgScanSplit() {
    orgShowLoading('split');
    try {
        const res = await window.api.findSplittableNotes();
        if (!res.success) throw new Error(res.error);

        orgHideLoading('split');
        orgShowResults('split');
        orgRenderSplit(res.notes);
    } catch (e) {
        orgHideLoading('split');
        orgShowResults('split');
        const summary = $('org-split-summary');
        if (summary) summary.textContent = `エラー: ${e.message}`;
    }
}

function orgRenderSplit(notes) {
    const summary = $('org-split-summary');
    const list = $('org-split-list');
    if (!list) return;

    if (notes.length === 0) {
        if (summary) summary.textContent = '分割候補の長文ノートは見つかりませんでした。';
        list.innerHTML = '<div class="org-empty-state">3000文字以上のノートはありません</div>';
        return;
    }

    if (summary) summary.textContent = `${notes.length}件の長文ノートが見つかりました`;

    list.innerHTML = notes.slice(0, 30).map(note => `
        <div class="org-item">
            <div class="org-item-row">
                <span class="org-item-title" onclick="window.api.openInObsidian('${esc(note.path)}')">${esc(note.name)}</span>
                <div class="org-item-actions">
                    <button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(note.path)}')" title="プレビュー">👁️</button>
                    <span class="org-item-badge warn">${note.charCount.toLocaleString()}文字</span>
                </div>
            </div>
            <div class="org-heading-list">
                ${note.headings.map(h => `<div class="org-heading-item">${esc(h.text)} (${h.charCount.toLocaleString()}文字)</div>`).join('')}
            </div>
        </div>
    `).join('');
}

// ── Feature 5: 空フォルダ検出 ──

let orgEmptyData = [];

async function orgScanEmpty() {
    orgShowLoading('empty');
    try {
        const res = await window.api.findEmptyFolders();
        if (!res.success) throw new Error(res.error);

        orgEmptyData = res.folders;
        orgHideLoading('empty');
        orgShowResults('empty');
        orgRenderEmpty(res.folders);
    } catch (e) {
        orgHideLoading('empty');
        orgShowResults('empty');
        const summary = $('org-empty-summary');
        if (summary) summary.textContent = `エラー: ${e.message}`;
    }
}

function orgRenderEmpty(folders) {
    const summary = $('org-empty-summary');
    const list = $('org-empty-list');
    const delBtn = $('btn-org-delete-empty');
    if (!list) return;

    if (folders.length === 0) {
        if (summary) summary.textContent = '空フォルダは見つかりませんでした。';
        list.innerHTML = '<div class="org-empty-state">全てのフォルダにノートがあります</div>';
        if (delBtn) delBtn.style.display = 'none';
        return;
    }

    const deletable = folders.filter(f => !f.hasOtherFiles);
    if (summary) summary.textContent = `${folders.length}件の空フォルダ（うち削除可能: ${deletable.length}件）`;
    if (delBtn) delBtn.style.display = deletable.length > 0 ? '' : 'none';

    list.innerHTML = folders.map(folder => `
        <div class="org-item">
            <div class="org-item-row">
                <span class="org-item-title">${esc(folder.relPath)}</span>
                ${folder.hasOtherFiles ? '<span class="org-item-badge warn">他ファイルあり</span>' : '<span class="org-item-badge green">空</span>'}
            </div>
        </div>
    `).join('');
}

async function orgDeleteEmpty() {
    const deletable = orgEmptyData.filter(f => !f.hasOtherFiles);
    if (deletable.length === 0) return;

    if (!await showConfirmModal('空フォルダ削除の確認', `${deletable.length}件の空フォルダを削除します。\n\n⚡ バックアップについて\n設定で『削除前にバックアップを作成』がオンの場合、自動的にバックアップが保存されます。`, '削除する')) return;

    try {
        const res = await window.api.deleteEmptyFolders(deletable.map(f => f.path));
        if (res.success) {
            addLog(`🗑️ 空フォルダ削除: ${res.deleted}件`, 'info', 'ORGANIZE');
            // 再スキャン
            orgScanEmpty();
        } else {
            addLog(`❌ 削除エラー: ${res.error}`, 'error', 'ORGANIZE');
        }
    } catch (e) {
        addLog(`❌ 削除エラー: ${e.message}`, 'error', 'ORGANIZE');
    }
}

// ── Feature 7: Daily Note TODO抽出 ──

async function orgScanTodos() {
    orgShowLoading('todo');
    try {
        const res = await window.api.extractDailyTodos();
        if (!res.success) throw new Error(res.error);

        orgHideLoading('todo');
        orgShowResults('todo');
        orgRenderTodos(res.results);
    } catch (e) {
        orgHideLoading('todo');
        orgShowResults('todo');
        const summary = $('org-todo-summary');
        if (summary) summary.textContent = `エラー: ${e.message}`;
    }
}

function orgRenderTodos(results) {
    const summary = $('org-todo-summary');
    const list = $('org-todo-list');
    if (!list) return;

    if (results.length === 0) {
        if (summary) summary.textContent = '未完了TODOは見つかりませんでした。';
        list.innerHTML = '<div class="org-empty-state">全てのTODOが完了済みです</div>';
        return;
    }

    const totalTodos = results.reduce((sum, r) => sum + r.todos.length, 0);
    if (summary) summary.textContent = `${results.length}日分のデイリーノートから ${totalTodos}件の未完了TODOを検出`;

    let html = '';
    for (const day of results.slice(0, 30)) {
        html += `<div class="org-todo-date">
            <span onclick="window.api.openInObsidian('${esc(day.file)}')" style="cursor:pointer">${esc(day.date)}</span>
            <button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(day.file)}')" title="プレビュー" style="margin-left:6px;vertical-align:middle">👁️</button>
            <span style="font-weight:normal;font-size:0.78rem;color:var(--muted);margin-left:4px">(${day.todos.length}件)</span>
        </div>`;
        for (const todo of day.todos) {
            html += `<div class="org-todo-item">${esc(todo.text)}</div>`;
        }
    }
    list.innerHTML = html;
}

// ── Feature 8: リンク正規化 ──

let orgLinksData = [];

async function orgScanLinks() {
    orgShowLoading('links');
    try {
        const res = await window.api.findInconsistentLinks();
        if (!res.success) throw new Error(res.error);

        orgLinksData = res.issues;
        orgHideLoading('links');
        orgShowResults('links');
        orgRenderLinks(res.issues);
    } catch (e) {
        orgHideLoading('links');
        orgShowResults('links');
        const summary = $('org-links-summary');
        if (summary) summary.textContent = `エラー: ${e.message}`;
    }
}

function orgRenderLinks(issues) {
    const summary = $('org-links-summary');
    const list = $('org-links-list');
    const fixBtn = $('btn-org-normalize-links');
    if (!list) return;

    if (issues.length === 0) {
        if (summary) summary.textContent = 'リンクの不整合は見つかりませんでした。';
        list.innerHTML = '<div class="org-empty-state">全てのリンクが正常です</div>';
        if (fixBtn) fixBtn.style.display = 'none';
        return;
    }

    const caseIssues = issues.filter(i => i.issue === 'case_mismatch');
    const brokenIssues = issues.filter(i => i.issue === 'broken');
    if (summary) summary.textContent = `大小文字不一致: ${caseIssues.length}件 / 壊れたリンク: ${brokenIssues.length}件`;
    if (fixBtn) fixBtn.style.display = caseIssues.length > 0 ? '' : 'none';

    list.innerHTML = issues.slice(0, 50).map(issue => `
        <div class="org-item">
            <div class="org-item-row">
                <span class="org-item-title" onclick="window.api.openInObsidian('${esc(issue.file)}')">${esc(issue.relPath)}</span>
                <div class="org-item-actions">
                    <button class="obsidian-btn" onclick="window.openNotePreviewModal('${esc(issue.file)}')" title="プレビュー">👁️</button>
                    <span class="org-link-issue ${issue.issue === 'case_mismatch' ? 'case' : 'broken'}">${issue.issue === 'case_mismatch' ? '大小文字' : '壊れたリンク'}</span>
                </div>
            </div>
            <div class="org-item-detail">
                ${esc(issue.link)}${issue.suggestion ? ` → <strong>${esc('[[' + issue.suggestion + ']]')}</strong>` : ''}
            </div>
        </div>
    `).join('');
}

async function orgNormalizeLinks() {
    const fixable = orgLinksData.filter(i => i.issue === 'case_mismatch' && i.suggestion);
    if (fixable.length === 0) return;

    if (!await showConfirmModal('リンク修正の確認', `${fixable.length}件のリンクを修正します。\n\n⚡ バックアップについて\n設定で『削除前にバックアップを作成』がオンの場合、自動的にバックアップが保存されます。`, '修正する')) return;

    try {
        const res = await window.api.normalizeLinks(fixable);
        if (res.success) {
            addLog(`🔗 リンク正規化: ${res.fixed}件修正`, 'info', 'ORGANIZE');
            // 再スキャン
            orgScanLinks();
        } else {
            addLog(`❌ リンク修正エラー: ${res.error}`, 'error', 'ORGANIZE');
        }
    } catch (e) {
        addLog(`❌ リンク修正エラー: ${e.message}`, 'error', 'ORGANIZE');
    }
}

// ============================================================
// タスク管理機能
// ============================================================
let allTasksCache = [];
let currentTaskFilter = 'all';

async function loadTaskTab() {
    // 保存先ドロップダウンを取得
    await loadTaskTargets();
    // タスク一覧を取得
    await refreshTaskList();
    // イベントバインド
    bindTaskEvents();
}

let selectedTaskPriority = '';

function bindTaskEvents() {
    const safe = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    safe('btn-add-task', addTask);
    safe('btn-refresh-tasks', refreshTaskList);

    // Enterキーでタスク追加
    const input = $('task-input');
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTask(); }
        });
    }

    // クイック日付ボタン
    document.querySelectorAll('.task-quick-date-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const offset = parseInt(btn.dataset.offset, 10);
            const d = new Date();
            d.setDate(d.getDate() + offset);
            const dateStr = d.toISOString().split('T')[0];
            const dueDateEl = $('task-due-date');
            if (dueDateEl) dueDateEl.value = dateStr;
        });
    });

    // 優先度ボタン
    document.querySelectorAll('.task-pri-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.task-pri-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            selectedTaskPriority = btn.dataset.pri;
        });
    });
    // デフォルト「なし」をアクティブに
    const defaultPriBtn = document.querySelector('.task-pri-btn[data-pri=""]');
    if (defaultPriBtn) defaultPriBtn.classList.add('active');

    // フィルターボタン
    document.querySelectorAll('.task-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.task-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTaskFilter = btn.dataset.filter;
            renderTaskList(allTasksCache, currentTaskFilter);
        });
    });
}

async function loadTaskTargets() {
    const sel = $('task-target-note');
    if (!sel) return;
    try {
        const res = await window.api.getTaskTargets();
        if (!res.success) return;
        sel.innerHTML = '';
        // デフォルトオプション
        const defOpt = document.createElement('option');
        defOpt.value = '__default__';
        defOpt.textContent = res.defaultLabel;
        sel.appendChild(defOpt);
        // タスクを含む既存ファイル
        for (const t of res.targets) {
            // デフォルトと同じファイルはスキップ
            if (t.filePath === res.defaultPath) continue;
            const opt = document.createElement('option');
            opt.value = t.filePath;
            opt.textContent = t.relPath;
            sel.appendChild(opt);
        }
    } catch (e) { console.warn('loadTaskTargets error:', e); }
}

async function addTask() {
    const input = $('task-input');
    const dueDateEl = $('task-due-date');
    const targetEl = $('task-target-note');
    const feedback = $('task-add-feedback');
    if (!input) return;

    const text = input.value.trim();
    if (!text) {
        input.focus();
        input.style.borderColor = '#f87171';
        setTimeout(() => { input.style.borderColor = ''; }, 1500);
        return;
    }

    try {
        const res = await window.api.addTask({
            text,
            dueDate: dueDateEl ? dueDateEl.value : '',
            priority: selectedTaskPriority || '',
            targetNote: targetEl ? targetEl.value : '__default__',
        });

        if (res.success) {
            addLog(`✅ タスク追加: ${text}`, 'info', 'TASK');
            // 成功フィードバック
            if (feedback) {
                feedback.style.display = 'block';
                feedback.style.background = 'rgba(52,211,153,.1)';
                feedback.style.border = '1px solid rgba(52,211,153,.3)';
                feedback.style.color = '#34d399';
                feedback.innerHTML = `✅ 「${esc(text)}」を追加しました`;
                setTimeout(() => { feedback.style.display = 'none'; }, 3000);
            }
            // フォームクリア
            input.value = '';
            if (dueDateEl) dueDateEl.value = '';
            selectedTaskPriority = '';
            document.querySelectorAll('.task-pri-btn').forEach(b => b.classList.remove('active'));
            const defaultPri = document.querySelector('.task-pri-btn[data-pri=""]');
            if (defaultPri) defaultPri.classList.add('active');
            // 一覧更新
            await refreshTaskList();
            await loadTaskTargets();
            input.focus();
        } else {
            addLog(`❌ タスク追加エラー: ${res.error}`, 'error', 'TASK');
            if (feedback) {
                feedback.style.display = 'block';
                feedback.style.background = 'rgba(248,113,113,.1)';
                feedback.style.border = '1px solid rgba(248,113,113,.3)';
                feedback.style.color = '#f87171';
                feedback.textContent = `❌ エラー: ${res.error}`;
            }
        }
    } catch (e) {
        addLog(`❌ タスク追加エラー: ${e.message}`, 'error', 'TASK');
    }
}

async function refreshTaskList() {
    const container = $('task-list-container');
    if (!container) return;
    container.innerHTML = '<div class="task-empty">読み込み中...</div>';

    try {
        const res = await window.api.getAllTasks();
        if (!res.success) {
            container.innerHTML = `<div class="task-empty">${esc(res.error)}</div>`;
            return;
        }
        allTasksCache = res.tasks;
        renderTaskList(allTasksCache, currentTaskFilter);
    } catch (e) {
        container.innerHTML = `<div class="task-empty">エラー: ${esc(e.message)}</div>`;
    }
}

function renderTaskList(tasks, filter) {
    const container = $('task-list-container');
    if (!container) return;

    const today = new Date().toISOString().slice(0, 10);
    // 今週末の日付を計算
    const todayDate = new Date();
    const weekEnd = new Date(todayDate);
    weekEnd.setDate(todayDate.getDate() + (7 - todayDate.getDay()));
    const weekEndStr = weekEnd.toISOString().slice(0, 10);

    // フィルタリング
    let filtered = tasks;
    switch (filter) {
        case 'today':
            filtered = tasks.filter(t => !t.done && t.dueDate === today);
            break;
        case 'week':
            filtered = tasks.filter(t => !t.done && t.dueDate && t.dueDate >= today && t.dueDate <= weekEndStr);
            break;
        case 'overdue':
            filtered = tasks.filter(t => !t.done && t.dueDate && t.dueDate < today);
            break;
        case 'done':
            filtered = tasks.filter(t => t.done);
            break;
        case 'all':
        default:
            // すべて表示
            break;
    }

    if (filtered.length === 0) {
        const emptyMessages = {
            all: 'タスクがありません。上のフォームからタスクを追加しましょう！',
            today: '今日のタスクはありません 🎉',
            week: '今週のタスクはありません',
            overdue: '期限切れのタスクはありません 🎉',
            done: '完了済みタスクはありません',
        };
        container.innerHTML = `<div class="task-empty"><span class="task-empty-icon">📭</span>${esc(emptyMessages[filter] || emptyMessages.all)}</div>`;
        return;
    }

    container.innerHTML = filtered.map((task, idx) => {
        const doneClass = task.done ? ' done' : '';
        const checkIcon = task.done ? '✓' : '';

        // 期限バッジ
        let dueBadgeHtml = '';
        if (task.dueDate) {
            let dueBadgeClass = 'future';
            let dueLabel = task.dueDate;
            if (task.dueDate < today && !task.done) { dueBadgeClass = 'overdue'; dueLabel = `${task.dueDate} (期限切れ)`; }
            else if (task.dueDate === today) { dueBadgeClass = 'today'; dueLabel = '今日'; }
            else if (task.dueDate <= weekEndStr) { dueBadgeClass = 'soon'; }
            dueBadgeHtml = `<span class="task-due-badge ${dueBadgeClass}">📅 ${esc(dueLabel)}</span>`;
        }

        // 優先度バッジ
        let priorityBadgeHtml = '';
        if (task.priority) {
            const pLabels = { high: '⏫ 高', medium: '🔼 中', low: '🔽 低' };
            priorityBadgeHtml = `<span class="task-priority-badge ${esc(task.priority)}">${pLabels[task.priority] || ''}</span>`;
        }

        // ソースファイル名
        const fileName = task.relPath ? task.relPath.split('/').pop().replace(/\.md$/, '') : '';

        return `<div class="task-item${doneClass}" data-task-idx="${idx}" data-file="${esc(task.filePath)}" data-line="${task.lineNumber}">
            <button class="task-checkbox" data-action="toggle" title="${task.done ? '未完了に戻す' : '完了にする'}">${checkIcon}</button>
            <span class="task-text">${esc(task.text)}</span>
            <div class="task-badges">
                ${dueBadgeHtml}
                ${priorityBadgeHtml}
                <span class="task-source" data-action="open-source" title="${esc(task.relPath)}">${esc(fileName)}</span>
            </div>
            <button class="obsidian-btn" data-action="preview" title="プレビュー" style="font-size:.78rem;padding:2px 6px">👁️</button>
            <button class="task-delete-btn" data-action="delete" title="タスクを削除">🗑️</button>
        </div>`;
    }).join('');

    // イベント委譲
    container.querySelectorAll('.task-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            const action = e.target.closest('[data-action]');
            if (!action) return;
            const act = action.dataset.action;
            const filePath = item.dataset.file;
            const lineNumber = parseInt(item.dataset.line, 10);

            if (act === 'toggle') {
                const isDone = item.classList.contains('done');
                try {
                    const res = await window.api.toggleTask({ filePath, lineNumber, done: !isDone });
                    if (res.success) await refreshTaskList();
                    else addLog(`❌ タスク更新エラー: ${res.error}`, 'error', 'TASK');
                } catch (err) { addLog(`❌ タスク更新エラー: ${err.message}`, 'error', 'TASK'); }
            } else if (act === 'delete') {
                if (!await showConfirmModal('タスク削除の確認', 'このタスクを削除しますか？', '削除する')) return;
                try {
                    const res = await window.api.deleteTask({ filePath, lineNumber });
                    if (res.success) { addLog('🗑️ タスク削除', 'info', 'TASK'); await refreshTaskList(); }
                    else addLog(`❌ タスク削除エラー: ${res.error}`, 'error', 'TASK');
                } catch (err) { addLog(`❌ タスク削除エラー: ${err.message}`, 'error', 'TASK'); }
            } else if (act === 'preview') {
                if (filePath) openNotePreviewModal(filePath);
            } else if (act === 'open-source') {
                window.api.openInObsidian(filePath).catch(console.error);
            }
        });
    });
}


// ============================================================
// オンボーディングウィザード
// ============================================================

function showOnboarding() {
    const overlay = $('onboarding-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function goOnboardingStep(step) {
    document.querySelectorAll('.onboarding-step').forEach(s => {
        s.style.display = s.dataset.step === String(step) ? '' : 'none';
    });
    document.querySelectorAll('.onboarding-dot').forEach(d => {
        d.classList.toggle('active', parseInt(d.dataset.dot) <= step);
    });
}

async function onboardingSelectVault() {
    try {
        const result = await window.api.selectVaultFolder();
        if (result) {
            const status = $('onboarding-vault-status');
            if (status) {
                status.textContent = '✅ Vault を選択しました: ' + result;
                status.style.color = 'var(--green)';
            }
            const nextBtn = $('onboarding-next-2');
            if (nextBtn) nextBtn.disabled = false;
            // 再初期化
            await initAsync();
        }
    } catch (e) {
        const status = $('onboarding-vault-status');
        if (status) {
            status.textContent = '❌ 選択に失敗しました: ' + e.message;
            status.style.color = 'var(--danger)';
        }
    }
}

async function onboardingRunScan() {
    const status = $('onboarding-scan-status');
    if (status) {
        status.textContent = '⏳ スキャン中...';
        status.style.color = 'var(--warn)';
    }
    try {
        await runScan();
        if (status) {
            status.textContent = '✅ スキャン完了！';
            status.style.color = 'var(--green)';
        }
        const nextBtn = $('onboarding-next-3');
        if (nextBtn) nextBtn.disabled = false;
    } catch (e) {
        if (status) {
            status.textContent = '❌ スキャンエラー: ' + e.message;
            status.style.color = 'var(--danger)';
        }
    }
}

async function finishOnboarding() {
    const overlay = $('onboarding-overlay');
    if (overlay) overlay.style.display = 'none';
    try {
        await window.api.saveConfigPartial({ onboardingCompleted: true });
    } catch (e) { console.warn('Failed to save onboarding state:', e); }
    activateTab('dashboard');
    showToast('セットアップ完了！ダッシュボードへようこそ', 'success');
}

// ============================================================
// Feature 1: ライセンス認証
// ============================================================

// ライセンスキー入力の自動フォーマット（ダッシュ挿入）
function formatLicenseKeyInput(inputEl) {
    if (!inputEl) return;
    inputEl.addEventListener('input', (e) => {
        let val = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        // OPT プレフィックスを保持
        let formatted = '';
        // OPT-XXXX-XXXX-XXXX-XXXX の形式にフォーマット
        // まず「OPT」を処理
        if (val.startsWith('OPT')) {
            formatted = 'OPT';
            val = val.slice(3);
        } else if (val.length > 0) {
            // OPTで始まらない場合はそのまま4文字ずつ区切る
            formatted = 'OPT';
            // 入力をそのまま残す（OPTプレフィックスなしの入力に対応）
        }
        // 残りを4文字ずつダッシュ区切り
        let i = 0;
        while (val.length > 0 && i < 4) {
            const chunk = val.slice(0, 4);
            val = val.slice(4);
            formatted += '-' + chunk;
            i++;
        }
        e.target.value = formatted;
    });
}

async function checkLicenseStatus() {
    try {
        const status = await window.api.getLicenseStatus();
        isLicensed = status.isLicensed;
        updateLicenseUI(status);
        if (!isLicensed) {
            // ライセンスモーダルを表示
            const modal = $('license-modal');
            if (modal) modal.style.display = 'flex';
        }
    } catch (e) {
        console.warn('ライセンス確認エラー:', e);
    }
}

function updateLicenseUI(status) {
    // 設定タブのライセンスバッジを更新
    const badge = $('license-status-badge');
    if (badge) {
        if (status.isLicensed) {
            badge.textContent = '認証済み: ' + status.maskedKey;
            badge.className = 'license-status-badge licensed';
        } else {
            badge.textContent = 'トライアル版';
            badge.className = 'license-status-badge trial';
        }
    }

    // トライアルモードの制御
    if (!status.isLicensed && isTrialMode) {
        applyTrialRestrictions();
    } else if (status.isLicensed) {
        isTrialMode = false;
        removeTrialRestrictions();
    }
}

function applyTrialRestrictions() {
    // 最適化、MOC、AIタブのボタンを無効化
    const restrictedButtons = [
        'btn-run-optimize', 'btn-quick-optimize', 'btn-preview', 'btn-run-dryrun'
    ];
    restrictedButtons.forEach(id => {
        const el = $(id);
        if (el) {
            el.disabled = true;
            el.title = 'ライセンスが必要です';
        }
    });

    // MOC作成タブとAI関連を制限クラスでマーク
    const restrictedTabs = ['tab-moc-create'];
    restrictedTabs.forEach(id => {
        const el = $(id);
        if (el && !el.classList.contains('trial-disabled')) {
            el.classList.add('trial-disabled');
        }
    });
}

function removeTrialRestrictions() {
    // すべての制限を解除
    const restrictedButtons = [
        'btn-run-optimize', 'btn-quick-optimize', 'btn-preview', 'btn-run-dryrun'
    ];
    restrictedButtons.forEach(id => {
        const el = $(id);
        if (el) {
            el.disabled = false;
            el.title = '';
        }
    });
    const restrictedTabs = ['tab-moc-create'];
    restrictedTabs.forEach(id => {
        const el = $(id);
        if (el) el.classList.remove('trial-disabled');
    });
}

async function verifyLicenseFromInput(inputId, errorId) {
    const inputEl = $(inputId);
    const errorEl = $(errorId);
    if (!inputEl) return false;

    const key = inputEl.value.trim().toUpperCase();
    if (!key) {
        if (errorEl) { errorEl.textContent = 'ライセンスキーを入力してください'; errorEl.style.display = 'block'; }
        return false;
    }

    try {
        const result = await window.api.verifyLicense(key);
        if (result.success) {
            isLicensed = true;
            isTrialMode = false;
            if (errorEl) errorEl.style.display = 'none';

            // モーダルを閉じる
            const modal = $('license-modal');
            if (modal) modal.style.display = 'none';

            // UIを更新
            updateLicenseUI({ isLicensed: true, maskedKey: key.slice(0, 8) + '-****-****' });
            removeTrialRestrictions();
            showToast('ライセンスが認証されました', 'success');
            return true;
        } else {
            if (errorEl) { errorEl.textContent = result.error; errorEl.style.display = 'block'; }
            return false;
        }
    } catch (e) {
        if (errorEl) { errorEl.textContent = 'エラー: ' + e.message; errorEl.style.display = 'block'; }
        return false;
    }
}

// ============================================================
// Feature 2: アップデートチェック
// ============================================================
async function checkForUpdates(silent) {
    const statusEl = $('update-status');
    const infoEl = $('update-info');

    if (!silent && statusEl) statusEl.textContent = '確認中...';

    try {
        const result = await window.api.checkForUpdates();
        if (result.error && !silent) {
            if (statusEl) statusEl.textContent = '確認できませんでした: ' + result.error;
            return;
        }
        if (result.updateAvailable) {
            if (statusEl) statusEl.textContent = '新バージョンがあります！';
            if (infoEl) {
                infoEl.style.display = 'block';
                infoEl.innerHTML = `
                    <div style="padding:12px;background:var(--glass);border:1px solid var(--border);border-radius:12px">
                        <p><strong>v${esc(result.latestVersion)}</strong> が利用可能です（現在: v${esc(result.currentVersion)}）</p>
                        ${result.releaseNotes ? '<p style="margin-top:8px;opacity:.7;font-size:.8rem;white-space:pre-wrap">' + esc(result.releaseNotes).slice(0, 300) + '</p>' : ''}
                        <a href="${esc(result.downloadUrl)}" style="display:inline-block;margin-top:10px;color:var(--accent);text-decoration:underline;cursor:pointer" onclick="event.preventDefault();window.api.openPath('${esc(result.downloadUrl)}')">ダウンロードページを開く</a>
                    </div>`;
            }
            // サイレントモードでもトーストを出す
            showToast('新バージョン v' + result.latestVersion + ' が利用可能です', 'info', 6000);
        } else {
            if (!silent && statusEl) statusEl.textContent = '最新版です (v' + result.currentVersion + ')';
            if (infoEl) infoEl.style.display = 'none';
        }
    } catch (e) {
        if (!silent && statusEl) statusEl.textContent = '確認エラー: ' + e.message;
    }
}

// ============================================================
// Feature 4: テーマ切り替え
// ============================================================
let currentTheme = 'dark';

function applyTheme(theme) {
    currentTheme = theme;
    const body = document.body;
    if (theme === 'light') {
        body.classList.add('theme-light');
        body.classList.remove('theme-dark');
    } else {
        body.classList.remove('theme-light');
        body.classList.add('theme-dark');
    }
    // テーマ切り替えボタンのアイコン更新
    const btn = $('btn-theme-toggle');
    if (btn) {
        btn.textContent = theme === 'light' ? '\u2600\uFE0F' : '\uD83C\uDF19';
        btn.title = theme === 'light' ? 'ダークテーマに切替' : 'ライトテーマに切替';
    }
}

async function toggleTheme() {
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
    try {
        await window.api.setAppTheme(newTheme);
    } catch (e) {
        console.warn('テーマ保存エラー:', e);
    }
}

// ============================================================
// Feature 5: お気に入りノート
// ============================================================
async function addFavoriteFromDialog() {
    try {
        const res = await window.api.selectFavoriteNote();
        if (res.success) {
            showToast('⭐ 「' + res.name + '」をお気に入りに追加しました', 'success');
            loadFavorites();
        }
    } catch (e) { showToast('エラー: ' + e.message, 'error'); }
}

async function loadFavorites() {
    const container = $('favorites-list');
    if (!container) return;
    try {
        const res = await window.api.getFavorites();
        if (!res.success || !res.favorites || res.favorites.length === 0) {
            container.innerHTML = '<p class="muted-hint">お気に入りはまだありません</p>';
            return;
        }
        container.innerHTML = '';
        res.favorites.forEach(fav => {
            const div = document.createElement('div');
            div.className = 'favorite-item';
            div.innerHTML = `
                <div class="favorite-item-info">
                    <div class="favorite-item-name">${esc(fav.name)}</div>
                    <div class="favorite-item-folder">${esc(fav.folder)}</div>
                </div>
            `;
            // Obsidianで開くボタン
            const openBtn = document.createElement('button');
            openBtn.className = 'favorite-btn';
            openBtn.textContent = '📂';
            openBtn.title = 'Obsidianで開く';
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.api.openFavorite(fav.path).catch(err => console.warn(err));
            });
            // 削除ボタン
            const removeBtn = document.createElement('button');
            removeBtn.className = 'favorite-btn';
            removeBtn.textContent = '✕';
            removeBtn.title = 'お気に入りから削除';
            removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await window.api.toggleFavorite({ notePath: fav.path });
                    showToast('お気に入りから削除しました', 'info');
                    loadFavorites();
                } catch (err) { showToast('エラー: ' + err.message, 'error'); }
            });
            div.appendChild(openBtn);
            div.appendChild(removeBtn);
            container.appendChild(div);
        });
    } catch (e) {
        container.innerHTML = `<p class="muted-hint">読み込みエラー: ${esc(e.message)}</p>`;
    }
}

// ノートプレビューにお気に入りボタンを追加するヘルパー
function addFavoriteButtonToPreview(previewEl, filePath) {
    if (!previewEl || !filePath) return;
    // 既にボタンがある場合はスキップ
    if (previewEl.querySelector('.favorite-btn')) return;

    const favBtn = document.createElement('button');
    favBtn.className = 'favorite-btn';
    favBtn.style.cssText = 'position:absolute;top:6px;right:6px;font-size:1.1rem;z-index:2';
    favBtn.title = 'お気に入りに追加/削除';

    // 現在の状態を確認
    window.api.getFavorites().then(res => {
        const isFav = res.success && res.favorites.some(f => f.path === filePath);
        favBtn.textContent = isFav ? '⭐' : '☆';
        if (isFav) favBtn.classList.add('favorite-btn-active');
    }).catch(() => { favBtn.textContent = '☆'; });

    favBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            const res = await window.api.toggleFavorite({ notePath: filePath });
            if (res.success) {
                const nowFav = res.favorites.includes(filePath);
                favBtn.textContent = nowFav ? '⭐' : '☆';
                favBtn.classList.toggle('favorite-btn-active', nowFav);
                showToast(nowFav ? 'お気に入りに追加しました' : 'お気に入りから削除しました', 'info');
                loadFavorites();
            }
        } catch (err) { showToast('エラー: ' + err.message, 'error'); }
    });

    previewEl.style.position = 'relative';
    previewEl.appendChild(favBtn);
}

// note-previewが生成された後にお気に入りボタンを注入するMutationObserver
const notePreviewObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType === 1 && node.classList && node.classList.contains('note-preview')) {
                // 親要素からファイルパスを取得
                const parent = node.closest('[data-path]') || node.parentElement;
                if (parent) {
                    const pathEl = parent.querySelector('[data-path]');
                    const filePath = pathEl ? pathEl.getAttribute('data-path') : parent.getAttribute('data-path');
                    if (filePath) addFavoriteButtonToPreview(node, filePath);
                }
            }
        }
    }
});
notePreviewObserver.observe(document.body, { childList: true, subtree: true });

// ============================================================
// Feature 6: Vault間ノート操作
// ============================================================
async function compareVaults() {
    const container = $('vault-compare-content');
    if (!container) return;
    container.innerHTML = '<p class="muted-hint">比較中...</p>';

    try {
        const res = await window.api.compareVaults();
        if (!res.success) {
            container.innerHTML = `<p class="muted-hint">${esc(res.error)}</p>`;
            return;
        }

        let html = '<table class="vault-compare-table"><thead><tr><th>Vault名</th><th>ノート数</th><th>タグ数</th><th>操作</th></tr></thead><tbody>';
        res.vaults.forEach(v => {
            html += `<tr>
                <td>${esc(v.name)}</td>
                <td>${v.noteCount}</td>
                <td>${v.tagCount}</td>
                <td><span class="muted-hint" style="font-size:.75rem">${esc(v.path)}</span></td>
            </tr>`;
        });
        html += '</tbody></table>';

        if (res.commonNotes && res.commonNotes.length > 0) {
            html += `<div class="vault-compare-common">
                <strong>📎 共通ノート名 (${res.commonNotes.length}件):</strong>
                <span style="margin-left:8px">${res.commonNotes.map(n => esc(n)).join(', ')}</span>
            </div>`;
        } else {
            html += '<p class="muted-hint" style="margin-top:8px">共通ノートはありません</p>';
        }

        // ノートコピーUI
        if (res.vaults.length >= 2) {
            html += `<div style="margin-top:14px;padding:12px;border:1px solid rgba(255,255,255,.06);border-radius:10px">
                <strong style="font-size:.85rem">📋 ノートをコピー</strong>
                <p class="muted-hint" style="font-size:.75rem;margin:4px 0 8px">現在のVaultのノートを別のVaultにコピーします（対象Vaultの 00 Inbox に保存されます）</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    <span style="font-size:.83rem">コピー先:</span>
                    <select id="copy-target-vault" class="vault-select" style="width:200px">
                        ${res.vaults.map(v => `<option value="${esc(v.path)}">${esc(v.name)}</option>`).join('')}
                    </select>
                </div>
                <p class="muted-hint" style="font-size:.72rem;margin-top:6px">※ スキャン結果画面でノートを選択してコピーする機能は今後追加予定です</p>
            </div>`;
        }

        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = `<p class="muted-hint">エラー: ${esc(e.message)}</p>`;
    }
}

// ============================================================
// Feature 7: 自動バックアップスケジュール（UI連携）
// ============================================================
async function initBackupScheduleUI() {
    const sel = $('backup-schedule');
    if (!sel) return;
    try {
        const res = await window.api.getBackupSchedule();
        if (res.success) sel.value = res.schedule;
    } catch (_) { /* ignore */ }

    sel.addEventListener('change', async () => {
        try {
            const res = await window.api.setBackupSchedule({ schedule: sel.value });
            if (res.success) {
                const labels = { off: 'オフ', daily: '毎日', weekly: '毎週' };
                showToast(`バックアップスケジュール: ${labels[res.schedule] || res.schedule}`, 'info');
            }
        } catch (e) { showToast('設定エラー: ' + e.message, 'error'); }
    });

    const runBtn = $('btn-run-backup-now');
    if (runBtn) {
        runBtn.addEventListener('click', async () => {
            runBtn.disabled = true;
            runBtn.textContent = 'バックアップ中...';
            try {
                const res = await window.api.runVaultBackup();
                if (res.success) {
                    showToast(`バックアップ完了: ${res.copiedCount}ファイル`, 'success');
                } else {
                    showToast('バックアップ失敗: ' + (res.error || '不明なエラー'), 'error');
                }
            } catch (e) {
                showToast('バックアップエラー: ' + e.message, 'error');
            } finally {
                runBtn.disabled = false;
                runBtn.textContent = '今すぐバックアップ';
            }
        });
    }
}

// ============================================================
// Feature 8: コマンドパレット (Cmd+P / Ctrl+P)
// ============================================================
const COMMANDS = [
    { id: 'scan', label: '🔍 スキャンを実行', action: () => runScan() },
    { id: 'optimize', label: '✨ 最適化を実行', action: () => activateTab('scan-optimize') },
    { id: 'moc', label: '🗺️ MOC作成', action: () => activateTab('moc-create') },
    { id: 'tasks', label: '📝 タスクタブを開く', action: () => activateTab('tasks') },
    { id: 'settings', label: '⚙️ 設定を開く', action: () => activateTab('settings') },
    { id: 'help', label: '❓ ヘルプを開く', action: () => activateTab('help') },
    { id: 'graph', label: '🕸️ グラフビューを開く', action: () => { activateTab('analytics'); switchSubTab('analytics', 'graph-view'); } },
    { id: 'organize', label: '🧹 整理ツールを開く', action: () => activateTab('tools') },
    { id: 'organize-all', label: '🔍 全ツール一括スキャン', action: () => { activateTab('tools'); orgScanAll(); } },
    { id: 'dashboard-full', label: '🖥️ フルダッシュボード生成', action: () => selectDashboardType('full') },
    { id: 'report', label: '📋 健康レポート出力', action: () => runHealthReport() },
    { id: 'ai-search', label: '🤖 AI検索', action: () => { activateTab('dashboard'); const el = $('ai-search-query'); if (el) el.focus(); } },
    { id: 'ai-ask', label: '🤖 Vaultに質問する', action: () => { activateTab('dashboard'); const el = $('ai-chat-input'); if (el) el.focus(); } },
    { id: 'theme', label: '🌙 テーマ切替', action: () => toggleTheme() },
    { id: 'favorites', label: '⭐ お気に入りを表示', action: () => { activateTab('dashboard'); const el = $('favorites-list'); if (el) el.scrollIntoView({ behavior: 'smooth' }); } },
    { id: 'analytics', label: '📊 分析タブを開く', action: () => activateTab('analytics') },
    { id: 'dashboard', label: '🏠 ダッシュボードを開く', action: () => activateTab('dashboard') },
    { id: 'backup', label: '💾 今すぐバックアップ', action: () => { const btn = $('btn-run-backup-now'); if (btn) btn.click(); else showToast('設定タブからバックアップを実行してください', 'warn'); } },
];

let commandPaletteActiveIndex = 0;
let filteredCommands = [...COMMANDS];

function openCommandPalette() {
    const overlay = $('command-palette');
    if (!overlay) return;
    overlay.style.display = 'flex';
    const searchInput = $('command-search');
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    commandPaletteActiveIndex = 0;
    filteredCommands = [...COMMANDS];
    renderCommandList();
}

function closeCommandPalette() {
    const overlay = $('command-palette');
    if (overlay) overlay.style.display = 'none';
}

function renderCommandList() {
    const list = $('command-list');
    if (!list) return;
    list.innerHTML = '';
    filteredCommands.forEach((cmd, i) => {
        const div = document.createElement('div');
        div.className = 'command-item' + (i === commandPaletteActiveIndex ? ' active' : '');
        div.textContent = cmd.label;
        div.addEventListener('click', () => {
            closeCommandPalette();
            cmd.action();
        });
        div.addEventListener('mouseenter', () => {
            commandPaletteActiveIndex = i;
            list.querySelectorAll('.command-item').forEach((el, j) => {
                el.classList.toggle('active', j === i);
            });
        });
        list.appendChild(div);
    });
}

function filterCommands(query) {
    const q = query.toLowerCase().trim();
    if (!q) {
        filteredCommands = [...COMMANDS];
    } else {
        filteredCommands = COMMANDS.filter(cmd =>
            cmd.label.toLowerCase().includes(q) || cmd.id.toLowerCase().includes(q)
        );
    }
    commandPaletteActiveIndex = 0;
    renderCommandList();
}

function executeActiveCommand() {
    if (filteredCommands.length > 0 && commandPaletteActiveIndex < filteredCommands.length) {
        const cmd = filteredCommands[commandPaletteActiveIndex];
        closeCommandPalette();
        cmd.action();
    }
}

// コマンドパレットのイベントバインド
document.addEventListener('keydown', (e) => {
    // Cmd+P / Ctrl+P でコマンドパレットを開く
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        const overlay = $('command-palette');
        if (overlay && overlay.style.display !== 'none') {
            closeCommandPalette();
        } else {
            openCommandPalette();
        }
        return;
    }

    // コマンドパレットが開いている時のキーボード操作
    const overlay = $('command-palette');
    if (!overlay || overlay.style.display === 'none') return;

    if (e.key === 'Escape') {
        e.preventDefault();
        closeCommandPalette();
        return;
    }

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filteredCommands.length > 0) {
            commandPaletteActiveIndex = (commandPaletteActiveIndex + 1) % filteredCommands.length;
            renderCommandList();
            // アクティブアイテムが見えるようにスクロール
            const list = $('command-list');
            const activeItem = list ? list.querySelector('.command-item.active') : null;
            if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
        }
        return;
    }

    if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filteredCommands.length > 0) {
            commandPaletteActiveIndex = (commandPaletteActiveIndex - 1 + filteredCommands.length) % filteredCommands.length;
            renderCommandList();
            const list = $('command-list');
            const activeItem = list ? list.querySelector('.command-item.active') : null;
            if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
        }
        return;
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        executeActiveCommand();
        return;
    }
});

// 検索入力のフィルタリング
document.addEventListener('DOMContentLoaded', () => {
    const searchInput = $('command-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterCommands(e.target.value);
        });
    }

    // コマンドパレットのオーバーレイクリックで閉じる
    const overlay = $('command-palette');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeCommandPalette();
        });
    }
});

// ============================================================
// Feature 5/6/7: 初期化統合
// ============================================================
// initAsyncから呼び出せるよう、DOMContentLoaded後に初期化
document.addEventListener('DOMContentLoaded', () => {
    // お気に入りの初期読み込み
    setTimeout(() => loadFavorites(), 500);
    // お気に入り追加ボタン
    const favAddBtn = $('btn-add-favorite');
    if (favAddBtn) favAddBtn.addEventListener('click', addFavoriteFromDialog);
    // バックアップスケジュールUI初期化
    setTimeout(() => initBackupScheduleUI(), 500);
    // Vault比較ボタン
    const compareBtn = $('btn-compare-vaults');
    if (compareBtn) {
        compareBtn.addEventListener('click', compareVaults);
    }
});
