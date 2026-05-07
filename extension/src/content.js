console.log('AESD: Monitoring applicant effort...');

const JOB_HOST_PATTERNS = [
  /linkedin\.com\/jobs/i,
  /indeed\./i,
  /greenhouse\.io/i,
  /lever\.co/i,
  /workdayjobs\.com/i,
  /myworkdayjobs\.com/i,
  /ashbyhq\.com/i,
  /smartrecruiters\.com/i,
  /jobvite\.com/i,
  /icims\.com/i,
  /careers?/i,
  /jobs?/i,
];

const JOB_TEXT_PATTERNS = /\b(apply now|easy apply|submit application|job description|responsibilities|qualifications|employment type|remote|hybrid|full[- ]time|part[- ]time)\b/i;
const DEV_LOG = true;
const IGNORED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', 'jobzoid', 'chrome-extension'];
const IGNORED_URL_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
  /chrome-extension:\/\//i,
];
const IGNORED_TITLE_PATTERNS = [
  /^jobzoid$/i,
  /jobzoid/i,
  /applicant energy sink detector/i,
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'GET_CURRENT_JOB_CONTEXT') {
        const context = getJobContext({ debug: true });
        const isValidJobPage = !isIgnoredPage() && isValidJobContext(context);
        const response = {
            isValidJobPage,
            pageType: isValidJobPage ? 'job_detail' : (context.pageType || 'unknown'),
            platform: context.platform,
            jobId: context.jobId,
            jobTitle: context.jobTitle,
            company: context.companyName,
            companyName: context.companyName,
            jobUrl: context.jobUrl,
            location: context.location,
            sourceSelectorUsed: context.metadata?.extraction?.sourceSelectorUsed,
        };
        if (isValidJobPage) {
            logJobContext(context);
        } else {
            logOnce(isIgnoredPage() ? 'Ignored localhost page' : 'Invalid context ignored', response);
        }
        sendResponse(response);
        return true;
    }
    return false;
});

let state = createTrackingState();
let scrollTimer = null;
let responseMarkerSent = false;
let contextTimer = null;
let appliedStatusTimer = null;
let lastLogKey = '';
let trackingEnabled = isValidJobDetailPage();

function isExtensionContextAvailable() {
  return Boolean(typeof chrome !== 'undefined' && chrome.runtime?.id);
}

function safeRuntimeSendMessage(message, callback) {
  if (!isExtensionContextAvailable()) {
    console.debug('AESD signal skipped: extension context invalidated');
    return;
  }
  try {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.debug('AESD signal skipped:', chrome.runtime.lastError.message);
        return;
      }
      callback?.(response);
    });
  } catch (error) {
    console.debug('AESD signal skipped:', error.message);
  }
}

function safeStorageGet(key, callback) {
  if (!isExtensionContextAvailable()) {
    return;
  }
  try {
    chrome.storage.local.get(key, (stored) => {
      if (chrome.runtime.lastError) {
        console.debug('AESD storage skipped:', chrome.runtime.lastError.message);
        return;
      }
      callback(stored || {});
    });
  } catch (error) {
    console.debug('AESD storage skipped:', error.message);
  }
}

function safeStorageSet(value, callback) {
  if (!isExtensionContextAvailable()) {
    return;
  }
  try {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        console.debug('AESD storage skipped:', chrome.runtime.lastError.message);
        return;
      }
      callback?.();
    });
  } catch (error) {
    console.debug('AESD storage skipped:', error.message);
  }
}

function createTrackingState() {
    return {
        startTime: Date.now(),
        lastHeartbeat: Date.now(),
        maxScrollDepth: 0,
        applyClicks: 0,
        pageUrl: normalizeJobUrl(window.location.href),
        jobId: null,
        lastVisitSentAt: 0,
    };
}

function normalizeJobUrl(rawUrl) {
    const url = new URL(rawUrl);
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'source', 'ref'].forEach((param) => url.searchParams.delete(param));
    url.searchParams.sort();
    return url.toString();
}

function normalizeJobDetailUrl(rawUrl, platformJobId) {
  const url = new URL(normalizeJobUrl(rawUrl));
  if (isLinkedIn()) {
    if (platformJobId && /^\d+$/.test(platformJobId)) {
      return `https://www.linkedin.com/jobs/view/${platformJobId}/`;
    }
  }
  return url.toString();
}

