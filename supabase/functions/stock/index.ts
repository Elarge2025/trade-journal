// 매매 복기노트 '종목 확인·시세' 함수.
// 사이트(브라우저)는 네이버에 직접 물어볼 수 없어서, 이 함수가 대신 물어보고 결과를 돌려준다.
//   { action: "search", q: "휴림" }               → 이름이 맞는 종목 후보 [{ name, code, market }]
//   { action: "quote", stocks: [{ name, code }] } → 종목마다 현재가·전일 종가·최근 7일 일봉·최근 뉴스 (stock_live에도 저장)
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
type News = { t: string; title: string; press: string; url: string };
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

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST만 받아요" }, 405);

  // 로그인 확인 (가입이 막혀 있어 로그인한 사람 = 사이트 주인)
  const auth = req.headers.get("authorization") || "", apikey = req.headers.get("apikey") || "";
  const base = Deno.env.get("SUPABASE_URL");
  if (!auth.startsWith("Bearer ") || !base) return json({ error: "로그인이 필요해요" }, 401);
  const who = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!who.ok) return json({ error: "로그인이 만료됐어요. 다시 로그인해 주세요" }, 401);

  let body: { action?: string; q?: string; stocks?: { name: string; code?: string }[] };
  try { body = await req.json(); } catch { return json({ error: "잘못된 요청이에요" }, 400); }

  if (body.action === "search") return json({ items: await search(String(body.q ?? "")) });
  if (body.action === "quote") {
    const list = (body.stocks ?? []).filter(s => s && s.name).slice(0, 30);
    const out: { name: string; data: Record<string, unknown> }[] = [];
    for (let i = 0; i < list.length; i += 6) out.push(...await Promise.all(list.slice(i, i + 6).map(quote)));
    await saveLive(out);
    return json({ items: out });
  }
  return json({ error: "action은 search 또는 quote" }, 400);
});
