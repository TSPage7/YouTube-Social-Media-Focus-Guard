// Detect which site we're on
const onYouTube   = location.hostname.includes('youtube.com');
const onX         = location.hostname.includes('x.com') || location.hostname.includes('twitter.com');
const onInstagram = location.hostname.includes('instagram.com');
const onTikTok    = location.hostname.includes('tiktok.com');
const onLinkedIn  = location.hostname.includes('linkedin.com');

const SITE = onYouTube ? 'youtube' : onX ? 'x' : onInstagram ? 'instagram' : onTikTok ? 'tiktok' : 'linkedin';

const SITE_CONFIG = {
  youtube: {
    name: 'YouTube',
    icon: '🎬',
    urlLabel: 'Video URL',
    urlPlaceholder: 'https://www.youtube.com/watch?v=...',
    reasonPlaceholder: 'e.g. This is a React hooks tutorial I need for my current project task...',
    subtitle: 'Paste your video link and explain why you need it — Claude will check the title, thumbnail, description, and transcript to decide.',
  },
  x: {
    name: 'X (Twitter)',
    icon: '🐦',
    urlLabel: 'Tweet URL (optional)',
    urlPlaceholder: 'https://x.com/username/status/...',
    reasonPlaceholder: 'e.g. Need to check an official announcement from a tool I use for work...',
    subtitle: 'Paste the specific tweet you need and explain why — Claude will evaluate if it\'s work-related.',
  },
  instagram: {
    name: 'Instagram',
    icon: '📸',
    urlLabel: 'Post / Reel URL (optional)',
    urlPlaceholder: 'https://www.instagram.com/p/... or /reel/...',
    reasonPlaceholder: 'e.g. Need to check a product post relevant to a project I\'m working on...',
    subtitle: 'Paste the specific post you need and explain why — Claude will evaluate if it\'s work-related.',
  },
  tiktok: {
    name: 'TikTok',
    icon: '🎵',
    urlLabel: 'Video URL (optional)',
    urlPlaceholder: 'https://www.tiktok.com/@username/video/...',
    reasonPlaceholder: 'e.g. This is a coding tutorial shared by a developer I follow...',
    subtitle: 'Paste the specific video you need and explain why — Claude will evaluate if it\'s genuinely productive.',
  },
  linkedin: {
    name: 'LinkedIn Feed',
    icon: '💼',
    urlLabel: 'Post URL (optional)',
    urlPlaceholder: 'https://www.linkedin.com/feed/update/urn:li:activity:...',
    reasonPlaceholder: 'e.g. Need to check a specific post about an industry tool relevant to my current project...',
    subtitle: 'The LinkedIn feed is blocked. Paste a specific post link and your reason — Claude will decide if it\'s worth your focus time.',
  },
}[SITE];

let blockOverlay = null;
let lastUrl = location.href;
let isChecking = false;
let videoPlayListener = null;
let videoMutationObserver = null;
let bypassPill = null;
let bypassEndsAt = null;
const intervals = [];

const DAILY_BANK_MS = 60 * 60 * 1000;

