const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const HERMES_MODEL = process.env.HERMES_MODEL || '';
const MAX_SESSION_LOGS = 500;
const MAX_SESSION_COUNT = 50;
const SESSION_RETENTION_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

const sessions = new Map();

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function createSession(meta) {
  const id = randomUUID();
  const session = {
    id,
    meta,
    status: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: null,
    updatedAt: new Date().toISOString(),
    logs: [],
    outputs: {},
    listeners: new Set(),
  };
  sessions.set(id, session);
  return session;
}

function sanitizeSession(session, options = {}) {
  const payload = {
    id: session.id,
    meta: session.meta,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    updatedAt: session.updatedAt,
    outputs: session.outputs,
    logCount: session.logs.length,
    lastLog: session.logs[session.logs.length - 1] || null,
  };
  if (options.includeLogs) {
    payload.logs = session.logs;
  }
  return payload;
}

function pushEvent(session, payload) {
  session.updatedAt = payload.at || new Date().toISOString();
  session.logs.push(payload);
  if (session.logs.length > MAX_SESSION_LOGS) {
    session.logs.shift();
  }

  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of session.listeners) {
    response.write(serialized);
  }
}

function closeSessionListeners(session) {
  for (const response of session.listeners) {
    try {
      response.end();
    } catch (error) {}
  }
  session.listeners.clear();
}

function removeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  closeSessionListeners(session);
  sessions.delete(sessionId);
}

function sweepSessions() {
  const now = Date.now();
  const removable = [];

  for (const session of sessions.values()) {
    if (session.status === 'running' || session.status === 'starting') {
      continue;
    }

    const finishedAt = session.endedAt ? Date.parse(session.endedAt) : Date.parse(session.updatedAt || session.startedAt);
    if (!Number.isFinite(finishedAt) || now - finishedAt > SESSION_RETENTION_MS) {
      removable.push(session.id);
    }
  }

  for (const sessionId of removable) {
    removeSession(sessionId);
  }

  if (sessions.size <= MAX_SESSION_COUNT) {
    return;
  }

  const overflow = Array.from(sessions.values())
    .filter((session) => session.status !== 'running' && session.status !== 'starting')
    .sort((left, right) => {
      const leftTime = Date.parse(left.endedAt || left.updatedAt || left.startedAt) || 0;
      const rightTime = Date.parse(right.endedAt || right.updatedAt || right.startedAt) || 0;
      return leftTime - rightTime;
    });

  while (sessions.size > MAX_SESSION_COUNT && overflow.length) {
    const oldest = overflow.shift();
    removeSession(oldest.id);
  }
}

function parseOutputs(session, line) {
  const planMatch = line.match(/^PLAN_JSON:(.+)$/);
  if (planMatch) {
    try {
      session.outputs.plan = JSON.parse(planMatch[1]);
    } catch (error) {
      session.outputs.planError = error.message;
    }
  }

  const xmlMatch = line.match(/XML saved:\s+(.+)$/);
  if (xmlMatch) {
    session.outputs.xml = xmlMatch[1].trim();
  }

  const mp4Match = line.match(/MP4 saved:\s+(.+?)(?:\s+\(|$)/);
  if (mp4Match) {
    session.outputs.mp4 = mp4Match[1].trim();
  }
}

function pipeStream(session, stream, kind) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const payload = {
        type: kind,
        line,
        at: new Date().toISOString(),
      };
      const consoleLine = `[${session.id.slice(0, 8)} ${kind}] ${line}\n`;
      if (kind === 'stderr') {
        process.stderr.write(consoleLine);
      } else {
        process.stdout.write(consoleLine);
      }
      parseOutputs(session, line);
      pushEvent(session, payload);
    }
  });
  stream.on('end', () => {
    if (buffer) {
      const payload = {
        type: kind,
        line: buffer,
        at: new Date().toISOString(),
      };
      const consoleLine = `[${session.id.slice(0, 8)} ${kind}] ${buffer}\n`;
      if (kind === 'stderr') {
        process.stderr.write(consoleLine);
      } else {
        process.stdout.write(consoleLine);
      }
      parseOutputs(session, buffer);
      pushEvent(session, payload);
      buffer = '';
    }
  });
}