async function hashString(str) {
    const msgUint8 = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

function isLikelyJobPage() {
    if (!/^https?:$/.test(window.location.protocol)) {
        return false;
    }
    if (isIgnoredPage()) {
        logOnce('Ignored AESD domain', window.location.href);
        return false;
    }
    const urlText = `${window.location.hostname}${window.location.pathname}`;
    if (JOB_HOST_PATTERNS.some((pattern) => pattern.test(urlText))) {
        return true;
    }
    const pageText = `${document.title} ${document.querySelector('h1')?.innerText || ''} ${document.body?.innerText?.slice(0, 4000) || ''}`;
    return JOB_TEXT_PATTERNS.test(pageText);
}

function isValidJobDetailPage() {
  if (isIgnoredPage()) {
    logOnce('Ignored localhost/JobZoid page', window.location.href);
    return false;
  }
  const context = extractJobContext();
  logJobContext(context);
  return context.pageType === 'job_detail' && isValidJobContext(context);
}

function isIgnoredPage() {
  const hostname = window.location.hostname.toLowerCase();
  const title = document.title || '';
  const url = window.location.href;
  
  if (IGNORED_HOSTS.includes(hostname) || IGNORED_URL_PATTERNS.some(p => p.test(url))) {
    return true;
  }
  
  if (hostname.includes('jobzoid') || hostname.includes('localhost')) {
    return true;
  }
  
  return IGNORED_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function getJobContext(options = {}) {
    return extractJobContext(options);
}

function extractJobContext(options = {}) {
    if (isIgnoredPage()) {
        return {
            jobTitle: 'Unknown Job',
            companyName: 'Unknown Company',
            company: 'Unknown Company',
            jobUrl: '',
            jobId: '',
            hostname: window.location.hostname,
            platform: window.location.hostname,
            pageType: 'unknown',
            location: '',
            metadata: { extraction: { sourceSelectorUsed: 'ignored_page' } },
        };
    }
  if (isLinkedIn()) {
    return extractLinkedInJobContext(options);
  }
  const hostname = window.location.hostname;
  const platform = hostname;
  const platformJobId = extractPlatformJobId();
  const structuredData = getStructuredJobData();
  const linkedInTitle = getLinkedInDetailText('title');
  const linkedInCompany = getLinkedInDetailText('company');
  const linkedInLocation = getLinkedInDetailText('location');
  
  const jobTitle = pickBestText([
    linkedInTitle,
    structuredData.title,
    getTextBySelectors([
      '.job-details-jobs-unified-top-card__job-title',
      '.job-details-jobs-unified-top-card__job-title h1',
      '.jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title h1',
      '[data-testid="jobsearch-JobInfoHeader-title"]',
      '[data-testid*="job-title" i]',
      '.top-card-layout__title',
      '.posting-headline h2',
      '.ashby-job-posting-heading h1',
      '.job-title',
      '[class*="job-title" i]',
      'h1',
    ]),
    isLinkedIn() ? '' : getMetaContent('og:title'),
    isLinkedIn() ? '' : getMetaContent('twitter:title'),
    isLinkedIn() ? '' : document.title,
  ], { fallback: 'Unknown Job', rejectHostLike: true, type: 'title' });

  const companyName = pickBestText([
    linkedInCompany,
    structuredData.hiringOrganization,
    getTextBySelectors([
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__primary-description-container a',
      '.jobs-unified-top-card__primary-description a',
      '[data-company]',
      '[data-testid="inlineHeader-companyName"]',
      '[data-testid*="company" i]',
      '.topcard__org-name-link',
      '.jobsearch-InlineCompanyRating a',
      '.jobsearch-CompanyInfoContainer a',
      '.posting-headline .company',
      '.ashby-job-posting-heading a',
      '.company-name',
      '.company',
      '[class*="company-name" i]',
    ]),
    isLinkedIn() ? '' : getMetaContent('og:site_name'),
    isLinkedIn() ? '' : inferCompanyFromUrl(hostname, window.location.pathname),
  ], { fallback: inferCompanyFromUrl(hostname, window.location.pathname) || hostname, rejectHostLike: false, type: 'company' });

  const location = pickBestText([
    linkedInLocation,
    getTextBySelectors([
      '.job-details-jobs-unified-top-card__primary-description-container span',
      '.jobs-unified-top-card__bullet',
      '[data-testid*="location" i]',
      '.topcard__flavor--bullet',
      '.job-location',
      '[class*="location" i]',
    ]),
  ], { fallback: '', rejectHostLike: true, type: 'location' });

  const pageType = determinePageType({ jobTitle, companyName, platformJobId, linkedInTitle, linkedInCompany });
  const jobUrl = normalizeJobDetailUrl(window.location.href, platformJobId);
  
  const canonicalJobId = platformJobId && isLinkedIn() && /^\d+$/.test(platformJobId) 
    ? `linkedin:${platformJobId}`
    : (platformJobId ? `${platform}:${platformJobId}` : null);

  logOnce('Job context extracted', { 
    platformJobId, 
    canonicalJobId, 
    jobTitle: cleanText(jobTitle),
    companyName: cleanText(companyName),
    pageType,
    isLinkedIn: isLinkedIn()
  });

  return {
    jobTitle,
    companyName,
    company: companyName,
    jobUrl,
    jobId: canonicalJobId,
    hostname,
    platform,
    pageType,
    location,
    metadata: {
      extraction: {
        title: jobTitle,
        companyName,
        hostname,
        location,
        platformJobId,
        titleSource: linkedInTitle ? 'job_detail_panel' : (structuredData.title ? 'structured_data' : 'selector'),
        companySource: linkedInCompany ? 'job_detail_panel' : (structuredData.hiringOrganization ? 'structured_data' : 'selector'),
        sourceSelectorUsed: linkedInTitle && linkedInCompany ? 'linkedin_detail_panel' : 'generic_selectors',
      },
    },
  };
}

function isLinkedIn() {
    return /(^|\.)linkedin\.com$/i.test(window.location.hostname);
}

function extractLinkedInJobContext({ debug = false } = {}) {
  const numericJobId = extractLinkedInNumericJobId();
  const detailRoot = getLinkedInDetailRoot();
  const selectedCard = numericJobId ? getLinkedInSelectedJobCard(numericJobId) : null;

  let sourceSelectorUsed = 'detail-panel';
  let jobTitle = pickBestText([
    getLinkedInText(detailRoot, [
      '.job-details-jobs-unified-top-card__job-title',
      '.jobs-unified-top-card__job-title',
      'h1',
      'h2',
      '[data-test-job-title]',
    ], 'title'),
    getLinkedInHeadingText(detailRoot),
  ], { fallback: '', rejectHostLike: true, type: 'title' });

  let companyName = pickBestText([
    getLinkedInText(detailRoot, [
      '.job-details-jobs-unified-top-card__company-name a',
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name a',
      '.jobs-unified-top-card__company-name',
      'a[href*="/company/"]',
    ], 'company'),
  ], { fallback: '', rejectHostLike: false, type: 'company' });

  if ((!isUsefulText(jobTitle) || isGenericTitle(jobTitle)) && selectedCard) {
    jobTitle = pickBestText([
      getLinkedInText(selectedCard, [
        '.job-card-list__title',
        '.job-card-container__link',
        'a[href*="/jobs/view/"]',
        'strong',
        'h3',
        'h2',
      ], 'title'),
      getSelectedCardFallbackLine(selectedCard, 'title'),
    ], { fallback: '', rejectHostLike: true, type: 'title' });
    sourceSelectorUsed = 'selected-card-fallback';
  }

  if ((!isUsefulText(companyName) || isGenericCompany(companyName)) && selectedCard) {
    companyName = pickBestText([
      getLinkedInText(selectedCard, [
        '.artdeco-entity-lockup__subtitle',
        '.job-card-container__primary-description',
        '.job-card-container__company-name',
      ], 'company'),
      getSelectedCardFallbackLine(selectedCard, 'company'),
    ], { fallback: '', rejectHostLike: false, type: 'company' });
    sourceSelectorUsed = 'selected-card-fallback';
  }

  const rawLocation = pickBestText([
    getLinkedInText(detailRoot, [
      '.job-details-jobs-unified-top-card__primary-description-container span',
      '.jobs-unified-top-card__bullet',
      '[class*="location" i]',
    ], 'location'),
  ], { fallback: '', rejectHostLike: true, type: 'location' });
  const location = isUsefulText(rawLocation) ? rawLocation : null;

  const valid = Boolean(
    numericJobId &&
    /^\d+$/.test(numericJobId) &&
    isUsefulText(jobTitle) &&
    isUsefulText(companyName) &&
    !isGenericTitle(jobTitle) &&
    !isGenericCompany(companyName)
  );
  const invalidReason = valid ? '' : (
    !numericJobId ? 'missing numeric job id' :
    !isUsefulText(jobTitle) || isGenericTitle(jobTitle) ? 'missing valid title' :
    !isUsefulText(companyName) || isGenericCompany(companyName) ? 'missing valid company' :
    'invalid context'
  );

  const context = {
    jobTitle: jobTitle || 'Unknown Job',
    companyName: companyName || 'Unknown Company',
    company: companyName || 'Unknown Company',
    jobUrl: numericJobId ? `https://www.linkedin.com/jobs/view/${numericJobId}/` : normalizeJobUrl(window.location.href),
    jobId: numericJobId ? `linkedin:${numericJobId}` : '',
    hostname: window.location.hostname,
    platform: 'linkedin',
    pageType: valid ? 'job_detail' : 'generic',
    location,
    metadata: {
      extraction: {
        sourceSelectorUsed,
        platformJobId: numericJobId,
        invalidReason,
      },
    },
  };

  if (debug) {
    console.debug('AESD LinkedIn extraction result:', {
      currentUrl: window.location.href,
      numericJobId,
      detailRootFound: Boolean(detailRoot),
      selectedCardFound: Boolean(selectedCard),
      extractedTitle: context.jobTitle,
      extractedCompany: context.companyName,
      finalValid: valid,
      invalidReason,
      sourceSelectorUsed,
    });
  }

  return context;
}

function extractLinkedInNumericJobId() {
  const url = new URL(window.location.href);
  const fromCurrentJobId = url.searchParams.get('currentJobId');
  const fromCurrentJob = url.searchParams.get('currentJob');
  const fromPath = url.pathname.match(/\/jobs\/view\/(\d+)/i)?.[1];
  if (fromCurrentJobId || fromCurrentJob || fromPath) {
    return fromCurrentJobId || fromCurrentJob || fromPath;
  }
  const selected = document.querySelector(
    '[aria-selected="true"][data-job-id], [aria-selected="true"][data-occludable-job-id], ' +
    '.jobs-search-results-list__list-item--active [data-job-id], .jobs-search-results-list__list-item--active [data-occludable-job-id], ' +
    '.jobs-search-results__list-item--active [data-job-id], .jobs-search-results__list-item--active [data-occludable-job-id]'
  );
  return selected?.getAttribute('data-job-id') || selected?.getAttribute('data-occludable-job-id') || '';
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    (el.offsetParent !== null || (rect.width > 0 && rect.height > 0));
}

function getLinkedInDetailRoot() {
  if (!isLinkedIn()) {
    return null;
  }
  const selectors = [
    '.jobs-search__job-details--container',
    '.job-view-layout',
    '.jobs-details',
    '.jobs-unified-top-card',
    '.job-details-jobs-unified-top-card',
    'main',
  ];
  for (const selector of selectors) {
    const root = Array.from(document.querySelectorAll(selector)).find(isVisible);
    if (root) return root;
  }
  return isVisible(document.body) ? document.body : null;
}

function getLinkedInSelectedJobCard(numericJobId) {
  const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(numericJobId) : numericJobId;
  const selectors = [
    `[data-job-id="${escapedId}"]`,
    `[data-occludable-job-id="${escapedId}"]`,
    `li:has([data-job-id="${escapedId}"])`,
    `li:has([data-occludable-job-id="${escapedId}"])`,
    '.jobs-search-results-list__list-item--active',
    '.jobs-search-results__list-item--active',
    '[aria-selected="true"]',
  ];
  for (const selector of selectors) {
    try {
      const card = Array.from(document.querySelectorAll(selector)).find(isVisible);
      if (card) return card.closest('li') || card;
    } catch {
      // Ignore unsupported selectors such as :has in older Chromium builds.
    }
  }
  return null;
}

function getLinkedInText(root, selectors, type) {
  if (!root) return '';
  for (const selector of selectors) {
    const element = Array.from(root.querySelectorAll(selector)).find(isVisible);
    const value = cleanLinkedInText(element?.innerText || element?.textContent || '');
    if (isUsefulText(value) && (type !== 'title' || !isGenericTitle(value)) && (type !== 'company' || !isGenericCompany(value))) {
      return value;
    }
  }
  return '';
}

function getLinkedInHeadingText(root) {
  if (!root) return '';
  const heading = Array.from(root.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .filter(isVisible)
    .map((el) => cleanLinkedInText(el.innerText || el.textContent || ''))
    .find((value) => isUsefulText(value) && !isGenericTitle(value));
  return heading || '';
}

function getSelectedCardFallbackLine(card, type) {
  const lines = String(card?.innerText || '')
    .split(/\s{2,}|\n/)
    .map(cleanLinkedInText)
    .filter(Boolean);
  if (type === 'title') {
    return lines.find((line) => !isGenericTitle(line) && !/^(promoted|view job|easy apply)$/i.test(line)) || '';
  }
  const title = getLinkedInText(card, ['.job-card-list__title', '.job-card-container__link', 'a[href*="/jobs/view/"]'], 'title');
  return lines.find((line) => line !== title && !isGenericCompany(line) && !/^(promoted|view job|easy apply|remote|hybrid)$/i.test(line)) || '';
}

function cleanLinkedInText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+logo$/i, '')
    .replace(/\s+[|-]\s+LinkedIn.*$/i, '')
    .replace(/\s+[|-]\s+Indeed.*$/i, '')
    .replace(/\s+[|-]\s+Glassdoor.*$/i, '')
    .replace(/\s+[|-]\s+Jobs.*$/i, '')
    .replace(/\bwith verification\b/ig, '')
    .replace(/\bpromoted\b/ig, '')
    .replace(/\beasy apply\b/ig, '')
    .trim()
    .slice(0, 180);
}

function extractPlatformJobId() {
  const url = new URL(window.location.href);
  if (isLinkedIn()) {
    const fromQuery = url.searchParams.get('currentJobId') || url.searchParams.get('currentJob') || url.searchParams.get('jobId');
    const fromPath = url.pathname.match(/\/jobs\/view\/(\d+)/i)?.[1];

    const selectedCard = document.querySelector( 
      '.jobs-search-results-list__list-item--active [data-job-id], ' + 
      '.jobs-search-results__list-item--active [data-job-id], ' + 
      '[aria-selected="true"][data-job-id], ' + 
      '[aria-current="page"][data-job-id], ' + 
      '.jobs-search-results-list__list-item--active [data-occludable-job-id], ' + 
      '.jobs-search-results__list-item--active [data-occludable-job-id], ' + 
      '[data-job-id][aria-selected="true"], ' + 
      '[data-occludable-job-id][aria-selected="true"]' 
    );

    const detailRoot = getLinkedInDetailRoot();
    const detailRootFound = detailRoot !== null;
    const fromData = selectedCard?.getAttribute('data-job-id') || 
      selectedCard?.getAttribute('data-occludable-job-id') || 
      (detailRoot ? detailRoot.querySelector('[data-job-id]')?.getAttribute('data-job-id') : null) || 
      (detailRoot ? detailRoot.querySelector('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id') : null);

    const numericId = fromQuery || fromPath || fromData || '';
    
    // PHASE 11: Log extraction state
    logOnce('LinkedIn jobId extraction', {
      activeUrl: window.location.href,
      numericLinkedInJobId: numericId,
      selectedDetailRootFound: detailRootFound,
      fromQuery,
      fromPath,
      fromData
    });
    
    return numericId;
  }
  const structuredData = getStructuredJobData();
  return structuredData.identifier || '';
}

function determinePageType({ jobTitle, companyName, platformJobId, linkedInTitle, linkedInCompany }) {
  if (!isLikelyJobPage()) {
    return 'generic';
  }
  if (isLinkedIn()) {
    const hasDetailUrl = /\/jobs\/view\/\d+/i.test(window.location.pathname) || Boolean(new URL(window.location.href).searchParams.get('currentJobId'));
    const hasDetailPanel = Boolean(getLinkedInDetailRoot());
    const hasValidNumericId = platformJobId && /^\d+$/.test(platformJobId);
    
    if (!hasValidNumericId || (!hasDetailUrl && !hasDetailPanel)) {
      logOnce('Ignored generic LinkedIn page - no valid job ID or detail panel', window.location.href);
      return 'generic';
    }
    
    const cleanedTitle = cleanText(jobTitle || linkedInTitle || '');
    const cleanedCompany = cleanText(companyName || linkedInCompany || '');
    
    if (!cleanedTitle || !cleanedCompany || 
        isGenericTitle(cleanedTitle) || 
        isGenericCompany(cleanedCompany) ||
        cleanedCompany.toLowerCase() === 'linkedin') {
      logOnce('Ignored LinkedIn page - invalid title/company', { title: cleanedTitle, company: cleanedCompany });
      return 'generic';
    }
  }
  return isValidLabels(jobTitle, companyName) ? 'job_detail' : 'generic';
}

function isValidJobContext(context) {
    return Boolean(
        context.jobId &&
        context.jobUrl &&
        context.platform &&
        context.pageType === 'job_detail' &&
        isValidLabels(context.jobTitle, context.companyName)
    );
}

function isValidLabels(jobTitle, companyName) {
    return !isGenericTitle(jobTitle) && !isGenericCompany(companyName);
}

function isGenericTitle(value) {
    const cleaned = cleanText(value).toLowerCase();
    return [
        'unknown',
        'unknown job',
        'unknown title',
        'linkedin',
        'jobs',
        'jobs | linkedin',
        'search results',
        'job search',
        'debug job',
        'jobzoid',
        'localhost',
    ].includes(cleaned) || cleaned.startsWith('jobs |') || cleaned.endsWith('| linkedin');
}

function isGenericCompany(value) {
    const cleaned = cleanText(value).toLowerCase();
    return [
        'unknown',
        'unknown company',
        'debug company',
        'localhost',
        'linkedin',
        'google',
    ].includes(cleaned);
}

function getLinkedInDetailText(kind) {
    if (!isLinkedIn()) {
        return '';
    }
    const root = getLinkedInDetailRoot();
    if (!root) {
        return '';
    }
    const selectorMap = {
        title: [
            '.jobs-unified-top-card__job-title',
            '.job-details-jobs-unified-top-card__job-title',
            '.job-details-jobs-unified-top-card__job-title h1',
            '.jobs-details__main-content h1',
            'h1',
        ],
        company: [
            '.jobs-unified-top-card__company-name a',
            '.jobs-unified-top-card__company-name',
            '.job-details-jobs-unified-top-card__company-name a',
            '.job-details-jobs-unified-top-card__company-name',
            '.job-details-jobs-unified-top-card__primary-description-container a',
            '.jobs-unified-top-card__primary-description a',
        ],
        location: [
            '.jobs-unified-top-card__bullet',
            '.job-details-jobs-unified-top-card__primary-description-container span',
        ],
    };
    for (const selector of selectorMap[kind] || []) {
        const value = cleanText(root.querySelector(selector)?.innerText || root.querySelector(selector)?.textContent || '');
        if (isUsefulText(value)) {
            return value;
        }
    }
    return '';
}

function cleanText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/\s+logo$/i, '')
        .replace(/\s+[|-]\s+LinkedIn.*$/i, '')
        .replace(/\s+[|-]\s+Indeed.*$/i, '')
        .replace(/\s+[|-]\s+Glassdoor.*$/i, '')
        .replace(/\s+[|-]\s+Jobs.*$/i, '')
        .trim()
        .slice(0, 180) || 'Unknown';
}

