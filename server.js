// Forj + HubSpot CORS proxy
// - GET  /<anything>            -> https://api.mobilize.io/v1/<anything>   (Basic auth relayed from Authorization header)
// - GET  /hubspot/<anything>    -> https://api.hubapi.com/<anything>       (Bearer token relayed from X-Hubspot-Token header)
// - POST /hubspot/crm/v3/objects/<type>/search  -> same upstream           (HubSpot's search endpoints are POST but read-only)
// No credentials are stored or logged on this server.
// No dependencies. Node 18+.

const http = require('http');

const FORJ_UPSTREAM = 'https://api.mobilize.io/v1';
const HUBSPOT_UPSTREAM = 'https://api.hubapi.com';
const PORT = process.env.PORT || 8010;

// Only these POST paths are allowed through (HubSpot CRM "search" = read via POST)
const HUBSPOT_POST_ALLOW = /^\/crm\/v3\/objects\/[a-z0-9_]+\/search$/;

function readBody(req){
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Follow redirects manually so auth headers survive them
async function forward(url, opts){
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

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Hubspot-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  try {
    /* ---------------- HubSpot route ---------------- */
    if (req.url.startsWith('/hubspot/')) {
      const path = req.url.slice('/hubspot'.length);          // keep leading slash
      const token = req.headers['x-hubspot-token'];
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"error_message":"Missing X-Hubspot-Token header"}');
      }
      const pathOnly = path.split('?')[0];
      if (req.method === 'POST' && !HUBSPOT_POST_ALLOW.test(pathOnly)) {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end('{"error_message":"Only CRM search POSTs are allowed through this proxy"}');
      }
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        return res.end('{"error_message":"Method not allowed"}');
      }
      const opts = {
        method: req.method,
        headers: { 'Authorization': 'Bearer ' + token }
      };
      if (req.method === 'POST') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = await readBody(req);
      }
      const upstream = await forward(HUBSPOT_UPSTREAM + path, opts);
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
      return res.end(body);
    }

    /* ---------------- Forj route (default) ---------------- */
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end('{"error_message":"Only GET is allowed for the Forj API"}');
    }
    if (!req.headers['authorization']) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error_message":"Missing Authorization header"}');
    }
    const upstream = await forward(FORJ_UPSTREAM + req.url, {
      method: 'GET',
      headers: { 'Authorization': req.headers['authorization'] }
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
    res.end(body);

  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_message: 'Upstream error: ' + e.message }));
  }
});

server.listen(PORT, () => {
  console.log('Forj + HubSpot proxy listening on port ' + PORT);
});
