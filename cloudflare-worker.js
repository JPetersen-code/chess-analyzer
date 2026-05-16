// Chess Analyzer — Cloudflare Worker
// Deploy via: https://dash.cloudflare.com → Workers & Pages → Create Worker → paste this file
// Then: Worker Settings → Variables → add Secret: GEMINI_API_KEY = your key

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
      });
    }

    if (request.method === 'POST' && url.pathname === '/analyze') {
      return handleAnalyze(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/debug') {
      const keySet = !!env.GEMINI_API_KEY;
      const keyLength = env.GEMINI_API_KEY ? env.GEMINI_API_KEY.length : 0;
      const keyPreview = env.GEMINI_API_KEY ? env.GEMINI_API_KEY.slice(0, 6) + '...' : 'NOT SET';
      return new Response(JSON.stringify({ keySet, keyLength, keyPreview }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

async function handleAnalyze(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { imageBase64, mimeType } = body;
  if (!imageBase64 || !mimeType) return json({ error: 'Missing image data' }, 400);

  // 1. Extract FEN via Gemini Vision
  let fen;
  try {
    fen = await extractFen(imageBase64, mimeType, env.GEMINI_API_KEY);
  } catch (err) {
    return json({ error: err.message }, 502);
  }

  if (!fen || fen === 'UNKNOWN' || !isValidFen(fen)) {
    return json({ error: "Couldn't read the chess position from this screenshot. Make sure the full board is visible and the image is clear." }, 422);
  }

  // 2. Get top 3 moves from Lichess cloud eval
  const lichessResp = await fetch(
    `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=3`,
    { headers: { Accept: 'application/json' } }
  );

  if (lichessResp.status === 404) {
    return json({ fen, lichessNotFound: true });
  }

  if (!lichessResp.ok) {
    return json({ error: `Lichess error ${lichessResp.status}` }, 502);
  }

  const moves = await lichessResp.json();
  return json({ fen, moves });
}

async function extractFen(base64, mimeType, apiKey) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: 'This is a chess board screenshot. Identify every piece on every square, then output ONLY the FEN notation string (example: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"). Output nothing else — no explanation, no markdown, just the raw FEN string. If you cannot determine the position, output only the word UNKNOWN.',
            },
            { inline_data: { mime_type: mimeType, data: base64 } },
          ],
        }],
        generationConfig: { temperature: 0 },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `Gemini error ${resp.status}`;
    throw new Error(msg);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'UNKNOWN';
  return text.replace(/```[^\n]*\n?/g, '').replace(/`/g, '').trim();
}