function getTextBySelectors(selectors) {
    for (const selector of selectors) {
        const element = document.querySelector(selector);
        const value = cleanText(element?.innerText || element?.textContent || '');
        if (isUsefulText(value)) {
            return value;
        }
    }
    return '';
}

function getMetaContent(name) {
    const element = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    return cleanText(element?.getAttribute('content') || '');
}

function getStructuredJobData() {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
        try {
            const parsed = JSON.parse(script.textContent || '{}');
            const items = Array.isArray(parsed) ? parsed : [parsed, ...(parsed['@graph'] || [])];
            const posting = items.find((item) => {
                const type = item?.['@type'];
                return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
            });
            if (posting) {
            return {
                title: cleanText(posting.title),
                hiringOrganization: cleanText(
                    posting.hiringOrganization?.name ||
                    posting.identifier?.name ||
                    ''
                ),
                identifier: cleanText(posting.identifier?.value || posting.identifier?.name || ''),
            };
            }
        } catch {
            // Ignore malformed JSON-LD from third-party pages.
        }
    }
    return {};
}

function pickBestText(values, { fallback, rejectHostLike, type }) {
    for (const value of values) {
        const cleaned = cleanText(value);
        if (!isUsefulText(cleaned)) {
            continue;
        }
        if (rejectHostLike && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) {
            continue;
        }
        if (type === 'title' && isGenericTitle(cleaned)) {
            continue;
        }
        if (type === 'company' && isGenericCompany(cleaned)) {
            continue;
        }
        return cleaned;
    }
    return cleanText(fallback);
}

