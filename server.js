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
// 27 SEP: PARTNER CONTACTS
// Adds the HubSpot endpoints the Partner Contacts manager needs, as an exact
// allow-list: batch reads, plus the writes that change contact roles, EA
// links and new contacts. Every other HubSpot POST is still refused. The
// existing Forj and HubSpot read routes are unchanged.
//
// 1 OCT: CALENDAR FEEDS
// Adds GET /ics?url=<feed> for the Master Calendar page, which needs to
// download public .ics feeds that don't send CORS headers. It is read-only and
// deliberately narrow: GET only, http/https/webcal URLs only, no credentials
// or cookies are forwarded, private and internal addresses are refused on
// every redirect hop, the response must actually be a calendar, and size and
// time are capped. Set ICS_ALLOWED_HOSTS to restrict it to known hosts.
// Forj and HubSpot routes are unchanged.
//
// ROUTES
//   OPTIONS *                       -> 204, CORS preflight. Answered FIRST, before
//                                      any auth check: a preflight carries no
//                                      credentials, so checking them here would
//                                      reject every preflight.
//   GET  /healthz                   -> {ok, routes, methods, writeTokenRequired}
//   GET  /ics?url=<encoded feed URL> -> the .ics file, as text/calendar. No auth.
//   GET  /hubspot/<path>            -> api.hubapi.com/<path>, Bearer from X-Hubspot-Token
//   POST /hubspot/crm/v3/objects/<type>/search
//                                   -> same. HubSpot's search is a POST but a read.
//   POST /hubspot/<Partner Contacts endpoints>
//                                   -> same. See HUBSPOT_POST_READS / _WRITES;
//                                      every other HubSpot POST is refused (405).
//   GET  /<path>                    -> api.mobilize.io/v1/<path>, Authorization relayed
//   POST|PUT /<path>                -> same, writes. Guarded by WRITE_TOKEN if set.
//
// ENV
//   WRITE_TOKEN        optional. If set, Forj writes need X-Write-Token to match.
//                      Leave unset unless the group console has a field for it.
//   FORJ_UPSTREAM      default https://api.mobilize.io/v1      (override for testing)
//   HUBSPOT_UPSTREAM   default https://api.hubapi.com          (override for testing)
//   ICS_ALLOWED_HOSTS  optional, comma-separated. If set, /ics only fetches from
//                      these hosts or their subdomains (e.g. "calendar.google.com,
//                      outlook.office365.com,lu.ma"). Unset = any public host.
//
// No credentials are stored or logged. No dependencies. Node 18+.

const http = require('http');
const dns  = require('dns').promises;
const net  = require('net');

const PORT             = process.env.PORT || 8010;
const FORJ_UPSTREAM    = process.env.FORJ_UPSTREAM    || 'https://api.mobilize.io/v1';
const HUBSPOT_UPSTREAM = process.env.HUBSPOT_UPSTREAM || 'https://api.hubapi.com';
const WRITE_TOKEN      = process.env.WRITE_TOKEN || '';
const ICS_ALLOWED_HOSTS = (process.env.ICS_ALLOWED_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const ICS_MAX_BYTES    = 10 * 1024 * 1024;   // 10 MB, far above any real feed
const ICS_TIMEOUT_MS   = 20000;

const FORJ_READ   = ['GET'];
const FORJ_WRITE  = ['POST', 'PUT'];
const FORJ_METHODS = FORJ_READ.concat(FORJ_WRITE);

// HubSpot POSTs allowed through, and nothing else.
const HUBSPOT_POST_READS = [
  /^\/crm\/v3\/objects\/[a-z0-9_]+\/search$/,                          // search (all pages)
  /^\/crm\/v3\/objects\/contacts\/batch\/read$/,                          // Partner Contacts
  /^\/crm\/v4\/associations\/(companies|contacts)\/(contacts|companies)\/batch\/read$/,
];
const HUBSPOT_POST_WRITES = [                                              // Partner Contacts only
  /^\/crm\/v3\/objects\/contacts$/,                                          // create a contact
  /^\/crm\/v4\/associations\/contacts\/(companies|contacts)\/batch\/create$/,      // add a role / EA link
  /^\/crm\/v4\/associations\/contacts\/(companies|contacts)\/batch\/labels\/archive$/, // remove a role
  /^\/crm\/v4\/associations\/contacts\/contacts\/batch\/archive$/,              // unlink an EA
];
const hubspotPostAllowed = p => HUBSPOT_POST_READS.concat(HUBSPOT_POST_WRITES).some(r => r.test(p));
const isHubspotWrite = p => HUBSPOT_POST_WRITES.some(r => r.test(p));

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

/* ------------------------------ Calendar feeds ------------------------------ */
// An open URL fetcher is the classic way into a server's private network, so
// every hop is checked: the host must resolve only to public addresses.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||          // carrier-grade NAT
      (a === 169 && b === 254) ||                    // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') ||
    v.startsWith('ff');
}

