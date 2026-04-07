import Anthropic from '@anthropic-ai/sdk';
import { retrieveContext } from '../lib/knowledge-base.js';

const SYSTEM_PROMPT = `あなたは「Obsidian Optimizer」というデスクトップアプリの公式サポートチャットボットです。

【重要なルール】
1. 必ず提供された「参考情報」に書かれている内容のみに基づいて回答してください
2. 参考情報に記載がない質問には「その点については正確な情報を持っていません。LINEオープンチャット（ObsidianOptimizerオプチャ）にてお気軽にご質問ください！」と答えてください
3. 推測・想像・憶測で回答しないでください
4. 回答は簡潔・明確に、できるだけ箇条書きで分かりやすくまとめてください
5. 日本語で回答してください
6. 購入・ライセンスキー取得の方法を聞かれたら「noteの記事を購入後、noteのDMにてライセンスキーをお送りします」と案内してください`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req, res) {
  // CORS preflight
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, history = [] } = req.body ?? {};

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: '質問を入力してください' });
    }
    if (question.length > 500) {
      return res.status(400).json({ error: '質問が長すぎます（500文字以内）' });
    }

    // RAG: 関連チャンクを取得
    const context = retrieveContext(question.trim(), 4);

    // 会話履歴（最新5ターンまで）
    const recentHistory = (Array.isArray(history) ? history : []).slice(-10);
    const messages = [
      ...recentHistory.map(h => ({ role: h.role, content: String(h.content) })),
      {
        role: 'user',
        content: `【参考情報】\n${context}\n\n【質問】\n${question.trim()}`,
      },
    ];

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages,
    });

    const answer = response.content[0]?.text ?? '回答を生成できませんでした。';
    return res.status(200).json({ answer });

  } catch (err) {
    console.error('[chat API error]', err);
    return res.status(500).json({ error: 'エラーが発生しました。しばらくしてから再度お試しください。' });
  }
}
