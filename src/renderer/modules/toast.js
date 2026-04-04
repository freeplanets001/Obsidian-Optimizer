/**
 * トースト通知モジュール
 * renderer.js から抽出した汎用トースト表示関数
 *
 * 使い方:
 *   import { showToast } from './modules/toast.js';
 *   showToast('保存しました', 'success');
 */

/**
 * @param {string} msg - 表示メッセージ
 * @param {'success'|'error'|'info'|'warning'} [type='info']
 * @param {number} [duration=3000] - 表示時間(ms)
 */
export function showToast(msg, type = 'info', duration = 3000) {
    const existing = document.getElementById('global-toast');
    if (existing) existing.remove();

    const iconMap = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const colorMap = {
        success: 'rgba(34,197,94,.15)',
        error:   'rgba(239,68,68,.15)',
        info:    'rgba(99,102,241,.15)',
        warning: 'rgba(234,179,8,.15)',
    };

    const toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px', 'z-index:9999',
        'padding:12px 18px', 'border-radius:10px',
        `background:${colorMap[type] || colorMap.info}`,
        'backdrop-filter:blur(12px)', 'border:1px solid rgba(255,255,255,.1)',
        'color:#fff', 'font-size:.88rem', 'max-width:360px',
        'display:flex', 'align-items:center', 'gap:8px',
        'box-shadow:0 4px 20px rgba(0,0,0,.3)',
        'animation:fadeInUp .25s ease',
    ].join(';');

    const icon = document.createElement('span');
    icon.textContent = iconMap[type] || 'ℹ️';
    const text = document.createElement('span');
    text.textContent = msg;

    toast.appendChild(icon);
    toast.appendChild(text);
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity .3s';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}