// YouTube: only block watch/shorts. LinkedIn: only block /feed/*. Others: block entire site.
function isBlockablePage(url) {
  try {
    const u = new URL(url);
    if (onYouTube) {
      if (u.pathname === '/watch' && u.searchParams.has('v')) return true;
      if (/^\/shorts\/[^/?&#]+/.test(u.pathname)) return true;
      return false;
    }
    if (onLinkedIn) {
      return /^\/feed(\/|$)/.test(u.pathname);
    }
    // X, Instagram, TikTok — block the whole site
    return true;
  } catch {}
  return false;
}

// Pre-fill the URL field when already on a specific content page
function getPrefilledUrl(url) {
  try {
    const u = new URL(url);
    if (onYouTube && (u.pathname === '/watch' || /^\/shorts\//.test(u.pathname))) return url;
    if (onX && /\/status\/\d+/.test(u.pathname)) return url;
    if (onInstagram && /^\/(p|reel|stories)\//.test(u.pathname)) return url;
    if (onTikTok && /\/@[^/?#]+\/video\/\d+/.test(u.pathname)) return url;
    if (onLinkedIn && /^\/feed\/update\//.test(u.pathname)) return url;
  } catch {}
  return '';
}

async function checkBlock() {
  if (isChecking) return;

  isChecking = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'CHECK_BLOCKED',
      url: location.href,
      site: SITE
    });
    // The pill shows on every page of the site while a bypass runs, since time is draining
    updateBypassPill(resp?.bypassEndsAt || null);
    if (resp?.blocked && isBlockablePage(location.href)) {
      showBlock(resp.remainingMs);
    } else {
      hideBlock();
    }
  } catch {
    teardownIfOrphaned();
  } finally {
    isChecking = false;
  }
}

function showBlock(remainingMs) {
  if (blockOverlay) {
    // Already showing — update URL field if we navigated to a specific page
    const urlInput = blockOverlay.querySelector('#yfg-url');
    if (urlInput && !urlInput.value) {
      urlInput.value = getPrefilledUrl(location.href);
    }
    updateBypassButton(remainingMs);
    return;
  }

  const prefillUrl = getPrefilledUrl(location.href);
  const cfg = SITE_CONFIG;

  blockOverlay = document.createElement('div');
  blockOverlay.id = 'yfg-block-overlay';
  blockOverlay.innerHTML = `
    <style>
      #yfg-block-overlay {
        position: fixed;
        inset: 0;
        background: #0f0f0f;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #fff;
      }
      #yfg-block-overlay * { box-sizing: border-box; margin: 0; padding: 0; }
      #yfg-card {
        background: #1a1a1a;
        border: 1px solid #2a2a2a;
        border-radius: 16px;
        padding: 40px 36px;
        max-width: 520px;
        width: 90%;
        text-align: center;
      }
      #yfg-icon { font-size: 52px; margin-bottom: 14px; display: block; }
      #yfg-title { font-size: 22px; font-weight: 700; color: #fff; margin-bottom: 10px; }
      #yfg-subtitle { font-size: 14px; color: #888; line-height: 1.6; margin-bottom: 28px; }
      #yfg-form { text-align: left; }
      .yfg-field { margin-bottom: 16px; }
      .yfg-label {
        display: block; font-size: 12px; font-weight: 600; color: #aaa;
        text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 7px;
      }
      .yfg-input, .yfg-textarea {
        width: 100%; background: #111; border: 1px solid #2a2a2a; border-radius: 8px;
        padding: 10px 14px; color: #fff; font-size: 14px; outline: none;
        transition: border-color 0.15s; font-family: inherit;
      }
      .yfg-input:focus, .yfg-textarea:focus { border-color: #ff4444; }
      .yfg-input::placeholder, .yfg-textarea::placeholder { color: #444; }
      .yfg-textarea { resize: vertical; min-height: 84px; }
      #yfg-submit {
        width: 100%; padding: 13px; background: #ff0000; color: #fff; border: none;
        border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer;
        transition: background 0.15s; font-family: inherit; margin-top: 4px;
      }
      #yfg-submit:hover:not(:disabled) { background: #cc0000; }
      #yfg-submit:disabled { opacity: 0.4; cursor: not-allowed; }
      #yfg-loading {
        display: none; color: #888; font-size: 14px; margin-top: 20px;
        text-align: center; align-items: center; justify-content: center; gap: 10px;
      }
      #yfg-spinner {
        width: 18px; height: 18px; border: 2px solid #333; border-top-color: #ff0000;
        border-radius: 50%; animation: yfg-spin 0.75s linear infinite; flex-shrink: 0;
      }
      @keyframes yfg-spin { to { transform: rotate(360deg); } }
      #yfg-result {
        display: none; margin-top: 16px; padding: 14px 16px; border-radius: 8px;
        font-size: 14px; line-height: 1.55; text-align: left;
      }
      #yfg-result.yfg-approved {
        background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.25); color: #4ade80;
      }
      #yfg-result.yfg-rejected {
        background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); color: #f87171;
      }
      #yfg-retry-btn {
        display: inline-block; margin-top: 12px; background: none; border: 1px solid #3a3a3a;
        color: #888; padding: 7px 16px; border-radius: 6px; cursor: pointer;
        font-size: 13px; font-family: inherit; transition: border-color 0.15s, color 0.15s;
      }
      #yfg-retry-btn:hover { border-color: #555; color: #bbb; }
      #yfg-bypass { margin-top: 24px; }
      #yfg-or {
        display: flex; align-items: center; gap: 12px; color: #555; font-size: 12px;
        text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 16px;
      }
      #yfg-or::before, #yfg-or::after { content: ''; flex: 1; border-top: 1px solid #2a2a2a; }
      #yfg-bypass-btn {
        width: 100%; padding: 11px; background: none; color: #fbbf24;
        border: 1px solid rgba(251,191,36,0.35); border-radius: 8px; font-size: 14px;
        font-weight: 600; cursor: pointer; font-family: inherit;
        transition: background 0.15s, border-color 0.15s;
      }
      #yfg-bypass-btn:hover:not(:disabled) { background: rgba(251,191,36,0.08); border-color: rgba(251,191,36,0.6); }
      #yfg-bypass-btn:disabled { color: #555; border-color: #2a2a2a; cursor: not-allowed; }
      #yfg-bypass-note { font-size: 12px; color: #555; margin-top: 8px; line-height: 1.5; }
    </style>

    <div id="yfg-card">
      <span id="yfg-icon">${cfg.icon}</span>
      <h1 id="yfg-title">${cfg.name} is Blocked</h1>
      <p id="yfg-subtitle">${cfg.subtitle}</p>

      <form id="yfg-form">
        <div class="yfg-field">
          <label class="yfg-label" for="yfg-url">${cfg.urlLabel}</label>
          <input id="yfg-url" class="yfg-input" type="url"
            placeholder="${cfg.urlPlaceholder}"
            value="${prefillUrl}" />
        </div>
        <div class="yfg-field">
          <label class="yfg-label" for="yfg-reason">Why do you need this?</label>
          <textarea id="yfg-reason" class="yfg-textarea"
            placeholder="${cfg.reasonPlaceholder}"></textarea>
        </div>
        <button type="submit" id="yfg-submit">Ask Claude</button>
      </form>

      <div id="yfg-loading">
        <div id="yfg-spinner"></div>
        Fetching content info and asking Claude…
      </div>
      <div id="yfg-result"></div>

      <div id="yfg-bypass">
        <div id="yfg-or">or</div>
        <button type="button" id="yfg-bypass-btn"></button>
        <p id="yfg-bypass-note">Unblocks every site until the timer runs out. Press End to stop early and save the rest — every blocked tab locks again.</p>
      </div>
    </div>
  `;

  document.documentElement.appendChild(blockOverlay);
  if (document.body) document.body.style.overflow = 'hidden';
  startVideoSuppression();
  updateBypassButton(remainingMs);

  blockOverlay.querySelector('#yfg-bypass-btn').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'START_BYPASS' });
    } catch {}
    checkBlock();
  });

  const form = blockOverlay.querySelector('#yfg-form');
  const loading = blockOverlay.querySelector('#yfg-loading');
  const result = blockOverlay.querySelector('#yfg-result');
  const submitBtn = blockOverlay.querySelector('#yfg-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const contentUrl = blockOverlay.querySelector('#yfg-url').value.trim();
    const reason = blockOverlay.querySelector('#yfg-reason').value.trim();

    form.style.display = 'none';
    loading.style.display = 'flex';
    result.style.display = 'none';
    submitBtn.disabled = true;

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'REQUEST_ACCESS',
        contentUrl: contentUrl || null,
        reason,
        site: SITE
      });

      loading.style.display = 'none';
      result.style.display = 'block';

      if (resp?.approved) {
        result.className = 'yfg-approved';
        result.innerHTML = `<strong>✓ Approved</strong><br>${escapeHtml(resp.reason)}`;
        setTimeout(() => {
          hideBlock();
          if (contentUrl && contentUrl !== location.href) location.href = contentUrl;
        }, 1800);
      } else {
        result.className = 'yfg-rejected';
        result.innerHTML = `
          <strong>✗ Not approved</strong><br>${escapeHtml(resp?.reason || 'Request rejected.')}
          <br><button id="yfg-retry-btn">Try a different request</button>
        `;
        blockOverlay.querySelector('#yfg-retry-btn').addEventListener('click', () => {
          result.style.display = 'none';
          form.style.display = 'block';
          submitBtn.disabled = false;
        });
      }
    } catch (err) {
      loading.style.display = 'none';
      form.style.display = 'block';
      submitBtn.disabled = false;
      result.style.display = 'block';
      result.className = 'yfg-rejected';
      result.textContent = `Error: ${err.message}`;
    }
  });
}

