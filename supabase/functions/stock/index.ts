// 매매 복기노트 '종목 확인·시세' 함수.
// 사이트(브라우저)는 네이버에 직접 물어볼 수 없어서, 이 함수가 대신 물어보고 결과를 돌려준다.
//   { action: "search", q: "휴림" }               → 이름이 맞는 종목 후보 [{ name, code, market }]
//   { action: "quote", stocks: [{ name, code }] } → 종목마다 현재가·전일 종가·최근 7일 일봉·최근 뉴스 (stock_live에도 저장)
//   { action: "news", name, code?, from, to }     → 그 종목의 기간 뉴스 (news에도 저장)
//   { action: "usnews", syms }                     → 미국 관련주 뉴스
//   { action: "caps", items: [{ name, code?, dates }] } → 매매 당시 시가총액 (stock_caps에도 저장)
//   { action: "article", urls }                    → 참고한 기사 제목·요약·사진·본문 (articles에도 저장)
//   { action: "us", syms }                         → 미국 지수·종목 일별 종가·등락률 (us_prices에도 저장)
// Supabase 대시보드 Edge Functions에서 이 파일 내용을 그대로 붙여넣어 'stock'이라는 이름으로 배포.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function get(url: string, referer = "https://m.stock.naver.com/"): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: referer, Accept: "application/json, text/plain, */*" } });
  if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}`);
  return await r.text();
}
const num = (v: unknown) => {
  if (v == null) return null;
  const s = String(v).replace(/[^\d.\-]/g, "");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
};
const cleanCode = (c: unknown) => {
  let s = String(c ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length === 7 && "AJQ".includes(s[0])) s = s.slice(1);
  return s.length === 6 && /\d/.test(s[0]) ? s : "";
};

// ---------- 종목 찾기 ----------
type Cand = { name: string; code: string; market: string };
function walk(o: unknown, out: Cand[]) {
  if (Array.isArray(o)) { o.forEach(v => walk(v, out)); return; }
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>;
    const code = cleanCode(r.code ?? r.itemCode ?? r.reutersCode);
    const name = (r.name ?? r.stockName ?? r.itemName) as string | undefined;
    if (code && name) out.push({ name: String(name), code, market: String(r.typeName ?? r.typeCode ?? r.stockExchangeName ?? r.market ?? "") });
    Object.values(r).forEach(v => walk(v, out));
  }
}
async function search(q: string): Promise<Cand[]> {
  q = q.trim(); if (!q) return [];
  const urls = [
    `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`,
    `https://m.stock.naver.com/front-api/search/autoComplete?query=${encodeURIComponent(q)}&target=stock`,
  ];
  for (const u of urls) {
    try {
      const out: Cand[] = []; walk(JSON.parse(await get(u)), out);
      const seen = new Set<string>(), uniq = out.filter(c => !seen.has(c.code) && seen.add(c.code));
      if (uniq.length) return uniq.slice(0, 12);
    } catch (_) { /* 다음 주소로 */ }
  }
  const code = cleanCode(q);
  if (code) { try { const b = await basic(code); if (b.name) return [{ name: b.name, code, market: b.market }]; } catch (_) { /* 없음 */ } }
  return [];
}

