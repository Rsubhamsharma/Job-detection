const DEFAULT_BASE_URL = 'http://localhost:8000';
const AUTH_STORAGE_KEY = 'aesdAuth';
const API_URL_STORAGE_KEY = 'aesdApiUrl';
const SIGNAL_QUEUE_KEY = 'aesdSignalQueue';
const SYNC_STATE_KEY = 'aesdSyncState';
const CAPTURED_COUNT_KEY = 'aesdCapturedSignalCount';
const SYNC_ALARM_NAME = 'aesdSignalSync';
const MAX_QUEUE_SIZE = 500;
const RETRY_DELAY_MS = 15000;
const VALID_SIGNAL_TYPES = new Set([
    'page_visit',
    'time_spent',
    'scroll_depth',
    'apply_click',
    'easy_apply_click',
    'application_submitted',
    'external_apply_redirect',
    'form_interaction',
    'resume_upload',
    'cover_letter_detected',
    'repeated_visit',
    'saved_job',
    'employer_response_detected',
    'interview_detected',
    'rejection_detected',
    'assessment_detected',
    'no_response_after_delay',
    'status_change_detected',
    'email_response_detected',
]);

const GENERIC_TITLES = new Set(['', 'unknown', 'unknown job', 'linkedin', 'jobs', 'jobs | linkedin', 'search results', 'job search', 'debug job', 'jobzoid']);
const GENERIC_COMPANIES = new Set(['', 'unknown', 'unknown company', 'debug company', 'localhost', 'linkedin', 'google', 'jobzoid']);
const IGNORED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'jobzoid']);
const IGNORED_PLATFORMS = new Set(['localhost', '127.0.0.1', '0.0.0.0', 'jobzoid']);

let syncInProgress = false;
let nextSyncAllowedAt = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SIGNAL_EVENT') {
        captureSignal(message.payload).then(sendResponse);
        return true;
    }
    if (message.type === 'SYNC_SIGNALS') {
        syncQueuedSignals({ force: true }).then(sendResponse);
        return true;
    }
    if (message.type === 'GET_SYNC_STATUS') {
        getSyncStatus().then(sendResponse);
        return true;
    }
    if (message.type === 'GET_SCORE') {
        fetchScore(message.payload).then(sendResponse);
        return true;
    }
    if (message.type === 'EXTENSION_LOGIN') {
        loginExtension(message.payload).then(async (response) => {
            if (response.ok) {
                await syncQueuedSignals({ force: true });
            }
            sendResponse(response);
        });
        return true;
    }
    if (message.type === 'GET_AUTH_STATUS') {
        getAuthState().then(async (auth) => sendResponse({
            authenticated: !!auth?.token,
            user: auth?.user || null,
            sync: await getSyncStatus(),
        }));
        return true;
    }
    if (message.type === 'EXTENSION_LOGOUT') {
        chrome.storage.local.remove(AUTH_STORAGE_KEY, async () => {
            await setSyncState({ status: 'Login required to sync signals', lastError: null });
            sendResponse({ ok: true });
        });
        return true;
    }
    if (message.type === 'GET_SETTINGS') {
        getBaseUrl().then((baseUrl) => sendResponse({ baseUrl }));
        return true;
    }
    if (message.type === 'SAVE_SETTINGS') {
        saveSettings(message.payload).then(sendResponse);
        return true;
    }
});

chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM_NAME) {
        syncQueuedSignals();
    }
});

chrome.runtime.onStartup?.addListener(() => {
    syncQueuedSignals();
});

chrome.runtime.onInstalled?.addListener(() => {
    syncQueuedSignals();
});

async function getBaseUrl() {
    const stored = await chrome.storage.local.get(API_URL_STORAGE_KEY);
    const baseUrl = sanitizeBaseUrl(stored[API_URL_STORAGE_KEY] || DEFAULT_BASE_URL);
    if (baseUrl !== stored[API_URL_STORAGE_KEY]) {
        await chrome.storage.local.set({ [API_URL_STORAGE_KEY]: baseUrl });
    }
    return baseUrl;
}

