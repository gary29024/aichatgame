// Cloudflare Worker: serves the web app (the "public" folder) and a small private API.
//
// The browser calls /api/... with the app password. This Worker checks the password,
// then forwards the request through Cloudflare AI Gateway to Google Vertex AI.
// Google credentials never reach the browser: they are either stored in AI Gateway
// ("Provider Keys", recommended) or in this Worker's secrets.
//
// Settings (Cloudflare dashboard → your Worker → Settings → Variables and Secrets):
//   APP_PASSWORD                 (secret, required)  password people type into the app
//   GCP_PROJECT_ID               (required)          your Google Cloud project ID
//   CF_ACCOUNT_ID                (required*)         your Cloudflare account ID
//   AI_GATEWAY_ID                (required*)         the name of your AI Gateway
//   CF_AIG_TOKEN                 (secret)            AI Gateway authentication token
//   GOOGLE_SERVICE_ACCOUNT_JSON  (secret, optional)  only if you did NOT store the key in AI Gateway
//   GCP_LOCATION_TEXT            (optional)          default "global"
//   GCP_LOCATION_IMAGE           (optional)          default "global"
//   GCP_LOCATION_VIDEO           (optional)          default "us-central1"
//   AI_GATEWAY_URL               (optional)          full gateway base URL; replaces CF_ACCOUNT_ID + AI_GATEWAY_ID
//
// Request bodies are streamed straight through without being read, so big pictures
// cost almost no Worker CPU time.

const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{1,80}$/;
const LOCATION_RE = /^[a-z0-9\-]{2,40}$/;
const OPERATION_RE = /^projects\/[\w.\-]+\/locations\/[a-z0-9\-]+\/publishers\/google\/models\/[a-z0-9.\-]+\/operations\/[\w.\-]+$/;
const MAX_POLL_BODY = 4096;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (e) {
      return json({ error: { message: `Server error: ${e?.message || e}` } }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  if (!env.APP_PASSWORD) return setupError('APP_PASSWORD is not set on the Worker.');
  if (!(await passwordOk(request, env.APP_PASSWORD))) return json({ error: { message: 'Wrong or missing app password.' } }, 401);

  const missing = missingConfig(env);
  if (missing.length) return setupError(`Server setup is incomplete. Missing: ${missing.join(', ')}`);
  const cfg = config(env);
  const parts = url.pathname.split('/').filter(Boolean); // ["api", ...]

  if (parts[1] === 'ping' && request.method === 'GET') {
    return json({
      ok: true,
      auth: env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'service-account-secret' : 'ai-gateway-provider-key',
      locations: { text: cfg.text, image: cfg.image, video: cfg.video },
    });
  }
  if (request.method !== 'POST') return json({ error: { message: 'Method not allowed.' } }, 405);

  // POST /api/generate/{text|image}/{model}  (body = Vertex generateContent request)
  if (parts[1] === 'generate' && parts.length === 4) {
    const [kind, model] = [parts[2], decodeURIComponent(parts[3])];
    if (!['text', 'image'].includes(kind) || !MODEL_RE.test(model)) return badRequest('Invalid model.');
    return forward(env, kind === 'image' ? cfg.image : cfg.text, model, 'generateContent', request.body);
  }

  // POST /api/video/start/{model}  (body = Veo predictLongRunning request)
  if (parts[1] === 'video' && parts[2] === 'start' && parts.length === 4) {
    const model = decodeURIComponent(parts[3]);
    if (!MODEL_RE.test(model)) return badRequest('Invalid model.');
    return forward(env, cfg.video, model, 'predictLongRunning', request.body);
  }

  // POST /api/video/poll/{model}  (body = {"operationName": "projects/.../operations/..."})
  if (parts[1] === 'video' && parts[2] === 'poll' && parts.length === 4) {
    const model = decodeURIComponent(parts[3]);
    if (!MODEL_RE.test(model)) return badRequest('Invalid model.');
    const text = await request.text();
    if (text.length > MAX_POLL_BODY) return badRequest('Request too large.');
    let operationName = '';
    try {
      operationName = JSON.parse(text).operationName || '';
    } catch {}
    if (!OPERATION_RE.test(operationName)) return badRequest('Invalid operation name.');
    return forward(env, cfg.video, model, 'fetchPredictOperation', JSON.stringify({ operationName }));
  }

  return json({ error: { message: 'Not found.' } }, 404);
}

// ---------------------------------------------------------------------------------------

function config(env) {
  const loc = (v, d) => (LOCATION_RE.test(v || '') ? v : d);
  return {
    text: loc(env.GCP_LOCATION_TEXT, 'global'),
    image: loc(env.GCP_LOCATION_IMAGE, 'global'),
    video: loc(env.GCP_LOCATION_VIDEO, 'us-central1'),
  };
}

function missingConfig(env) {
  const missing = [];
  if (!env.GCP_PROJECT_ID) missing.push('GCP_PROJECT_ID');
  if (!env.AI_GATEWAY_URL) {
    if (!env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');
    if (!env.AI_GATEWAY_ID) missing.push('AI_GATEWAY_ID');
  }
  if (!env.CF_AIG_TOKEN && !env.GOOGLE_SERVICE_ACCOUNT_JSON) missing.push('CF_AIG_TOKEN (or GOOGLE_SERVICE_ACCOUNT_JSON)');
  return missing;
}

function gatewayBase(env) {
  if (env.AI_GATEWAY_URL) return env.AI_GATEWAY_URL.replace(/\/+$/, '');
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CF_ACCOUNT_ID)}/${encodeURIComponent(env.AI_GATEWAY_ID)}/google-vertex-ai`;
}

async function forward(env, location, model, method, body) {
  const target =
    `${gatewayBase(env)}/v1/projects/${encodeURIComponent(env.GCP_PROJECT_ID)}` +
    `/locations/${location}/publishers/google/models/${model}:${method}`;

  const headers = { 'content-type': 'application/json' };
  if (env.CF_AIG_TOKEN) headers['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;
  // Only when the Google key is NOT stored in AI Gateway: send the service account JSON
  // (base64, with a "region" field) and AI Gateway exchanges it for a Google token.
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) headers.authorization = `Bearer ${serviceAccountBearer(env.GOOGLE_SERVICE_ACCOUNT_JSON, location)}`;

  let res;
  try {
    res = await fetch(target, { method: 'POST', headers, body });
  } catch (e) {
    return json({ error: { message: `Could not reach Cloudflare AI Gateway: ${e?.message || e}` } }, 502);
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' },
  });
}

const bearerCache = new Map();
function serviceAccountBearer(rawJson, location) {
  if (!bearerCache.has(location)) {
    let sa;
    try {
      sa = JSON.parse(rawJson);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
    if (!sa.region) sa.region = location;
    bearerCache.set(location, btoa(JSON.stringify(sa)));
  }
  return bearerCache.get(location);
}

async function passwordOk(request, expected) {
  const header = request.headers.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const badRequest = (message) => json({ error: { message } }, 400);
const setupError = (message) => json({ error: { message, setup: true } }, 500);
