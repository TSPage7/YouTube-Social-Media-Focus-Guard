const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// --- ID extraction ---

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const shorts = u.pathname.match(/^\/shorts\/([^/?&#]+)/);
      if (shorts) return shorts[1];
    } else if (u.hostname === 'youtu.be') {
      const id = u.pathname.slice(1).split('?')[0];
      if (id) return id;
    }
  } catch {}
  return null;
}

function extractTweetId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('x.com') || u.hostname.includes('twitter.com')) {
      const match = u.pathname.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
  } catch {}
  return null;
}

function extractInstagramId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('instagram.com')) {
      // Post: /p/{shortcode}/  Reel: /reel/{shortcode}/
      const content = u.pathname.match(/^\/(p|reel)\/([^/?#]+)/);
      if (content) return content[2];
      // Story: /stories/{username}/{id}/
      const story = u.pathname.match(/^\/stories\/[^/?#]+\/(\d+)/);
      if (story) return story[1];
    }
  } catch {}
  return null;
}

function extractTikTokId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('tiktok.com')) {
      // Long URL: /@username/video/{id}
      const video = u.pathname.match(/\/@[^/?#]+\/video\/(\d+)/);
      if (video) return video[1];
      // Short link: /t/{code}
      const short = u.pathname.match(/^\/t\/([^/?#]+)/);
      if (short) return short[1];
    }
  } catch {}
  return null;
}

function extractLinkedInId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('linkedin.com')) {
      // e.g. /feed/update/urn:li:activity:1234567890/
      const match = u.pathname.match(/\/feed\/update\/([^/?#]+)/);
      if (match) return match[1];
      // Feed root (no specific post) — use a sentinel so the feed itself can't be whitelisted
      if (/^\/feed(\/|$)/.test(u.pathname)) return null;
    }
  } catch {}
  return null;
}

function extractContentId(url, site) {
  switch (site) {
    case 'youtube':   return extractYouTubeId(url);
    case 'x':         return extractTweetId(url);
    case 'instagram': return extractInstagramId(url);
    case 'tiktok':    return extractTikTokId(url);
    case 'linkedin':  return extractLinkedInId(url);
    default:          return null;
  }
}

// --- Schedule check ---

async function isCurrentlyBlocked() {
  const { schedules = [] } = await chrome.storage.local.get('schedules');
  const now = new Date();
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  return schedules.some(s => {
    if (!s.days.includes(day)) return false;
    const [sh, sm] = s.startTime.split(':').map(Number);
    const [eh, em] = s.endTime.split(':').map(Number);
    return mins >= sh * 60 + sm && mins < eh * 60 + em;
  });
}

async function isApproved(url, site) {
  const contentId = extractContentId(url, site);
  if (!contentId) return false;
  const { approvedContent = [] } = await chrome.storage.local.get('approvedContent');
  return approvedContent.some(c => c.id === contentId && c.site === site);
}

// --- Daily time bank ---

const DAILY_BANK_MS = 60 * 60 * 1000;
const BLOCKED_SITE_PATTERNS = [
  '*://*.youtube.com/*', '*://*.x.com/*', '*://*.twitter.com/*',
  '*://*.instagram.com/*', '*://*.tiktok.com/*', '*://*.linkedin.com/*'
];

// --- Trusted clock ---
// The system clock is user-editable, so time-bank math runs on server time: the local clock plus
// the offset measured from a real server's Date header. During a bypass it also never runs backwards.

let lastClockSync = -Infinity; // performance.now() is monotonic, unlike Date.now()

async function syncClock(force = false) {
  if (!force && performance.now() - lastClockSync < 60_000) return;
  lastClockSync = performance.now();
  try {
    const res = await fetch('https://www.youtube.com/generate_204', { method: 'HEAD', cache: 'no-store' });
    const serverMs = Date.parse(res.headers.get('date'));
    if (!Number.isNaN(serverMs)) await chrome.storage.local.set({ clockOffsetMs: serverMs - Date.now() });
  } catch {}
}

async function trustedNow() {
  const { clockOffsetMs = 0, bypassStartedAt = null, bypassLastSeen = 0 } =
    await chrome.storage.local.get(['clockOffsetMs', 'bypassStartedAt', 'bypassLastSeen']);
  return Math.max(Date.now() + clockOffsetMs, bypassStartedAt ? bypassLastSeen : 0);
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Comparable day number; parses both padded and unpadded keys
function dayNumber(key) {
  const [y, m, d] = key.split('-').map(Number);
  return y * 10_000 + m * 100 + d;
}

// Only a later day refills the bank, so winding the clock back can't trigger a second refill
function isNewDay(now, timeBank) {
  return dayNumber(dayKey(now)) > dayNumber(timeBank.date);
}

// Returns { remainingMs, bypassEndsAt }. Refills the bank on a new day and settles an expired bypass.
// bypassEndsAt is in local-clock time, since that's what alarms and the page timers run on.
async function getBankState() {
  let now = await trustedNow();
  let { timeBank = { date: dayKey(now), usedMs: 0 }, bypassStartedAt = null } =
    await chrome.storage.local.get(['timeBank', 'bypassStartedAt']);
  let changed = false;
  let expired = false;

  if (isNewDay(now, timeBank)) {
    // Re-check against the server so a clock moved forward can't fake a new day
    await syncClock();
    now = await trustedNow();
  }
  if (isNewDay(now, timeBank)) {
    // A bypass running across midnight only counts from midnight
    timeBank = { date: dayKey(now), usedMs: 0 };
    if (bypassStartedAt) bypassStartedAt = Math.max(bypassStartedAt, new Date(now).setHours(0, 0, 0, 0));
    changed = true;
  }

  let remainingMs = DAILY_BANK_MS - timeBank.usedMs - (bypassStartedAt ? now - bypassStartedAt : 0);
  if (bypassStartedAt && remainingMs <= 0) {
    timeBank.usedMs = DAILY_BANK_MS;
    bypassStartedAt = null;
    changed = expired = true;
  }
  if (changed || bypassStartedAt) {
    await chrome.storage.local.set({ timeBank, bypassStartedAt, bypassLastSeen: now });
  }

  remainingMs = Math.max(0, remainingMs);
  const state = { remainingMs, bypassEndsAt: bypassStartedAt ? Date.now() + remainingMs : null };
  if (expired) {
    applyBypassUi(state);
    broadcastBypassChange();
  }
  return state;
}

async function startBypass() {
  await syncClock(true);
  const state = await getBankState();
  if (state.bypassEndsAt || state.remainingMs <= 0) return state;
  const { clockOffsetMs = 0 } = await chrome.storage.local.get('clockOffsetMs');
  const now = Date.now() + clockOffsetMs;
  await chrome.storage.local.set({ bypassStartedAt: now, bypassLastSeen: now });
  return onBypassChanged();
}

// Ending early saves the remaining time; every open blocked tab re-locks via the broadcast
async function endBypass() {
  const state = await getBankState();
  if (!state.bypassEndsAt) return state;

  const { timeBank } = await chrome.storage.local.get('timeBank');
  await chrome.storage.local.set({
    timeBank: { ...timeBank, usedMs: DAILY_BANK_MS - state.remainingMs },
    bypassStartedAt: null
  });
  return onBypassChanged();
}

async function onBypassChanged() {
  const state = await getBankState();
  applyBypassUi(state);
  broadcastBypassChange();
  return state;
}

// Toolbar badge shows minutes left while a bypass runs; alarms wake the worker to end it on time
function applyBypassUi({ remainingMs, bypassEndsAt }) {
  if (bypassEndsAt) {
    chrome.alarms.create('bypass-end', { when: bypassEndsAt });
    chrome.alarms.create('bypass-tick', { periodInMinutes: 0.5 });
    chrome.action.setBadgeBackgroundColor({ color: remainingMs <= 5 * 60_000 ? '#d97706' : '#16a34a' });
    chrome.action.setBadgeText({ text: `${Math.ceil(remainingMs / 60_000)}m` });
  } else {
    chrome.alarms.clear('bypass-end');
    chrome.alarms.clear('bypass-tick');
    chrome.action.setBadgeText({ text: '' });
  }
}

// Tell every open blocked-site tab to re-check, so they all lock/unlock together
async function broadcastBypassChange() {
  const tabs = await chrome.tabs.query({ url: BLOCKED_SITE_PATTERNS });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'BYPASS_CHANGED' }).catch(() => {
      // No live content script (e.g. orphaned by a reload) — inject one so the tab still locks
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'bypass-end' || alarm.name === 'bypass-tick') {
    await syncClock();
    applyBypassUi(await getBankState());
  }
});

// Chrome doesn't inject content scripts into tabs that were already open on install, and a reload
// orphans the old ones. Inject fresh copies so no open tab escapes blocking.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'chrome_update') return; // existing scripts are still live
  const tabs = await chrome.tabs.query({ url: BLOCKED_SITE_PATTERNS });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
});

// Restore the badge whenever the service worker wakes up
syncClock().then(getBankState).then(applyBypassUi);

// --- YouTube data fetching ---

async function getYouTubeData(videoUrl, videoId, googleApiKey) {
  if (googleApiKey && videoId) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${googleApiKey}`
      );
      if (res.ok) {
        const data = await res.json();
        const snippet = data.items?.[0]?.snippet;
        if (snippet) {
          return {
            title: snippet.title || '',
            channelName: snippet.channelTitle || '',
            description: snippet.description || '',
            tags: snippet.tags || []
          };
        }
      }
    } catch {}
  }
  // Fallback: oEmbed
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
    if (res.ok) {
      const data = await res.json();
      return { title: data.title || '', channelName: data.author_name || '', description: '', tags: [] };
    }
  } catch {}
  return { title: '', channelName: '', description: '', tags: [] };
}

async function getYouTubeThumbnail(videoId) {
  if (!videoId) return null;
  for (const q of ['maxresdefault', 'hqdefault']) {
    try {
      const res = await fetch(`https://img.youtube.com/vi/${videoId}/${q}.jpg`);
      if (!res.ok) continue;
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK)
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      return btoa(binary);
    } catch {}
  }
  return null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#10;/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ');
}