async function saveSettings(payload = {}) {
    const baseUrl = sanitizeBaseUrl(payload.baseUrl || DEFAULT_BASE_URL);
    if (!/^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(baseUrl)) {
        return { ok: false, error: 'Enter a valid backend URL, for example http://localhost:8000' };
    }
    await chrome.storage.local.set({ [API_URL_STORAGE_KEY]: baseUrl });
    return { ok: true, baseUrl };
}

function sanitizeBaseUrl(value) {
    const raw = String(value || DEFAULT_BASE_URL).trim();
    try {
        const url = new URL(raw.startsWith('http') ? raw : `http://${raw}`);
        if (['localhost', '127.0.0.1'].includes(url.hostname) && (!url.port || url.port === '3000')) {
            url.port = '8000';
        }
        url.pathname = url.pathname.replace(/\/api\/?$/i, '') || '/';
        url.search = '';
        url.hash = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return DEFAULT_BASE_URL;
    }
}

async function getAuthState() {
    const stored = await chrome.storage.local.get(AUTH_STORAGE_KEY);
    return stored[AUTH_STORAGE_KEY] || null;
}

async function getQueue() {
    const stored = await chrome.storage.local.get(SIGNAL_QUEUE_KEY);
    return Array.isArray(stored[SIGNAL_QUEUE_KEY]) ? stored[SIGNAL_QUEUE_KEY] : [];
}

async function saveQueue(queue) {
    await chrome.storage.local.set({ [SIGNAL_QUEUE_KEY]: queue.slice(-MAX_QUEUE_SIZE) });
}

async function incrementCapturedCount() {
    const stored = await chrome.storage.local.get(CAPTURED_COUNT_KEY);
    const nextCount = Number(stored[CAPTURED_COUNT_KEY] || 0) + 1;
    await chrome.storage.local.set({ [CAPTURED_COUNT_KEY]: nextCount });
    return nextCount;
}

async function setSyncState(patch) {
    const stored = await chrome.storage.local.get(SYNC_STATE_KEY);
    const nextState = {
        status: 'Idle',
        lastError: null,
        lastSyncedAt: null,
        ...stored[SYNC_STATE_KEY],
        ...patch,
    };
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: nextState });
    return nextState;
}

async function getSyncStatus() {
    const stored = await chrome.storage.local.get([SIGNAL_QUEUE_KEY, SYNC_STATE_KEY, CAPTURED_COUNT_KEY, AUTH_STORAGE_KEY]);
    const queue = Array.isArray(stored[SIGNAL_QUEUE_KEY]) ? stored[SIGNAL_QUEUE_KEY] : [];
    return {
        capturedCount: Number(stored[CAPTURED_COUNT_KEY] || 0),
        pendingCount: queue.length,
        authenticated: !!stored[AUTH_STORAGE_KEY]?.token,
        status: stored[SYNC_STATE_KEY]?.status || (queue.length ? 'Waiting to sync' : 'Idle'),
        lastError: stored[SYNC_STATE_KEY]?.lastError || null,
        lastSyncedAt: stored[SYNC_STATE_KEY]?.lastSyncedAt || null,
    };
}

async function withAuthHeaders(extraHeaders = {}) {
    const auth = await getAuthState();
    if (!auth?.token) {
        throw new Error('Not authenticated');
    }

    return {
        ...extraHeaders,
        Authorization: `Bearer ${auth.token}`,
    };
}

async function loginExtension(credentials) {
    try {
        const baseUrl = await getBaseUrl();
        const payload = {
            ...credentials,
            email: (credentials?.email || '').trim().toLowerCase(),
        };
        const response = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 404) {
                return { ok: false, error: 'Auth endpoint not found. Please check backend URL.' };
            }
            return { ok: false, error: data.detail || `Login failed (${response.status})` };
        }

        if (!data.access_token) {
            return { ok: false, error: 'Unexpected response format: token missing' };
        }

        const authState = {
            token: data.access_token,
            user: data.user,
        };
        await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: authState });
        return { ok: true, ...authState };
    } catch (error) {
        if (error.message.includes('Failed to fetch') || error.name === 'TypeError') {
            return { ok: false, error: 'Backend unreachable. Check if server is running at localhost:8000' };
        }
        return { ok: false, error: error.message };
    }
}