function isUsefulText(value) {
    const cleaned = cleanText(value);
    return Boolean(cleaned && !/^unknown/i.test(cleaned) && cleaned.length > 1);
}

function inferCompanyFromUrl(hostname, pathname) {
    const hostParts = hostname.split('.').filter(Boolean);
    if (/greenhouse\.io$/i.test(hostname) || /lever\.co$/i.test(hostname) || /ashbyhq\.com$/i.test(hostname)) {
        const firstPathPart = pathname.split('/').filter(Boolean)[0];
        return humanizeCompany(firstPathPart || hostParts[0]);
    }
    if (/myworkdayjobs\.com$/i.test(hostname) || /workdayjobs\.com$/i.test(hostname)) {
        return humanizeCompany(hostParts[0]?.replace(/careers?$/i, ''));
    }
    if (hostParts.length >= 2) {
        return humanizeCompany(hostParts[hostParts.length - 2]);
    }
    return humanizeCompany(hostname);
}

function humanizeCompany(value) {
    return cleanText(String(value || '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase()));
}

async function sendSignal(eventType, extra = {}) {
  if (isIgnoredPage()) {
    logOnce('Ignored localhost/JobZoid domain', window.location.href);
    return;
  }
  const context = getJobContext();
  const validationResult = isValidJobContext(context);
  
  // PHASE 11: Log validation state
  if (!validationResult) {
    const reason = !context.jobId ? 'no jobId' : 
      !context.jobUrl ? 'no jobUrl' : 
      !context.platform ? 'no platform' : 
      context.pageType !== 'job_detail' ? 'wrong pageType' : 
      !isValidLabels(context.jobTitle, context.companyName) ? 'invalid labels' : 'unknown';
    logOnce('Invalid job context - signal not sent', { 
      jobId: context.jobId, 
      title: context.jobTitle, 
      company: context.companyName, 
      pageType: context.pageType,
      validationResult,
      reason
    });
    return;
  }
  trackingEnabled = true;

  if (!context.jobId) {
    context.jobId = await hashString(`${context.jobUrl}|${context.companyName}|${context.jobTitle}`);
  }
  state.jobId = context.jobId;
  state.pageUrl = context.jobUrl;

  logOnce('Sending signal', { 
    eventType, 
    jobId: context.jobId, 
    title: context.jobTitle, 
    company: context.companyName 
  });

  const signalPayload = {
    eventType,
    signalType: eventType,
    ...context,
    ...extra,
    metadata: {
      ...context.metadata,
      ...(extra.metadata || {}),
    },
    timestamp: Date.now(),
  };
  console.debug('AESD content: signal payload before sending', signalPayload);

  safeRuntimeSendMessage({
    type: 'SIGNAL_EVENT',
    payload: signalPayload,
  }, (response) => {
    if (response && !response.ok) {
      console.debug('AESD signal queued/sync issue:', response.error || response);
    }
  });
}

function trackPageVisit() {
    if (Date.now() - state.lastVisitSentAt > 60000) {
        state.lastVisitSentAt = Date.now();
        sendSignal('PAGE_VISIT');
    }
}

function trackScrollDepth() {
    const doc = document.documentElement;
    const totalScrollable = Math.max(doc.scrollHeight - window.innerHeight, 1);
    const currentDepth = totalScrollable <= 1
        ? 0
        : Math.min(100, Math.round((window.scrollY / totalScrollable) * 100));
    if (currentDepth >= state.maxScrollDepth + 10 || currentDepth === 100) {
        state.maxScrollDepth = currentDepth;
        sendSignal('SCROLL_DEPTH', { scrollDepth: state.maxScrollDepth });
    }
    state.lastHeartbeat = Date.now();
}

function trackTimeSpent() {
    const now = Date.now();
    if (now - state.lastHeartbeat <= 30000) {
        sendSignal('TIME_SPENT', { timeSpentSeconds: 10 });
    }
}

function trackApplyClick(event) {
  const target = event.target?.closest('button, a, input[type="submit"]');
  if (!target) {
    return;
  }

  const text = ( 
    target.innerText || 
    target.textContent || 
    target.getAttribute('aria-label') || 
    target.getAttribute('title') || 
    target.value || 
    '' 
  ).toLowerCase();
  const href = target.getAttribute('href') || '';
  const actionText = `${text} ${href}`.toLowerCase();

  if (/(apply|applied|submit application|easy apply|application)/.test(actionText)) {
    const context = getJobContext();
    console.debug('AESD content: apply button clicked', { text, href, context });
    if (!isValidJobContext(context) || isIgnoredPage()) {
      logOnce('Apply click ignored - no valid job context', { text, href });
      return;
    }

    state.applyClicks += 1;
    const applyType = text.includes('easy') ? 'easy_apply_click' : 'apply_click';
    logOnce('Apply signal sent', { 
      applyType, 
      jobId: context.jobId, 
      title: context.jobTitle, 
      company: context.companyName 
    });
    sendSignal(applyType, { 
      metadata: { 
        label: text || href, 
        applyClicks: state.applyClicks, 
        buttonText: text 
      }, 
      applyClicks: state.applyClicks 
    });
  }
  state.lastHeartbeat = Date.now();
}

function detectAppliedStatus() {
  if (!isLinkedIn()) {
    return;
  }
  const context = getJobContext();
  if (!isValidJobContext(context) || isIgnoredPage()) {
    return;
  }
  const root = getLinkedInDetailRoot() || document.body;
  const visibleText = Array.from(root.querySelectorAll('button, span, div, p'))
    .filter(isVisible)
    .map((el) => cleanLinkedInText(el.innerText || el.textContent || ''))
    .filter(Boolean)
    .join(' ');
  if (!/\b(applied|applied\s+\d+\s+\w+\s+ago|applied\s+just\s+now|your application was submitted)\b/i.test(visibleText)) {
    return;
  }
  const dedupeKey = `applied_detected:${context.jobId}`;
  safeStorageGet(dedupeKey, (stored) => {
    if (stored?.[dedupeKey]) {
      return;
    }
    safeStorageSet({ [dedupeKey]: Date.now() }, () => {
      console.debug('AESD content: applied status detected', {
        jobId: context.jobId,
        title: context.jobTitle,
        company: context.companyName,
      });
      sendSignal('application_submitted', {
        metadata: {
          source: 'linkedin_applied_status',
          appliedStatusText: 'Applied',
        },
        applyClicks: state.applyClicks,
      });
    });
  });
}

function trackResponseMarkers() {
    if (responseMarkerSent) {
        return;
    }
    const bodyText = document.body?.innerText?.toLowerCase() || '';
    if (/(application received|thank you for applying|thanks for applying|application submitted|interview|next steps)/.test(bodyText)) {
        responseMarkerSent = true;
        sendSignal('RESPONSE', { metadata: { source: 'page_text_marker' } });
    }
}

function installSpaNavigationTracking() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    const handleRouteChange = () => {
        refreshJobContext();
    };

    history.pushState = function (...args) {
        originalPushState.apply(this, args);
        handleRouteChange();
    };

    history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        handleRouteChange();
    };

    window.addEventListener('popstate', handleRouteChange);
}