async function checkIcsUrl(raw) {
  let u;
  try { u = new URL(raw.trim().replace(/^webcal:\/\//i, 'https://')); }
  catch { throw Object.assign(new Error('Not a valid URL'), { code: 400 }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw Object.assign(new Error('Only http, https and webcal URLs are allowed'), { code: 400 });
  if (u.username || u.password)
    throw Object.assign(new Error('URLs with embedded credentials are not allowed'), { code: 400 });
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (ICS_ALLOWED_HOSTS.length && !ICS_ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h)))
    throw Object.assign(new Error('Host ' + host + ' is not in ICS_ALLOWED_HOSTS'), { code: 403 });
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); }
  catch { throw Object.assign(new Error('Could not resolve ' + host), { code: 502 }); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address)))
    throw Object.assign(new Error('Private or internal addresses are not allowed'), { code: 403 });
  return u;
}

async function readCapped(upstream) {
  const reader = upstream.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > ICS_MAX_BYTES) { reader.cancel(); throw Object.assign(new Error('Feed is larger than 10 MB'), { code: 502 }); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchIcs(raw) {
  let u = await checkIcsUrl(raw);
  const signal = AbortSignal.timeout(ICS_TIMEOUT_MS);
  for (let hop = 0; hop < 5; hop++) {
    const upstream = await fetch(u, {
      redirect: 'manual', signal,
      headers: {
        // Some hosts refuse requests without a browser-like UA.
        'User-Agent': 'Mozilla/5.0 (compatible; MasterCalendar-ICS/1.0)',
        'Accept': 'text/calendar, text/plain;q=0.9, */*;q=0.5'
      }
    });
    const loc = upstream.headers.get('location');
    if (upstream.status >= 300 && upstream.status < 400 && loc) {
      u = await checkIcsUrl(new URL(loc, u).toString());   // re-check every hop
      continue;
    }
    if (!upstream.ok)
      throw Object.assign(new Error('Calendar host returned HTTP ' + upstream.status), { code: 502 });
    const text = await readCapped(upstream);
    if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096)))
      throw Object.assign(new Error('That URL did not return a calendar (.ics) file'), { code: 502 });
    return text;
  }
  throw Object.assign(new Error('Too many redirects'), { code: 502 });
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
      routes: ['forj', 'hubspot', 'ics'],
      methods: { forj: FORJ_METHODS, hubspot: ['GET', 'POST (search, batch reads, Partner Contacts writes)'], ics: ['GET'] },
      hubspotWrites: true,
      icsAllowedHosts: ICS_ALLOWED_HOSTS.length ? ICS_ALLOWED_HOSTS : 'any public host',
      writeTokenRequired: !!WRITE_TOKEN
    });
  }

  /* ------------------------------ Calendar feeds ------------------------------ */
  // Matched before the Forj route, which would otherwise demand Authorization.
  if (req.url === '/ics' || req.url.startsWith('/ics?')) {
    if (req.method !== 'GET')
      return send(res, 405, { error_message: 'Only GET is allowed on /ics' });
    const target = new URL(req.url, 'http://x').searchParams.get('url');
    if (!target)
      return send(res, 400, { error_message: 'Add ?url=<encoded .ics URL>' });
    try {
      const text = await fetchIcs(target);
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(text);
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'Calendar host took too long to respond'
        : e.message === 'fetch failed' ? 'Could not reach the calendar host' + (e.cause && e.cause.code ? ' (' + e.cause.code + ')' : '')
        : e.message;
      // Host only, never the full URL: private feed links carry secret tokens.
      let host = '?'; try { host = new URL(target.replace(/^webcal:/i, 'https:')).hostname; } catch {}
      console.log(new Date().toISOString(), 'ICS', host, '->', e.code || 502, msg);
      return send(res, e.code || 502, { error_message: msg });
    }
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
      if (req.method === 'POST' && !hubspotPostAllowed(pathOnly))
        return send(res, 405, { error_message: 'This HubSpot endpoint is not allowed through this proxy' });

      const opts = { method: req.method, headers: { 'Authorization': 'Bearer ' + token } };
      if (req.method === 'POST') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = await readBody(req);
      }
      const hsUpstream = await forward(HUBSPOT_UPSTREAM + path, opts);
      await relay(res, hsUpstream);
      // Audit trail for HubSpot writes: path and status only, never the body.
      if (req.method === 'POST' && isHubspotWrite(pathOnly))
        console.log(new Date().toISOString(), 'HUBSPOT POST', pathOnly, '->', hsUpstream.status);
      return;
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
  console.log('Forj + HubSpot + ICS proxy listening on port ' + PORT +
    ' | forj: ' + FORJ_METHODS.join(',') +
    ' | hubspot: GET + search + Partner Contacts' +
    ' | ics: GET' + (ICS_ALLOWED_HOSTS.length ? ' (' + ICS_ALLOWED_HOSTS.join(',') + ')' : ' (any public host)') +
    (WRITE_TOKEN ? ' | write token required' : ' | no write token set'));
});