function extractCompanyName(hostname) {
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return hostname;
}

function normalizeJobUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.hash = '';
    [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_content',
        'utm_term',
        'source',
        'ref',
    ].forEach((param) => url.searchParams.delete(param));
    url.searchParams.sort();
    return url.toString();
}

async function handleSignal(data) {
    const payload = await buildSignalPayload(data);
    return postSignal(payload);
}

async function buildSignalPayload(data = {}) {
    const normalizedJobUrl = normalizeJobUrl(data.jobUrl || data.url);
    const url = new URL(normalizedJobUrl);
    const jobId = data.jobId || await hashString(normalizedJobUrl);
    const eventType = normalizeSignalType(data.eventType || data.signalType || data.type || 'UNKNOWN');
    const metadata = {
        ...(data.metadata || {}),
        platform: data.platform || data.metadata?.platform || url.hostname,
        pageType: data.pageType || data.metadata?.pageType || 'generic',
        source: data.metadata?.source || 'chrome_extension',
    };
    return {
        eventType,
        signalType: eventType,
        jobTitle: data.jobTitle || data.title || 'Unknown Job',
        companyName: data.companyName || data.company || extractCompanyName(url.hostname),
        company: data.companyName || data.company || extractCompanyName(url.hostname),
        jobUrl: normalizedJobUrl,
        jobId,
        hostname: data.hostname || url.hostname,
        platform: data.platform || url.hostname,
        pageType: data.pageType || metadata.pageType,
        location: data.location || metadata.location || '',
        timeSpentSeconds: Number(data.timeSpentSeconds ?? data.timeSpent ?? data.value ?? 0),
        timeSpent: Number(data.timeSpentSeconds ?? data.timeSpent ?? data.value ?? 0),
        scrollDepth: Number(data.scrollDepth ?? data.metadata?.scrollDepth ?? 0),
        metadata,
        timestamp: data.timestamp || Date.now(),
    };
}

function normalizeSignalType(value) {
    const normalized = String(value || 'unknown').trim().toLowerCase();
    return {
        job_page_visit: 'page_visit',
        page_visit: 'page_visit',
        time_spent: 'time_spent',
        scroll_depth: 'scroll_depth',
        apply_click: 'apply_click',
        easy_apply_click: 'easy_apply_click',
        application_submitted: 'application_submitted',
        response: 'employer_response_detected',
        interview: 'interview_detected',
        rejection: 'rejection_detected',
        ack: 'status_change_detected',
    }[normalized] || normalized;
}

function isIgnoredUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return IGNORED_HOSTS.has(url.hostname);
    } catch {
        return true;
    }
}

function isGenericTitle(value) {
    const cleaned = String(value || '').trim().toLowerCase();
    return GENERIC_TITLES.has(cleaned) || cleaned.startsWith('jobs |') || cleaned.endsWith('| linkedin');
}

function isGenericCompany(value) {
    return GENERIC_COMPANIES.has(String(value || '').trim().toLowerCase());
}