function hideBlock() {
  if (blockOverlay) {
    stopVideoSuppression();
    blockOverlay.remove();
    blockOverlay = null;
    if (document.body) document.body.style.overflow = '';
  }
}

// --- Time bank bypass ---

function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

function updateBypassButton(remainingMs) {
  const btn = blockOverlay?.querySelector('#yfg-bypass-btn');
  if (!btn) return;
  if (remainingMs > 0) {
    btn.disabled = false;
    btn.textContent = `⏱ Bypass — ${formatClock(remainingMs)} left today`;
  } else {
    btn.disabled = true;
    btn.textContent = 'Time bank empty — refills at midnight';
  }
}

function updateBypassPill(endsAt) {
  bypassEndsAt = endsAt;
  if (!endsAt) {
    bypassPill?.remove();
    bypassPill = null;
    return;
  }
  if (!bypassPill) {
    bypassPill = document.createElement('div');
    // Shadow DOM keeps the host site's CSS from restyling the pill
    const root = bypassPill.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .pill {
          position: fixed; left: 20px; bottom: 20px; z-index: 2147483647;
          display: flex; align-items: center; gap: 10px; overflow: hidden;
          padding: 8px 8px 8px 14px; border-radius: 999px;
          background: rgba(15,15,15,0.92); border: 1px solid var(--c);
          box-shadow: 0 4px 16px rgba(0,0,0,0.4);
          font: 600 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #fff; --c: #22c55e;
        }
        .pill.low { --c: #f59e0b; }
        .pill.critical { --c: #ef4444; animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 50% { box-shadow: 0 0 0 4px rgba(239,68,68,0.25); } }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
        .time { font-variant-numeric: tabular-nums; min-width: 38px; }
        .label { color: #888; font-weight: 500; }
        button {
          background: #262626; color: #ccc; border: none; border-radius: 999px;
          padding: 5px 11px; font: inherit; font-size: 12px; cursor: pointer;
        }
        button:hover { background: #333; color: #fff; }
        .bar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--c); }
      </style>
      <div class="pill">
        <span class="dot"></span>
        <span class="label">Bypass</span>
        <span class="time"></span>
        <button type="button" title="Stop the timer, keep the remaining time, and re-lock every blocked tab">End</button>
        <div class="bar"></div>
      </div>
    `;
    root.querySelector('button').addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'END_BYPASS' });
      } catch {}
      checkBlock();
    });
    document.documentElement.appendChild(bypassPill);
  }
  renderBypassPill();
}

function renderBypassPill() {
  if (!bypassPill || !bypassEndsAt) return;
  const ms = bypassEndsAt - Date.now();
  if (ms <= 0) {
    updateBypassPill(null);
    checkBlock();
    return;
  }
  const root = bypassPill.shadowRoot;
  const pill = root.querySelector('.pill');
  pill.classList.toggle('low', ms <= 5 * 60_000 && ms > 60_000);
  pill.classList.toggle('critical', ms <= 60_000);
  root.querySelector('.time').textContent = formatClock(ms);
  root.querySelector('.bar').style.width = `${(ms / DAILY_BANK_MS) * 100}%`;
}

// After the extension reloads, this copy can't reach the background anymore and a fresh copy has
// been injected in its place. Remove everything this copy added so the two don't fight.
function teardownIfOrphaned() {
  if (chrome.runtime?.id) return false;
  intervals.forEach(clearInterval);
  bypassPill?.remove();
  blockOverlay?.remove();
  if (videoPlayListener) document.removeEventListener('play', videoPlayListener, true);
  videoMutationObserver?.disconnect();
  if (document.body && !document.getElementById('yfg-block-overlay')) document.body.style.overflow = '';
  return true;
}

intervals.push(setInterval(() => {
  if (!teardownIfOrphaned()) renderBypassPill();
}, 1000));

// Background tells every tab when a bypass starts, ends, or runs out. Replying tells the background
// this tab has a live script, so it doesn't inject a second copy.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'BYPASS_CHANGED') {
    checkBlock();
    respond({ ok: true });
  }
});

// --- Video suppression ---

function suppressVideo(v) {
  if (!v.paused) v.pause();
  v.muted = true;
  v.volume = 0;
}

function startVideoSuppression() {
  // Pause anything already playing
  document.querySelectorAll('video').forEach(suppressVideo);

  // Intercept every future play() call at the capture phase — fires before the video plays
  videoPlayListener = (e) => {
    if (e.target instanceof HTMLVideoElement) suppressVideo(e.target);
  };
  document.addEventListener('play', videoPlayListener, true);

  // Watch for video elements injected into the DOM after the overlay appears
  videoMutationObserver = new MutationObserver(() => {
    document.querySelectorAll('video').forEach(suppressVideo);
  });
  videoMutationObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopVideoSuppression() {
  if (videoPlayListener) {
    document.removeEventListener('play', videoPlayListener, true);
    videoPlayListener = null;
  }
  if (videoMutationObserver) {
    videoMutationObserver.disconnect();
    videoMutationObserver = null;
  }
  // Restore audio so the approved video can play normally
  document.querySelectorAll('video').forEach(v => {
    v.muted = false;
    v.volume = 1;
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Navigation monitoring ---

// YouTube: SPA navigation event
document.addEventListener('yt-navigate-finish', () => {
  lastUrl = location.href;
  checkBlock();
});

// X / general: popstate (back/forward)
window.addEventListener('popstate', () => {
  lastUrl = location.href;
  checkBlock();
});

// Fallback: poll every second for URL changes (catches pushState)
intervals.push(setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    checkBlock();
  }
}, 1000));

// Recheck every 60s to catch schedule start/end while page is open
intervals.push(setInterval(checkBlock, 60_000));

// Initial check
checkBlock();