async function getYouTubeTranscript(videoId) {
  if (!videoId) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    clearTimeout(timeout);
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const markerIdx = html.indexOf('"captionTracks":');
    if (markerIdx === -1) return null;
    const arrayStart = html.indexOf('[', markerIdx);
    if (arrayStart === -1) return null;

    let depth = 0, arrayEnd = arrayStart;
    while (arrayEnd < html.length) {
      if (html[arrayEnd] === '[') depth++;
      else if (html[arrayEnd] === ']') { depth--; if (depth === 0) break; }
      arrayEnd++;
    }

    let tracks;
    try { tracks = JSON.parse(html.slice(arrayStart, arrayEnd + 1)); } catch { return null; }
    if (!tracks?.length) return null;

    const enManual = tracks.find(t => t.languageCode === 'en' && !t.kind);
    const enAsr = tracks.find(t => t.languageCode === 'en');
    const track = enManual || enAsr || tracks[0];
    if (!track?.baseUrl) return null;

    const capRes = await fetch(track.baseUrl);
    if (!capRes.ok) return null;
    const xml = await capRes.text();

    const lines = [];
    for (const match of xml.matchAll(/<text[^>]*start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g)) {
      if (parseFloat(match[1]) > 300) break;
      const text = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '')).trim();
      if (text) lines.push(text);
    }
    return lines.length ? lines.join(' ') : null;
  } catch { return null; }
}