function validateSignalPayload(payload) {
  if (!payload) {
    return 'Invalid signal: null payload';
  }
  
  const hostname = payload.hostname || (payload.jobUrl ? new URL(payload.jobUrl).hostname : '');
  const platform = payload.platform || '';
  const company = payload.companyName || payload.company || '';
  const title = payload.jobTitle || payload.title || '';
  const jobUrl = payload.jobUrl || payload.url || '';
  
  if (IGNORED_HOSTS.has(hostname.toLowerCase()) || 
      IGNORED_PLATFORMS.has(platform.toLowerCase()) ||
      IGNORED_HOSTS.has(company.toLowerCase()) ||
      (title && title.toLowerCase().includes('jobzoid')) ||
      (jobUrl && Array.from(IGNORED_HOSTS).some(h => jobUrl.toLowerCase().includes(h)))) {
    console.debug('AESD: Ignored invalid local app signal', { hostname, platform, company, title, jobUrl });
    return 'Invalid signal: localhost/JobZoid detected';
  }
  
  if (!VALID_SIGNAL_TYPES.has(payload.eventType)) {
    return 'Invalid signal type';
  }
  if (isIgnoredUrl(payload.jobUrl) || isGenericTitle(payload.jobTitle)) {
    return 'Invalid job context: generic or incomplete job page';
  }
  if (payload.pageType !== 'job_detail') {
    return 'Invalid job context: generic or incomplete job page';
  }
  if (!payload.jobId || payload.jobId.length < 8 || !payload.jobUrl || !payload.platform) {
    return 'Invalid job context: missing stable job id, URL, or platform';
  }
  if (isGenericTitle(payload.jobTitle) || isGenericCompany(payload.companyName)) {
    return 'Invalid job context: generic or incomplete job page';
  }
  return null;
}

async function captureSignal(data) {
  try {
    console.debug('AESD background: signal received from content', data);
    const payload = await buildSignalPayload(data);
    const validationError = validateSignalPayload(payload);
    if (validationError) {
      if (validationError.includes('localhost') || validationError.includes('JobZoid')) {
        console.debug('AESD background: Rejected invalid localhost/JobZoid signal', { jobId: payload.jobId, error: validationError });
      }
      await setSyncState({ status: validationError, lastError: null });
      return { ok: false, discarded: true, error: validationError };
    }
    const queue = await getQueue();
    queue.push({ 
      id: `${payload.jobId}-${payload.eventType}-${payload.timestamp}-${Math.random().toString(16).slice(2)}`,
      payload, 
      attempts: 0, 
      capturedAt: Date.now(), 
    });
    await saveQueue(queue);
    await incrementCapturedCount();
    await setSyncState({ status: 'Queued signal for sync' });
    console.debug('AESD background: signal accepted locally', { jobId: payload.jobId, eventType: payload.eventType });
    const syncStatus = await syncQueuedSignals({ force: true });
    
    if (payload.eventType === 'apply_click' || payload.eventType === 'easy_apply_click' || payload.eventType === 'application_submitted') {
      console.debug('AESD background: apply_click jobId', payload.jobId);
    }
    
    return { ok: true, queued: true, pendingCount: syncStatus.pendingCount, syncStatus };
  } catch (error) {
    await setSyncState({ status: 'Signal capture failed', lastError: error.message });
    return { ok: false, error: error.message };
  }
}

