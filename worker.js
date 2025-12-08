export default {
  // HTTP 入口：面板 API + 手动触发
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    // CORS 预检
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // ===== 1. 登录接口 =====
    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await req.json();
      const password = body.password || "";

      if (!env.ADMIN_PASSWORD) {
        return withCORS(
          new Response("ADMIN_PASSWORD not set", { status: 500 })
        );
      }

      if (password !== env.ADMIN_PASSWORD) {
        return withCORS(
          Response.json({ ok: false, msg: "密码错误" }, { status: 401 })
        );
      }

      const token = crypto.randomUUID();
      await env.KV_CONFIG.put(`session:${token}`, "1", {
        expirationTtl: 60 * 60 * 24 * 7, // 7 天
      });

      return withCORS(Response.json({ ok: true, token }));
    }

    // ===== 2. 读取配置（需要登录） =====
    if (url.pathname === "/api/config" && req.method === "GET") {
      const authed = await checkAuth(req, env);
      if (!authed.ok) return authed.resp;

      const json = await env.KV_CONFIG.get("config", { type: "json" });
      return withCORS(Response.json(json || {}));
    }

    // ===== 3. 保存配置（需要登录） =====
    if (url.pathname === "/api/config" && req.method === "POST") {
      const authed = await checkAuth(req, env);
      if (!authed.ok) return authed.resp;

      const body = await req.json();
      await env.KV_CONFIG.put("config", JSON.stringify(body));
      return withCORS(Response.json({ ok: true }));
    }

    // ===== 4. 手动触发抓取（调试用） =====
    if (url.pathname === "/run") {
      await handleBot(env);
      return withCORS(new Response("OK"));
    }

    return withCORS(new Response("ok"));
  },

  // Cron 触发
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleBot(env));
  },
};

/* ----------------- CORS 辅助 ----------------- */

function corsHeaders() {
  return {
    // 如果以后换成你自己的域名，可以改成 https://panel.xxx.com
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function withCORS(resp) {
  const headers = new Headers(resp.headers);
  const extra = corsHeaders();
  for (const k in extra) headers.set(k, extra[k]);
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

/* ----------------- 登录校验 ----------------- */

async function checkAuth(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return {
      ok: false,
      resp: withCORS(new Response("Unauthorized", { status: 401 })),
    };
  }

  const token = auth.substring("Bearer ".length).trim();
  if (!token) {
    return {
      ok: false,
      resp: withCORS(new Response("Unauthorized", { status: 401 })),
    };
  }

  const exists = await env.KV_CONFIG.get(`session:${token}`);
  if (!exists) {
    return {
      ok: false,
      resp: withCORS(new Response("Unauthorized", { status: 401 })),
    };
  }

  return { ok: true };
}

/* ----------------- 推送主逻辑 ----------------- */

async function handleBot(env) {
  const config = (await env.KV_CONFIG.get("config", { type: "json" })) || {};

  const enableKeyword = !!config.enable_keyword;
  const keywordRule = config.keywords || "";
  const enableAI = !!config.enable_ai;

  const FEEDS = [
    "https://lowendtalk.com/discussions/feed.rss",
    // 需要的话可以再加其他分类：
    // "https://lowendtalk.com/categories/offers/feed.rss",
  ];

  const keywordGroups = buildKeywordGroups(keywordRule); // [[出],[促销,低价],...]

  for (const feedUrl of FEEDS) {
    try {
      const resp = await fetch(feedUrl, {
        headers: { "User-Agent": "Cloudflare-Worker-LowEndTalk-TGBot" },
      });
      if (!resp.ok) {
        console.error("fetch feed failed", feedUrl, resp.status);
        continue;
      }

      const xmlText = await resp.text();
      const items = parseRssItems(xmlText);

      for (const item of items) {
        const postId = item.link || item.guid || item.title;
        if (!postId) continue;

        // 去重
        const seen = await env.KV_CONFIG.get(`post:${postId}`);
        if (seen) continue;

        const textForMatch = `${item.title} ${item.description}`.toLowerCase();

        // 关键词过滤：逗号分组 OR，组内 + 为 AND
        if (enableKeyword && keywordGroups.length > 0) {
          const hit = keywordGroups.some((group) =>
            group.every((kw) => textForMatch.includes(kw))
          );
          if (!hit) continue;
        }

        // AI 过滤（可选）
        if (enableAI) {
          const pass = await aiFilter(env, config, item);
          if (!pass) continue;
        }

        // 发送到 Telegram
        const ok = await sendToTelegram(env, item);
        if (ok) {
          await env.KV_CONFIG.put(`post:${postId}`, "1", {
            expirationTtl: 60 * 60 * 24 * 7,
          });
        }
      }
    } catch (e) {
      console.error("handle feed error", feedUrl, e);
    }
  }
}

/* ----------------- 关键词解析 ----------------- */
// 规则：
//   出,收,促销+低价
//   => [ ["出"], ["收"], ["促销","低价"] ]
function buildKeywordGroups(rule) {
  if (!rule) return [];
  return rule
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) =>
      g
        .split("+")
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean)
    )
    .filter((group) => group.length > 0);
}

/* ----------------- RSS 解析 ----------------- */

function parseRssItems(xmlText) {
  const items = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const matches = xmlText.match(itemRegex) || [];
  for (const block of matches) {
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const description = extractTag(block, "description");
    const pubDate = extractTag(block, "pubDate");
    const guid = extractTag(block, "guid");
    items.push({ title, link, description, pubDate, guid });
  }
  return items;
}

function extractTag(block, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = block.match(regex);
  if (!match) return "";
  return match[1]
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .trim();
}

/* ----------------- TG 推送 ----------------- */

async function sendToTelegram(env, item) {
  const botToken = env.BOT_TOKEN;
  const chatId = env.CHANNEL_ID;

  if (!botToken || !chatId) {
    console.error("BOT_TOKEN or CHANNEL_ID not set");
    return false;
  }

  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const text =
    `🆕 LowEndTalk 新帖子\n\n` +
    `📌 *${escapeMarkdown(item.title || "No title")}*\n` +
    (item.pubDate ? `🕒 ${escapeMarkdown(item.pubDate)}\n` : "") +
    (item.link ? `🔗 [打开帖子](${escapeMarkdown(item.link)})\n\n` : "\n") +
    (item.description
      ? `${truncate(escapeMarkdown(stripHtml(item.description)), 800)}`
      : "");

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: false,
  };

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error("Telegram send failed", resp.status, body);
    return false;
  }
  return true;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ");
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (match) => "\\" + match);
}

/* ----------------- AI 过滤（可选） ----------------- */

async function aiFilter(env, config, item) {
  const accountId = config.cf_account;
  const token = config.cf_token;
  const model = config.ai_model;
  const prompt = config.ns_prompt;

  // 配置不全就直接放行
  if (!accountId || !token || !model || !prompt) return true;

  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${encodeURIComponent(
      model
    )}`;

    const content = `标题：${item.title}\n\n内容：${stripHtml(
      item.description || ""
    )}\n\n请根据提示词判断。`;

    const payload = {
      messages: [
        { role: "system", content: prompt },
        { role: "user", content },
      ],
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      console.error("AI filter failed", resp.status, await resp.text());
      return true; // AI 调不通就直接放行，避免漏
    }

    const data = await resp.json();
    const text = (
      data.result?.response ||
      data.result?.output ||
      ""
    )
      .toString()
      .toLowerCase();

    if (text.includes("true")) return true;
    if (text.includes("false")) return false;
    return true;
  } catch (e) {
    console.error("AI filter error", e);
    return true;
  }
}