function refreshJobContext() {
  if (isIgnoredPage()) {
    trackingEnabled = false;
    return;
  }
  const context = extractJobContext();
  const nextUrl = context.jobUrl || normalizeJobUrl(window.location.href);
  const nextJobId = context.jobId || '';
  
  const jobChanged = state.pageUrl !== nextUrl || (nextJobId && state.jobId && state.jobId !== nextJobId);
  const contextValid = context.pageType === 'job_detail' && isValidJobContext(context);
  
  if (jobChanged) {
    state = createTrackingState();
    state.pageUrl = nextUrl;
    state.jobId = nextJobId || null;
    trackingEnabled = contextValid;
    responseMarkerSent = false;
    
    logOnce('Job context changed', { 
      fromUrl: state.pageUrl, 
      toUrl: nextUrl,
      fromJobId: state.jobId,
      toJobId: nextJobId,
      trackingEnabled: contextValid
    });
    
    if (trackingEnabled) {
      trackPageVisit();
      trackResponseMarkers();
    }
  } else {
    trackingEnabled = contextValid;
  }
}

function logOnce(label, payload) {
    if (!DEV_LOG) return;
    const key = `${label}:${typeof payload === 'string' ? payload : JSON.stringify(payload)}`;
    if (key === lastLogKey) return;
    lastLogKey = key;
    console.debug(`AESD: ${label}`, payload);
}