function buildHermesPrompt(body) {
  const modeLabel = body.mode === 'speech-clean' ? 'speech cleanup' : body.mode;
  return [
    'Use the silence-cutter skill as context.',
    `A Premiere cleanup run is starting for this local file: ${body.videoPath}.`,
    `Mode: ${modeLabel}. Language: ${body.language}.`,
    'Briefly explain what Hermes Agent is doing for this edit workflow.',
    'Do not ask follow-up questions.',
    'Keep the answer short and practical.',
  ].join(' ');
}

function buildHermesProcess(body) {
  const args = ['chat', '-v'];
  if (HERMES_MODEL) {
    args.push('-m', HERMES_MODEL);
  }
  args.push('-q', buildHermesPrompt(body));

  return {
    command: 'hermes',
    args,
    cwd: ROOT,
  };
}

function buildProcess(body) {
  const commonArgs = [
    body.videoPath,
    '--mode', body.mode,
    '--language', body.language,
    '--speech-model', 'base',
    '--aggressiveness', body.aggressiveness,
  ];

  if (hasValue(body.fillerWords)) {
    commonArgs.push('--filler-words', body.fillerWords);
  }
  if (hasValue(body.repeatGap)) {
    commonArgs.push('--repeat-gap', String(body.repeatGap));
  }
  if (hasValue(body.fillerMaxDuration)) {
    commonArgs.push('--filler-max-duration', String(body.fillerMaxDuration));
  }
  if (hasValue(body.padding)) {
    commonArgs.push('--padding', String(body.padding));
  }
  if (body.noMarkers) {
    commonArgs.push('--no-markers');
  }
  if (hasValue(body.threshold)) {
    commonArgs.push('--threshold', String(body.threshold));
  }
  if (hasValue(body.minSilence)) {
    commonArgs.push('--min-silence', String(body.minSilence));
  }
  if (hasValue(body.outputDir)) {
    commonArgs.push('--output-dir', body.outputDir);
  }

  if (body.directPremiere) {
    commonArgs.push('--plan-only', '--emit-plan');
    return {
      command: 'python3',
      args: [path.join(ROOT, 'silence_cutter.py'), ...commonArgs],
      cwd: ROOT,
    };
  }

  if (body.openPremiere) {
    return {
      command: 'python3',
      args: [path.join(ROOT, 'premiere_bridge.py'), ...commonArgs],
      cwd: ROOT,
    };
  }

  if (body.xmlOnly) {
    commonArgs.push('--xml-only');
  }
  if (body.mp4Only) {
    commonArgs.push('--mp4-only');
  }

  return {
    command: 'python3',
    args: [path.join(ROOT, 'silence_cutter.py'), ...commonArgs],
    cwd: ROOT,
  };
}

function spawnManagedChild(session, processConfig, onClose) {
  pushEvent(session, {
    type: 'meta',
    line: `$ ${[processConfig.command, ...processConfig.args].join(' ')}`,
    at: new Date().toISOString(),
  });

  const child = spawn(processConfig.command, processConfig.args, {
    cwd: processConfig.cwd,
    env: process.env,
  });

  session.child = child;
  pipeStream(session, child.stdout, 'stdout');
  pipeStream(session, child.stderr, 'stderr');

  child.on('error', (error) => {
    session.status = 'error';
    session.endedAt = new Date().toISOString();
    pushEvent(session, {
      type: 'stderr',
      line: error.message,
      at: session.endedAt,
    });
  });

  child.on('close', (code) => {
    session.child = null;
    onClose(code);
  });
}

