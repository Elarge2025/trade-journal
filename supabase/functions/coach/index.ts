// 매매 복기노트 AI 코치: 로그인한 사용자의 매매 요약을 받아 Claude에게 분석을 맡긴다.
import { PRINCIPLES } from "./principles.ts";

const MODELS: Record<string, string> = { deep: "claude-sonnet-5-5", fast: "claude-haiku-5-5" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SYSTEM = `당신은 개인 매매일지 사이트의 'AI 코치'입니다. 사용자는 트레이더 미모사의 단기 매매 강의(나주다 스쿨 2기)를 들은 수강생이고, 아래 [미모사 강의 원칙]이 사용자가 따르려는 기준입니다.

역할
- 사용자의 실제 매매 기록 숫자와 복기 글을 근거로, 미모사 강의 원칙에 비추어 지금 어떻게 매매하고 있는지 진단하고 다음 행동을 정해 줍니다.
- 말투는 미모사 강의 글의 분위기를 따릅니다: 존댓말, 따뜻하지만 원칙에는 단호함, '마음 편한 비중', '계좌를 지키는', '주도주', '거래대금' 같은 강의 용어 사용, 포기하지 말라는 격려.
- 당신은 미모사 본인이 아닙니다. '저는 미모사입니다'처럼 본인을 사칭하지 말고, 원칙을 인용할 때는 "강의에서는 ~라고 했어요"처럼 출처를 밝힙니다.

규칙
- 모든 주장에 사용자의 숫자(건수, 금액, 승률, 날짜, 종목)를 붙입니다. 데이터에 없는 사실을 지어내지 않습니다.
- 표본이 적으면(30건 미만, 또는 해당 항목 5건 미만) 그렇다고 말하고 결론을 약하게 냅니다.
- 특정 종목을 사라/팔라고 권하지 않습니다. 매매 습관과 원칙 준수에 대한 코칭만 합니다.
- 결과(수익/손실)보다 과정(원칙 준수, 손절, 비중, 시장 판단)을 평가합니다.

출력 형식 (한국어, 아래 제목 그대로, 마크다운)
## 지금 나는 이렇게 매매하고 있어요
(3~5문장 요약)
## 잘하고 있는 점
(1~3개 불릿, 숫자 근거)
## 가장 먼저 고칠 것
(가장 비싼 문제 1~3개. 각 항목: **제목** / 내 기록 / 강의 원칙 / 다음 주 구체적 행동)
## 다음 주 행동강령
(모니터 옆에 붙일 짧은 문장 3~5개)
## 한마디
(짧은 격려 1~2문장)

[미모사 강의 원칙]
${PRINCIPLES}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // 로그인 확인 (가입이 막혀 있어 로그인한 사람 = 사이트 주인)
  const auth = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || "";
  const base = Deno.env.get("SUPABASE_URL");
  if (!auth.startsWith("Bearer ") || !base) return json({ error: "로그인이 필요해요" }, 401);
  const who = await fetch(`${base}/auth/v1/user`, { headers: { Authorization: auth, apikey } });
  if (!who.ok) return json({ error: "로그인이 만료됐어요. 다시 로그인해 주세요" }, 401);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI 키가 아직 등록되지 않았어요" }, 503);

  let body: { mode?: string; data?: unknown };
  try { body = await req.json(); } catch { return json({ error: "잘못된 요청이에요" }, 400); }
  const model = MODELS[body.mode || "fast"] || MODELS.fast;
  const data = JSON.stringify(body.data ?? {});
  if (data.length > 400_000) return json({ error: "보낼 기록이 너무 많아요. 기간을 줄여 주세요" }, 413);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 3000, system: SYSTEM,
      messages: [{ role: "user", content: `아래는 내 매매 기록 요약이에요. 미모사 강의 원칙에 비추어 진단해 주세요.\n\n${data}` }],
    }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = out?.error?.message || "";
    const nice = /credit|balance/i.test(msg) ? "API 충전 잔액이 부족해요. console.anthropic.com에서 충전해 주세요"
      : r.status === 401 ? "AI 키가 올바르지 않아요" : r.status === 429 ? "잠시 후 다시 시도해 주세요" : "AI 분석에 실패했어요";
    return json({ error: nice, detail: msg.slice(0, 300) }, 502);
  }
  const text = (out.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
  return json({ text, model, usage: out.usage });
});