function logJobContext(context) {
    if (!DEV_LOG || context.pageType !== 'job_detail') return;
    logOnce('Detected job context', {
        pageType: context.pageType,
        jobId: context.jobId,
        title: context.jobTitle,
        company: context.companyName,
        platform: context.platform,
        url: context.jobUrl,
        sourceSelectorUsed: context.metadata?.extraction?.sourceSelectorUsed,
    });
}

function installJobPanelObserver() {
  let lastJobId = null;
  let lastUrl = window.location.href;
  
  const checkAndRefresh = () => {
    const currentUrl = window.location.href;
    const currentJobId = extractPlatformJobId();
    
    if (currentUrl !== lastUrl || currentJobId !== lastJobId) {
      lastUrl = currentUrl;
      lastJobId = currentJobId;
      if (contextTimer) {
        window.clearTimeout(contextTimer);
      }
      contextTimer = window.setTimeout(() => {
        refreshJobContext();
        if (isValidJobDetailPage()) {
          trackPageVisit();
        }
      }, 500);
    }
  };
  
  const observer = new MutationObserver(() => {
    checkAndRefresh();
    if (appliedStatusTimer) {
      window.clearTimeout(appliedStatusTimer);
    }
    appliedStatusTimer = window.setTimeout(() => {
      detectAppliedStatus();
    }, 700);
  });
  
  observer.observe(document.documentElement, { 
    childList: true, 
    subtree: true,
    attributes: false,
    characterData: false
  });
  
  setTimeout(checkAndRefresh, 500);
  setTimeout(checkAndRefresh, 1500);
  setTimeout(checkAndRefresh, 3000);
  setTimeout(detectAppliedStatus, 1200);
  setTimeout(detectAppliedStatus, 3000);
}

if (trackingEnabled) {
    trackPageVisit();
    trackResponseMarkers();
}
installSpaNavigationTracking();
installJobPanelObserver();

document.addEventListener('scroll', () => {
    if (scrollTimer) {
        return;
    }
    scrollTimer = window.setTimeout(() => {
        scrollTimer = null;
        trackScrollDepth();
    }, 500);
}, { passive: true });
document.addEventListener('click', trackApplyClick, true);
['mousemove', 'keydown', 'click'].forEach((eventName) => {
    document.addEventListener(eventName, () => {
        state.lastHeartbeat = Date.now();
    }, { passive: true });
});

setInterval(trackTimeSpent, 10000);
