// Forj + HubSpot proxy — merged build
//
// WHY THIS FILE EXISTS
// On 15 Sep the group console shipped a new server.js "replacing the earlier
// read-only version". It was built from the original Forj-only proxy, not the
// Forj + HubSpot one, so deploying it silently removed the /hubspot route and
// dropped X-Hubspot-Token from the CORS allow-list. Every HubSpot call from the
// impact report and the association coverage page has failed since, at the
// CORS preflight, before reaching this server's routing at all.
//
// This build restores both. Nothing either service relied on is removed.
//
// ROUTES
//   OPTIONS *                       -> 204, CORS preflight. Answered FIRST, before
//                                      any auth check: a preflight carries no
//                                      credentials, so checking them here would
//                                      reject every preflight.
//   GET  /healthz                   -> {ok, routes, methods, writeTokenRequired}
//   GET  /hubspot/<path>            -> api.hubapi.com/<path>, Bearer from X-Hubspot-Token
//   POST /hubspot/crm/v3/objects/<type>/search
//                                   -> same. HubSpot's search is a POST but a read;
//                                      every other HubSpot POST is refused (405).
//   GET  /<path>                    -> api.mobilize.io/v1/<path>, Authorization relayed
//   POST|PUT /<path>                -> same, writes. Guarded by WRITE_TOKEN if set.
//
// ENV
//   WRITE_TOKEN        optional. If set, Forj writes need X-Write-Token to match.
//                      Leave unset unless the group console has a field for it.
//   FORJ_UPSTREAM      default https://api.mobilize.io/v1      (override for testing)
//   HUBSPOT_UPSTREAM   default https://api.hubapi.com          (override for testing)
//
// No credentials are stored or logged. No dependencies. Node 18+.

const http = require('http');

const PORT             = process.env.PORT || 8010;
const FORJ_UPSTREAM    = process.env.FORJ_UPSTREAM    || 'https://api.mobilize.io/v1';
const HUBSPOT_UPSTREAM = process.env.HUBSPOT_UPSTREAM || 'https://api.hubapi.com';
const WRITE_TOKEN      = process.env.WRITE_TOKEN || '';

const FORJ_READ   = ['GET'];
const FORJ_WRITE  = ['POST', 'PUT'];
const FORJ_METHODS = FORJ_READ.concat(FORJ_WRITE);

// HubSpot stays read-only. Search is the one POST that reads.
const HUBSPOT_POST_ALLOW = /^\/crm\/v3\/objects\/[a-z0-9_]+\/search$/;

// Every header any of the pages sends. X-Hubspot-Token is the one the
// group-console build dropped.
const ALLOW_HEADERS = 'Authorization, Content-Type, Accept, X-Hubspot-Token, X-Write-Token';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Every response goes through here, including errors, so a browser can always
// read what went wrong. An error without CORS headers looks to the page like
// a network failure and hides the real message.
function send(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Follow redirects by hand so the auth header survives them. Node's fetch
// drops Authorization on a cross-origin redirect, which Forj has triggered.
async function forward(url, opts) {
  let upstream;
  for (let hop = 0; hop < 5; hop++) {
    upstream = await fetch(url, { ...opts, redirect: 'manual' });
    const loc = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    break;
  }
  return upstream;
}

async function relay(res, upstream) {
  const text = await upstream.text();
  cors(res);
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json'
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/healthz') {
    return send(res, 200, {
      ok: true,
      routes: ['forj', 'hubspot'],
      methods: { forj: FORJ_METHODS, hubspot: ['GET', 'POST (search only)'] },
      writeTokenRequired: !!WRITE_TOKEN
    });
  }

  try {
    /* ------------------------------ HubSpot ------------------------------ */
    if (req.url.startsWith('/hubspot/')) {
      const path = req.url.slice('/hubspot'.length);           // keeps leading slash + query
      const pathOnly = path.split('?')[0];
      const token = req.headers['x-hubspot-token'];

      if (!token)
        return send(res, 401, { error_message: 'Missing X-Hubspot-Token header' });
      if (req.method !== 'GET' && req.method !== 'POST')
        return send(res, 405, { error_message: req.method + ' is not allowed on the HubSpot route' });
      if (req.method === 'POST' && !HUBSPOT_POST_ALLOW.test(pathOnly))
        return send(res, 405, { error_message: 'Only CRM search POSTs are allowed through this proxy' });

      const opts = { method: req.method, headers: { 'Authorization': 'Bearer ' + token } };
      if (req.method === 'POST') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = await readBody(req);
      }
      return relay(res, await forward(HUBSPOT_UPSTREAM + path, opts));
    }

    /* -------------------------------- Forj -------------------------------- */
    if (FORJ_METHODS.indexOf(req.method) === -1)
      return send(res, 405, { error_message: req.method + ' is not allowed through this proxy.' });
    if (!req.headers['authorization'])
      return send(res, 401, { error_message: 'Missing Authorization header' });

    const isWrite = FORJ_WRITE.indexOf(req.method) !== -1;
    if (isWrite && WRITE_TOKEN && req.headers['x-write-token'] !== WRITE_TOKEN)
      return send(res, 403, { error_message: 'Writes require a valid X-Write-Token header.' });

    const body = isWrite ? await readBody(req) : undefined;
    const upstream = await forward(FORJ_UPSTREAM + req.url, {
      method: req.method,
      headers: Object.assign(
        { 'Authorization': req.headers['authorization'], 'Accept': 'application/json' },
        isWrite ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {}
      ),
      body: body && body.length ? body : undefined
    });
    await relay(res, upstream);

    // Audit trail for writes: path and status only, never the body, which
    // would put member data and credentials into Render's logs.
    if (isWrite) console.log(new Date().toISOString(), req.method, req.url, '->', upstream.status);

  } catch (e) {
    send(res, 502, { error_message: 'Upstream error: ' + e.message });
  }
});

server.listen(PORT, () => {
  console.log('Forj + HubSpot proxy listening on port ' + PORT +
    ' | forj: ' + FORJ_METHODS.join(',') +
    ' | hubspot: GET + search POST' +
    (WRITE_TOKEN ? ' | write token required' : ' | no write token set'));
});
