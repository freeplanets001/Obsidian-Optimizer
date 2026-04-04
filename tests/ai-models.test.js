import { describe, it, expect } from 'vitest';
import { AI_MODELS, AI_COST_RATES, getDefaultModel, getCostRate, isValidModel } from '../src/config/ai-models.js';

describe('AI_MODELS', () => {
    it('claude, openai, gemini の3プロバイダーが定義されている', () => {
        expect(Object.keys(AI_MODELS)).toEqual(['claude', 'openai', 'gemini']);
    });

    it('各プロバイダーに最低1モデルが存在する', () => {
        for (const [provider, models] of Object.entries(AI_MODELS)) {
            expect(models.length, `${provider} のモデルが空`).toBeGreaterThan(0);
        }
    });
});

describe('AI_COST_RATES', () => {
    it('全モデルにコストレートが定義されている', () => {
        for (const provider of Object.values(AI_MODELS)) {
            for (const model of provider) {
                expect(AI_COST_RATES[model], `${model} のコストレートが未定義`).toBeDefined();
            }
        }
    });

    it('コストレートは [input, output] の数値ペア', () => {
        for (const [model, rate] of Object.entries(AI_COST_RATES)) {
            expect(Array.isArray(rate), `${model}: 配列でない`).toBe(true);
            expect(rate.length, `${model}: 要素数が2でない`).toBe(2);
            expect(typeof rate[0], `${model}: inputが数値でない`).toBe('number');
            expect(typeof rate[1], `${model}: outputが数値でない`).toBe('number');
        }
    });
});

describe('getDefaultModel', () => {
    it('存在するプロバイダーのデフォルトモデルを返す', () => {
        expect(getDefaultModel('claude')).toBe('claude-opus-4-6');
        expect(getDefaultModel('openai')).toBe('gpt-5.4');
        expect(getDefaultModel('gemini')).toBe('gemini-2.5-flash');
    });

    it('存在しないプロバイダーは空文字列を返す', () => {
        expect(getDefaultModel('unknown')).toBe('');
    });
});

describe('getCostRate', () => {
    it('既知モデルのレートを返す', () => {
        const rate = getCostRate('claude-sonnet-4-6');
        expect(rate).toEqual([3, 15]);
    });

    it('未知モデルはSonnetレートをフォールバックで返す', () => {
        const rate = getCostRate('unknown-model-xyz');
        expect(rate).toEqual([3, 15]);
    });
});

describe('isValidModel', () => {
    it('存在するモデルはtrueを返す', () => {
        expect(isValidModel('claude', 'claude-sonnet-4-6')).toBe(true);
    });

    it('存在しないモデルはfalseを返す', () => {
        expect(isValidModel('claude', 'gpt-5.4')).toBe(false);
    });

    it('存在しないプロバイダーはfalseを返す', () => {
        expect(isValidModel('unknown', 'claude-sonnet-4-6')).toBe(false);
    });
});
