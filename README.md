# Forj CORS Proxy

A tiny read-only proxy that lets a browser app (the Company Impact Explorer
dashboard) call the Journey by Forj (Mobilize) v1 API, which does not send
CORS headers itself.

- Forwards `GET` requests to `https://api.mobilize.io/v1`, preserving the path
  and query string.
- Relays the caller's `Authorization` header on every request. **No API keys
  are stored, configured, or logged on this server.**
- Rejects anything that isn't a `GET` and anything without an
  `Authorization` header.
- `GET /healthz` returns `{"ok":true}` for health checks.

## Run locally

```
npm start
# Forj proxy listening on port 8010
```

Test:

```
curl http://localhost:8010/healthz
curl -u YOUR_API_KEY:YOUR_API_SECRET "http://localhost:8010/users/search?keywords=@acme.com"
```

## Deploy on Render

1. New → Web Service → connect this repo.
2. Runtime: **Node** · Build command: `npm install` · Start command: `npm start`.
3. Instance type: Free is fine (note: free instances sleep after ~15 min idle;
   the first request after that takes 30–60 s to wake).
4. Verify at `https://<your-service>.onrender.com/healthz`.

Then set the dashboard's **Advanced → API base URL** to your Render URL
(no trailing slash or path), e.g. `https://forj-cors-proxy.onrender.com`.

## Notes

- Node 18+ required (uses the built-in `fetch`). Render's default Node runtime
  qualifies.
- No dependencies; `npm install` is effectively a no-op but keeps Render's
  default build command happy.
