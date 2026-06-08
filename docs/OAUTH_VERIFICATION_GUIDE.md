<!-- Drive Dupe Destroyer v12.8 — OAUTH_VERIFICATION_GUIDE.md -->
# Google OAuth Verification Guide — Drive Dupe Destroyer v12.0

## What This Achieves
Once your app passes Google's verification:
- ✅ No more security warning emails when users sign in
- ✅ Refresh tokens last indefinitely (no more 7-day expiry / repeated logins)
- ✅ Professional branded consent screen shown to users
- ✅ Your app listed as "verified" in Google's registry

---

## Step 1: Host the App Publicly

Google's reviewers need a public URL to inspect. Options:

### Option A: GitHub Pages (Free, Recommended)
1. Push your app folder to a GitHub repository
2. Go to repo Settings → Pages → Source: `main` branch, `/root`
3. Your URL will be `https://carloscamacho.github.io/Drive-Dupe-Destroyer/`

### Option B: Netlify (Free, Drag-and-Drop)
1. Go to netlify.com → "Add new site" → "Deploy manually"
2. Drag the `Drive_Dupe_Destroyer_v10_1` folder onto the upload area
3. You get a URL like `https://your-app.netlify.app`

### Option C: Any static host (Firebase Hosting, Vercel, Cloudflare Pages)

**Important:** Your hosted server must send these HTTP headers for full security:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
```
The included `sw.js` injects these via the Service Worker as a fallback when headers can't be set.

---

## Step 2: Host Privacy Policy & Terms of Service

Upload `privacy.html` and `terms.html` from this folder to your public host.

Your URLs will be something like:
- `https://your-app.netlify.app/privacy.html`
- `https://your-app.netlify.app/terms.html`

---

## Step 3: Configure Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Select your project → **APIs & Services → OAuth consent screen**
3. Fill in:
   - **App name:** Drive Dupe Destroyer
   - **App logo:** Create a simple logo (must be 120×120px PNG, no Google branding)
   - **App home page:** your public URL
   - **App privacy policy:** `https://your-app.netlify.app/privacy.html`
   - **App terms of service:** `https://your-app.netlify.app/terms.html`
   - **Authorized domains:** add your hosting domain (e.g. `netlify.app` or your custom domain)

4. Under **Authorized JavaScript origins** in Credentials → your OAuth Client:
   - Add your public URL: `https://your-app.netlify.app`
   - Keep `http://localhost:8080` for local development

---

## Step 4: Submit for Verification

1. On the OAuth consent screen page, click **"Publish App"** (moves from Testing to Production)
2. Then click **"Submit for Verification"**
3. In the verification form:
   - **Explain why you need the Drive scope:** "This app lists Drive folders and reads image thumbnails to compute perceptual hashes for duplicate detection. It moves selected files to Drive Trash. No file contents are stored or transmitted."
   - **Attach a demo video:** Record a 2–3 minute Loom/YouTube showing: sign in → pick folders → run scan → review results → delete a duplicate. This is required for sensitive scope review.
   - **Link to your privacy policy**

4. Google will email you within 1–6 weeks. They may ask follow-up questions — respond promptly.

---

## Step 5: While Awaiting Verification

Until verified, add your own email (and testers' emails) as **Test Users**:
1. OAuth consent screen → **Test users** → **Add users**
2. Add each tester's Gmail address
3. Test users can use the app without the 7-day token expiry limitation

---

## What Google Reviewers Check

| Requirement | Status in v12.0 |
|---|---|
| Minimal scopes — only request what you use | ✅ Only `drive` scope (required for arbitrary folder listing) |
| Privacy policy publicly hosted | ✅ `privacy.html` included |
| Terms of service publicly hosted | ✅ `terms.html` included |
| Accurate scope justification | ✅ Explained in `privacy.html` |
| Tokens not stored in localStorage | ✅ In-memory only (security.js) |
| No eval() usage | ✅ Verified |
| XSS protection (escapeHtml on all user data) | ✅ All innerHTML uses escapeHtml() |
| Content-Security-Policy | ✅ Set by security.js + sw.js |
| X-Frame-Options: DENY | ✅ Set by sw.js |
| X-Content-Type-Options: nosniff | ✅ Set in index.html meta + sw.js |
| Referrer-Policy | ✅ Set in index.html meta + sw.js |
| Permissions-Policy | ✅ Set by security.js |
| Sign-out revokes token | ✅ auth.js calls google.accounts.oauth2.revoke() |
| Demo video showing scope usage | ⚠️ You need to record this |
| App logo (120×120px PNG) | ⚠️ You need to create this |

---

## Quick Server with Security Headers (for local testing of SAB/COOP/COEP)

```python
# serve_secure.py — run instead of python3 -m http.server
from http.server import HTTPServer, SimpleHTTPRequestHandler

class SecureHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

if __name__ == "__main__":
    server = HTTPServer(("localhost", 8080), SecureHandler)
    print("Serving at http://localhost:8080 with security headers")
    server.serve_forever()
```

Run: `python3 serve_secure.py` — this enables SharedArrayBuffer (SAB ✓ in telemetry).
