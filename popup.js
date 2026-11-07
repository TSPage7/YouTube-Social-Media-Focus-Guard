const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

let selectedDays = new Set();
let schedules = [];
let approvedContent = [];
let bankRemainingMs = 0;
let bypassEndsAt = null;
let otherDevicesMs = 0;

const DAILY_BANK_MS = 60 * 60 * 1000;

const SITE_LABELS = { youtube: '▶ YouTube', x: '✕ X', instagram: '📸 Instagram', tiktok: '🎵 TikTok', linkedin: '💼 LinkedIn' };

// --- Tab switching ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Day selector ---
document.querySelectorAll('.day-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const day = Number(btn.dataset.day);
    if (selectedDays.has(day)) {
      selectedDays.delete(day);
      btn.classList.remove('selected');
    } else {
      selectedDays.add(day);
      btn.classList.add('selected');
    }
  });
});

// --- Load data on open ---
async function loadData() {
  const data = await sendMsg({ type: 'GET_DATA' });
  schedules = data.schedules || [];
  approvedContent = data.approvedContent || [];
  bankRemainingMs = data.remainingMs ?? DAILY_BANK_MS;
  bypassEndsAt = data.bypassEndsAt || null;
  otherDevicesMs = data.otherDevicesMs || 0;

  if (data.apiKey) {
    document.getElementById('api-key-input').value = data.apiKey;
  }
  if (data.googleApiKey) {
    document.getElementById('google-key-input').value = data.googleApiKey;
  }

  renderSchedules();
  renderApproved();
  updateBlockStatus();
  renderBank();
}

// --- Time bank ---
function renderBank() {
  const ms = bypassEndsAt ? Math.max(0, bypassEndsAt - Date.now()) : bankRemainingMs;
  const totalSec = Math.ceil(ms / 1000);
  const active = !!bypassEndsAt && ms > 0;

  document.getElementById('bank-time').textContent =
    `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
  document.getElementById('bank-bar-fill').style.width = `${(ms / DAILY_BANK_MS) * 100}%`;
  document.getElementById('bank-label').textContent = active ? 'Bypass running' : 'Daily time bank';
  document.querySelector('.bank-card').classList.toggle('active', active);
  document.getElementById('end-bypass-btn').style.display = active ? 'block' : 'none';
  const otherMins = Math.round(otherDevicesMs / 60_000);
  document.getElementById('bank-sub').textContent =
    otherMins > 0 ? `Includes ${otherMins} min used on your other computers today` : '';

  if (active) {
    const headerStatus = document.getElementById('header-status');
    headerStatus.textContent = 'Bypass';
    headerStatus.className = 'header-status status-bypass';
  } else if (bypassEndsAt) {
    // Ran out while the popup was open
    bypassEndsAt = null;
    bankRemainingMs = 0;
    updateBlockStatus();
  }
}

setInterval(() => { if (bypassEndsAt) renderBank(); }, 1000);

document.getElementById('end-bypass-btn').addEventListener('click', async () => {
  const state = await sendMsg({ type: 'END_BYPASS' });
  bankRemainingMs = state.remainingMs;
  bypassEndsAt = state.bypassEndsAt;
  otherDevicesMs = state.otherDevicesMs || 0;
  updateBlockStatus();
  renderBank();
});

function updateBlockStatus() {
  const now = new Date();
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();

  const isBlocked = schedules.some(s => {
    if (!s.days.includes(day)) return false;
    const [sh, sm] = s.startTime.split(':').map(Number);
    const [eh, em] = s.endTime.split(':').map(Number);
    return mins >= sh * 60 + sm && mins < eh * 60 + em;
  });

  const headerStatus = document.getElementById('header-status');
  const badge = document.getElementById('block-status-badge');
  const badgeText = document.getElementById('block-status-text');

  if (isBlocked) {
    headerStatus.textContent = 'Blocked';
    headerStatus.className = 'header-status status-blocked';
    badge.className = 'block-badge active';
    badgeText.textContent = 'YouTube, X, Instagram & TikTok are blocked';
  } else {
    headerStatus.textContent = 'Free';
    headerStatus.className = 'header-status status-free';
    badge.className = 'block-badge inactive';
    badgeText.textContent = 'All sites are currently free';
  }
}

// --- Schedule rendering ---
function renderSchedules() {
  const list = document.getElementById('schedule-list');
  if (!schedules.length) {
    list.innerHTML = '<div class="empty-state">No schedules yet</div>';
    return;
  }
  list.innerHTML = schedules.map((s, i) => {
    const dayLabels = s.days
      .slice()
      .sort((a, b) => a - b)
      .map(d => DAY_NAMES[d])
      .join(', ');
    return `
      <div class="schedule-item">
        <div class="schedule-info">
          <div class="schedule-days">${dayLabels}</div>
          <div class="schedule-time">${fmt12(s.startTime)} – ${fmt12(s.endTime)}</div>
        </div>
        <button class="del-btn" data-index="${i}" title="Remove">✕</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteSchedule(Number(btn.dataset.index)));
  });
}

