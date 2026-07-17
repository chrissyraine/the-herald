import crypto from 'crypto';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // --- API Routes ---
    if (path.startsWith('/api/')) {
      // CORS preflight
      if (method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
          }
        });
      }

      if (path === '/api/health') {
        return json({ status: 'ok', type: 'passive-mirror', timestamp: new Date().toISOString() });
      }

      // --- Authentication ---
      if (path === '/api/auth/admin/login' && method === 'POST') {
        const { pin } = await request.json();
        const expectedPinHash = env.ADMIN_PIN_HASH || hashPin('admin');
        if (hashPin(pin) !== expectedPinHash) return json({ error: 'Invalid PIN' }, 401);
        return json({ success: true, token: signToken({ scope: 'admin', exp: Date.now() + 12*60*60*1000 }, sessionSecret(env)) });
      }

      if (path === '/api/auth/login' && method === 'POST') {
        const { slug, pin } = await request.json();
        const business = await env.DB.prepare('SELECT id, pin_hash FROM businesses WHERE slug = ?').bind(slug).first();
        if (!business) return json({ error: 'Business not found' }, 404);
        if (hashPin(pin) !== business.pin_hash) return json({ error: 'Invalid PIN' }, 401);
        const token = signToken({ scope: 'business', slug, bid: business.id, exp: Date.now() + 12*60*60*1000 }, sessionSecret(env));
        return json({ success: true, businessId: business.id, slug, token });
      }

      // --- Public Aggregator API (Passive Mirror) ---
      
      // Get single business feed (For Studio Static Sites)
      const publicFeedMatch = path.match(/^\/api\/public\/businesses\/([^\/]+)\/feed$/);
      if (publicFeedMatch && method === 'GET') {
        const slug = publicFeedMatch[1];
        const business = await env.DB.prepare('SELECT id, name FROM businesses WHERE slug = ?').bind(slug).first();
        if (!business) return json({ error: 'Business not found' }, 404);

        // Fetch Announcement
        const announcement = await env.DB.prepare(
          `SELECT text, expires_at FROM announcements 
           WHERE business_id = ? AND is_active = 1 
           AND (expires_at IS NULL OR expires_at > datetime('now'))`
        ).bind(business.id).first();

        // Fetch Today's Hours (0=Sun, 6=Sat)
        const todayIdx = new Date().getDay();
        const todayDateStr = new Date().toISOString().split('T')[0];
        
        let hours = await env.DB.prepare(
          `SELECT open_time, close_time, is_closed, override_status, override_note, override_date 
           FROM operating_hours WHERE business_id = ? AND day_of_week = ?`
        ).bind(business.id, todayIdx).first();

        // Resolve today's status.
        //
        // status is one of: 'unknown' | 'open' | 'closed' | 'open_special'
        //
        // 'unknown' = this tenant has never set hours for today. It used to fall through to
        // 'open', which put a green "Open" pill on a brand-new client's live site for a
        // business that might be shut. Saying nothing is honest; guessing open is not.
        // Consumers should hide the pill on 'unknown'. (2026-07-16)
        // Note the middle case: a row can exist WITHOUT real hours, because setting an
        // override upserts a row carrying only the override columns. Once that override
        // expires, is_closed defaults to 0 — which would read as 'open' for a tenant who
        // never entered hours at all. So "open" requires actual open/close times.
        let currentStatus;
        if (!hours) {
          currentStatus = 'unknown';                    // never configured
        } else if (hours.is_closed) {
          currentStatus = 'closed';                     // explicitly closed today
        } else if (hours.open_time && hours.close_time) {
          currentStatus = 'open';                       // real hours on file
        } else {
          currentStatus = 'unknown';                    // row exists, hours never filled in
        }

        let currentNote = null;
        // A same-day override wins — but only if it carries a status we recognise. The
        // owner UI sends 'closed' or 'open_special'; anything else means the row is
        // malformed, and we'd rather fall back to the regular hours than emit a status no
        // website knows how to render.
        if (hours && hours.override_date === todayDateStr &&
            (hours.override_status === 'closed' || hours.override_status === 'open_special')) {
          currentStatus = hours.override_status;
          currentNote = hours.override_note;
        }

        // Social feed — DELIBERATELY EMPTY. Instagram/Facebook sync is not built.
        //
        // This used to fabricate a post ("Latest post synced from social!") whenever a
        // meta_connections row existed, and serve it on the tenant's own website as if the
        // owner had written it. Publishing invented words under a client's name is not a
        // placeholder, it's a lie with their name on it. Removed 2026-07-16.
        //
        // To actually ship this (see C:\foreverstill\integrations-roadmap.md):
        //   1. Meta Developer App + App Review (pages_read_engagement / pages_show_list,
        //      instagram_basic). The Connect button in townsquare's HeraldModule.jsx still
        //      writes a mock token, so no real token has ever reached meta_connections.
        //   2. Then fetch here with the stored access_token, e.g.
        //      graph.instagram.com/me/media?fields=id,caption,media_url,timestamp
        //   3. Return [] on any error — a client's site must never depend on Meta being up.
        //
        // Until step 1 is real, this stays []. Do not "helpfully" restore the mock.
        const socialFeed = [];

        // Town Crier posts: owner self-posts (newest first). Facebook posts merge in
        // here once a facebook connection with page_id + token exists.
        const postRows = await env.DB.prepare(
          'SELECT body, image_url, source, created_at FROM crier_posts WHERE business_id = ? ORDER BY created_at DESC LIMIT 10'
        ).bind(business.id).all();
        const posts = (postRows.results || []).map((p) => ({
          text: p.body, image: p.image_url || null, source: p.source || 'owner', created_at: p.created_at
        }));

        return json({
          business: { name: business.name, slug: slug },
          announcement: announcement ? { text: announcement.text, expires_at: announcement.expires_at } : null,
          hours: {
            status: currentStatus,
            open_time: hours?.open_time,
            close_time: hours?.close_time,
            note: currentNote
          },
          social_feed: socialFeed,
          posts: posts
        });
      }

      // Facebook Page photos for a client's gallery (multi-tenant, cached 30 min, CORS).
      // Creds (page_id + access_token) come from meta_connections for the business slug.
      // Returns { photos: [] } if not connected or on any error, so the site keeps its own photos.
      const fbPhotosMatch = path.match(/^\/api\/public\/businesses\/([^\/]+)\/fb-photos$/);
      if (fbPhotosMatch && method === 'GET') {
        const slug = fbPhotosMatch[1];
        const business = await env.DB.prepare('SELECT id FROM businesses WHERE slug = ?').bind(slug).first();
        if (!business) return json({ photos: [], note: 'unknown business' });
        const conn = await env.DB.prepare(
          "SELECT page_id, access_token FROM meta_connections WHERE business_id = ? AND platform = 'facebook'"
        ).bind(business.id).first();
        if (!conn || !conn.page_id || !conn.access_token) return json({ photos: [], note: 'not configured' });
        const pageId = conn.page_id, token = conn.access_token;

        const cache = caches.default;
        const cacheKey = new Request('https://cache.local/herald-fb/v1/' + slug);
        const hit = await cache.match(cacheKey);
        if (hit) return hit;

        const limit = Math.min(24, parseInt(url.searchParams.get('limit') || '12', 10) || 12);
        const fetchCount = Math.min(50, limit * 4);
        const source = url.searchParams.get('source') || 'posts';  // 'album' = uploaded Photos only (skip timeline posts)
        const postsApi = 'https://graph.facebook.com/v21.0/' + pageId +
          '/posts?fields=full_picture,permalink_url,message,attachments{media_type,media,subattachments{media}}' +
          '&limit=' + fetchCount + '&access_token=' + encodeURIComponent(token);
        const fromMedia = function (m) {
          if (m && m.image && m.image.src) return { src: m.image.src, thumb: m.image.src };
          return null;
        };
        let photos = [];
        try {
          if (source !== 'album') {
          const r = await fetch(postsApi);
          const data = await r.json();
          if (data && Array.isArray(data.data)) {
            const seen = new Set();
            for (const post of data.data) {
              const postPhotos = [];
              if (post.attachments && Array.isArray(post.attachments.data)) {
                for (const att of post.attachments.data) {
                  if (att.subattachments && Array.isArray(att.subattachments.data)) {
                    for (const sub of att.subattachments.data) {
                      const p = fromMedia(sub.media); if (p) postPhotos.push(p);
                    }
                  } else if (att.media_type === 'photo') {
                    const p = fromMedia(att.media); if (p) postPhotos.push(p);
                  }
                }
              }
              if (!postPhotos.length && post.full_picture) {
                postPhotos.push({ src: post.full_picture, thumb: post.full_picture });
              }
              const caption = ((post.message || '').split('\n')[0] || '').slice(0, 140);
              const link = post.permalink_url || null;
              for (const p of postPhotos) {
                if (seen.has(p.src)) continue;
                seen.add(p.src);
                photos.push({ src: p.src, thumb: p.thumb, link: link, caption: caption });
                if (photos.length >= limit) break;
              }
              if (photos.length >= limit) break;
            }
          }
          }
          if (!photos.length) {
            const photosApi = 'https://graph.facebook.com/v21.0/' + pageId +
              '/photos?type=uploaded&fields=images,link,name,created_time&limit=' + limit +
              '&access_token=' + encodeURIComponent(token);
            const r2 = await fetch(photosApi);
            const data2 = await r2.json();
            if (data2 && Array.isArray(data2.data)) {
              photos = data2.data.map(function (p) {
                const imgs = (p.images || []).slice().sort(function (a, b) { return b.width - a.width; });
                const full = imgs[0] ? imgs[0].source : null;
                const thumbObj = imgs.find(function (i) { return i.width <= 600; }) || imgs[imgs.length - 1] || imgs[0] || {};
                return full ? { src: full, thumb: thumbObj.source || full, link: p.link || null, caption: p.name || '' } : null;
              }).filter(Boolean);
            }
          }
        } catch (e) { photos = []; }

        const out = new Response(JSON.stringify({ photos: photos }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=1800' }
        });
        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      }

      // --- Protected Owner Hub API ---
      const protectedMatch = path.match(/^\/api\/businesses\/([^\/]+)\/(.*)$/);
      if (protectedMatch && method !== 'OPTIONS') {
        const slug = protectedMatch[1];
        const action = protectedMatch[2];
        
        if (!requireBusiness(request, env, slug)) return json({ error: 'Unauthorized' }, 401);
        
        const business = await env.DB.prepare('SELECT id FROM businesses WHERE slug = ?').bind(slug).first();

        // Save Announcement
        if (action === 'announcement' && method === 'POST') {
          const { active, text, expiresAt } = await request.json();
          await env.DB.prepare(
            `INSERT INTO announcements (business_id, is_active, text, expires_at) 
             VALUES (?, ?, ?, ?)
             ON CONFLICT(business_id) DO UPDATE SET 
             is_active=excluded.is_active, text=excluded.text, expires_at=excluded.expires_at, updated_at=CURRENT_TIMESTAMP`
          ).bind(business.id, active ? 1 : 0, text, expiresAt).run();
          return json({ success: true });
        }

        // Save Hours Override
        //
        // These were plain UPDATEs. A tenant with no operating_hours row for today matched
        // nothing, changed 0 rows, and still returned success — so an owner could set
        // "Closed today", see it save, and watch their site keep saying Open. The write is
        // now an upsert (operating_hours has UNIQUE(business_id, day_of_week)), so the
        // override lands whether or not regular hours were ever entered. (2026-07-16)
        if (action === 'hours/override' && method === 'POST') {
          const { active, status, note } = await request.json();
          const todayIdx = new Date().getDay();
          const todayDateStr = new Date().toISOString().split('T')[0];

          if (active) {
            // Only statuses the public feed can render — otherwise the override is ignored
            // downstream and we'd be lying about having saved it.
            if (status !== 'closed' && status !== 'open_special') {
              return json({ error: "status must be 'closed' or 'open_special'" }, 400);
            }
            await env.DB.prepare(
              `INSERT INTO operating_hours (business_id, day_of_week, override_status, override_note, override_date)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(business_id, day_of_week) DO UPDATE SET
                 override_status = excluded.override_status,
                 override_note   = excluded.override_note,
                 override_date   = excluded.override_date`
            ).bind(business.id, todayIdx, status, note || null, todayDateStr).run();
          } else {
            // Clearing an override on a day that has no row is a no-op by definition —
            // there's nothing to clear. No upsert needed.
            await env.DB.prepare(
              `UPDATE operating_hours SET override_status = NULL, override_note = NULL, override_date = NULL
               WHERE business_id = ? AND day_of_week = ?`
            ).bind(business.id, todayIdx).run();
          }
          return json({ success: true });
        }

        // Town Crier — owner self-posts (stream to titusvillesquare.com Town Crier)
        if (action === 'crier' && method === 'POST') {
          const { body, image_url } = await request.json();
          const text = (body || '').trim();
          if (!text) return json({ error: 'empty' }, 400);
          // Daily cap — keeps the shared Town Crier from getting spammy. Counts a
          // rolling 24h window. Change DAILY_CRIER_LIMIT to adjust. The official
          // Titusville Square account is exempt so spotlights are never blocked.
          const DAILY_CRIER_LIMIT = 2;
          if (slug !== 'titusville-square') {
            const used = await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM crier_posts WHERE business_id = ? AND created_at >= datetime('now','-1 day')"
            ).bind(business.id).first();
            if (used && used.n >= DAILY_CRIER_LIMIT) {
              return json({ error: `You've reached today's limit of ${DAILY_CRIER_LIMIT} Town Crier posts. You can post again in 24 hours.` }, 429);
            }
          }
          await env.DB.prepare(
            "INSERT INTO crier_posts (business_id, body, image_url, source) VALUES (?, ?, ?, 'owner')"
          ).bind(business.id, text.slice(0, 1000), image_url || null).run();
          return json({ success: true });
        }
        if (action === 'crier' && method === 'GET') {
          const rows = await env.DB.prepare(
            'SELECT id, body, image_url, source, created_at FROM crier_posts WHERE business_id = ? ORDER BY created_at DESC LIMIT 20'
          ).bind(business.id).all();
          return json({ posts: rows.results || [] });
        }
        const crierDel = action.match(/^crier\/(\d+)$/);
        if (crierDel && method === 'DELETE') {
          await env.DB.prepare('DELETE FROM crier_posts WHERE id = ? AND business_id = ?')
            .bind(crierDel[1], business.id).run();
          return json({ success: true });
        }

        // Save Meta Auth Token
        if (action === 'meta-auth' && method === 'POST') {
          const { platform, page_id, access_token, expires_in_days } = await request.json();
          const expiresAt = new Date(Date.now() + (expires_in_days || 60) * 24 * 60 * 60 * 1000).toISOString();

          await env.DB.prepare(
            `INSERT INTO meta_connections (business_id, platform, page_id, access_token, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(business_id, platform) DO UPDATE SET
             page_id=excluded.page_id, access_token=excluded.access_token, expires_at=excluded.expires_at, updated_at=CURRENT_TIMESTAMP`
          ).bind(business.id, platform, page_id || null, access_token, expiresAt).run();
          return json({ success: true });
        }
      }

      return json({ error: 'Not found' }, 404);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};

// --- Helpers ---
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
  });
}

function hashPin(pin) {
  const salt = Buffer.alloc(16, 0);
  return crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function sessionSecret(env) { return env.SESSION_SECRET || env.ADMIN_PIN_HASH || 'herald-dev-secret'; }
function b64url(str) { return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(str) { return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(); }
function hmac(body, secret) { return crypto.createHmac('sha256', secret).update(body).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return body + '.' + hmac(body, secret);
}
function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const idx = token.lastIndexOf('.');
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = hmac(body, secret);
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch (e) { return null; }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
function getAuth(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  return verifyToken(h.slice(7), sessionSecret(env));
}
function requireBusiness(request, env, slug) {
  const a = getAuth(request, env);
  if (!a) return false;
  if (a.scope === 'admin') return true;
  return a.scope === 'business' && a.slug === slug;
}
