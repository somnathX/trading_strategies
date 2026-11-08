// Vercel function: one bot tick. Call it at 09:16, 09:31 … 15:16 IST (e.g. from cron-job.org)
// with the header  Authorization: Bearer <BOT_SECRET>. The bot itself is bundled by `npm run build:bot`.
import { tick } from "../bot-dist/bot.js";

export async function GET(request) {
  const secret = process.env.BOT_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Forbidden", { status: 403 });
  try {
    return Response.json({ ok: true, result: await tick(process.env) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
    if (token && chat) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: `⚠️ Bot error: ${msg}` }),
      }).catch(() => null);
    }
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
