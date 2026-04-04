# ライセンスキー認証ロジック — 汎用リファレンス

## アーキテクチャ概要

```
┌─────────────────────────────────────────────────┐
│  キー形式:  PREFIX-XXXX-XXXX-XXXX-CCCC          │
│             ─────────────────────  ────          │
│             ランダム部（prefix）    チェックサム  │
│                                                  │
│  検証: HMAC-SHA256(prefix, SECRET) → 先頭4文字   │
│        == チェックサム なら有効                    │
└─────────────────────────────────────────────────┘
```

## 構成要素

| 要素 | 値（Obsidian Optimizer の場合） | 汎用化するとき |
|------|------|------|
| プレフィックス識別子 | `OPT` | アプリ固有の3文字に変更（例: `MYA`） |
| ランダム部 | 3ブロック × 4文字（A-Z, 0-9） | ブロック数・文字数は調整可 |
| チェックサム | HMAC-SHA256 の先頭4文字 | 桁数を増やすと衝突率が下がる |
| シークレット | `ObsidianOptimizer2026CraftLab` | **アプリごとに必ず変更** |
| 保存先 | `~/.obsidian-optimizer-config.json` | 任意の設定ファイル |

---

## 1. キー生成（開発者側）

```javascript
const crypto = require('crypto');

// ========== ここを自分のアプリ用に変更 ==========
const PREFIX = 'OPT';                              // アプリ識別子
const SECRET = 'ObsidianOptimizer2026CraftLab';    // HMAC シークレット
// ================================================

function generateLicenseKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    // ① ランダムな prefix を生成: OPT-XXXX-XXXX-XXXX
    let prefix = PREFIX;
    for (let i = 0; i < 3; i++) {
        prefix += '-';
        for (let j = 0; j < 4; j++) {
            prefix += chars[crypto.randomInt(chars.length)];
        }
    }

    // ② prefix から HMAC-SHA256 → 先頭4文字をチェックサムに
    const checksum = crypto.createHmac('sha256', SECRET)
        .update(prefix)
        .digest('hex')
        .slice(0, 4)
        .toUpperCase();

    // ③ 結合: OPT-XXXX-XXXX-XXXX-CCCC
    return prefix + '-' + checksum;
}
```

---

## 2. キー検証（アプリ側）

```javascript
function generateLicenseHash(key) {
    return crypto.createHmac('sha256', SECRET)
        .update(key)
        .digest('hex')
        .slice(0, 16);
}

function isValidLicenseKey(key) {
    if (!key) return false;

    // ① 正規表現でフォーマットチェック
    const pattern = new RegExp(
        `^${PREFIX}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$`
    );
    if (!pattern.test(key)) return false;

    // ② キーを分割
    const prefix   = key.slice(0, -5);  // OPT-XXXX-XXXX-XXXX
    const checksum = key.slice(-4);     // 末尾4文字

    // ③ prefix から再計算したハッシュと比較
    const expected = generateLicenseHash(prefix)
        .slice(0, 4)
        .toUpperCase();

    return checksum === expected;
}
```

---

## 3. IPC ハンドラ（Electron の場合）

```javascript
// 認証
ipcMain.handle('verify-license', (_, key) => {
    const normalized = key.trim().toUpperCase();
    if (!isValidLicenseKey(normalized)) {
        return { success: false, error: 'ライセンスキーが無効です' };
    }
    config.licenseKey = normalized;
    saveConfig(config);
    return { success: true, key: normalized };
});

// 状態取得（UIにマスク表示）
ipcMain.handle('get-license-status', () => {
    const key = config.licenseKey || '';
    const isLicensed = isValidLicenseKey(key);
    const maskedKey = isLicensed
        ? key.slice(0, 8) + '-****-****'
        : '';
    return { isLicensed, maskedKey };
});
```

---

## 4. キー一括生成スクリプト（CLI）

```bash
node scripts/generate-license-keys.js          # 1個
node scripts/generate-license-keys.js 10       # 10個
node scripts/generate-license-keys.js 50 csv   # 50個 → CSV出力
```

CSV出力例:

```
No,ライセンスキー,発行日,状態
1,OPT-JE23-TM4C-4KIX-1878,2026-03-28,未使用
```

---

## 他ツールに流用する手順

1. **`PREFIX`** を変更（例: `MYA`, `TLS`）
2. **`SECRET`** を新しいランダム文字列に変更（**最重要**）
3. 正規表現パターンをプレフィックスに合わせて更新
4. 保存先の設定ファイルパスを変更

---

## 注意点

| 項目 | 内容 |
|------|------|
| **オフライン検証** | サーバー不要。SECRET を知っていれば誰でも生成可能なので、クライアントコードの難読化を推奨 |
| **衝突率** | チェックサム4文字(16進) = 65,536通り。総当たりで約0.0015%の確率で偽のキーが通る |
| **強化案** | チェックサムを6〜8文字に増やす / サーバー検証を併用する / キーに有効期限を埋め込む |
| **SECRET漏洩** | ソースコードに埋め込まれているため、asar展開で読める。Proプランではサーバー検証を検討 |
