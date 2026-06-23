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

        // Apply Override if date matches today
        let currentStatus = hours && hours.is_closed ? 'closed' : 'open';
        let currentNote = null;
        if (hours && hours.override_date === todayDateStr) {
          currentStatus = hours.override_status;
          currentNote = hours.override_note;
        }

        // Fetch Social Feed (mocking fetch from Meta Graph API since we don't have secrets injected)
        // In reality, we'd use the access_token from `meta_connections` and do:
        // fetch(`https://graph.instagram.com/me/media?fields=id,caption,media_url,timestamp&access_token=${token}`)
        const metaConnection = await env.DB.prepare(
          `SELECT platform FROM meta_connections WHERE business_id = ?`
        ).bind(business.id).first();

        const socialFeed = metaConnection ? [
          { platform: metaConnection.platform, id: '123', caption: 'Latest post synced from social!', timestamp: new Date().toISOString() }
        ] : [];

        return json({
          business: { name: business.name, slug: slug },
          announcement: announcement ? { text: announcement.text, expires_at: announcement.expires_at } : null,
          hours: {
            status: currentStatus,
            open_time: hours?.open_time,
            close_time: hours?.close_time,
            note: currentNote
          },
          social_feed: socialFeed
        });
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
        if (action === 'hours/override' && method === 'POST') {
          const { active, status, note } = await request.json();
          const todayIdx = new Date().getDay();
          const todayDateStr = new Date().toISOString().split('T')[0];
          
          if (active) {
            await env.DB.prepare(
              `UPDATE operating_hours SET override_status = ?, override_note = ?, override_date = ? 
               WHERE business_id = ? AND day_of_week = ?`
            ).bind(status, note, todayDateStr, business.id, todayIdx).run();
          } else {
            await env.DB.prepare(
              `UPDATE operating_hours SET override_status = NULL, override_note = NULL, override_date = NULL 
               WHERE business_id = ? AND day_of_week = ?`
            ).bind(business.id, todayIdx).run();
          }
          return json({ success: true });
        }

        // Save Meta Auth Token
        if (action === 'meta-auth' && method === 'POST') {
          const { platform, access_token, expires_in_days } = await request.json();
          const expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString();
          
          await env.DB.prepare(
            `INSERT INTO meta_connections (business_id, platform, access_token, expires_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(business_id, platform) DO UPDATE SET 
             access_token=excluded.access_token, expires_at=excluded.expires_at, updated_at=CURRENT_TIMESTAMP`
          ).bind(business.id, platform, access_token, expiresAt).run();
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