// --- Social media content scraping (X, Instagram, TikTok) ---
// Attempts to pull the og:description from the server-rendered HTML.
// Falls back gracefully to null if blocked or unavailable.

async function getSocialContent(url) {
  if (!url) return null;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    // og:description is server-side rendered on X, TikTok, and public Instagram posts
    const match = html.match(/<meta(?:\s+[^>]*?)?\sproperty="og:description"\s+content="([^"]+)"/i)
                || html.match(/<meta(?:\s+[^>]*?)?\scontent="([^"]+)"\s+property="og:description"/i);
    if (!match) return null;
    return decodeHtmlEntities(match[1]);
  } catch { return null; }
}

// --- Claude evaluation ---

async function evaluateWithClaude(site, contentUrl, reason, youtubeData, thumbnailBase64) {
  const { apiKey = '' } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    return { approved: false, reason: 'No Anthropic API key configured. Open the extension popup → Settings.' };
  }

  let promptText;

  if (site === 'youtube') {
    const { title, channelName, description, tags, transcript } = youtubeData;
    const lines = [
      'A user wants to access YouTube during a scheduled focus/work block.',
      '',
      `Video: "${title || 'Unknown title'}"`,
      channelName ? `Channel: ${channelName}` : null,
      `URL: ${contentUrl}`,
      description ? `\nDescription:\n${description.slice(0, 600)}` : null,
      tags?.length ? `\nTags: ${tags.slice(0, 10).join(', ')}` : null,
      transcript ? `\nTranscript (first 5 min):\n${transcript.slice(0, 3000)}` : null,
      '',
      `User's stated reason: "${reason || 'No reason provided'}"`,
      '',
      'APPROVE if: programming/tech tutorials, academic lectures, technical walkthroughs, language learning, professional skill courses, guided workouts, guided yoga, guided meditation.',
      'REJECT if: entertainment, gaming, vlogs, music videos, comedy, sports highlights, reaction videos, "study with me" ambiance, vague reasons.',
      thumbnailBase64 ? '\nThe thumbnail image is provided above — use it as an additional signal.' : null,
      '',
      'Be strict. When in doubt, reject. Respond ONLY with valid JSON:',
      '{"approved": true/false, "reason": "one concise sentence"}'
    ].filter(l => l !== null).join('\n');
    promptText = lines;
  } else if (site === 'x') {
    const { socialText, username } = youtubeData;
    promptText = [
      'A user wants to access X (Twitter) during a scheduled focus/work block.',
      '',
      contentUrl ? `Tweet URL: ${contentUrl}` : 'No specific tweet URL provided.',
      username ? `Account: @${username}` : null,
      socialText ? `\nTweet content: "${socialText}"` : null,
      '',
      `User's stated reason: "${reason || 'No reason provided'}"`,
      '',
      'X/Twitter is a social media platform. Be very strict.',
      'APPROVE only if: checking a specific official announcement from a tool/company relevant to active work, a specific technical thread directly needed right now.',
      'REJECT if: general browsing, news, entertainment, vague reasons, social interaction, anything that could wait.',
      '',
      'Respond ONLY with valid JSON: {"approved": true/false, "reason": "one concise sentence"}'
    ].filter(Boolean).join('\n');

  } else if (site === 'instagram') {
    const { socialText, username } = youtubeData;
    promptText = [
      'A user wants to access Instagram during a scheduled focus/work block.',
      '',
      contentUrl ? `Post URL: ${contentUrl}` : 'No specific post URL provided.',
      username ? `Account: @${username}` : null,
      socialText ? `\nPost caption: "${socialText}"` : null,
      '',
      `User's stated reason: "${reason || 'No reason provided'}"`,
      '',
      'Instagram is a social media platform primarily for entertainment and personal content. Be very strict.',
      'APPROVE only if: a specific post directly needed for active work (e.g. a client\'s design reference, a product specification, a work-related infographic).',
      'REJECT if: general browsing, entertainment, influencer content, personal posts, anything not immediately required for work.',
      '',
      'Respond ONLY with valid JSON: {"approved": true/false, "reason": "one concise sentence"}'
    ].filter(Boolean).join('\n');

  } else if (site === 'tiktok') {
    const { socialText, username } = youtubeData;
    promptText = [
      'A user wants to access TikTok during a scheduled focus/work block.',
      '',
      contentUrl ? `Video URL: ${contentUrl}` : 'No specific video URL provided.',
      username ? `Creator: @${username}` : null,
      socialText ? `\nVideo caption: "${socialText}"` : null,
      '',
      `User's stated reason: "${reason || 'No reason provided'}"`,
      '',
      'TikTok is primarily an entertainment platform with short-form videos. Be extremely strict.',
      'APPROVE only if: a clearly technical or educational video (e.g. a specific coding demo, a verified professional tutorial) that cannot be found elsewhere.',
      'REJECT if: entertainment, trends, challenges, vlogs, music, comedy, anything vague, or anything that could wait until after the focus block.',
      '',
      'Respond ONLY with valid JSON: {"approved": true/false, "reason": "one concise sentence"}'
    ].filter(Boolean).join('\n');

  } else {
    // LinkedIn feed
    const { socialText } = youtubeData;
    const isSpecificPost = contentUrl && /\/feed\/update\//.test(contentUrl);
    promptText = [
      'A user wants to access the LinkedIn feed during a scheduled focus/work block.',
      '',
      isSpecificPost ? `Post URL: ${contentUrl}` : 'No specific post URL provided — user wants general feed access.',
      socialText ? `\nPost content: "${socialText}"` : null,
      '',
      `User's stated reason: "${reason || 'No reason provided'}"`,
      '',
      'The LinkedIn feed is a social media feed full of career updates, motivational posts, and engagement bait. Be strict.',
      'APPROVE only if: a specific post directly relevant to an active work task (e.g. a technical article, a tool announcement, a job posting they need to act on right now).',
      'REJECT if: general browsing, motivational content, news, networking for its own sake, vague reasons, or no specific post provided.',
      '',
      'Respond ONLY with valid JSON: {"approved": true/false, "reason": "one concise sentence"}'
    ].filter(Boolean).join('\n');
  }

  const content = [];
  if (thumbnailBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumbnailBase64 } });
  }
  content.push({ type: 'text', text: promptText });

  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { approved: false, reason: `Claude API error (${res.status}): ${err.error?.message || res.statusText}` };
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { approved: !!parsed.approved, reason: parsed.reason || '' };
    }
    return { approved: false, reason: "Couldn't parse Claude's response. Please try again." };
  } catch (e) {
    return { approved: false, reason: `Network error: ${e.message}` };
  }
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, sender, respond) => {

  if (msg.type === 'CHECK_BLOCKED') {
    (async () => {
      const bank = await getBankState();
      const blocked = !bank.bypassEndsAt
        && await isCurrentlyBlocked()
        && !(await isApproved(msg.url, msg.site || 'youtube'));
      respond({ blocked, ...bank });
    })();
    return true;
  }

  if (msg.type === 'START_BYPASS') {
    startBypass().then(respond);
    return true;
  }

  if (msg.type === 'END_BYPASS') {
    endBypass().then(respond);
    return true;
  }

  if (msg.type === 'REQUEST_ACCESS') {
    (async () => {
      const site = msg.site || 'youtube';
      const contentUrl = msg.contentUrl;
      const { googleApiKey = '' } = await chrome.storage.local.get('googleApiKey');

      let contentData = {};
      let thumbnailBase64 = null;

      if (site === 'youtube') {
        const videoId = contentUrl ? extractYouTubeId(contentUrl) : null;
        const [ytData, thumb, transcript] = await Promise.all([
          contentUrl ? getYouTubeData(contentUrl, videoId, googleApiKey) : Promise.resolve({ title: '', channelName: '', description: '', tags: [] }),
          videoId ? getYouTubeThumbnail(videoId) : Promise.resolve(null),
          videoId ? getYouTubeTranscript(videoId) : Promise.resolve(null)
        ]);
        contentData = { ...ytData, transcript };
        thumbnailBase64 = thumb;
      } else {
        // X, Instagram, TikTok — scrape og:description + extract username from URL
        const socialText = contentUrl ? await getSocialContent(contentUrl) : null;
        let username = null;
        try {
          const u = new URL(contentUrl || '');
          const parts = u.pathname.split('/').filter(Boolean);
          // X: /username/status/...  Instagram: /username/ or /p/...  TikTok: /@username/...
          const raw = parts[0] || '';
          username = raw.startsWith('@') ? raw.slice(1) : raw || null;
        } catch {}
        contentData = { socialText, username };
      }

      const result = await evaluateWithClaude(site, contentUrl, msg.reason, contentData, thumbnailBase64);

      if (result.approved && contentUrl) {
        const contentId = extractContentId(contentUrl, site);
        if (contentId) {
          const { approvedContent = [] } = await chrome.storage.local.get('approvedContent');
          if (!approvedContent.some(c => c.id === contentId && c.site === site)) {
            approvedContent.push({
              id: contentId,
              site,
              url: contentUrl,
              title: contentData.title || contentData.socialText?.slice(0, 80) || contentUrl,
              reason: msg.reason,
              approvedAt: Date.now()
            });
            await chrome.storage.local.set({ approvedContent });
          }
        }
      }

      respond({ ...result, contentTitle: contentData.title || contentData.socialText?.slice(0, 80) || '' });
    })();
    return true;
  }

  if (msg.type === 'GET_DATA') {
    (async () => {
      const data = await chrome.storage.local.get(['schedules', 'approvedContent', 'apiKey', 'googleApiKey']);
      // Backwards-compat: merge old approvedVideos into approvedContent if present
      if (data.approvedVideos?.length && !data.approvedContent?.length) {
        data.approvedContent = data.approvedVideos.map(v => ({ ...v, site: 'youtube' }));
      }
      respond({ ...data, ...(await getBankState()) });
    })();
    return true;
  }

  if (msg.type === 'SAVE_SCHEDULES') {
    chrome.storage.local.set({ schedules: msg.schedules }, () => respond({ ok: true }));
    return true;
  }

  if (msg.type === 'SAVE_API_KEY') {
    chrome.storage.local.set({ apiKey: msg.apiKey }, () => respond({ ok: true }));
    return true;
  }

  if (msg.type === 'SAVE_GOOGLE_API_KEY') {
    chrome.storage.local.set({ googleApiKey: msg.googleApiKey }, () => respond({ ok: true }));
    return true;
  }

  if (msg.type === 'CLEAR_APPROVED') {
    chrome.storage.local.set({ approvedContent: [] }, () => respond({ ok: true }));
    return true;
  }

  if (msg.type === 'REMOVE_APPROVED') {
    (async () => {
      const { approvedContent = [] } = await chrome.storage.local.get('approvedContent');
      await chrome.storage.local.set({
        approvedContent: approvedContent.filter(c => !(c.id === msg.contentId && c.site === msg.site))
      });
      respond({ ok: true });
    })();
    return true;
  }
});
