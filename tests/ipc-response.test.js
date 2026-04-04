import { describe, it, expect, vi } from 'vitest';
import { ok, fail, withErrorHandling } from '../src/utils/ipc-response.js';

describe('ok', () => {
    it('success:trueを含むオブジェクトを返す', () => {
        expect(ok()).toEqual({ success: true });
    });

    it('追加データをマージして返す', () => {
        expect(ok({ count: 5 })).toEqual({ success: true, count: 5 });
    });
});

describe('fail', () => {
    it('success:falseとエラーメッセージを返す', () => {
        const result = fail(new Error('テストエラー'));
        expect(result.success).toBe(false);
        expect(result.error).toBe('テストエラー');
    });

    it('文字列エラーも処理できる', () => {
        const result = fail('Vaultが見つかりません');
        expect(result.success).toBe(false);
        expect(result.error).toBe('Vaultが見つかりません');
    });
});

describe('withErrorHandling', () => {
    it('正常なハンドラはそのまま結果を返す', async () => {
        const handler = withErrorHandling('test-channel', async () => ok({ data: 42 }));
        const result = await handler(null);
        expect(result).toEqual({ success: true, data: 42 });
    });

    it('例外が発生した場合は fail レスポンスを返す', async () => {
        const handler = withErrorHandling('test-channel', async () => {
            throw new Error('予期せぬエラー');
        });
        const result = await handler(null);
        expect(result.success).toBe(false);
        expect(result.error).toBe('予期せぬエラー');
    });

    it('引数をハンドラに正しく渡す', async () => {
        const handler = withErrorHandling('test-channel', async (_, arg1, arg2) => {
            return ok({ sum: arg1 + arg2 });
        });
        const result = await handler(null, 3, 4);
        expect(result).toEqual({ success: true, sum: 7 });
    });
});