// ---------- 시세·일봉·뉴스 ----------
async function basic(code: string) {
  const d = JSON.parse(await get(`https://m.stock.naver.com/api/stock/${code}/basic`));
  let pct = num(d.fluctuationsRatio), diff = num(d.compareToPreviousClosePrice);
  const kind = String(d.compareToPreviousPrice?.name ?? "").toUpperCase();
  if (/FALLING|LOWER/.test(kind)) { if (pct && pct > 0) pct = -pct; if (diff && diff > 0) diff = -diff; }
  const price = num(d.closePrice);
  return {
    name: String(d.stockName ?? ""), price, diff, chgPct: pct,
    prevClose: price != null && diff != null ? price - diff : null,
    market: String(d.stockExchangeType?.nameKor ?? d.stockExchangeType?.name ?? d.stockExchangeName ?? ""),
    marketStatus: String(d.marketStatus ?? ""), asOf: String(d.localTradedAt ?? ""),
  };
}
async function candles(code: string) {
  const end = new Date(Date.now() + 9 * 3600e3), start = new Date(end.getTime() - 25 * 864e5);
  const f = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const txt = await get(`https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${f(start)}&endTime=${f(end)}&timeframe=day`, "https://finance.naver.com/");
  const rows: number[][] = [];
  for (const m of txt.matchAll(/\[\s*"(\d{8})"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g)) {
    rows.push([+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]]);
  }
  return rows.slice(-7).map(r => { const d = String(r[0]); return [`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, r[1], r[2], r[3], r[4], r[5]]; });
}
type News = { t: string; title: string; press: string; url: string; sym?: string };
const unesc = (x: string) => x.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const kst = (ms: number) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
// 어떤 모양의 JSON이든 '제목 + 시각'이 있는 기사를 모음 (해외주식 뉴스용)
function anyNewsWalk(o: unknown, out: News[]) {
  if (Array.isArray(o)) { o.forEach(v => anyNewsWalk(v, out)); return; }
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>;
    const title = [r.title, r.tit, r.headline].find(v => typeof v === "string" && v.trim()) as string | undefined;
    const raw = [r.datetime, r.dateTime, r.dt, r.createdAt, r.publishedAt, r.pubDate, r.date].find(v => v != null && String(v).trim() !== "");
    let t = "";
    if (raw != null) {
      const d = String(raw).replace(/\D/g, "");
      if (d.length >= 12) t = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}`;
      else { const ms = Date.parse(String(raw)); if (isFinite(ms)) t = kst(ms); }
    }
    if (title && t) {
      const oid = r.officeId ?? r.oid, aid = r.articleId ?? r.aid;
      out.push({ t, title: unesc(title), press: String(r.officeName ?? r.ohnm ?? r.press ?? r.source ?? ""),
        url: oid && aid ? `https://n.news.naver.com/mnews/article/${oid}/${aid}` : String(r.linkUrl ?? r.url ?? r.mobileUrl ?? "") });
      return;
    }
    Object.values(r).forEach(v => anyNewsWalk(v, out));
  }
}
function newsWalk(o: unknown, out: News[]) {
  if (Array.isArray(o)) { o.forEach(v => newsWalk(v, out)); return; }
  if (o && typeof o === "object") {
    const r = o as Record<string, unknown>;
    const dt = String(r.datetime ?? r.dateTime ?? "").replace(/\D/g, "");
    if (typeof r.title === "string" && dt.length >= 12 && (r.articleId || r.officeId)) {
      out.push({
        t: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)} ${dt.slice(8, 10)}:${dt.slice(10, 12)}`,
        title: r.title.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim(),
        press: String(r.officeName ?? ""),
        url: r.officeId && r.articleId ? `https://n.news.naver.com/mnews/article/${r.officeId}/${r.articleId}` : "",
      });
      return;
    }
    Object.values(r).forEach(v => newsWalk(v, out));
  }
}
async function news(code: string) {
  const out: News[] = []; newsWalk(JSON.parse(await get(`https://m.stock.naver.com/api/news/stock/${code}?pageSize=20&page=1`)), out);
  return out.sort((a, b) => b.t.localeCompare(a.t)).slice(0, 20);
}
// 같은 섹터 종목의 '전 거래일 ~ 매매일' 뉴스 (복기 창 관련 뉴스의 종목 버튼)
async function newsRange(name: string, code: string, from: string, to: string) {
  if (!code) { const c = await search(name); code = (c.find(x => x.name === name) ?? c[0])?.code ?? ""; }
  const data: Record<string, unknown> = { name, code, from, to, fetchedAt: new Date().toISOString(), items: [] as News[], src: "naver-m" };
  if (!code) { data.status = "nocode"; return data; }
  const all: News[] = []; let oldest = "9999", reached = false;
  try {
    for (let page = 1; page <= 60; page++) {
      const got: News[] = []; newsWalk(JSON.parse(await get(`https://m.stock.naver.com/api/news/stock/${code}?pageSize=20&page=${page}`)), got);
      if (!got.length) { reached = true; break; }
      all.push(...got); oldest = got.reduce((m, x) => x.t.slice(0, 10) < m ? x.t.slice(0, 10) : m, oldest);
      if (oldest < from) { reached = true; break; }
    }
  } catch (_) { /* 깊은 쪽은 네이버가 거부함 */ }
  const seen = new Set<string>();
  const inRange = all.filter(x => x.t.slice(0, 10) >= from && x.t.slice(0, 10) <= to)
    .sort((a, b) => b.t.localeCompare(a.t)).filter(x => { const k = x.title.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 40); return !seen.has(k) && !!seen.add(k); });
  const core = (x: News) => x.t >= `${from} 15:30` && x.t <= `${to} 15:30`;
  data.items = [...inRange.filter(core), ...inRange.filter(x => !core(x))].slice(0, 60).sort((a, b) => b.t.localeCompare(a.t));
  data.status = !all.length ? "empty" : reached ? "ok" : "partial";
  return data;
}

