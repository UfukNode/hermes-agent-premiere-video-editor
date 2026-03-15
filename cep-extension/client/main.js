(function () {
  var HEALTH_URL = 'http://127.0.0.1:4317/api/health';
  var RUN_URL = 'http://127.0.0.1:4317/api/run';
  var SESSION_URL = 'http://127.0.0.1:4317/api/sessions/';
  var cs = new CSInterface();

  var refreshButton = document.getElementById('refreshSelectionBtn');
  var runButton = document.getElementById('runBtn');
  var runLabel = document.getElementById('runLabel');
  var modeRow = document.getElementById('modeRow');
  var languageRow = document.getElementById('languageRow');
  var statusTitle = document.getElementById('statusTitle');
  var statusText = document.getElementById('statusText');

  var currentSelection = null;
  var currentMode = 'silence';
  var currentLanguage = 'en';
  var currentSessionId = null;
  var currentSessionStream = null;

  function updateActiveButtons(group, attr, value) {
    var buttons = group.querySelectorAll('.chip');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-' + attr) === value);
    }
  }

  function http(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var payload = {};
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch (error) {}
      callback(xhr.status, payload);
    };
    if (body) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(body));
      return;
    }
    xhr.send();
  }

  function parseJson(value) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  function escapeForEvalScript(value) {
    return String(value)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
  }

  function setStatus(title, text) {
    statusTitle.textContent = title;
    statusText.textContent = text;
  }

  function setRunningState(isRunning, label) {
    runButton.disabled = isRunning;
    refreshButton.disabled = isRunning;
    runButton.classList.toggle('is-loading', isRunning);
    runLabel.textContent = label || (isRunning ? 'Running...' : 'Start');
  }

  function stopSessionStream() {
    if (currentSessionStream) {
      currentSessionStream.close();
      currentSessionStream = null;
    }
  }

  function ensureBackend(callback) {
    http('GET', HEALTH_URL, null, function (status) {
      callback(status >= 200 && status < 300);
    });
  }

  function refreshSelection() {
    setStatus('Checking Selection', 'Reading the current Premiere timeline selection.');
    cs.evalScript('hermes_getSelectedClipContext()', function (result) {
      if (!result || result === 'NO_SELECTION') {
        currentSelection = null;
        setStatus('Select a Clip', 'Select one timeline clip, then use Start or Refresh again.');
        return;
      }

      if (result.indexOf('ERROR:') === 0) {
        currentSelection = null;
        setStatus('Selection Failed', result);
        return;
      }

      var context = parseJson(result);
      if (!context || !context.mediaPath) {
        currentSelection = null;
        setStatus('Selection Failed', 'Premiere returned an invalid selected clip payload.');
        return;
      }

      currentSelection = context;
      setStatus('Clip Ready', 'The selected clip will be cleaned in the same active sequence using ' + currentMode + ' mode.');
    });
  }

  function applyPlanInPremiere(plan) {
    if (!plan || !currentSelection) {
      setRunningState(false, 'Retry');
      setStatus('Premiere Apply Failed', 'Cleanup plan or selected clip context is missing.');
      return;
    }

    var payload = {
      plan: plan,
      selection: currentSelection
    };

    setStatus('Applying in Premiere', 'Hermes is writing the cleanup result back into the active sequence.');
    cs.evalScript(
      "hermes_applyCleanupPlanToSelection('" + escapeForEvalScript(JSON.stringify(payload)) + "')",
      function (result) {
        if (!result) {
          setRunningState(false, 'Retry');
          setStatus('Premiere Apply Failed', 'Premiere did not return a sequence update result.');
          return;
        }

        if (result.indexOf('ERROR:') === 0) {
          setRunningState(false, 'Retry');
          setStatus('Premiere Apply Failed', result);
          return;
        }

        setRunningState(false, 'Done');
        setStatus('Done', result);
      }
    );
  }

  function handleCompletedSession(session) {
    stopSessionStream();
    if (session.outputs && session.outputs.plan) {
      applyPlanInPremiere(session.outputs.plan);
      return;
    }
    setRunningState(false, 'Retry');
    setStatus('Run Complete', 'Cleanup finished but no Premiere plan data was returned.');
  }

  function handleFailedSession(session) {
    stopSessionStream();
    setRunningState(false, 'Retry');
    setStatus('Run Failed', (session.lastLog && session.lastLog.line) || 'Cleanup failed.');
  }

  function readSessionSnapshot(sessionId, allowReconnect) {
    http('GET', SESSION_URL + sessionId, null, function (status, payload) {
      if (status < 200 || status >= 300 || !payload.session) {
        stopSessionStream();
        setRunningState(false, 'Retry');
        setStatus('Run Failed', 'Could not read the final cleanup session state.');
        return;
      }

      if (payload.session.status === 'completed') {
        handleCompletedSession(payload.session);
        return;
      }

      if (allowReconnect && (payload.session.status === 'running' || payload.session.status === 'starting')) {
        setStatus('Hermes Running', currentMode + ' mode is still processing the selected clip.');
        streamSession(sessionId);
        return;
      }

      handleFailedSession(payload.session);
    });
  }

  function handleSessionEvent(sessionId, payload) {
    if (!payload || payload.type !== 'status') {
      return;
    }

    if (payload.line === 'Hermes agent stage finished. Starting cleanup apply stage...') {
      setStatus('Building Cleanup Plan', 'Hermes finished. The cleanup engine is preparing the Premiere apply plan.');
      return;
    }

    if (payload.line.indexOf('Hermes agent stage failed') === 0 || payload.line.indexOf('Process exited with code') === 0) {
      readSessionSnapshot(sessionId);
    }
  }

  function streamSession(sessionId) {
    stopSessionStream();
    currentSessionId = sessionId;
    currentSessionStream = new EventSource(SESSION_URL + sessionId + '/events');

    currentSessionStream.onmessage = function (event) {
      var payload = parseJson(event.data);
      handleSessionEvent(sessionId, payload);
    };

    currentSessionStream.onerror = function () {
      if (!currentSessionStream) {
        return;
      }

      if (currentSessionId === sessionId && currentSessionStream.readyState === 2) {
        readSessionSnapshot(sessionId, true);
      }
    };
  }

  function runCleanup() {
    if (!currentSelection || !currentSelection.mediaPath) {
      refreshSelection();
      return;
    }

    ensureBackend(function (ok) {
      if (!ok) {
        setRunningState(false, 'Retry');
        setStatus('Backend Offline', 'The terminal must keep npm start running.');
        return;
      }

      setRunningState(true, 'Running...');
      setStatus('Hermes Running', currentMode + ' mode is analyzing the selected clip.');

      http('POST', RUN_URL, {
        videoPath: currentSelection.mediaPath,
        mode: currentMode,
        language: currentLanguage,
        aggressiveness: 'medium',
        directPremiere: true,
        xmlOnly: false,
        mp4Only: false,
        noMarkers: true
      }, function (status, response) {
        if (status < 200 || status >= 300 || !response.session) {
          setRunningState(false, 'Retry');
          setStatus('Run Failed', (response && response.error) || 'Cleanup could not be started.');
          return;
        }

        streamSession(response.session.id);
      });
    });
  }

  modeRow.addEventListener('click', function (event) {
    var button = event.target.closest('[data-mode]');
    if (!button) return;
    currentMode = button.getAttribute('data-mode');
    updateActiveButtons(modeRow, 'mode', currentMode);
    if (currentSelection) {
      setStatus('Clip Ready', 'The selected clip will be cleaned in the same active sequence using ' + currentMode + ' mode.');
    }
  });

  languageRow.addEventListener('click', function (event) {
    var button = event.target.closest('[data-language]');
    if (!button) return;
    currentLanguage = button.getAttribute('data-language');
    updateActiveButtons(languageRow, 'language', currentLanguage);
  });

  refreshButton.addEventListener('click', refreshSelection);
  runButton.addEventListener('click', runCleanup);
  window.addEventListener('beforeunload', stopSessionStream);

  setRunningState(false, 'Start');
  refreshSelection();
})();
