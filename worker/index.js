// Thinking Probe — Cloudflare Worker proxy
// Keeps the Anthropic API key server-side so it never ships inside the extension.
//
// Required environment secrets (set in Cloudflare dashboard → Settings → Variables):
//   ANTHROPIC_API_KEY  — your sk-ant-... key
//   PROBE_SECRET       — any random string; must match PROBE_SECRET in config.js

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-probe-secret',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const secret = request.headers.get('x-probe-secret');
    if (!secret || secret !== env.PROBE_SECRET) {
      return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
    }

    const body = await request.text();

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  },
};