// 미국 관련주 뉴스: 네이버 해외주식 뉴스(한국어) → 안 되면 Yahoo(영어)
async function usNews(sym: string): Promise<News[]> {
  const codes: string[] = [];
  try {
    const c: Record<string, unknown>[] = [];
    const j = JSON.parse(await get(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(sym)}&target=stock`));
    (function w(o: unknown) { if (Array.isArray(o)) o.forEach(w); else if (o && typeof o === "object") { const r = o as Record<string, unknown>; if (r.reutersCode) c.push(r); Object.values(r).forEach(w); } })(j);
    const hit = c.find(r => String(r.code ?? "").toUpperCase() === sym && r.nationCode !== "KOR") ?? c.find(r => String(r.reutersCode).toUpperCase().startsWith(sym + "."));
    if (hit) codes.push(String(hit.reutersCode));
  } catch (_) { /* 자동완성 실패 */ }
  codes.push(`${sym}.O`, `${sym}.N`, `${sym}.K`);
  for (const rc of [...new Set(codes)]) {
    for (const u of [`https://api.stock.naver.com/news/worldStock/${rc}?pageSize=20&page=1`, `https://m.stock.naver.com/api/news/worldStock/${rc}?pageSize=20&page=1`]) {
      try { const got: News[] = []; anyNewsWalk(JSON.parse(await get(u)), got); if (got.length) return got.map(x => ({ ...x, sym })); } catch (_) { /* 다음 */ }
    }
  }
  try {
    const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym)}&quotesCount=0&newsCount=12`, "https://finance.yahoo.com/"));
    return (j.news ?? []).filter((n: Record<string, unknown>) => n.title && n.providerPublishTime)
      .map((n: Record<string, unknown>) => ({ t: kst(Number(n.providerPublishTime) * 1000), title: unesc(String(n.title)), press: String(n.publisher ?? "Yahoo"), url: String(n.link ?? ""), sym }));
  } catch (_) { return []; }
}

async function saveNews(key: string, data: unknown) {
  const base = Deno.env.get("SUPABASE_URL"), k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !k) return;
  const h: Record<string, string> = { apikey: k, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
  if (k.startsWith("eyJ")) h.Authorization = `Bearer ${k}`;
  await fetch(`${base}/rest/v1/news?on_conflict=key`, { method: "POST", headers: h, body: JSON.stringify([{ key, data, updated_at: new Date().toISOString() }]) }).catch(() => {});
}

async function quote(s: { name: string; code?: string }) {
  let code = cleanCode(s.code);
  if (!code) { const c = await search(s.name); code = (c.find(x => x.name === s.name) ?? c[0])?.code ?? ""; }
  const data: Record<string, unknown> = { code, fetchedAt: new Date().toISOString(), status: code ? "ok" : "nocode" };
  if (!code) return { name: s.name, data };
  const [b, c, n] = await Promise.allSettled([basic(code), candles(code), news(code)]);
  if (b.status === "fulfilled") Object.assign(data, b.value);
  if (c.status === "fulfilled") data.candles = c.value;
  if (n.status === "fulfilled") data.news = n.value;
  if (b.status === "rejected" && c.status === "rejected") data.status = "error";
  data.name = s.name;
  return { name: s.name, data };
}

async function saveLive(rows: { name: string; data: unknown }[]) {
  const base = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key || !rows.length) return;
  const h: Record<string, string> = { apikey: key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  const now = new Date().toISOString();
  await fetch(`${base}/rest/v1/stock_live?on_conflict=name`, { method: "POST", headers: h, body: JSON.stringify(rows.map(r => ({ ...r, updated_at: now }))) }).catch(() => {});
}

// ---------- Supabase 표 읽기·쓰기 (서비스 키) ----------
function sbHeaders(extra: Record<string, string> = {}) {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const h: Record<string, string> = { apikey: k, "Content-Type": "application/json", ...extra };
  if (k.startsWith("eyJ")) h.Authorization = `Bearer ${k}`;
  return h;
}
async function sbGet(path: string) {
  const base = Deno.env.get("SUPABASE_URL"); if (!base) return [];
  const r = await fetch(`${base}/rest/v1/${path}`, { headers: sbHeaders() }).catch(() => null);
  return r && r.ok ? await r.json() : [];
}
async function sbUpsert(table: string, conflict: string, rows: unknown[]) {
  const base = Deno.env.get("SUPABASE_URL"); if (!base || !rows.length) return;
  await fetch(`${base}/rest/v1/${table}?on_conflict=${conflict}`, { method: "POST", headers: sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(rows) }).catch(() => {});
}
const inList = (xs: string[]) => `(${xs.map(x => `"${String(x).replace(/"/g, '\\"')}"`).join(",")})`;

// ---------- 매매 당시 시가총액 ----------
const eok = (v: unknown) => {
  const t = String(v ?? "").replace(/[,\s원]/g, "");
  const m = t.match(/^(?:([\d.]+)조)?(?:([\d.]+)억)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return parseFloat(m[1] || "0") * 10000 + parseFloat(m[2] || "0");
};
async function sharesOf(code: string) {
  let price: number | null = null, mv: number | null = null, shares: number | null = null;
  try { const b = JSON.parse(await get(`https://m.stock.naver.com/api/stock/${code}/basic`)); price = num(b.closePrice); mv = eok(b.marketValue) ?? mv; } catch (_) { /* */ }
  try {
    const objs: Record<string, unknown>[] = [];
    (function w(o: unknown) { if (Array.isArray(o)) o.forEach(w); else if (o && typeof o === "object") { objs.push(o as Record<string, unknown>); Object.values(o).forEach(w); } })(JSON.parse(await get(`https://m.stock.naver.com/api/stock/${code}/integration`)));
    for (const o of objs) {
      if (o.value == null) continue;
      const key = String(o.code ?? o.key ?? ""), label = String(o.key ?? o.name ?? o.title ?? "");
      if (key === "marketValue" || /시총|시가총액/.test(label)) mv = eok(o.value) ?? mv;
      if (/listedStock/i.test(key) || /상장주식/.test(label)) shares = num(o.value) ?? shares;
    }
  } catch (_) { /* */ }
  if (!shares && mv && price) shares = mv * 1e8 / price;
  return { shares, mv };
}
async function closesRange(code: string, from: string, to: string) {
  const f = (d: string) => d.replace(/-/g, "");
  const start = new Date(new Date(from).getTime() - 12 * 864e5).toISOString().slice(0, 10);
  const txt = await get(`https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${f(start)}&endTime=${f(to)}&timeframe=day`, "https://finance.naver.com/");
  const out: Record<string, number> = {};
  for (const m of txt.matchAll(/\[\s*"(\d{8})"\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)/g)) out[`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`] = +m[2];
  return out;
}
async function capsFor(items: { name: string; code?: string; dates: string[] }[]) {
  const names = items.map(i => i.name);
  const have: Record<string, Record<string, unknown>> = {};
  for (const r of await sbGet(`stock_caps?select=name,data&name=in.${encodeURIComponent(inList(names))}`)) have[r.name] = r.data || {};
  const now = new Date().toISOString(), rows: { name: string; data: Record<string, unknown>; updated_at: string }[] = [];
  await Promise.all(items.map(async it => {
    const old = have[it.name] || {};
    const data: Record<string, unknown> = { ...old, caps: { ...(old.caps as Record<string, number> || {}) } };
    let code = cleanCode(it.code) || cleanCode(old.code);
    if (!code) { const c = await search(it.name); code = (c.find(x => x.name === it.name) ?? c[0])?.code ?? ""; }
    data.code = code;
    const dates = [...new Set(it.dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    if (!code) { data.status = "nocode"; } else if (dates.length) {
      try {
        let sh = old.shares as number | undefined;
        if (!sh || String(old.sharesAt || "") < new Date(Date.now() - 30 * 864e5).toISOString()) { const r = await sharesOf(code); sh = r.shares ?? undefined; data.shares = sh; data.sharesAt = now; data.mvNow = r.mv; }
        if (!sh) throw new Error("상장주식수 없음");
        const cl = await closesRange(code, dates[0], dates[dates.length - 1]), known = Object.keys(cl).sort();
        for (const d of dates) { const prev = known.filter(k => k <= d).pop(); if (prev) (data.caps as Record<string, number>)[d] = Math.round(sh * cl[prev] / 1e8); }
        data.status = "ok";
      } catch (e) { data.status = "error"; data.error = String(e).slice(0, 200); }
    }
    data.fetchedAt = now;
    rows.push({ name: it.name, data, updated_at: now });
  }));
  await sbUpsert("stock_caps", "name", rows);
  return rows.map(r => ({ name: r.name, data: r.data }));
}

// ---------- 참고한 기사 본문 ----------
async function getPage(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://www.naver.com/", Accept: "text/html,*/*" } });
  if (!r.ok) throw new Error(String(r.status));
  const buf = new Uint8Array(await r.arrayBuffer());
  let cs = (r.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1] || "";
  if (!cs) cs = new TextDecoder("utf-8").decode(buf.slice(0, 3000)).match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || "utf-8";
  try { return new TextDecoder(cs.toLowerCase()).decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}
function metaOf(h: string, ...names: string[]) {
  for (const n of names) {
    const e = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${e}["'][^>]*content=["']([^"']*)`, "i")) || h.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${e}["']`, "i"));
    if (m && m[1].trim()) return unesc(m[1]);
  }
  return "";
}
function blockText(h: string) {
  h = h.replace(/<(script|style|noscript|button|figcaption)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<em[^>]*class=["'][^"']*img_desc[^"']*["'][^>]*>[\s\S]*?<\/em>/gi, " ");
  h = h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d|li|tr)>/gi, "\n");
  const t = h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return t.split("\n").map(l => l.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function article(url: string) {
  const h = await getPage(url);
  const data: Record<string, unknown> = { title: metaOf(h, "og:title", "twitter:title"), desc: metaOf(h, "og:description", "description", "twitter:description"),
    img: metaOf(h, "og:image", "twitter:image"), press: metaOf(h, "og:article:author", "twitter:creator", "og:site_name").replace(/\s*[|｜:]\s*(네이버|NAVER|naver)\s*$/, "") };
  const dt = h.match(/data-date-time="([\d\- :]+)"/); if (dt) data.t = dt[1].slice(0, 16);
  let body = "";
  const m = h.match(/<article[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/article>/i);
  if (m) body = blockText(m[1]);
  if (!body) {
    const scope = h.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] || h;
    body = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x => unesc(x[1].replace(/\s+/g, " "))).filter(x => x.length > 30).join("\n\n");
  }
  data.body = body.slice(0, 20000);
  data.status = body || data.desc ? "ok" : "nobody";
  return data;
}

// ---------- 미국 시세 ----------
async function usPrices(syms: string[]) {
  const have: Record<string, Record<string, unknown>> = {};
  for (const r of await sbGet(`us_prices?select=sym,data&sym=in.${encodeURIComponent(inList(syms))}`)) have[r.sym] = r.data || {};
  const now = new Date().toISOString(), rows: { sym: string; data: Record<string, unknown>; updated_at: string }[] = [];
  await Promise.all(syms.map(async sym => {
    const old = have[sym] || {}, oldD = (old.d || {}) as Record<string, [number, number | null]>;
    const rng = Object.keys(oldD).length ? "1mo" : "2y";
    try {
      const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${rng}&interval=1d`, "https://finance.yahoo.com/"));
      const res = j.chart.result[0], off = res.meta.gmtoffset ?? -18000, cl = res.indicators.quote[0].close as (number | null)[];
      const merged: Record<string, number> = {}; for (const [d, v] of Object.entries(oldD)) merged[d] = v[0];
      (res.timestamp as number[] || []).forEach((ts, i) => { const c = cl[i]; if (c != null) merged[new Date((ts + off) * 1000).toISOString().slice(0, 10)] = Math.round(c * 1e4) / 1e4; });
      const d: Record<string, [number, number | null]> = {}; let prev: number | null = null;
      for (const k of Object.keys(merged).sort()) { const c = merged[k]; d[k] = [c, prev ? Math.round((c / prev - 1) * 1e4) / 100 : null]; prev = c; }
      rows.push({ sym, data: { ...old, d, name: old.name || res.meta.shortName || "", src: "yahoo", status: "ok" }, updated_at: now });
    } catch (e) { if (!Object.keys(oldD).length) rows.push({ sym, data: { d: {}, status: "error", error: String(e).slice(0, 200) }, updated_at: now }); }
  }));
  await sbUpsert("us_prices", "sym", rows);
  return rows.map(r => ({ sym: r.sym, data: r.data }));
}

// ---------- 그날 시장 (코스피·코스닥 지수·거래대금·투자자별 순매수) → market_days ----------
async function daumDays(market: string, start: string) {
  const out: Record<string, Record<string, unknown>> = {};
  for (let page = 1; page <= 5; page++) {
    const txt = await get(`https://finance.daum.net/api/market_index/days?page=${page}&perPage=100&market=${market}&pagination=true`, "https://finance.daum.net/");
    const rows = (JSON.parse(txt).data ?? []) as Record<string, number | string | null>[];
    const e = (v: unknown) => v == null ? null : Math.round(Number(v) / 1e7) / 10;
    for (const r of rows) {
      const d = String(r.date ?? "").slice(0, 10), close = r.tradePrice as number | null, chg = r.changePrice as number | null;
      const prev = close != null && chg != null ? close - chg : null;
      out[d] = { close, chg, chgPct: prev ? Math.round(chg! / prev * 10000) / 100 : null, vol: r.accTradeVolume ?? null, value: r.accTradePrice ?? null,
        _flow: { indiv: e(r.individualStraightPurchasePrice), foreign: e(r.foreignStraightPurchasePrice), inst: e(r.institutionStraightPurchasePrice) } };
    }
    if (rows.length < 100 || Object.keys(out).sort()[0] < start) break;
  }
  return out;
}
async function indexOhlc(code: string, start: string, end: string) {
  const f = (d: string) => d.replace(/-/g, "");
  const txt = await get(`https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${f(start)}&endTime=${f(end)}&timeframe=day`, "https://finance.naver.com/");
  const out: Record<string, { open: number; high: number; low: number; close: number; vol: number }> = {};
  for (const m of txt.matchAll(/\[\s*"(\d{8})"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/g))
    out[`${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`] = { open: +m[2], high: +m[3], low: +m[4], close: +m[5], vol: +m[6] };
  return out;
}
async function marketDays(days: number) {
  const kst = new Date(Date.now() + 9 * 3600e3), end = kst.toISOString().slice(0, 10);
  const start = new Date(kst.getTime() - days * 864e5).toISOString().slice(0, 10);
  const merged: Record<string, Record<string, unknown>> = {}, notes: string[] = [];
  for (const [key, code] of [["kospi", "KOSPI"], ["kosdaq", "KOSDAQ"]]) {
    let daum: Record<string, Record<string, unknown>> = {}, ohlc: Awaited<ReturnType<typeof indexOhlc>> = {};
    try { daum = await daumDays(code, start); } catch (e) { notes.push(`${key} daum: ${String(e).slice(0, 80)}`); }
    try { ohlc = await indexOhlc(code, new Date(new Date(start).getTime() - 10 * 864e5).toISOString().slice(0, 10), end); } catch (e) { notes.push(`${key} naver: ${String(e).slice(0, 80)}`); }
    const od = Object.keys(ohlc).sort();
    for (const d of new Set([...Object.keys(daum), ...od])) {
      if (d < start || d > end) continue;
      const x = { ...(daum[d] ?? {}) } as Record<string, unknown>, flow = x._flow as Record<string, number | null> | undefined; delete x._flow;
      const o = ohlc[d];
      if (o) { x.open = o.open; x.high = o.high; x.low = o.low; if (x.close == null) x.close = o.close; }
      if (x.chgPct == null && o) { const i = od.indexOf(d), pc = i > 0 ? ohlc[od[i - 1]].close : null; if (pc) { x.chg = Math.round((o.close - pc) * 100) / 100; x.chgPct = Math.round((o.close / pc - 1) * 10000) / 100; } }
      if (x.close == null) continue;
      const ent = merged[d] ??= {}; ent[key] = x;
      if (flow && Object.values(flow).some(v => v != null)) ((ent.flow ??= {}) as Record<string, unknown>)[key] = flow;
    }
  }
  const now = new Date().toISOString();
  // 오늘은 장 마감 정리 뒤(15:45 이후)에만 저장
  if (kst.getUTCHours() * 60 + kst.getUTCMinutes() < 15 * 60 + 45) delete merged[end];
  // 이미 있는 값은 이번에 못 받은 항목(예: Daum이 막혀 거래대금·순매수 없음)만큼 남김
  const ds = Object.keys(merged);
  if (ds.length) {
    const old = await sbGet(`market_days?select=date,data&date=in.${inList(ds)}`) as { date: string; data: Record<string, Record<string, unknown>> }[];
    const keep = (a: Record<string, unknown> = {}, b: Record<string, unknown> = {}) => { const o = { ...a }; for (const [k, v] of Object.entries(b)) if (v != null) o[k] = v; return o; };
    for (const r of old) {
      const m = merged[r.date], od = r.data || {};
      for (const k of ["kospi", "kosdaq"]) if (od[k] || m[k]) m[k] = keep(od[k], m[k] as Record<string, unknown>);
      const of = (od.flow || {}) as Record<string, Record<string, unknown>>, nf = (m.flow || {}) as Record<string, Record<string, unknown>>;
      const fl: Record<string, unknown> = {}; for (const k of ["kospi", "kosdaq"]) if (of[k] || nf[k]) fl[k] = keep(of[k], nf[k]);
      if (Object.keys(fl).length) m.flow = fl;
    }
  }
  await sbUpsert("market_days", "date", ds.map(d => ({ date: d, data: merged[d], updated_at: now })));
  return { items: ds.sort().map(d => ({ date: d, data: merged[d] })), notes };
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST만 받아요" }, 405);

  // 로그인 확인 (가입이 막혀 있어 로그인한 사람 = 사이트 주인)
  const auth = req.headers.get("authorization") || "", apikey = req.headers.get("apikey") || "";
  const base = Deno.env.get("SUPABASE_URL");
  if (!auth.startsWith("Bearer ") || !base) return json({ error: "로그인이 필요해요" }, 401);
  const who = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!who.ok) return json({ error: "로그인이 만료됐어요. 다시 로그인해 주세요" }, 401);

  let body: { action?: string; q?: string; stocks?: { name: string; code?: string }[]; name?: string; code?: string; from?: string; to?: string; syms?: string[]; date?: string;
    items?: { name: string; code?: string; dates: string[] }[]; urls?: string[]; days?: number };
  try { body = await req.json(); } catch { return json({ error: "잘못된 요청이에요" }, 400); }

  if (body.action === "search") return json({ items: await search(String(body.q ?? "")) });
  if (body.action === "quote") {
    const list = (body.stocks ?? []).filter(s => s && s.name).slice(0, 30);
    const out: { name: string; data: Record<string, unknown> }[] = [];
    for (let i = 0; i < list.length; i += 6) out.push(...await Promise.all(list.slice(i, i + 6).map(quote)));
    await saveLive(out);
    return json({ items: out });
  }
  if (body.action === "news") {
    const ok = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!body.name || !ok(body.from) || !ok(body.to)) return json({ error: "name, from, to(YYYY-MM-DD)가 필요해요" }, 400);
    const data = await newsRange(String(body.name), cleanCode(body.code), body.from!, body.to!);
    if (data.status !== "nocode") await saveNews(`${body.to}|${body.name}`, data);
    return json({ data });
  }
  if (body.action === "usnews") {
    const syms = [...new Set((body.syms ?? []).map(x => String(x).toUpperCase().trim()).filter(x => /^\^?[A-Z0-9.\-]{1,12}$/.test(x)))].slice(0, 8);
    const lists = await Promise.all(syms.map(usNews));
    const seen = new Set<string>();
    const items = lists.flat().sort((a, b) => b.t.localeCompare(a.t)).filter(x => !seen.has(x.title) && !!seen.add(x.title));
    return json({ items: items.slice(0, 60) });
  }
  if (body.action === "caps") {
    const items = (body.items ?? []).filter(i => i && i.name && Array.isArray(i.dates)).slice(0, 25);
    return json({ items: await capsFor(items) });
  }
  if (body.action === "article") {
    const urls = [...new Set((body.urls ?? []).filter(u => /^https?:\/\//i.test(String(u))))].slice(0, 8);
    const now = new Date().toISOString();
    const rows = await Promise.all(urls.map(async url => {
      let data: Record<string, unknown>;
      try { data = await article(url); } catch (e) { data = { status: "error", error: String(e).slice(0, 200) }; }
      data.fetchedAt = now; return { url, data, updated_at: now };
    }));
    await sbUpsert("articles", "url", rows);
    return json({ items: rows.map(r => ({ url: r.url, data: r.data })) });
  }
  if (body.action === "us") {
    const syms = [...new Set((body.syms ?? []).map(x => String(x).toUpperCase().trim()).filter(x => /^\^?[A-Z0-9.\-]{1,12}$/.test(x)))].slice(0, 20);
    return json({ items: await usPrices(syms) });
  }
  if (body.action === "market") {
    const days = Math.max(3, Math.min(400, Math.round(Number(body.days) || 10)));
    return json(await marketDays(days));
  }
  return json({ error: "action은 search, quote, news, usnews, caps, article, us, market 중 하나" }, 400);
});
