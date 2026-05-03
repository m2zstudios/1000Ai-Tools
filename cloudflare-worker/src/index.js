const CACHE_KEYS = {
  tools: 'cache:tools',
  categories: 'cache:categories',
  stats: 'cache:stats',
  latest: 'cache:latest',
  meta: 'cache:meta'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/refresh' && request.method === 'POST') {
      const auth = request.headers.get('x-refresh-token');
      if (!auth || auth !== env.REFRESH_TOKEN) return json({ error: 'Unauthorized' }, 401);
      const result = await refreshCache(env);
      return json({ ok: true, ...result });
    }

    if (url.pathname === '/tools') return serveCached(env, CACHE_KEYS.tools);
    if (url.pathname === '/categories') return serveCached(env, CACHE_KEYS.categories);
    if (url.pathname === '/stats') return serveCached(env, CACHE_KEYS.stats);
    if (url.pathname === '/latest') return serveCached(env, CACHE_KEYS.latest);
    if (url.pathname === '/health') return serveCached(env, CACHE_KEYS.meta);

    return json({ error: 'Not found' }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshCache(env));
  }
};

async function serveCached(env, key) {
  const value = await env.TOOLS_KV.get(key);
  if (!value) return json({ error: 'Cache cold. Trigger /refresh.' }, 503);
  return new Response(value, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400'
    }
  });
}

async function refreshCache(env) {
  const tools = await fetchAllToolsFromAppwrite(env);
  const categories = buildCategories(tools);
  const stats = {
    totalTools: tools.length,
    totalCategories: categories.length,
    lastRefreshedAt: new Date().toISOString()
  };
  const latest = [...tools]
    .sort((a, b) => new Date(b.$createdAt) - new Date(a.$createdAt))
    .slice(0, 50);

  const expirationTtl = Number(env.CACHE_TTL_SECONDS || 259200);
  await Promise.all([
    env.TOOLS_KV.put(CACHE_KEYS.tools, JSON.stringify({ tools }), { expirationTtl }),
    env.TOOLS_KV.put(CACHE_KEYS.categories, JSON.stringify({ categories }), { expirationTtl }),
    env.TOOLS_KV.put(CACHE_KEYS.stats, JSON.stringify(stats), { expirationTtl }),
    env.TOOLS_KV.put(CACHE_KEYS.latest, JSON.stringify({ latest }), { expirationTtl }),
    env.TOOLS_KV.put(CACHE_KEYS.meta, JSON.stringify({ ok: true, ...stats }), { expirationTtl })
  ]);

  return { totalTools: tools.length, totalCategories: categories.length, refreshedAt: stats.lastRefreshedAt };
}

async function fetchAllToolsFromAppwrite(env) {
  const endpoint = env.APPWRITE_ENDPOINT;
  const db = env.APPWRITE_DATABASE_ID;
  const col = env.APPWRITE_TOOLS_COLLECTION_ID;
  const headers = {
    'x-appwrite-project': env.APPWRITE_PROJECT_ID,
    'x-appwrite-key': env.APPWRITE_API_KEY,
    'content-type': 'application/json'
  };

  const tools = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const params = new URLSearchParams();
    params.append('queries[]', `limit(100)`);
    params.append('queries[]', `offset(${offset})`);
    const res = await fetch(`${endpoint}/databases/${db}/collections/${col}/documents?${params.toString()}`, { headers });
    if (!res.ok) throw new Error(`Appwrite fetch failed: ${res.status}`);
    const payload = await res.json();
    total = payload.total;
    const docs = payload.documents || [];
    tools.push(...docs);
    if (!docs.length) break;
    offset += docs.length;
  }

  return tools;
}

function buildCategories(tools) {
  const map = new Map();
  for (const t of tools) map.set(t.category, (map.get(t.category) || 0) + 1);
  return [...map.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
