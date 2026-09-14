// Forj proxy — read/write
//
// Replaces the earlier read-only server.js. The dashboards only ever needed
// GET; the Group Alignment Console needs to POST and PUT as well, so this
// version forwards those too — behind an explicit allow-list rather than
// opening the door to every method.
//
// What changed from the read-only version, and why:
//   1. POST and PUT are forwarded. DELETE is still refused, because Forj has
//      no group-delete endpoint anyway and there is no reason to hand out a
//      destructive verb nobody uses.
//   2. The request body is streamed through, which the GET-only version never
//      had to do.
//   3. OPTIONS is answered directly. A POST carrying Content-Type:
//      application/json plus an Authorization header triggers a CORS preflight,
//      and if that preflight is not answered the browser never sends the real
//      request — it just reports an opaque network error.
//   4. WRITE_TOKEN (optional). Reads stay open to anyone holding a valid Forj
//      key; writes can additionally require a shared secret, so a leaked URL
//      alone cannot change anything. Set it in Render's environment variables
//      and put the same value in the console's "Write token" field.
//
// The API key and secret are still never stored here. Every request carries
// the caller's own Authorization header and this service just relays it.
//
// DEPLOY: same as before — replace server.js in the repo, commit, push.
// Render redeploys on push. Confirm with GET /healthz.

const http = require('http');

const PORT = process.env.PORT || 8010;
const UPSTREAM = 'https://api.mobilize.io/v1';
const WRITE_TOKEN = process.env.WRITE_TOKEN || '';

const READ_METHODS  = ['GET'];
const WRITE_METHODS = ['POST', 'PUT'];
const ALLOWED = READ_METHODS.concat(WRITE_METHODS);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ALLOWED.join(', ') + ', OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, X-Write-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
}

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
      // a group payload is tiny; anything large is a mistake or an attack
      if (size > 1_000_000) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Preflight. Must come first — the browser sends this before the real
  // request and it carries no Authorization header, so any auth check above
  // this point would reject it and the real request would never arrive.
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/healthz') {
    return send(res, 200, { ok: true, methods: ALLOWED, writeTokenRequired: !!WRITE_TOKEN });
  }

  if (ALLOWED.indexOf(req.method) === -1) {
    return send(res, 405, { error_message: req.method + ' is not allowed through this proxy.' });
  }

  if (!req.headers['authorization']) {
    return send(res, 401, { error_message: 'Missing Authorization header' });
  }

  const isWrite = WRITE_METHODS.indexOf(req.method) !== -1;
  if (isWrite && WRITE_TOKEN && req.headers['x-write-token'] !== WRITE_TOKEN) {
    return send(res, 403, { error_message: 'Writes require a valid X-Write-Token header.' });
  }

  try {
    const body = isWrite ? await readBody(req) : undefined;
    const upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers: Object.assign(
        { 'Authorization': req.headers['authorization'], 'Accept': 'application/json' },
        isWrite ? { 'Content-Type': req.headers['content-type'] || 'application/json' } : {}
      ),
      body: body && body.length ? body : undefined
    });

    const text = await upstream.text();
    cors(res);
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    });
    res.end(text);

    // A one-line audit trail for writes. The path and status only — never the
    // body, which would put member data and credentials into Render's logs.
    if (isWrite) {
      console.log(new Date().toISOString(), req.method, req.url, '->', upstream.status);
    }
  } catch (e) {
    send(res, 502, { error_message: 'Upstream error: ' + e.message });
  }
});

server.listen(PORT, () => {
  console.log('Forj proxy listening on port ' + PORT +
    ' — methods: ' + ALLOWED.join(',') +
    (WRITE_TOKEN ? ' (write token required)' : ' (no write token set)'));
});
