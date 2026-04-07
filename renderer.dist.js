var RendererModules = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/renderer/main.js
  var main_exports = {};
  __export(main_exports, {
    AI_COST_STORAGE_KEY: () => AI_COST_STORAGE_KEY,
    JPY_RATE: () => JPY_RATE,
    getAiCostHistory: () => getAiCostHistory,
    renderAiCostDisplay: () => renderAiCostDisplay,
    saveAiCostEntry: () => saveAiCostEntry,
    showToast: () => showToast
  });

  // src/renderer/modules/ai-cost.js
  var AI_COST_STORAGE_KEY = "obsidian-optimizer-ai-cost-history";
  var JPY_RATE = 150;
  function getAiCostHistory() {
    try {
      const raw = localStorage.getItem(AI_COST_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }
  function saveAiCostEntry(feature, model, inputTokensEstimate, outputTokensEstimate, pricingTable) {
    const history = getAiCostHistory();
    const pricing = pricingTable && pricingTable[model] || { input: 1, output: 5 };
    const costUsd = inputTokensEstimate / 1e6 * pricing.input + outputTokensEstimate / 1e6 * pricing.output;
    const costJpy = Math.round(costUsd * JPY_RATE * 100) / 100;
    history.push({
      date: (/* @__PURE__ */ new Date()).toISOString(),
      feature,
      model,
      inputTokens: inputTokensEstimate,
      outputTokens: outputTokensEstimate,
      costUsd: Math.round(costUsd * 1e4) / 1e4,
      costJpy
    });
    if (history.length > 1e3) history.splice(0, history.length - 1e3);
    localStorage.setItem(AI_COST_STORAGE_KEY, JSON.stringify(history));
  }
  async function renderAiCostDisplay(pricingTable) {
    const $ = (id) => document.getElementById(id);
    const esc = (str) => str ? String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") : "";
    const container = $("ai-cost-display");
    if (!container) return;
    let usage;
    try {
      const res = await window.api.getAiUsage();
      if (!res.success || !res.usage) {
        container.innerHTML = '<p class="muted-hint">AI\u5229\u7528\u30C7\u30FC\u30BF\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F</p>';
        return;
      }
      usage = res.usage;
    } catch (e) {
      container.innerHTML = `<p class="muted-hint">\u30A8\u30E9\u30FC: ${esc(e.message)}</p>`;
      return;
    }
    const history = usage.history || [];
    const now = /* @__PURE__ */ new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthEntries = history.filter((h) => h.date?.startsWith(thisMonth));
    const totalCalls = monthEntries.length;
    const totalCostJpy = monthEntries.reduce((sum, h) => sum + (h.cost || 0) * JPY_RATE, 0);
    const featureCosts = {};
    monthEntries.forEach((h) => {
      const key = h.feature || "\u4E0D\u660E";
      featureCosts[key] = (featureCosts[key] || 0) + (h.cost || 0) * JPY_RATE;
    });
    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px">';
    html += `<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center"><div style="font-size:1.2rem;font-weight:700">${totalCalls}</div><div style="font-size:.72rem;opacity:.5">\u4ECA\u6708\u306EAPI\u547C\u3073\u51FA\u3057</div></div>`;
    html += `<div style="padding:12px;border-radius:10px;background:rgba(255,255,255,.04);text-align:center"><div style="font-size:1.2rem;font-weight:700">\xA5${Math.round(totalCostJpy)}</div><div style="font-size:.72rem;opacity:.5">\u4ECA\u6708\u306E\u63A8\u5B9A\u30B3\u30B9\u30C8</div></div>`;
    html += "</div>";
    if (Object.keys(featureCosts).length > 0) {
      html += '<div style="margin-bottom:12px"><strong style="font-size:.82rem">\u6A5F\u80FD\u5225\u30B3\u30B9\u30C8\u5185\u8A33</strong>';
      const sorted = Object.entries(featureCosts).sort((a, b) => b[1] - a[1]);
      const maxCost = sorted[0]?.[1] || 1;
      sorted.forEach(([name, cost]) => {
        const pct = Math.round(cost / maxCost * 100);
        html += `<div style="display:flex;align-items:center;gap:8px;margin-top:6px"><span style="font-size:.78rem;min-width:100px">${esc(name)}</span><div style="flex:1;height:8px;background:rgba(255,255,255,.06);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:var(--accent);border-radius:4px"></div></div><span style="font-size:.72rem;opacity:.6">\xA5${Math.round(cost)}</span></div>`;
      });
      html += "</div>";
    }
    const last10 = history.slice(-10).reverse();
    if (last10.length > 0) {
      html += '<div style="margin-bottom:12px"><strong style="font-size:.82rem">\u76F4\u8FD1\u306EAPI\u547C\u3073\u51FA\u3057</strong><div style="margin-top:6px;max-height:200px;overflow:auto">';
      last10.forEach((h) => {
        const d = new Date(h.date);
        const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
        html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:.75rem;border-bottom:1px solid rgba(255,255,255,.04)"><span style="opacity:.5;min-width:70px">${dateStr}</span><span style="flex:1">${esc(h.feature)}</span><span style="opacity:.5">${esc(h.model || "")}</span><span style="min-width:50px;text-align:right">\xA5${((h.cost || 0) * JPY_RATE).toFixed(2)}</span></div>`;
      });
      html += "</div></div>";
    }
    if (pricingTable) {
      html += '<details style="margin-top:8px"><summary style="font-size:.78rem;cursor:pointer;opacity:.6">\u{1F4B0} \u30D7\u30ED\u30D0\u30A4\u30C0\u30FC\u6599\u91D1\u4E00\u89A7\uFF081M\u30C8\u30FC\u30AF\u30F3\u3042\u305F\u308A\uFF09</summary><div style="margin-top:8px;overflow-x:auto"><table style="width:100%;font-size:.72rem;border-collapse:collapse"><tr style="border-bottom:1px solid rgba(255,255,255,.1)"><th style="text-align:left;padding:4px">\u30E2\u30C7\u30EB</th><th style="text-align:right;padding:4px">\u5165\u529B($)</th><th style="text-align:right;padding:4px">\u51FA\u529B($)</th><th style="text-align:right;padding:4px">\u5165\u529B(\xA5)</th><th style="text-align:right;padding:4px">\u51FA\u529B(\xA5)</th></tr>';
      Object.entries(pricingTable).forEach(([model, rate]) => {
        html += `<tr style="border-bottom:1px solid rgba(255,255,255,.04)"><td style="padding:3px 4px">${esc(model)}</td><td style="text-align:right;padding:3px 4px">$${rate.input}</td><td style="text-align:right;padding:3px 4px">$${rate.output}</td><td style="text-align:right;padding:3px 4px">\xA5${Math.round(rate.input * JPY_RATE)}</td><td style="text-align:right;padding:3px 4px">\xA5${Math.round(rate.output * JPY_RATE)}</td></tr>`;
      });
      html += "</table></div></details>";
    }
    container.innerHTML = html;
  }

  // src/renderer/modules/toast.js
  function showToast(msg, type = "info", duration = 3e3) {
    const existing = document.getElementById("global-toast");
    if (existing) existing.remove();
    const iconMap = { success: "\u2705", error: "\u274C", info: "\u2139\uFE0F", warning: "\u26A0\uFE0F" };
    const colorMap = {
      success: "rgba(34,197,94,.15)",
      error: "rgba(239,68,68,.15)",
      info: "rgba(99,102,241,.15)",
      warning: "rgba(234,179,8,.15)"
    };
    const toast = document.createElement("div");
    toast.id = "global-toast";
    toast.style.cssText = [
      "position:fixed",
      "bottom:24px",
      "right:24px",
      "z-index:9999",
      "padding:12px 18px",
      "border-radius:10px",
      `background:${colorMap[type] || colorMap.info}`,
      "backdrop-filter:blur(12px)",
      "border:1px solid rgba(255,255,255,.1)",
      "color:#fff",
      "font-size:.88rem",
      "max-width:360px",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "box-shadow:0 4px 20px rgba(0,0,0,.3)",
      "animation:fadeInUp .25s ease"
    ].join(";");
    const icon = document.createElement("span");
    icon.textContent = iconMap[type] || "\u2139\uFE0F";
    const text = document.createElement("span");
    text.textContent = msg;
    toast.appendChild(icon);
    toast.appendChild(text);
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transition = "opacity .3s";
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
  return __toCommonJS(main_exports);
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL3JlbmRlcmVyL21haW4uanMiLCAic3JjL3JlbmRlcmVyL21vZHVsZXMvYWktY29zdC5qcyIsICJzcmMvcmVuZGVyZXIvbW9kdWxlcy90b2FzdC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBzcmMvcmVuZGVyZXIvbWFpbi5qcyBcdTIwMTQgcmVuZGVyZXIuanMgXHU3OUZCXHU4ODRDXHUzMEE4XHUzMEYzXHUzMEM4XHUzMEVBXHUzMEREXHUzMEE0XHUzMEYzXHUzMEM4XG4gKlxuICogXHU2QkI1XHU5NjhFXHU3OUZCXHU4ODRDXHU2MjI2XHU3NTY1OlxuICogICAxLiBcdTY1QjBcdTZBNUZcdTgwRkRcdTMwNkZcdTVGQzVcdTMwNUFcdTMwNTNcdTMwNTNcdTMwNkIgaW1wb3J0IFx1MzA1N1x1MzA2Nlx1OEZGRFx1NTJBMFx1MzA1OVx1MzA4QlxuICogICAyLiByZW5kZXJlci5qcyBcdTMwNkVcdTY1RTJcdTVCNThcdTMwQjNcdTMwRkNcdTMwQzlcdTMwNkZcdTZBNUZcdTgwRkRcdTUzNThcdTRGNERcdTMwNjdcdTk4MDZcdTZCMjFcdTMwNTNcdTMwNjFcdTMwODlcdTMwNkJcdTc5RkJcdTY5MERcdTMwNTlcdTMwOEJcbiAqICAgMy4gXHU3OUZCXHU2OTBEXHU1QjhDXHU0RTg2XHUzMDU3XHUzMDVGXHU2QTVGXHU4MEZEXHUzMDZGIHJlbmRlcmVyLmpzIFx1MzA0Qlx1MzA4OVx1NTI0QVx1OTY2NFx1MzA1OVx1MzA4QlxuICogICA0LiBcdTY3MDBcdTdENDJcdTc2ODRcdTMwNkIgcmVuZGVyZXIuanMgXHUzMDZFXHU1MTY4XHU1MTg1XHU1QkI5XHUzMDkyXHUzMDUzXHUzMDUzXHUzMDZCXHU1M0Q2XHUzMDhBXHU4RkJDXHUzMDdGXHUzMDAxcmVuZGVyZXIuanMgXHUzMDkyXHU1RUMzXHU2QjYyXHUzMDU5XHUzMDhCXG4gKlxuICogXHUzMEQzXHUzMEVCXHUzMEM5XHU2NUI5XHU2Q0Q1OlxuICogICBucG0gcnVuIGJ1aWxkOnJlbmRlcmVyICAgICAgICAjIFx1NjcyQ1x1NzU2QVxuICogICBucG0gcnVuIGJ1aWxkOnJlbmRlcmVyOmRldiAgICAjIFx1OTU4Qlx1NzY3QSAoc291cmNlbWFwIFx1NEVEOFx1MzA0RClcbiAqXG4gKiBcdTUxRkFcdTUyOUI6IHJlbmRlcmVyLmRpc3QuanNcbiAqIGluZGV4Lmh0bWwgXHUzMDY3XHUzMDZFXHU0RjdGXHU3NTI4OiA8c2NyaXB0IHNyYz1cInJlbmRlcmVyLmRpc3QuanNcIj48L3NjcmlwdD5cbiAqL1xuXG4vLyAtLS0tIFx1NzlGQlx1ODg0Q1x1NkUwOFx1MzA3Rlx1MzBFMlx1MzBCOFx1MzBFNVx1MzBGQ1x1MzBFQiAtLS0tXG5leHBvcnQgKiBmcm9tICcuL21vZHVsZXMvYWktY29zdC5qcyc7XG5leHBvcnQgKiBmcm9tICcuL21vZHVsZXMvdG9hc3QuanMnO1xuIiwgIi8qKlxuICogQUlcdTMwQjNcdTMwQjlcdTMwQzhcdTg4NjhcdTc5M0FcdTMwRTJcdTMwQjhcdTMwRTVcdTMwRkNcdTMwRUJcbiAqIHJlbmRlcmVyLmpzIFx1MzA2RSBGZWF0dXJlIDE1IFx1MzA0Qlx1MzA4OVx1NzlGQlx1NjkwRFxuICpcbiAqIFx1NEY5RFx1NUI1ODpcbiAqICAgLSB3aW5kb3cuYXBpLmdldEFpVXNhZ2UoKSAocHJlbG9hZC5qc1x1N0Q0Q1x1NzUzMSlcbiAqICAgLSBlc2MoKSAvICQoKSAocmVuZGVyZXIuanMgXHUzMDZFXHUzMEIwXHUzMEVEXHUzMEZDXHUzMEQwXHUzMEVCXHU5NUEyXHU2NTcwKVxuICogICAtIEFJX1BSSUNJTkdfUEVSXzFNIChyZW5kZXJlci5qcyBcdTMwNkVcdTMwQjBcdTMwRURcdTMwRkNcdTMwRDBcdTMwRUJcdTU5MDlcdTY1NzApXG4gKlxuICogVE9ETzogXHU3OUZCXHU4ODRDXHU1QjhDXHU0RTg2XHU1RjhDXHUzMDAxcmVuZGVyZXIuanMgXHUzMDZFIEZlYXR1cmUgMTUgXHUzMEJCXHUzMEFGXHUzMEI3XHUzMEU3XHUzMEYzXHUzMDkyXHU1MjRBXHU5NjY0XHUzMDU5XHUzMDhCXG4gKi9cblxuZXhwb3J0IGNvbnN0IEFJX0NPU1RfU1RPUkFHRV9LRVkgPSAnb2JzaWRpYW4tb3B0aW1pemVyLWFpLWNvc3QtaGlzdG9yeSc7XG5leHBvcnQgY29uc3QgSlBZX1JBVEUgPSAxNTA7XG5cbi8qKlxuICogQUlcdTMwQjNcdTMwQjlcdTMwQzhcdTVDNjVcdTZCNzRcdTMwOTJsb2NhbFN0b3JhZ2VcdTMwNEJcdTMwODlcdTUzRDZcdTVGOTdcdTMwNTlcdTMwOEJcbiAqIEByZXR1cm5zIHtBcnJheX1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldEFpQ29zdEhpc3RvcnkoKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmF3ID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oQUlfQ09TVF9TVE9SQUdFX0tFWSk7XG4gICAgICAgIHJldHVybiByYXcgPyBKU09OLnBhcnNlKHJhdykgOiBbXTtcbiAgICB9IGNhdGNoIChfKSB7IHJldHVybiBbXTsgfVxufVxuXG4vKipcbiAqIFx1MzBCM1x1MzBCOVx1MzBDOFx1MzBBOFx1MzBGM1x1MzBDOFx1MzBFQVx1MzA5Mlx1NEZERFx1NUI1OFx1MzA1OVx1MzA4QlxuICogQHBhcmFtIHtzdHJpbmd9IGZlYXR1cmVcbiAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbFxuICogQHBhcmFtIHtudW1iZXJ9IGlucHV0VG9rZW5zRXN0aW1hdGVcbiAqIEBwYXJhbSB7bnVtYmVyfSBvdXRwdXRUb2tlbnNFc3RpbWF0ZVxuICogQHBhcmFtIHtSZWNvcmQ8c3RyaW5nLCB7aW5wdXQ6IG51bWJlciwgb3V0cHV0OiBudW1iZXJ9Pn0gcHJpY2luZ1RhYmxlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzYXZlQWlDb3N0RW50cnkoZmVhdHVyZSwgbW9kZWwsIGlucHV0VG9rZW5zRXN0aW1hdGUsIG91dHB1dFRva2Vuc0VzdGltYXRlLCBwcmljaW5nVGFibGUpIHtcbiAgICBjb25zdCBoaXN0b3J5ID0gZ2V0QWlDb3N0SGlzdG9yeSgpO1xuICAgIGNvbnN0IHByaWNpbmcgPSAocHJpY2luZ1RhYmxlICYmIHByaWNpbmdUYWJsZVttb2RlbF0pIHx8IHsgaW5wdXQ6IDEsIG91dHB1dDogNSB9O1xuICAgIGNvbnN0IGNvc3RVc2QgPSAoaW5wdXRUb2tlbnNFc3RpbWF0ZSAvIDFfMDAwXzAwMCAqIHByaWNpbmcuaW5wdXQpICsgKG91dHB1dFRva2Vuc0VzdGltYXRlIC8gMV8wMDBfMDAwICogcHJpY2luZy5vdXRwdXQpO1xuICAgIGNvbnN0IGNvc3RKcHkgPSBNYXRoLnJvdW5kKGNvc3RVc2QgKiBKUFlfUkFURSAqIDEwMCkgLyAxMDA7XG5cbiAgICBoaXN0b3J5LnB1c2goe1xuICAgICAgICBkYXRlOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIGZlYXR1cmUsXG4gICAgICAgIG1vZGVsLFxuICAgICAgICBpbnB1dFRva2VuczogaW5wdXRUb2tlbnNFc3RpbWF0ZSxcbiAgICAgICAgb3V0cHV0VG9rZW5zOiBvdXRwdXRUb2tlbnNFc3RpbWF0ZSxcbiAgICAgICAgY29zdFVzZDogTWF0aC5yb3VuZChjb3N0VXNkICogMTAwMDApIC8gMTAwMDAsXG4gICAgICAgIGNvc3RKcHksXG4gICAgfSk7XG5cbiAgICBpZiAoaGlzdG9yeS5sZW5ndGggPiAxMDAwKSBoaXN0b3J5LnNwbGljZSgwLCBoaXN0b3J5Lmxlbmd0aCAtIDEwMDApO1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEFJX0NPU1RfU1RPUkFHRV9LRVksIEpTT04uc3RyaW5naWZ5KGhpc3RvcnkpKTtcbn1cblxuLyoqXG4gKiBBSVx1MzBCM1x1MzBCOVx1MzBDOFx1ODg2OFx1NzkzQVx1MzA5Mlx1NjNDRlx1NzUzQlx1MzA1OVx1MzA4QlxuICogQHBhcmFtIHtSZWNvcmQ8c3RyaW5nLCB7aW5wdXQ6IG51bWJlciwgb3V0cHV0OiBudW1iZXJ9Pn0gcHJpY2luZ1RhYmxlIC0gQUlfUFJJQ0lOR19QRVJfMU1cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlckFpQ29zdERpc3BsYXkocHJpY2luZ1RhYmxlKSB7XG4gICAgLy8gRE9NIFx1MzBEOFx1MzBFQlx1MzBEMVx1MzBGQ1x1MzA2Rlx1MzBCMFx1MzBFRFx1MzBGQ1x1MzBEMFx1MzBFQlx1NTNDMlx1NzE2N1x1RkYwOHJlbmRlcmVyLmpzIFx1MzA2OFx1MzA2RVx1NTE3MVx1NUI1OFx1NjcxRlx1OTU5M1x1NEUyRFx1RkYwOVxuICAgIGNvbnN0ICQgPSBpZCA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gICAgY29uc3QgZXNjID0gc3RyID0+IHN0ciA/IFN0cmluZyhzdHIpLnJlcGxhY2UoLyYvZywgJyZhbXA7JykucmVwbGFjZSgvPC9nLCAnJmx0OycpLnJlcGxhY2UoLz4vZywgJyZndDsnKS5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7JykucmVwbGFjZSgvJy9nLCAnJiMzOTsnKSA6ICcnO1xuXG4gICAgY29uc3QgY29udGFpbmVyID0gJCgnYWktY29zdC1kaXNwbGF5Jyk7XG4gICAgaWYgKCFjb250YWluZXIpIHJldHVybjtcblxuICAgIGxldCB1c2FnZTtcbiAgICB0cnkge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCB3aW5kb3cuYXBpLmdldEFpVXNhZ2UoKTtcbiAgICAgICAgaWYgKCFyZXMuc3VjY2VzcyB8fCAhcmVzLnVzYWdlKSB7XG4gICAgICAgICAgICBjb250YWluZXIuaW5uZXJIVE1MID0gJzxwIGNsYXNzPVwibXV0ZWQtaGludFwiPkFJXHU1MjI5XHU3NTI4XHUzMEM3XHUzMEZDXHUzMEJGXHUzMDkyXHU1M0Q2XHU1Rjk3XHUzMDY3XHUzMDREXHUzMDdFXHUzMDVCXHUzMDkzXHUzMDY3XHUzMDU3XHUzMDVGPC9wPic7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdXNhZ2UgPSByZXMudXNhZ2U7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb250YWluZXIuaW5uZXJIVE1MID0gYDxwIGNsYXNzPVwibXV0ZWQtaGludFwiPlx1MzBBOFx1MzBFOVx1MzBGQzogJHtlc2MoZS5tZXNzYWdlKX08L3A+YDtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGhpc3RvcnkgPSB1c2FnZS5oaXN0b3J5IHx8IFtdO1xuICAgIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7XG4gICAgY29uc3QgdGhpc01vbnRoID0gYCR7bm93LmdldEZ1bGxZZWFyKCl9LSR7U3RyaW5nKG5vdy5nZXRNb250aCgpICsgMSkucGFkU3RhcnQoMiwgJzAnKX1gO1xuICAgIGNvbnN0IG1vbnRoRW50cmllcyA9IGhpc3RvcnkuZmlsdGVyKGggPT4gaC5kYXRlPy5zdGFydHNXaXRoKHRoaXNNb250aCkpO1xuICAgIGNvbnN0IHRvdGFsQ2FsbHMgPSBtb250aEVudHJpZXMubGVuZ3RoO1xuICAgIGNvbnN0IHRvdGFsQ29zdEpweSA9IG1vbnRoRW50cmllcy5yZWR1Y2UoKHN1bSwgaCkgPT4gc3VtICsgKChoLmNvc3QgfHwgMCkgKiBKUFlfUkFURSksIDApO1xuXG4gICAgY29uc3QgZmVhdHVyZUNvc3RzID0ge307XG4gICAgbW9udGhFbnRyaWVzLmZvckVhY2goaCA9PiB7XG4gICAgICAgIGNvbnN0IGtleSA9IGguZmVhdHVyZSB8fCAnXHU0RTBEXHU2NjBFJztcbiAgICAgICAgZmVhdHVyZUNvc3RzW2tleV0gPSAoZmVhdHVyZUNvc3RzW2tleV0gfHwgMCkgKyAoKGguY29zdCB8fCAwKSAqIEpQWV9SQVRFKTtcbiAgICB9KTtcblxuICAgIGxldCBodG1sID0gJzxkaXYgc3R5bGU9XCJkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgoMTQwcHgsMWZyKSk7Z2FwOjEycHg7bWFyZ2luLWJvdHRvbToxNnB4XCI+JztcbiAgICBodG1sICs9IGA8ZGl2IHN0eWxlPVwicGFkZGluZzoxMnB4O2JvcmRlci1yYWRpdXM6MTBweDtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjA0KTt0ZXh0LWFsaWduOmNlbnRlclwiPjxkaXYgc3R5bGU9XCJmb250LXNpemU6MS4ycmVtO2ZvbnQtd2VpZ2h0OjcwMFwiPiR7dG90YWxDYWxsc308L2Rpdj48ZGl2IHN0eWxlPVwiZm9udC1zaXplOi43MnJlbTtvcGFjaXR5Oi41XCI+XHU0RUNBXHU2NzA4XHUzMDZFQVBJXHU1NDdDXHUzMDczXHU1MUZBXHUzMDU3PC9kaXY+PC9kaXY+YDtcbiAgICBodG1sICs9IGA8ZGl2IHN0eWxlPVwicGFkZGluZzoxMnB4O2JvcmRlci1yYWRpdXM6MTBweDtiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjA0KTt0ZXh0LWFsaWduOmNlbnRlclwiPjxkaXYgc3R5bGU9XCJmb250LXNpemU6MS4ycmVtO2ZvbnQtd2VpZ2h0OjcwMFwiPlx1MDBBNSR7TWF0aC5yb3VuZCh0b3RhbENvc3RKcHkpfTwvZGl2PjxkaXYgc3R5bGU9XCJmb250LXNpemU6LjcycmVtO29wYWNpdHk6LjVcIj5cdTRFQ0FcdTY3MDhcdTMwNkVcdTYzQThcdTVCOUFcdTMwQjNcdTMwQjlcdTMwQzg8L2Rpdj48L2Rpdj5gO1xuICAgIGh0bWwgKz0gJzwvZGl2Pic7XG5cbiAgICBpZiAoT2JqZWN0LmtleXMoZmVhdHVyZUNvc3RzKS5sZW5ndGggPiAwKSB7XG4gICAgICAgIGh0bWwgKz0gJzxkaXYgc3R5bGU9XCJtYXJnaW4tYm90dG9tOjEycHhcIj48c3Ryb25nIHN0eWxlPVwiZm9udC1zaXplOi44MnJlbVwiPlx1NkE1Rlx1ODBGRFx1NTIyNVx1MzBCM1x1MzBCOVx1MzBDOFx1NTE4NVx1OEEzMzwvc3Ryb25nPic7XG4gICAgICAgIGNvbnN0IHNvcnRlZCA9IE9iamVjdC5lbnRyaWVzKGZlYXR1cmVDb3N0cykuc29ydCgoYSwgYikgPT4gYlsxXSAtIGFbMV0pO1xuICAgICAgICBjb25zdCBtYXhDb3N0ID0gc29ydGVkWzBdPy5bMV0gfHwgMTtcbiAgICAgICAgc29ydGVkLmZvckVhY2goKFtuYW1lLCBjb3N0XSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcGN0ID0gTWF0aC5yb3VuZChjb3N0IC8gbWF4Q29zdCAqIDEwMCk7XG4gICAgICAgICAgICBodG1sICs9IGA8ZGl2IHN0eWxlPVwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O21hcmdpbi10b3A6NnB4XCI+PHNwYW4gc3R5bGU9XCJmb250LXNpemU6Ljc4cmVtO21pbi13aWR0aDoxMDBweFwiPiR7ZXNjKG5hbWUpfTwvc3Bhbj48ZGl2IHN0eWxlPVwiZmxleDoxO2hlaWdodDo4cHg7YmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4wNik7Ym9yZGVyLXJhZGl1czo0cHg7b3ZlcmZsb3c6aGlkZGVuXCI+PGRpdiBzdHlsZT1cImhlaWdodDoxMDAlO3dpZHRoOiR7cGN0fSU7YmFja2dyb3VuZDp2YXIoLS1hY2NlbnQpO2JvcmRlci1yYWRpdXM6NHB4XCI+PC9kaXY+PC9kaXY+PHNwYW4gc3R5bGU9XCJmb250LXNpemU6LjcycmVtO29wYWNpdHk6LjZcIj5cdTAwQTUke01hdGgucm91bmQoY29zdCl9PC9zcGFuPjwvZGl2PmA7XG4gICAgICAgIH0pO1xuICAgICAgICBodG1sICs9ICc8L2Rpdj4nO1xuICAgIH1cblxuICAgIGNvbnN0IGxhc3QxMCA9IGhpc3Rvcnkuc2xpY2UoLTEwKS5yZXZlcnNlKCk7XG4gICAgaWYgKGxhc3QxMC5sZW5ndGggPiAwKSB7XG4gICAgICAgIGh0bWwgKz0gJzxkaXYgc3R5bGU9XCJtYXJnaW4tYm90dG9tOjEycHhcIj48c3Ryb25nIHN0eWxlPVwiZm9udC1zaXplOi44MnJlbVwiPlx1NzZGNFx1OEZEMVx1MzA2RUFQSVx1NTQ3Q1x1MzA3M1x1NTFGQVx1MzA1Nzwvc3Ryb25nPjxkaXYgc3R5bGU9XCJtYXJnaW4tdG9wOjZweDttYXgtaGVpZ2h0OjIwMHB4O292ZXJmbG93OmF1dG9cIj4nO1xuICAgICAgICBsYXN0MTAuZm9yRWFjaChoID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGQgPSBuZXcgRGF0ZShoLmRhdGUpO1xuICAgICAgICAgICAgY29uc3QgZGF0ZVN0ciA9IGAke2QuZ2V0TW9udGgoKSArIDF9LyR7ZC5nZXREYXRlKCl9ICR7ZC5nZXRIb3VycygpfToke1N0cmluZyhkLmdldE1pbnV0ZXMoKSkucGFkU3RhcnQoMiwgJzAnKX1gO1xuICAgICAgICAgICAgaHRtbCArPSBgPGRpdiBzdHlsZT1cImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjZweDtwYWRkaW5nOjRweCAwO2ZvbnQtc2l6ZTouNzVyZW07Ym9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMDQpXCI+PHNwYW4gc3R5bGU9XCJvcGFjaXR5Oi41O21pbi13aWR0aDo3MHB4XCI+JHtkYXRlU3RyfTwvc3Bhbj48c3BhbiBzdHlsZT1cImZsZXg6MVwiPiR7ZXNjKGguZmVhdHVyZSl9PC9zcGFuPjxzcGFuIHN0eWxlPVwib3BhY2l0eTouNVwiPiR7ZXNjKGgubW9kZWwgfHwgJycpfTwvc3Bhbj48c3BhbiBzdHlsZT1cIm1pbi13aWR0aDo1MHB4O3RleHQtYWxpZ246cmlnaHRcIj5cdTAwQTUkeygoaC5jb3N0IHx8IDApICogSlBZX1JBVEUpLnRvRml4ZWQoMil9PC9zcGFuPjwvZGl2PmA7XG4gICAgICAgIH0pO1xuICAgICAgICBodG1sICs9ICc8L2Rpdj48L2Rpdj4nO1xuICAgIH1cblxuICAgIGlmIChwcmljaW5nVGFibGUpIHtcbiAgICAgICAgaHRtbCArPSAnPGRldGFpbHMgc3R5bGU9XCJtYXJnaW4tdG9wOjhweFwiPjxzdW1tYXJ5IHN0eWxlPVwiZm9udC1zaXplOi43OHJlbTtjdXJzb3I6cG9pbnRlcjtvcGFjaXR5Oi42XCI+XHVEODNEXHVEQ0IwIFx1MzBEN1x1MzBFRFx1MzBEMFx1MzBBNFx1MzBDMFx1MzBGQ1x1NjU5OVx1OTFEMVx1NEUwMFx1ODlBN1x1RkYwODFNXHUzMEM4XHUzMEZDXHUzMEFGXHUzMEYzXHUzMDQyXHUzMDVGXHUzMDhBXHVGRjA5PC9zdW1tYXJ5PjxkaXYgc3R5bGU9XCJtYXJnaW4tdG9wOjhweDtvdmVyZmxvdy14OmF1dG9cIj48dGFibGUgc3R5bGU9XCJ3aWR0aDoxMDAlO2ZvbnQtc2l6ZTouNzJyZW07Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlXCI+PHRyIHN0eWxlPVwiYm9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMSlcIj48dGggc3R5bGU9XCJ0ZXh0LWFsaWduOmxlZnQ7cGFkZGluZzo0cHhcIj5cdTMwRTJcdTMwQzdcdTMwRUI8L3RoPjx0aCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo0cHhcIj5cdTUxNjVcdTUyOUIoJCk8L3RoPjx0aCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo0cHhcIj5cdTUxRkFcdTUyOUIoJCk8L3RoPjx0aCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo0cHhcIj5cdTUxNjVcdTUyOUIoXHUwMEE1KTwvdGg+PHRoIHN0eWxlPVwidGV4dC1hbGlnbjpyaWdodDtwYWRkaW5nOjRweFwiPlx1NTFGQVx1NTI5QihcdTAwQTUpPC90aD48L3RyPic7XG4gICAgICAgIE9iamVjdC5lbnRyaWVzKHByaWNpbmdUYWJsZSkuZm9yRWFjaCgoW21vZGVsLCByYXRlXSkgPT4ge1xuICAgICAgICAgICAgaHRtbCArPSBgPHRyIHN0eWxlPVwiYm9yZGVyLWJvdHRvbToxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMDQpXCI+PHRkIHN0eWxlPVwicGFkZGluZzozcHggNHB4XCI+JHtlc2MobW9kZWwpfTwvdGQ+PHRkIHN0eWxlPVwidGV4dC1hbGlnbjpyaWdodDtwYWRkaW5nOjNweCA0cHhcIj4kJHtyYXRlLmlucHV0fTwvdGQ+PHRkIHN0eWxlPVwidGV4dC1hbGlnbjpyaWdodDtwYWRkaW5nOjNweCA0cHhcIj4kJHtyYXRlLm91dHB1dH08L3RkPjx0ZCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzozcHggNHB4XCI+XHUwMEE1JHtNYXRoLnJvdW5kKHJhdGUuaW5wdXQgKiBKUFlfUkFURSl9PC90ZD48dGQgc3R5bGU9XCJ0ZXh0LWFsaWduOnJpZ2h0O3BhZGRpbmc6M3B4IDRweFwiPlx1MDBBNSR7TWF0aC5yb3VuZChyYXRlLm91dHB1dCAqIEpQWV9SQVRFKX08L3RkPjwvdHI+YDtcbiAgICAgICAgfSk7XG4gICAgICAgIGh0bWwgKz0gJzwvdGFibGU+PC9kaXY+PC9kZXRhaWxzPic7XG4gICAgfVxuXG4gICAgY29udGFpbmVyLmlubmVySFRNTCA9IGh0bWw7XG59XG4iLCAiLyoqXG4gKiBcdTMwQzhcdTMwRkNcdTMwQjlcdTMwQzhcdTkwMUFcdTc3RTVcdTMwRTJcdTMwQjhcdTMwRTVcdTMwRkNcdTMwRUJcbiAqIHJlbmRlcmVyLmpzIFx1MzA0Qlx1MzA4OVx1NjJCRFx1NTFGQVx1MzA1N1x1MzA1Rlx1NkM0RVx1NzUyOFx1MzBDOFx1MzBGQ1x1MzBCOVx1MzBDOFx1ODg2OFx1NzkzQVx1OTVBMlx1NjU3MFxuICpcbiAqIFx1NEY3Rlx1MzA0NFx1NjVCOTpcbiAqICAgaW1wb3J0IHsgc2hvd1RvYXN0IH0gZnJvbSAnLi9tb2R1bGVzL3RvYXN0LmpzJztcbiAqICAgc2hvd1RvYXN0KCdcdTRGRERcdTVCNThcdTMwNTdcdTMwN0VcdTMwNTdcdTMwNUYnLCAnc3VjY2VzcycpO1xuICovXG5cbi8qKlxuICogQHBhcmFtIHtzdHJpbmd9IG1zZyAtIFx1ODg2OFx1NzkzQVx1MzBFMVx1MzBDM1x1MzBCQlx1MzBGQ1x1MzBCOFxuICogQHBhcmFtIHsnc3VjY2Vzcyd8J2Vycm9yJ3wnaW5mbyd8J3dhcm5pbmcnfSBbdHlwZT0naW5mbyddXG4gKiBAcGFyYW0ge251bWJlcn0gW2R1cmF0aW9uPTMwMDBdIC0gXHU4ODY4XHU3OTNBXHU2NjQyXHU5NTkzKG1zKVxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvd1RvYXN0KG1zZywgdHlwZSA9ICdpbmZvJywgZHVyYXRpb24gPSAzMDAwKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvYmFsLXRvYXN0Jyk7XG4gICAgaWYgKGV4aXN0aW5nKSBleGlzdGluZy5yZW1vdmUoKTtcblxuICAgIGNvbnN0IGljb25NYXAgPSB7IHN1Y2Nlc3M6ICdcdTI3MDUnLCBlcnJvcjogJ1x1Mjc0QycsIGluZm86ICdcdTIxMzlcdUZFMEYnLCB3YXJuaW5nOiAnXHUyNkEwXHVGRTBGJyB9O1xuICAgIGNvbnN0IGNvbG9yTWFwID0ge1xuICAgICAgICBzdWNjZXNzOiAncmdiYSgzNCwxOTcsOTQsLjE1KScsXG4gICAgICAgIGVycm9yOiAgICdyZ2JhKDIzOSw2OCw2OCwuMTUpJyxcbiAgICAgICAgaW5mbzogICAgJ3JnYmEoOTksMTAyLDI0MSwuMTUpJyxcbiAgICAgICAgd2FybmluZzogJ3JnYmEoMjM0LDE3OSw4LC4xNSknLFxuICAgIH07XG5cbiAgICBjb25zdCB0b2FzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO1xuICAgIHRvYXN0LmlkID0gJ2dsb2JhbC10b2FzdCc7XG4gICAgdG9hc3Quc3R5bGUuY3NzVGV4dCA9IFtcbiAgICAgICAgJ3Bvc2l0aW9uOmZpeGVkJywgJ2JvdHRvbToyNHB4JywgJ3JpZ2h0OjI0cHgnLCAnei1pbmRleDo5OTk5JyxcbiAgICAgICAgJ3BhZGRpbmc6MTJweCAxOHB4JywgJ2JvcmRlci1yYWRpdXM6MTBweCcsXG4gICAgICAgIGBiYWNrZ3JvdW5kOiR7Y29sb3JNYXBbdHlwZV0gfHwgY29sb3JNYXAuaW5mb31gLFxuICAgICAgICAnYmFja2Ryb3AtZmlsdGVyOmJsdXIoMTJweCknLCAnYm9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xKScsXG4gICAgICAgICdjb2xvcjojZmZmJywgJ2ZvbnQtc2l6ZTouODhyZW0nLCAnbWF4LXdpZHRoOjM2MHB4JyxcbiAgICAgICAgJ2Rpc3BsYXk6ZmxleCcsICdhbGlnbi1pdGVtczpjZW50ZXInLCAnZ2FwOjhweCcsXG4gICAgICAgICdib3gtc2hhZG93OjAgNHB4IDIwcHggcmdiYSgwLDAsMCwuMyknLFxuICAgICAgICAnYW5pbWF0aW9uOmZhZGVJblVwIC4yNXMgZWFzZScsXG4gICAgXS5qb2luKCc7Jyk7XG5cbiAgICBjb25zdCBpY29uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO1xuICAgIGljb24udGV4dENvbnRlbnQgPSBpY29uTWFwW3R5cGVdIHx8ICdcdTIxMzlcdUZFMEYnO1xuICAgIGNvbnN0IHRleHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7XG4gICAgdGV4dC50ZXh0Q29udGVudCA9IG1zZztcblxuICAgIHRvYXN0LmFwcGVuZENoaWxkKGljb24pO1xuICAgIHRvYXN0LmFwcGVuZENoaWxkKHRleHQpO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQodG9hc3QpO1xuXG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIHRvYXN0LnN0eWxlLm9wYWNpdHkgPSAnMCc7XG4gICAgICAgIHRvYXN0LnN0eWxlLnRyYW5zaXRpb24gPSAnb3BhY2l0eSAuM3MnO1xuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHRvYXN0LnJlbW92ZSgpLCAzMDApO1xuICAgIH0sIGR1cmF0aW9uKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBOzs7QUNZTyxNQUFNLHNCQUFzQjtBQUM1QixNQUFNLFdBQVc7QUFNakIsV0FBUyxtQkFBbUI7QUFDL0IsUUFBSTtBQUNBLFlBQU0sTUFBTSxhQUFhLFFBQVEsbUJBQW1CO0FBQ3BELGFBQU8sTUFBTSxLQUFLLE1BQU0sR0FBRyxJQUFJLENBQUM7QUFBQSxJQUNwQyxTQUFTLEdBQUc7QUFBRSxhQUFPLENBQUM7QUFBQSxJQUFHO0FBQUEsRUFDN0I7QUFVTyxXQUFTLGdCQUFnQixTQUFTLE9BQU8scUJBQXFCLHNCQUFzQixjQUFjO0FBQ3JHLFVBQU0sVUFBVSxpQkFBaUI7QUFDakMsVUFBTSxVQUFXLGdCQUFnQixhQUFhLEtBQUssS0FBTSxFQUFFLE9BQU8sR0FBRyxRQUFRLEVB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