function isValidFen(fen) {
  const rows = fen.trim().split(/\s+/)[0].split('/');
  return rows.length === 8;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ---- Embedded frontend ----
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chess Analyzer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 32px 16px;
    }
    h1 { font-size: 1.6rem; color: #e2c98a; margin-bottom: 6px; }
    .sub { color: #666; font-size: 0.85rem; margin-bottom: 28px; }
    .card {
      background: #16213e;
      border-radius: 14px;
      padding: 22px;
      width: 100%;
      max-width: 480px;
      margin-bottom: 16px;
    }
    .paste-zone {
      border: 2px dashed #2a3a5a;
      border-radius: 10px;
      padding: 48px 20px;
      text-align: center;
      transition: border-color 0.2s, background 0.2s;
      position: relative;
      outline: none;
    }
    .paste-zone.active { border-color: #e2c98a; background: #1e2d4a; }
    .paste-zone.has-image { padding: 0; border-color: #334; overflow: hidden; }
    .paste-zone img { width: 100%; border-radius: 8px; display: block; }
    .paste-icon { font-size: 2.8rem; margin-bottom: 10px; }
    .paste-label { color: #aaa; font-size: 1rem; }
    .paste-hint { color: #555; font-size: 0.8rem; margin-top: 8px; }
    .clear-btn {
      position: absolute; top: 8px; right: 8px;
      background: rgba(0,0,0,0.65); border: none; color: #eee;
      border-radius: 50%; width: 30px; height: 30px;
      cursor: pointer; font-size: 1rem;
      display: flex; align-items: center; justify-content: center;
    }
    .analyze-btn {
      width: 100%; padding: 14px;
      background: #e2c98a; color: #1a1a2e;
      border: none; border-radius: 10px;
      font-size: 1rem; font-weight: 700; cursor: pointer;
      transition: opacity 0.2s; margin-top: 14px;
    }
    .analyze-btn:disabled { opacity: 0.35; cursor: not-allowed; }
    .analyze-btn:not(:disabled):hover { opacity: 0.88; }
    .spinner {
      display: inline-block; width: 16px; height: 16px;
      border: 2px solid #334; border-top-color: #e2c98a;
      border-radius: 50%; animation: spin 0.7s linear infinite;
      vertical-align: middle; margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text { text-align: center; color: #888; font-size: 0.9rem; padding: 8px 0; }
    .fen-box {
      background: #0f1f0f; border: 1px solid #1e3a1e;
      border-radius: 8px; padding: 10px 12px;
      font-family: monospace; font-size: 0.78rem;
      color: #6fdc8c; word-break: break-all; margin-bottom: 14px;
    }
    .fen-label { font-size: 0.75rem; color: #555; margin-bottom: 4px; }
    .move-card {
      background: #0f1729; border-radius: 8px;
      padding: 14px 16px; margin-bottom: 10px;
      display: flex; align-items: center; gap: 14px;
      border-left: 4px solid #2a3a5a;
    }
    .move-card:nth-child(1) { border-left-color: #e2c98a; }
    .move-card:nth-child(2) { border-left-color: #a0b4d0; }
    .move-card:nth-child(3) { border-left-color: #666; }
    .rank { font-size: 1.3rem; font-weight: 700; color: #444; min-width: 24px; }
    .move-card:nth-child(1) .rank { color: #e2c98a; }
    .move-card:nth-child(2) .rank { color: #a0b4d0; }
    .move { font-size: 1.2rem; font-weight: 600; font-family: monospace; }
    .continuation { font-size: 0.75rem; color: #555; font-family: monospace; }
    .eval { margin-left: auto; font-size: 0.9rem; font-family: monospace; font-weight: 600; }
    .pos { color: #6fdc8c; } .neg { color: #ff8b8b; } .neu { color: #a8b4d0; }
    .error-box {
      background: #2a1a1a; border: 1px solid #5a2a2a;
      border-radius: 8px; padding: 14px;
      color: #ff9090; font-size: 0.875rem; line-height: 1.6;
    }
    a { color: #e2c98a; }
    .depth-info { font-size: 0.75rem; color: #555; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>Chess Analyzer</h1>
  <p class="sub">Paste a screenshot &rarr; get the top 3 moves instantly</p>

  <div class="card">
    <div class="paste-zone" id="pasteZone" tabindex="0">
      <div id="pastePrompt">
        <div class="paste-icon">&#128247;</div>
        <div class="paste-label">Paste your chess screenshot here</div>
        <div class="paste-hint">Ctrl+V on desktop &nbsp;&middot;&nbsp; Long-press &rarr; Paste on iPhone</div>
      </div>
      <img id="preview" style="display:none" alt="">
      <button class="clear-btn" id="clearBtn" style="display:none" onclick="clearImage(event)">&#10005;</button>
    </div>
    <button class="analyze-btn" id="analyzeBtn" onclick="analyze()" disabled>Analyze Position</button>
  </div>

  <div class="card" id="resultsCard" style="display:none">
    <div id="results"></div>
  </div>

<script>
  let imageBlob = null;

  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    imageBlob = item.getAsFile();
    showPreview(imageBlob);
  });

  function showPreview(blob) {
    const url = URL.createObjectURL(blob);
    document.getElementById('preview').src = url;
    document.getElementById('preview').style.display = 'block';
    document.getElementById('pastePrompt').style.display = 'none';
    document.getElementById('clearBtn').style.display = 'flex';
    document.getElementById('pasteZone').classList.add('has-image');
    document.getElementById('analyzeBtn').disabled = false;
    document.getElementById('resultsCard').style.display = 'none';
  }

  function clearImage(e) {
    e.stopPropagation();
    imageBlob = null;
    document.getElementById('preview').style.display = 'none';
    document.getElementById('preview').src = '';
    document.getElementById('pastePrompt').style.display = 'block';
    document.getElementById('clearBtn').style.display = 'none';
    document.getElementById('pasteZone').classList.remove('has-image');
    document.getElementById('analyzeBtn').disabled = true;
    document.getElementById('resultsCard').style.display = 'none';
  }

  const zone = document.getElementById('pasteZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('active'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('active'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('active');
    const f = e.dataTransfer.files[0];
    if (f?.type.startsWith('image/')) { imageBlob = f; showPreview(f); }
  });

  async function analyze() {
    if (!imageBlob) return;
    const btn = document.getElementById('analyzeBtn');
    const card = document.getElementById('resultsCard');
    const results = document.getElementById('results');
    btn.disabled = true;
    card.style.display = 'block';
    results.innerHTML = '<p class="status-text"><span class="spinner"></span>Reading board&hellip;</p>';

    try {
      const base64 = await toBase64(imageBlob);
      const resp = await fetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType: imageBlob.type || 'image/png' }),
      });

      const data = await resp.json();

      if (data.error) {
        results.innerHTML = \`<div class="error-box">\${data.error}</div>\`;
        return;
      }

      const { fen, moves, lichessNotFound } = data;
      const fenHtml = \`<div class="fen-label">Detected position</div><div class="fen-box">\${fen}</div>\`;

      if (lichessNotFound) {
        results.innerHTML = fenHtml + '<p class="status-text"><span class="spinner"></span>Running Stockfish engine locally&hellip;</p>';
        try {
          const pvs = await analyzeWithStockfish(fen);
          results.innerHTML = fenHtml + '<div class="depth-info">Stockfish local analysis</div>' + renderCards(pvs);
        } catch (err) {
          results.innerHTML = fenHtml + \`<div class="error-box">Engine error: \${err.message}</div>\`;
        }
        return;
      }

      const pvs = moves.pvs || [];
      const depth = moves.depth ? \`<div class="depth-info">Depth \${moves.depth} &middot; <a href="https://lichess.org/analysis/\${encodeURIComponent(fen)}" target="_blank">Open in Lichess</a></div>\` : '';
      results.innerHTML = fenHtml + depth + renderCards(pvs);

    } catch (err) {
      results.innerHTML = \`<div class="error-box">Request failed: \${err.message}</div>\`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderCards(pvs) {
    return pvs.slice(0, 3).map((pv, i) => {
      const ms = (pv.moves || '').split(' ');
      const best = ms[0] || '?';
      const cont = ms.slice(1, 4).join(' ');
      let ev = '', cls = 'neu';
      if (pv.cp !== undefined) {
        ev = (pv.cp > 0 ? '+' : '') + (pv.cp / 100).toFixed(2);
        cls = pv.cp > 30 ? 'pos' : pv.cp < -30 ? 'neg' : 'neu';
      } else if (pv.mate !== undefined) {
        ev = 'M' + pv.mate;
        cls = pv.mate > 0 ? 'pos' : 'neg';
      }
      return \`<div class="move-card">
        <div class="rank">#\${i+1}</div>
        <div>
          <div class="move">\${best}</div>
          \${cont ? \`<div class="continuation">\${cont}&hellip;</div>\` : ''}
        </div>
        <div class="eval \${cls}">\${ev}</div>
      </div>\`;
    }).join('');
  }

  async function analyzeWithStockfish(fen) {
    const resp = await fetch('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
    if (!resp.ok) throw new Error('Could not load Stockfish engine');
    const script = await resp.text();
    const blob = new Blob([script], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));

    return new Promise((resolve, reject) => {
      const pvs = [];
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        worker.terminate();
        resolve(pvs.filter(Boolean).slice(0, 3));
      };

      setTimeout(finish, 8000);

      worker.onmessage = e => {
        const msg = e.data;
        if (msg.startsWith('info') && msg.includes('multipv') && msg.includes(' pv ')) {
          const idx = parseInt(msg.match(/multipv (\d+)/)?.[1] || '1') - 1;
          const pv = msg.match(/ pv (.+)/)?.[1]?.trim().split(' ') || [];
          const cp = msg.match(/score cp (-?\d+)/)?.[1];
          const mate = msg.match(/score mate (-?\d+)/)?.[1];
          if (pv.length) {
            pvs[idx] = {
              moves: pv.join(' '),
              cp: cp !== undefined ? parseInt(cp) : undefined,
              mate: mate !== undefined ? parseInt(mate) : undefined,
            };
          }
        }
        if (msg.startsWith('bestmove')) finish();
      };

      worker.onerror = e => { if (!settled) { settled = true; worker.terminate(); reject(new Error(e.message)); } };

      worker.postMessage('uci');
      worker.postMessage('isready');
      worker.postMessage(\`position fen \${fen}\`);
      worker.postMessage('setoption name MultiPV value 3');
      worker.postMessage('go movetime 3000');
    });
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }
<\/script>
</body>
</html>`;
