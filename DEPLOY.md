# Deploy: Vercel + Render

Your **404 on `upload-resume` / `voice-chat-stream`** means the frontend is not reaching the Render backend.

## 1. Deploy backend on Render

1. Push repo to GitHub.
2. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint** (uses `render.yaml`) or **Web Service**.
3. Root directory: `backend`
4. Start: `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 120`
5. Environment variables:
   - `GEMINI_API_KEY`
   - `SARVAM_API_KEY`
   - `GEMINI_MODEL=gemini-flash-lite-latest`
   - `CORS_ORIGINS=https://jobi-ai-omega.vercel.app`

6. Copy your live URL, e.g. `https://ai-career-backend.onrender.com`

7. Test: `https://YOUR-SERVICE.onrender.com/health` → `"gemini": {"ok": true}`

## 2. Point frontend to backend (pick ONE)

### Option A — Vercel proxy (recommended)

Edit **`frontend/vercel.json`** — replace with your real Render URL:

```json
"destination": "https://YOUR-SERVICE.onrender.com/api/:path*"
```

Edit **`frontend/public/api-config.json`**:

```json
{
  "apiUrl": "https://YOUR-SERVICE.onrender.com/api"
}
```

Redeploy on Vercel. The app can use `/api` on the same domain.

### Option B — Direct API URL

In **Vercel → Project → Settings → Environment Variables**:

| Name | Value |
|------|--------|
| `VITE_API_URL` | `https://YOUR-SERVICE.onrender.com/api` |

Redeploy (must rebuild). No `vercel.json` proxy needed.

## 3. Vercel project settings

- **Root Directory:** `frontend`
- **Framework:** Vite
- **Build:** `npm run build`
- **Output:** `dist`

## 4. Verify production

1. Open `https://jobi-ai-omega.vercel.app`
2. DevTools → Network → upload resume
3. Request should go to:
   - `https://jobi-ai-omega.vercel.app/api/upload-resume` (proxy), **or**
   - `https://YOUR-SERVICE.onrender.com/api/upload-resume` (direct)
4. Status should be **200**, not **404**.

## Common mistakes

| Problem | Fix |
|---------|-----|
| 404 on `/api/*` | Wrong Render URL in `vercel.json` or missing `VITE_API_URL` |
| CORS error | Set `CORS_ORIGINS` on Render to your Vercel URL |
| 503 / AI errors | Check `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-flash-lite-latest` on Render |
| Render cold start | First request after idle may take ~30s on free tier |
