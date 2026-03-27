const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfigPartial: (p) => ipcRenderer.invoke('save-config-partial', p),
    checkVault: () => ipcRenderer.invoke('check-vault'),
    selectVaultFolder: () => ipcRenderer.invoke('select-vault-folder'),
    openVaultFolder: () => ipcRenderer.invoke('open-vault-folder'),
    openPath: (p) => ipcRenderer.invoke('open-path', p),
    openInObsidian: (filePath) => ipcRenderer.invoke('open-in-obsidian', filePath),
    scanVault: () => ipcRenderer.invoke('scan-vault'),
    dryRun: () => ipcRenderer.invoke('dry-run'),
    optimizeVault: (opts) => ipcRenderer.invoke('optimize-vault', opts),
    deleteSelected: (paths) => ipcRenderer.invoke('delete-selected', paths),
    exportReport: (stats) => ipcRenderer.invoke('export-report', stats),
    exportData: (stats, format) => ipcRenderer.invoke('export-data', { stats, format }),
    onScanProgress: (cb) => {
        ipcRenderer.removeAllListeners('scan-progress');
        ipcRenderer.on('scan-progress', (_, m) => cb(m));
    },
    onOptimizeProgress: (cb) => {
        ipcRenderer.removeAllListeners('optimize-progress');
        ipcRenderer.on('optimize-progress', (_, m) => cb(m));
    },
    // v4.0 新機能
    switchVault: (index) => ipcRenderer.invoke('switch-vault', index),
    addVault: () => ipcRenderer.invoke('add-vault'),
    removeVault: (index) => ipcRenderer.invoke('remove-vault', index),
    fixBrokenLink: (req) => ipcRenderer.invoke('fix-broken-link', req),
    moveSelected: (req) => ipcRenderer.invoke('move-selected', req),
    generateFolderMoc: (req) => ipcRenderer.invoke('generate-folder-moc', req),
    // v4.1 MOC作成機能
    getMocTemplates: () => ipcRenderer.invoke('get-moc-templates'),
    saveMocTemplate: (tpl) => ipcRenderer.invoke('save-moc-template', tpl),
    deleteMocTemplate: (id) => ipcRenderer.invoke('delete-moc-template', id),
    createMocFromTemplate: (params) => ipcRenderer.invoke('create-moc-from-template', params),
    previewMoc: (params) => ipcRenderer.invoke('preview-moc', params),
    getVaultFolders: () => ipcRenderer.invoke('get-vault-folders'),
    getExistingMocs: () => ipcRenderer.invoke('get-existing-mocs'),
    // v4.2 MOC強化機能
    analyzeVaultForMoc: (params) => ipcRenderer.invoke('analyze-vault-for-moc', params),
    refreshMoc: (params) => ipcRenderer.invoke('refresh-moc', params),
    batchGenerateMocs: (params) => ipcRenderer.invoke('batch-generate-mocs', params),
    getMocGraph: () => ipcRenderer.invoke('get-moc-graph'),
    suggestTagMocs: () => ipcRenderer.invoke('suggest-tag-mocs'),
    // スキャンキャンセル
    cancelScan: () => ipcRenderer.invoke('cancel-scan'),
    // 元に戻す
    checkUndo: () => ipcRenderer.invoke('check-undo'),
    undoLastOperation: () => ipcRenderer.invoke('undo-last-operation'),
    // v4.3 新機能
    listBackups: () => ipcRenderer.invoke('list-backups'),
    restoreBackup: (name) => ipcRenderer.invoke('restore-backup', name),
    deleteBackup: (name) => ipcRenderer.invoke('delete-backup', name),
    getLastScan: () => ipcRenderer.invoke('get-last-scan'),
    saveScanSnapshot: (data) => ipcRenderer.invoke('save-scan-snapshot', data),
    readNotePreview: (filePath) => ipcRenderer.invoke('read-note-preview', filePath),
    renameTag: (params) => ipcRenderer.invoke('rename-tag', params),
    // Feature A/E/F
    analyzeKnowledgeGraph: () => ipcRenderer.invoke('analyze-knowledge-graph'),
    suggestArchives: () => ipcRenderer.invoke('suggest-archives'),
    previewMerge: (params) => ipcRenderer.invoke('preview-merge', params),
    executeMerge: (params) => ipcRenderer.invoke('execute-merge', params),
    // Feature B/D/G
    getWritingAnalytics: () => ipcRenderer.invoke('get-writing-analytics'),
    startVaultWatch: () => ipcRenderer.invoke('start-vault-watch'),
    stopVaultWatch: () => ipcRenderer.invoke('stop-vault-watch'),
    onVaultWatchEvent: (cb) => { ipcRenderer.removeAllListeners('vault-watch-event'); ipcRenderer.on('vault-watch-event', (_, d) => cb(d)); },
    getVaultTimeline: (dateStr) => ipcRenderer.invoke('get-vault-timeline', dateStr),
    // Feature C/H/I/J
    getStructureTemplates: () => ipcRenderer.invoke('get-structure-templates'),
    analyzeVaultStructure: () => ipcRenderer.invoke('analyze-vault-structure'),
    applyStructureTemplate: (params) => ipcRenderer.invoke('apply-structure-template', params),
    getFullGraph: () => ipcRenderer.invoke('get-full-graph'),
    getAppLanguage: () => ipcRenderer.invoke('get-app-language'),
    setAppLanguage: (lang) => ipcRenderer.invoke('set-app-language', lang),
    generateOptimizerReportNote: () => ipcRenderer.invoke('generate-optimizer-report-note'),
    // Feature 3: Vault ヘルスレポート PDF/MD 出力
    exportHealthReport: () => ipcRenderer.invoke('export-health-report'),
    // Feature 9: ノートインポーター (Notion / Evernote / Bear)
    importNotes: (params) => ipcRenderer.invoke('import-notes', params),
    selectImportPath: (opts) => ipcRenderer.invoke('select-import-path', opts),
    // Feature 11: MOC テンプレート共有
    exportMocTemplate: (id) => ipcRenderer.invoke('export-moc-template', id),
    importMocTemplate: () => ipcRenderer.invoke('import-moc-template'),
    // Feature 4: ノートスコア
    getNoteScores: () => ipcRenderer.invoke('get-note-scores'),
    // Feature 5: Vault履歴（タイムトラベル）
    saveVaultSnapshot: (snapshot) => ipcRenderer.invoke('save-vault-snapshot', snapshot),
    getVaultHistory: () => ipcRenderer.invoke('get-vault-history'),
    // Feature 8: ゲーミフィケーション
    getAchievements: () => ipcRenderer.invoke('get-achievements'),
    updateAchievementProgress: (updates) => ipcRenderer.invoke('update-achievement-progress', updates),
    // Feature 10: スケジュール自動スキャン
    setAutoScanSchedule: (schedule) => ipcRenderer.invoke('set-auto-scan-schedule', schedule),
    // 整理ツール機能
    scanTitleMismatches: () => ipcRenderer.invoke('scan-title-mismatches'),
    suggestNoteTitle: (filePath) => ipcRenderer.invoke('suggest-note-title', filePath),
    renameNote: (params) => ipcRenderer.invoke('rename-note', params),
    scanFrontmatter: () => ipcRenderer.invoke('scan-frontmatter'),
    fixFrontmatter: (params) => ipcRenderer.invoke('fix-frontmatter', params),
    suggestFolderMoves: () => ipcRenderer.invoke('suggest-folder-moves'),
    moveNoteToFolder: (params) => ipcRenderer.invoke('move-note-to-folder', params),
    findSplittableNotes: () => ipcRenderer.invoke('find-splittable-notes'),
    findEmptyFolders: () => ipcRenderer.invoke('find-empty-folders'),
    deleteEmptyFolders: (paths) => ipcRenderer.invoke('delete-empty-folders', paths),
    extractDailyTodos: () => ipcRenderer.invoke('extract-daily-todos'),
    findInconsistentLinks: () => ipcRenderer.invoke('find-inconsistent-links'),
    normalizeLinks: (items) => ipcRenderer.invoke('normalize-links', items),
    // Obsidianダッシュボード生成
    generateObsidianDashboard: (params) => ipcRenderer.invoke('generate-obsidian-dashboard', params),
    // AI統合機能
    saveAiConfig: (params) => ipcRenderer.invoke('save-ai-config', params),
    testAiConnection: () => ipcRenderer.invoke('test-ai-connection'),
    aiSummarizeNote: (filePath) => ipcRenderer.invoke('ai-summarize-note', filePath),
    aiSuggestTags: (filePath) => ipcRenderer.invoke('ai-suggest-tags', filePath),
    aiFindDuplicates: () => ipcRenderer.invoke('ai-find-duplicates'),
    aiSuggestLinks: (filePath) => ipcRenderer.invoke('ai-suggest-links', filePath),
});
