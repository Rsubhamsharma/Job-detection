document.addEventListener('DOMContentLoaded', async () => {
    const loginPanel = document.getElementById('loginPanel');
    const scorePanel = document.getElementById('scorePanel');
    const statusEl = document.getElementById('status');
    const loginErrorEl = document.getElementById('loginError');
    const scoreEl = document.getElementById('score');
    const companyEl = document.getElementById('company');
    const recommendationEl = document.getElementById('recommendation');
    const effortEl = document.getElementById('effort');
    const responsesEl = document.getElementById('responses');
    const apiUrlEl = document.getElementById('apiUrl');
    const scoreApiUrlEl = document.getElementById('scoreApiUrl');
    const capturedCountEl = document.getElementById('capturedCount');
    const pendingCountEl = document.getElementById('pendingCount');
    const syncStatusEl = document.getElementById('syncStatus');

    function loadSettings() {
        chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (response) => {
            const baseUrl = response?.baseUrl || 'http://localhost:8000';
            apiUrlEl.value = baseUrl;
            scoreApiUrlEl.value = baseUrl;
        });
    }

    function clearScoreDisplay(message = 'No valid job detected on this page') {
        scoreEl.innerText = '--';
        companyEl.innerText = message;
        recommendationEl.innerText = message;
        effortEl.innerText = 0;
        responsesEl.innerText = 'pending';
    }

    function requestCurrentJobContext(tab) {
        return new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_JOB_CONTEXT' }, (response) => {
                if (chrome.runtime.lastError) {
                    console.debug('AESD popup: Invalid context ignored', chrome.runtime.lastError.message);
                    resolve(null);
                    return;
                }
                resolve(response || null);
            });
        });
    }

    async function showScorePanel() {
        loginPanel.classList.add('hidden');
        scorePanel.classList.remove('hidden');
        statusEl.innerText = 'Connected';
        refreshSyncStatus();
        clearScoreDisplay('Loading current job...');

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) {
            clearScoreDisplay('No active tab');
            return;
        }

        const url = new URL(tab.url);
        console.debug('AESD popup: activeTabUrl', tab.url);
        if (!/^https?:$/.test(url.protocol) || ['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
            console.debug('AESD popup: Ignored localhost page', tab.url);
            clearScoreDisplay('No valid job detected on this page');
            return;
        }

  const jobContext = await requestCurrentJobContext(tab);
  console.debug('AESD popup: extractedJobContext', jobContext);
  
  if (!jobContext?.isValidJobPage || !jobContext.jobId) {
    clearScoreDisplay('No valid job detected on this page');
    return;
  }

  const cleanedTitle = (jobContext.jobTitle || '').trim();
  const cleanedCompany = (jobContext.company || jobContext.companyName || '').trim();
  
  if (!cleanedTitle || !cleanedCompany || 
      cleanedTitle.toLowerCase().includes('jobzoid') ||
      cleanedTitle.toLowerCase().includes('localhost') ||
      cleanedCompany.toLowerCase().includes('jobzoid') ||
      cleanedCompany.toLowerCase().includes('localhost') ||
      cleanedCompany.toLowerCase() === 'linkedin') {
    clearScoreDisplay('No valid job detected on this page');
    return;
  }

  companyEl.innerText = `${cleanedTitle} - ${cleanedCompany}`;
  scoreEl.innerText = '--';
  recommendationEl.innerText = 'Tracking';
  responsesEl.innerText = 'Not enough effort data';
      console.debug('AESD popup: requestedScoreJobId', jobContext.jobId);

      chrome.runtime.sendMessage( 
        { type: 'GET_SCORE',
        payload: { 
          url: jobContext.jobUrl,
          jobUrl: jobContext.jobUrl,
          jobId: jobContext.jobId,
          jobTitle: cleanedTitle,
          companyName: cleanedCompany,
          domain: url.hostname,
      }, 
      },
      (response) => { 
        console.debug('AESD popup: scoreApiResponse', response);
        if (response?.data) {
          const scoreValue = response.data.energySinkScore !== null && response.data.energySinkScore !== undefined 
            ? Math.round(response.data.energySinkScore) 
            : null;
          scoreEl.innerText = scoreValue !== null ? scoreValue : '--';
          companyEl.innerText = `${response.data.jobTitle || cleanedTitle} - ${response.data.name || cleanedCompany}`;

          // Apply PHASE 9 rules
          const scoreStatus = response.data.scoreStatus || response.data.status || 'not_enough_effort_data';
          const energySinkScore = response.data.energySinkScore;
          
          // Determine recommendation based on rules
          let recommendation = 'Tracking';
          if (scoreStatus === 'scored' && energySinkScore !== null) {
            if (energySinkScore >= 70) {
              recommendation = 'Avoid';
            } else if (energySinkScore >= 40) {
              recommendation = 'Apply cautiously';
            } else {
              recommendation = 'Apply confidently';
            }
          }
          // For not_enough_effort_data or null energySinkScore, recommendation stays Tracking
          
          recommendationEl.innerText = recommendation;
          effortEl.innerText = response.data.effortCount || response.data.effortScore || 0;
          responsesEl.innerText = response.data.responseCount || response.data.responseScore || 'pending';
        } else {
          scoreEl.innerText = '--';
          companyEl.innerText = `${cleanedTitle} - ${cleanedCompany}`;
          recommendationEl.innerText = 'Tracking';
          effortEl.innerText = 0;
          responsesEl.innerText = 'Not enough effort data';
        }
      }
  );
    }

    function showLoginPanel() {
        scorePanel.classList.add('hidden');
        loginPanel.classList.remove('hidden');
        statusEl.innerText = 'Login Required';
    }

    function refreshSyncStatus() {
        chrome.runtime.sendMessage({ type: 'GET_SYNC_STATUS' }, (response) => {
            capturedCountEl.innerText = response?.capturedCount ?? 0;
            pendingCountEl.innerText = response?.pendingCount ?? 0;
            syncStatusEl.innerText = response?.status || 'No sync status';
            if (!response?.authenticated && response?.pendingCount > 0) {
                syncStatusEl.innerText = 'Login required to sync signals';
            }
        });
    }

    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, (response) => {
        if (response?.authenticated) {
            showScorePanel();
        } else {
            showLoginPanel();
        }
    });

    document.getElementById('loginButton').addEventListener('click', () => {
        loginErrorEl.innerText = '';
        chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: { baseUrl: apiUrlEl.value } }, (settingsResponse) => {
            if (!settingsResponse?.ok) {
                loginErrorEl.innerText = settingsResponse?.error || 'Invalid backend URL';
                return;
            }
            chrome.runtime.sendMessage(
            {
                type: 'EXTENSION_LOGIN',
                payload: {
                    email: document.getElementById('email').value.trim(),
                    password: document.getElementById('password').value,
                },
            },
            (response) => {
                if (response?.ok) {
                    showScorePanel();
                } else {
                    loginErrorEl.innerText = response?.error || 'Login failed';
                }
            }
            );
        });
    });

    document.getElementById('logoutButton').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'EXTENSION_LOGOUT' }, () => showLoginPanel());
    });

    document.getElementById('syncNowButton').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SYNC_SIGNALS' }, () => refreshSyncStatus());
    });

    document.getElementById('openWebLogin').addEventListener('click', () => {
        chrome.tabs.create({ url: 'http://localhost:5173/login?source=extension' });
    });

    document.getElementById('saveSettingsButton').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload: { baseUrl: scoreApiUrlEl.value } }, (response) => {
            recommendationEl.innerText = response?.ok ? 'Backend URL saved' : (response?.error || 'Unable to save settings');
        });
    });

    loadSettings();
    window.setInterval(refreshSyncStatus, 3000);
});
