// Forj API CORS proxy — forwards requests to api.mobilize.io/v1
// No dependencies. Node 18+ (Render's default runtime is fine).

const http = require('http');

const UPSTREAM = 'https://api.mobilize.io/v1';
const PORT = process.env.PORT || 8010;

const server = http.createServer(async (req, res) => {
  // CORS headers so the browser (Claude artifact) can call this service
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Simple health check for Render
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  // Read-only proxy: this dashboard only ever needs GET
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end('{"error_message":"Only GET is allowed through this proxy"}');
  }

  // Require the caller to supply their own Forj credentials —
  // this service holds no keys of its own.
  if (!req.headers['authorization']) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end('{"error_message":"Missing Authorization header"}');
  }

  try {
    let url = UPSTREAM + req.url;
    let upstream;
    for (let hop = 0; hop < 5; hop++) {
      upstream = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'Authorization': req.headers['authorization'] }
      });
      const loc = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && loc) {
        url = new URL(loc, url).toString();   // follow, re-attaching auth
        continue;
      }
      break;
    }
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_message: 'Upstream error: ' + e.message }));
  }
});

server.listen(PORT, () => {
  console.log('Forj proxy listening on port ' + PORT);
});