function startRun(body) {
  const processConfig = buildProcess(body);
  const hermesConfig = body.directPremiere ? buildHermesProcess(body) : null;
  const session = createSession({
    ...body,
    command: hermesConfig
      ? `${[hermesConfig.command, ...hermesConfig.args].join(' ')} -> ${[processConfig.command, ...processConfig.args].join(' ')}`
      : [processConfig.command, ...processConfig.args].join(' '),
  });

  session.status = 'running';

  if (hermesConfig) {
    spawnManagedChild(session, hermesConfig, (code) => {
      if (code !== 0) {
        session.status = 'failed';
        session.endedAt = new Date().toISOString();
        pushEvent(session, {
          type: 'status',
          line: `Hermes agent stage failed with code ${code}. Cleanup stage skipped.`,
          at: session.endedAt,
        });
        return;
      }

      pushEvent(session, {
        type: 'status',
        line: 'Hermes agent stage finished. Starting cleanup apply stage...',
        at: new Date().toISOString(),
      });

      spawnManagedChild(session, processConfig, (code) => {
        session.status = code === 0 ? 'completed' : 'failed';
        session.endedAt = new Date().toISOString();
        pushEvent(session, {
          type: 'status',
          line: `Process exited with code ${code}`,
          at: session.endedAt,
        });
      });
    });
    return session;
  }

  spawnManagedChild(session, processConfig, (code) => {
    session.status = code === 0 ? 'completed' : 'failed';
    session.endedAt = new Date().toISOString();
    pushEvent(session, {
      type: 'status',
      line: `Process exited with code ${code}`,
      at: session.endedAt,
    });
  });

  return session;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
      }
    });
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function serveStatic(requestPath, response) {
  const safePath = requestPath === '/' ? '/index.html' : requestPath;
  const relativePath = path.normalize(safePath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = path.join(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }

    const ext = path.extname(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    });
    response.end(data);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      service: 'hermes-premiere-video-editor',
      activeSessions: Array.from(sessions.values()).filter((item) => item.status === 'running').length,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    const payload = Array.from(sessions.values())
      .slice(-12)
      .reverse()
      .map(sanitizeSession);
    sendJson(response, 200, { sessions: payload });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/run') {
    try {
      const body = await readBody(request);
      if (!body.videoPath) {
        sendJson(response, 400, { error: 'videoPath is required' });
        return;
      }

      const session = startRun({
        mode: body.mode || 'silence',
        engine: 'direct',
        language: body.language || 'en',
        speechModel: 'base',
        aggressiveness: body.aggressiveness || 'medium',
        provider: 'nous',
        videoPath: body.videoPath,
        fillerWords: body.fillerWords || '',
        repeatGap: body.repeatGap ?? '',
        fillerMaxDuration: body.fillerMaxDuration ?? '',
        padding: body.padding ?? '',
        threshold: body.threshold ?? '',
        minSilence: body.minSilence ?? '',
        outputDir: body.outputDir ?? '',
        xmlOnly: Boolean(body.xmlOnly),
        mp4Only: Boolean(body.mp4Only),
        noMarkers: Boolean(body.noMarkers),
        openPremiere: Boolean(body.openPremiere),
        directPremiere: Boolean(body.directPremiere),
      });

      sendJson(response, 200, { session: sanitizeSession(session) });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  const sessionEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (request.method === 'GET' && sessionEventsMatch) {
    const session = sessions.get(sessionEventsMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: 'Session not found' });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('\n');
    session.listeners.add(response);

    for (const log of session.logs) {
      response.write(`data: ${JSON.stringify(log)}\n\n`);
    }

    request.on('close', () => {
      session.listeners.delete(response);
    });
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (request.method === 'GET' && sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    if (!session) {
      sendJson(response, 404, { error: 'Session not found' });
      return;
    }
    sendJson(response, 200, { session: sanitizeSession(session, { includeLogs: true }) });
    return;
  }

  if (request.method === 'GET') {
    serveStatic(url.pathname, response);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
});

setInterval(sweepSessions, SESSION_SWEEP_INTERVAL_MS).unref();

server.listen(PORT, HOST, () => {
  console.log(`hermes premiere video editor ready at http://${HOST}:${PORT}`);
});