function fmt12(time24) {
  const [h, m] = time24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// --- Add schedule ---
document.getElementById('add-schedule-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('schedule-error');
  errEl.textContent = '';

  if (!selectedDays.size) {
    errEl.textContent = 'Select at least one day.';
    return;
  }

  const start = document.getElementById('start-time').value;
  const end = document.getElementById('end-time').value;

  if (!start || !end) {
    errEl.textContent = 'Set both start and end times.';
    return;
  }

  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (sh * 60 + sm >= eh * 60 + em) {
    errEl.textContent = 'Start time must be before end time.';
    return;
  }

  schedules.push({ days: [...selectedDays], startTime: start, endTime: end });
  await sendMsg({ type: 'SAVE_SCHEDULES', schedules });

  // Reset form
  selectedDays.clear();
  document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('selected'));

  renderSchedules();
  updateBlockStatus();
});

async function deleteSchedule(index) {
  schedules.splice(index, 1);
  await sendMsg({ type: 'SAVE_SCHEDULES', schedules });
  renderSchedules();
  updateBlockStatus();
}

// --- Approved content ---
function renderApproved() {
  const list = document.getElementById('approved-list');
  if (!approvedContent.length) {
    list.innerHTML = '<div class="empty-state">No approved content this session</div>';
    return;
  }

  list.innerHTML = approvedContent.map(c => {
    const timeStr = new Date(c.approvedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const title = c.title || c.url || c.id;
    const reason = c.reason ? `"${c.reason}"` : '';
    const siteLabel = SITE_LABELS[c.site] || c.site;
    return `
      <div class="approved-item">
        <div class="approved-info">
          <div class="approved-title" title="${escHtml(c.title || c.url)}">
            <span style="color:#555;font-size:10px;margin-right:5px;">${escHtml(siteLabel)}</span>${escHtml(title)}
          </div>
          ${reason ? `<div class="approved-reason">${escHtml(reason)}</div>` : ''}
          <div class="approved-time">Approved at ${timeStr}</div>
        </div>
        <button class="del-btn" data-id="${escHtml(c.id)}" data-site="${escHtml(c.site)}" title="Remove">✕</button>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => removeApproved(btn.dataset.id, btn.dataset.site));
  });
}

async function removeApproved(contentId, site) {
  await sendMsg({ type: 'REMOVE_APPROVED', contentId, site });
  approvedContent = approvedContent.filter(c => !(c.id === contentId && c.site === site));
  renderApproved();
}

document.getElementById('clear-approved-btn').addEventListener('click', async () => {
  await sendMsg({ type: 'CLEAR_APPROVED' });
  approvedContent = [];
  renderApproved();
});

// --- API key ---
document.getElementById('save-key-btn').addEventListener('click', async () => {
  const key = document.getElementById('api-key-input').value.trim();
  const indicator = document.getElementById('save-indicator');

  if (!key) {
    indicator.style.color = '#f87171';
    indicator.textContent = 'Please enter an API key.';
    return;
  }
  if (!key.startsWith('sk-ant-')) {
    indicator.style.color = '#f87171';
    indicator.textContent = 'Key should start with sk-ant-';
    return;
  }

  await sendMsg({ type: 'SAVE_API_KEY', apiKey: key });
  indicator.style.color = '#4ade80';
  indicator.textContent = '✓ Saved';
  setTimeout(() => { indicator.textContent = ''; }, 2500);
});

// --- Helpers ---
function sendMsg(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Google API key ---
document.getElementById('save-google-key-btn').addEventListener('click', async () => {
  const key = document.getElementById('google-key-input').value.trim();
  const indicator = document.getElementById('save-google-indicator');

  if (key && !key.startsWith('AIza')) {
    indicator.style.color = '#f87171';
    indicator.textContent = 'Key should start with AIza';
    return;
  }

  await sendMsg({ type: 'SAVE_GOOGLE_API_KEY', googleApiKey: key });
  indicator.style.color = '#4ade80';
  indicator.textContent = key ? '✓ Saved' : '✓ Cleared';
  setTimeout(() => { indicator.textContent = ''; }, 2500);
});

// Boot
loadData();
