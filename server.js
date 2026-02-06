import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3847;
const BASE = `http://localhost:${PORT}`;

app.use(express.static(__dirname));
app.use(express.json());

// ─── In-memory token store (per session, resets on restart) ───
const tokens = { meta: null, linkedin: null };

// ─── Helper: fetch JSON from HTTPS ───
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: { 'User-Agent': 'SQ-BTTP-Dashboard/1.0', ...options.headers },
    };
    const req = https.request(reqOptions, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════
// META (Facebook + Instagram) OAuth
// ═══════════════════════════════════════════════════

const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'read_insights',
  'instagram_basic',
  'instagram_manage_insights',
  'business_management',
].join(',');

app.get('/auth/meta', (req, res) => {
  const url = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(BASE + '/auth/meta/callback')}&scope=${META_SCOPES}&response_type=code`;
  res.redirect(url);
});

app.get('/auth/meta/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received');

  try {
    // Exchange code for short-lived token
    const tokenRes = await fetchJSON(
      `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&redirect_uri=${encodeURIComponent(BASE + '/auth/meta/callback')}&code=${code}`
    );

    if (tokenRes.data.error) {
      return res.status(400).send(`Meta auth error: ${tokenRes.data.error.message}`);
    }

    // Exchange for long-lived token
    const longRes = await fetchJSON(
      `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.META_APP_ID}&client_secret=${process.env.META_APP_SECRET}&fb_exchange_token=${tokenRes.data.access_token}`
    );

    tokens.meta = longRes.data.access_token || tokenRes.data.access_token;
    res.redirect('/?connected=meta');
  } catch (err) {
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// ─── Fetch all Meta data ───
app.get('/api/meta/data', async (req, res) => {
  if (!tokens.meta) return res.status(401).json({ error: 'Not connected' });

  const results = {};
  const token = tokens.meta;

  try {
    // 1. Get user's pages
    const pagesRes = await fetchJSON(
      `https://graph.facebook.com/v21.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${token}`
    );
    const pages = pagesRes.data?.data || [];
    results.pages = { status: pages.length > 0 ? 'ok' : 'fail', data: pages.map(p => ({ id: p.id, name: p.name })), note: `${pages.length} page(s) found` };

    const page = pages[0];
    if (!page) {
      return res.json({ platform: 'meta', results, note: 'No Facebook Pages found. You need a Facebook Page to access insights.' });
    }

    const pageToken = page.access_token;

    // 2. Facebook: Post history + metrics
    const postsRes = await fetchJSON(
      `https://graph.facebook.com/v21.0/${page.id}/feed?fields=id,message,created_time,shares,reactions.summary(true),comments.summary(true),likes.summary(true)&limit=100&access_token=${pageToken}`
    );
    const posts = postsRes.data?.data || [];
    results.fb_post_history = { status: posts.length > 0 ? 'ok' : 'fail', data: posts.slice(0, 5), note: `${posts.length} posts fetched` };

    // 3. Facebook: Post-level insights (first 5 posts)
    const postInsights = [];
    for (const post of posts.slice(0, 5)) {
      try {
        const insRes = await fetchJSON(
          `https://graph.facebook.com/v21.0/${post.id}/insights?metric=post_engaged_users,post_clicks&access_token=${pageToken}`
        );
        postInsights.push({ post_id: post.id, insights: insRes.data?.data || [], error: insRes.data?.error || null });
      } catch { postInsights.push({ post_id: post.id, error: 'fetch failed' }); }
    }
    results.fb_post_metrics = { status: postInsights.some(p => p.insights?.length) ? 'ok' : 'fail', data: postInsights, note: `Tested ${postInsights.length} posts` };

    // 4. Facebook: Page insights (daily engagement)
    const pageInsRes = await fetchJSON(
      `https://graph.facebook.com/v21.0/${page.id}/insights?metric=page_post_engagements,page_views_total&period=day&access_token=${pageToken}`
    );
    results.fb_page_insights = { status: pageInsRes.data?.data?.length > 0 ? 'ok' : 'fail', data: pageInsRes.data?.data?.slice(0, 2) || [], error: pageInsRes.data?.error || null, note: pageInsRes.data?.data?.length > 0 ? 'Daily engagement data available' : 'No page insights returned' };

    // 5. Facebook: Fans online (expected deprecated)
    const fansOnlineRes = await fetchJSON(
      `https://graph.facebook.com/v21.0/${page.id}/insights?metric=page_fans_online&period=day&access_token=${pageToken}`
    );
    results.fb_fans_online = { status: fansOnlineRes.data?.error ? 'fail' : 'ok', error: fansOnlineRes.data?.error || null, note: fansOnlineRes.data?.error ? 'Deprecated — confirmed unavailable' : 'Unexpectedly available!' };

    // 6. Instagram: Find IG account
    const igAccount = page.instagram_business_account;
    if (igAccount) {
      const igId = igAccount.id;

      // IG profile info
      const igProfileRes = await fetchJSON(
        `https://graph.facebook.com/v21.0/${igId}?fields=id,username,name,followers_count,media_count&access_token=${token}`
      );
      results.ig_profile = { status: 'ok', data: igProfileRes.data, note: `@${igProfileRes.data?.username || 'unknown'}, ${igProfileRes.data?.followers_count || 0} followers` };

      // IG: Post history
      const igMediaRes = await fetchJSON(
        `https://graph.facebook.com/v21.0/${igId}/media?fields=id,caption,timestamp,media_type,like_count,comments_count,permalink&limit=100&access_token=${token}`
      );
      const igPosts = igMediaRes.data?.data || [];
      results.ig_post_history = { status: igPosts.length > 0 ? 'ok' : 'fail', data: igPosts.slice(0, 5), note: `${igPosts.length} posts fetched` };

      // IG: Per-post insights (first 3)
      const igInsights = [];
      for (const post of igPosts.slice(0, 3)) {
        try {
          const metrics = post.media_type === 'VIDEO' ? 'impressions,reach,saved' : 'impressions,reach,engagement,saved';
          const insRes = await fetchJSON(
            `https://graph.facebook.com/v21.0/${post.id}/insights?metric=${metrics}&access_token=${token}`
          );
          igInsights.push({ post_id: post.id, media_type: post.media_type, insights: insRes.data?.data || [], error: insRes.data?.error || null });
        } catch { igInsights.push({ post_id: post.id, error: 'fetch failed' }); }
      }
      results.ig_post_metrics = { status: igInsights.some(p => p.insights?.length) ? 'ok' : 'fail', data: igInsights, note: `Tested ${igInsights.length} posts` };

      // IG: Online followers (THE KEY METRIC)
      const onlineRes = await fetchJSON(
        `https://graph.facebook.com/v21.0/${igId}/insights?metric=online_followers&period=lifetime&access_token=${token}`
      );
      results.ig_online_followers = { status: onlineRes.data?.data?.[0]?.values?.[0]?.value ? 'ok' : 'fail', data: onlineRes.data?.data?.[0]?.values?.[0]?.value || null, error: onlineRes.data?.error || null, note: onlineRes.data?.data?.[0]?.values?.[0]?.value ? 'Hourly online data received!' : 'Not available (need 100+ followers)' };

      // IG: Audience demographics
      const demoRes = await fetchJSON(
        `https://graph.facebook.com/v21.0/${igId}/insights?metric=audience_city,audience_country,audience_gender_age&period=lifetime&access_token=${token}`
      );
      const demoData = demoRes.data?.data || [];
      results.ig_audience_geo = { status: demoData.length > 0 ? 'ok' : 'fail', data: demoData, error: demoRes.data?.error || null, note: demoData.length > 0 ? `${demoData.length} demographic metrics returned` : 'No demographic data (need 100+ followers)' };

    } else {
      results.ig_profile = { status: 'fail', note: 'No Instagram Business account linked to this Page' };
    }

    // 7. Compute best posting times from FB post data
    if (posts.length > 0) {
      const hourEngagement = {};
      for (const post of posts) {
        const hour = new Date(post.created_time).getUTCHours();
        const day = new Date(post.created_time).getUTCDay();
        const key = `${day}-${hour}`;
        const engagement = (post.reactions?.summary?.total_count || 0) + (post.comments?.summary?.total_count || 0) + (post.shares?.count || 0);
        if (!hourEngagement[key]) hourEngagement[key] = { total: 0, count: 0 };
        hourEngagement[key].total += engagement;
        hourEngagement[key].count += 1;
      }
      const avgEngagement = {};
      for (const [key, val] of Object.entries(hourEngagement)) {
        avgEngagement[key] = Math.round(val.total / val.count * 100) / 100;
      }
      results.fb_inferred_times = { status: 'ok', data: avgEngagement, note: `Computed from ${posts.length} posts` };
    }

    res.json({ platform: 'meta', results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// LINKEDIN OAuth
// ═══════════════════════════════════════════════════

const LI_SCOPES = 'openid profile r_organization_social rw_organization_admin r_member_postAnalytics w_member_social';

app.get('/auth/linkedin', (req, res) => {
  const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(BASE + '/auth/linkedin/callback')}&scope=${encodeURIComponent(LI_SCOPES)}`;
  res.redirect(url);
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received');

  try {
    const body = `grant_type=authorization_code&code=${code}&client_id=${process.env.LINKEDIN_CLIENT_ID}&client_secret=${process.env.LINKEDIN_CLIENT_SECRET}&redirect_uri=${encodeURIComponent(BASE + '/auth/linkedin/callback')}`;

    const tokenRes = await fetchJSON('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (tokenRes.data.error) {
      return res.status(400).send(`LinkedIn auth error: ${tokenRes.data.error_description}`);
    }

    tokens.linkedin = tokenRes.data.access_token;
    res.redirect('/?connected=linkedin');
  } catch (err) {
    res.status(500).send(`OAuth error: ${err.message}`);
  }
});

// ─── Fetch all LinkedIn data ───
app.get('/api/linkedin/data', async (req, res) => {
  if (!tokens.linkedin) return res.status(401).json({ error: 'Not connected' });

  const results = {};
  const token = tokens.linkedin;
  const liHeaders = {
    'Authorization': `Bearer ${token}`,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': '202501',
  };

  try {
    // 1. Get user profile
    const profileRes = await fetchJSON('https://api.linkedin.com/v2/userinfo', { headers: { 'Authorization': `Bearer ${token}` } });
    results.profile = { status: 'ok', data: { name: profileRes.data?.name, sub: profileRes.data?.sub }, note: profileRes.data?.name || 'Profile retrieved' };

    // 2. Get user's organizations (company pages)
    const orgsRes = await fetchJSON(
      'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(id,localizedName,vanityName)))',
      { headers: liHeaders }
    );
    const orgs = orgsRes.data?.elements || [];
    results.organizations = { status: orgs.length > 0 ? 'ok' : 'fail', data: orgs.slice(0, 5), note: `${orgs.length} organization(s) found`, error: orgsRes.data?.message || null };

    if (orgs.length > 0) {
      const orgUrn = orgs[0].organization;
      const orgId = orgUrn?.split(':').pop();

      if (orgId) {
        // 3. Follower count
        const sizeRes = await fetchJSON(
          `https://api.linkedin.com/rest/networkSizes/${encodeURIComponent(`urn:li:organization:${orgId}`)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
          { headers: liHeaders }
        );
        results.li_follower_count = { status: sizeRes.data?.firstDegreeSize != null ? 'ok' : 'fail', data: sizeRes.data, note: sizeRes.data?.firstDegreeSize != null ? `${sizeRes.data.firstDegreeSize} followers` : 'Could not fetch', error: sizeRes.data?.message || null };

        // 4. Follower demographics
        const followerRes = await fetchJSON(
          `https://api.linkedin.com/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(`urn:li:organization:${orgId}`)}`,
          { headers: liHeaders }
        );
        const followerData = followerRes.data?.elements?.[0] || {};
        results.li_follower_geo = { status: followerData.followerCountsByGeoCountry ? 'ok' : 'fail', data: followerData.followerCountsByGeoCountry?.slice(0, 10) || null, note: followerData.followerCountsByGeoCountry ? `${followerData.followerCountsByGeoCountry.length} countries` : 'Not available', error: followerRes.data?.message || null };
        results.li_follower_industry = { status: followerData.followerCountsByIndustry ? 'ok' : 'fail', data: followerData.followerCountsByIndustry?.slice(0, 10) || null, note: followerData.followerCountsByIndustry ? `${followerData.followerCountsByIndustry.length} industries` : 'Not available' };
        results.li_follower_seniority = { status: followerData.followerCountsBySeniority ? 'ok' : 'fail', data: followerData.followerCountsBySeniority?.slice(0, 10) || null, note: followerData.followerCountsBySeniority ? `${followerData.followerCountsBySeniority.length} levels` : 'Not available' };
        results.li_follower_function = { status: followerData.followerCountsByFunction ? 'ok' : 'fail', data: followerData.followerCountsByFunction?.slice(0, 10) || null, note: followerData.followerCountsByFunction ? `${followerData.followerCountsByFunction.length} functions` : 'Not available' };

        // 5. Share statistics (posts performance)
        const shareRes = await fetchJSON(
          `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(`urn:li:organization:${orgId}`)}`,
          { headers: liHeaders }
        );
        results.li_share_stats = { status: shareRes.data?.elements?.length > 0 ? 'ok' : 'fail', data: shareRes.data?.elements?.slice(0, 3) || null, note: shareRes.data?.elements?.length > 0 ? 'Share statistics available' : 'No data', error: shareRes.data?.message || null };
      }
    }

    // 6. Followers online — expected to fail
    results.li_followers_online = { status: 'fail', note: 'No such endpoint exists in LinkedIn API — confirmed' };

    // 7. Member posts (personal profile)
    const memberPostsRes = await fetchJSON(
      'https://api.linkedin.com/rest/posts?q=author&author=urn%3Ali%3Aperson%3Ame&count=50&sortBy=CREATED',
      { headers: { ...liHeaders, 'X-RestLi-Method': 'FINDER' } }
    );
    results.li_post_history = { status: memberPostsRes.data?.elements?.length > 0 ? 'ok' : 'fail', data: memberPostsRes.data?.elements?.slice(0, 5) || null, note: memberPostsRes.data?.elements ? `${memberPostsRes.data.elements.length} posts fetched` : 'No posts or access denied', error: memberPostsRes.data?.message || null };

    res.json({ platform: 'linkedin', results });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Connection status ───
app.get('/api/status', (req, res) => {
  res.json({
    meta: !!tokens.meta,
    linkedin: !!tokens.linkedin,
  });
});

// ─── Raw token check (for debugging) ───
app.get('/api/debug/tokens', (req, res) => {
  res.json({
    meta: tokens.meta ? `${tokens.meta.substring(0, 12)}...` : null,
    linkedin: tokens.linkedin ? `${tokens.linkedin.substring(0, 12)}...` : null,
  });
});

app.listen(PORT, () => {
  console.log(`\n  Best Time to Post — Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Meta App ID: ${process.env.META_APP_ID ? 'configured' : 'MISSING — set META_APP_ID in .env'}`);
  console.log(`  LinkedIn Client ID: ${process.env.LINKEDIN_CLIENT_ID ? 'configured' : 'MISSING — set LINKEDIN_CLIENT_ID in .env'}`);
  console.log('');
});
