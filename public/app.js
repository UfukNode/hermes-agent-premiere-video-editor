const form = document.getElementById('run-form');
const openPremiereBtn = document.getElementById('openPremiereBtn');
const consoleOutput = document.getElementById('consoleOutput');
const consoleStatus = document.getElementById('consoleStatus');
const sessionMeta = document.getElementById('sessionMeta');
const outputsList = document.getElementById('outputsList');
const recentSessions = document.getElementById('recentSessions');

let currentEventSource = null;
let currentOutputs = {};

function appendLine(line, kind = 'stdout') {
  const prefix = kind === 'stderr' ? '[err] ' : kind === 'status' ? '[status] ' : '';
  const next = consoleOutput.textContent === 'Waiting for operator command...'
    ? `${prefix}${line}`
    : `${consoleOutput.textContent}\n${prefix}${line}`;
  consoleOutput.textContent = next;
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function setStatus(status) {
  consoleStatus.textContent = status;
  consoleStatus.className = `status-pill ${status}`;
}

function updateOutputs(outputs = {}) {
  currentOutputs = { ...currentOutputs, ...outputs };
  const items = [];
  if (currentOutputs.xml) items.push(`XML: ${currentOutputs.xml}`);
  if (currentOutputs.mp4) items.push(`MP4: ${currentOutputs.mp4}`);
  outputsList.innerHTML = items.length
    ? items.map((item) => `<li>${item}</li>`).join('')
    : '<li>XML output appears here</li><li>MP4 output appears here</li>';
}

function renderSession(session) {
  currentOutputs = {};
  sessionMeta.innerHTML = `
    <p class="label">${session.status}</p>
    <strong>${session.meta.mode} • ${session.meta.language.toUpperCase()}</strong>
    <p>${session.meta.videoPath}</p>
  `;
  updateOutputs(session.outputs);
  setStatus(session.status);
}

async function loadRecentSessions() {
  const response = await fetch('/api/sessions');
  const data = await response.json();
  if (!data.sessions || data.sessions.length === 0) {
    recentSessions.innerHTML = '<li>No sessions yet</li>';
    return;
  }

  recentSessions.innerHTML = data.sessions.map((session) => {
    const outputText = session.outputs.xml || session.outputs.mp4 || 'no output yet';
    return `<li><strong>${session.meta.mode}</strong> · ${session.status}<br><small>${outputText}</small></li>`;
  }).join('');
}

function connectSession(sessionId) {
  if (currentEventSource) {
    currentEventSource.close();
  }

  currentEventSource = new EventSource(`/api/sessions/${sessionId}/events`);
  currentEventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    appendLine(payload.line, payload.type);
    const xmlMatch = payload.line.match(/XML saved:\s+(.+)$/);
    if (xmlMatch) {
      updateOutputs({ xml: xmlMatch[1].trim() });
    }
    const mp4Match = payload.line.match(/MP4 saved:\s+(.+?)(?:\s+\(|$)/);
    if (mp4Match) {
      updateOutputs({ mp4: mp4Match[1].trim() });
    }
    if (payload.type === 'status') {
      const completed = payload.line.includes('code 0');
      setStatus(completed ? 'completed' : 'failed');
      loadRecentSessions().catch(() => {});
    }
  };
}

function collectPayload({ openPremiere = false } = {}) {
  const formData = new FormData(form);
  return {
    videoPath: formData.get('videoPath'),
    mode: formData.get('mode'),
    language: formData.get('language'),
    aggressiveness: formData.get('aggressiveness'),
    fillerWords: formData.get('fillerWords'),
    xmlOnly: document.getElementById('xmlOnly').checked,
    mp4Only: document.getElementById('mp4Only').checked,
    noMarkers: document.getElementById('noMarkers').checked,
    openPremiere,
  };
}

async function startRun(payload) {
  consoleOutput.textContent = 'Waiting for operator command...';
  currentOutputs = {};
  updateOutputs({});
  setStatus('running');

  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    appendLine(data.error || 'Run failed to start', 'stderr');
    setStatus('failed');
    return;
  }

  renderSession(data.session);
  connectSession(data.session.id);
  await loadRecentSessions();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await startRun(collectPayload({ openPremiere: false }));
});

openPremiereBtn.addEventListener('click', async () => {
  await startRun(collectPayload({ openPremiere: true }));
});

loadRecentSessions().catch((error) => {
  appendLine(error.message, 'stderr');
});