async function postSignal(payload) {
    try {
        const headers = await withAuthHeaders({ 'Content-Type': 'application/json' });
        const baseUrl = await getBaseUrl();
        const signalUrl = `${baseUrl}/api/signals`;
        console.debug('AESD background: POST /api/signals URL', signalUrl, payload);
        const response = await fetch(signalUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        console.debug('AESD background: /api/signals response status', response.status);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const detail = typeof error.detail === 'string' ? error.detail : JSON.stringify(error.detail || error);
            console.warn('AESD signal sync failed:', response.status, detail, payload);
            return { ok: false, status: response.status, discard: false, error: detail || 'Signal rejected' };
        }

        const data = await response.json();
        console.debug('AESD background: signal synced', data);
        return { ok: true, data };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

async function syncQueuedSignals({ force = false } = {}) {
    if (syncInProgress) {
        return getSyncStatus();
    }
    const now = Date.now();
    if (!force && now < nextSyncAllowedAt) {
        return getSyncStatus();
    }

    const auth = await getAuthState();
    const queue = await getQueue();
    if (!queue.length) {
        await setSyncState({ status: 'All signals synced', lastError: null });
        return getSyncStatus();
    }
    if (!auth?.token) {
        await setSyncState({ status: 'Login required to sync signals', lastError: null });
        return getSyncStatus();
    }

    syncInProgress = true;
    await setSyncState({ status: 'Syncing signals', lastError: null });

    const remaining = [];
    let syncedCount = 0;
    let lastError = null;

    for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        const result = await postSignal(item.payload);
        if (result.ok) {
            syncedCount += 1;
            continue;
        }

        const nextItem = {
            ...item,
            attempts: (item.attempts || 0) + 1,
            lastError: result.error,
            lastAttemptAt: Date.now(),
        };
        if (!result.discard) {
            remaining.push(nextItem);
        }
        lastError = result.status === 401 ? 'Login required to sync signals' : result.error;
        if (result.status === 401) {
            remaining.push(...queue.slice(index + 1));
            break;
        }
    }

    await saveQueue(remaining);
    nextSyncAllowedAt = remaining.length ? Date.now() + RETRY_DELAY_MS : 0;
    await setSyncState({
        status: remaining.length
            ? (lastError === 'Login required to sync signals' ? lastError : `${remaining.length} signals waiting to sync`)
            : `Synced ${syncedCount} signal${syncedCount === 1 ? '' : 's'}`,
        lastError,
        lastSyncedAt: syncedCount ? new Date().toISOString() : undefined,
    });
    syncInProgress = false;
    return getSyncStatus();
}

async function fetchScore(payload) {
  try {
    // PHASE 11: Log score lookup
    console.debug('AESD background: score lookup requested', { 
      jobId: payload.jobId,
      jobTitle: payload.jobTitle,
      companyName: payload.companyName || payload.company
    });
    
    if (isIgnoredUrl(payload.url || payload.jobUrl)) {
      return { ignored: true, error: 'Ignored AESD domain' };
    }
    if (!payload.jobId) {
      return { error: 'No valid job detected on this page' };
    }
    const authHeaders = await withAuthHeaders();
    const baseUrl = await getBaseUrl();
    await syncQueuedSignals({ force: true });
    const scoreUrl = new URL(`${baseUrl}/api/scores`);
    scoreUrl.searchParams.set('jobId', payload.jobId);
    if (payload.jobTitle) {
      scoreUrl.searchParams.set('jobTitle', payload.jobTitle);
    }
    if (payload.companyName || payload.company) {
      scoreUrl.searchParams.set('companyName', payload.companyName || payload.company);
    }
    const response = await fetch(scoreUrl.toString(), { 
      headers: authHeaders, 
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return { error: error.detail || 'Unable to fetch score' };
    }

    const data = await response.json();
    
    // PHASE 11: Log score API response
    console.debug('AESD background: score API response', { 
      requestedJobId: payload.jobId,
      responseJobId: data?.jobId,
      energySinkScore: data?.energySinkScore,
      scoreStatus: data?.scoreStatus,
      recommendation: data?.recommendation
    });
    
    if (!data || data.jobId !== payload.jobId) {
      console.debug('AESD: Ignored stale latest score', { requestedScoreJobId: payload.jobId, scoreApiResponse: data });
      return { 
        data: { 
          score: null,
          energySinkScore: null,
          scoreStatus: 'not_enough_effort_data', 
          responseStatus: 'Not enough effort data', 
          name: payload.companyName || payload.company || payload.domain, 
          jobTitle: payload.jobTitle, 
          recommendation: 'Tracking', 
          effortCount: 0, 
          responseCount: 0, 
        }, 
      };
    }
    return { 
      data: { 
        score: data.energySinkScore,
        energySinkScore: data.energySinkScore,
        scoreStatus: data.scoreStatus || 'not_enough_data', 
        responseStatus: data.responseStatus || null, 
        name: data.companyName || payload.domain, 
        jobTitle: data.jobTitle || payload.jobTitle, 
        recommendation: data.recommendation || 'No data yet', 
        effortCount: data.effortScore || 0, 
        responseCount: data.responseScore || 0,
            },
        };
    } catch (error) {
        return { error: error.message };
    }
}

async function hashString(str) {
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && /^https?:\/\//.test(tab.url)) {
        // Response redirects are tracked only when a content script has valid job context.
        // The background tab URL alone is not enough to create a scored job safely.
    }
});
