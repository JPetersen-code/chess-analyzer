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
  let fen, rawGemini;
  try {
    ({ fen, raw: rawGemini } = await extractFen(imageBase64, mimeType, env.GEMINI_API_KEY));
  } catch (err) {
    if (err.message.startsWith('RATE_LIMIT:')) {
      const seconds = err.message.split(':')[1];
      return json({ rateLimited: true, retryAfter: parseInt(seconds) }, 429);
    }
    return json({ error: err.message }, 502);
  }

  if (!fen || fen === 'UNKNOWN' || !isValidFen(fen)) {
    return json({ error: "Couldn't read the chess position from this screenshot. Make sure the full board is visible and the image is clear.", rawGemini }, 422);
  }

  // 2. Get top 3 moves from Lichess cloud eval
  const lichessResp = await fetch(
    `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=3`,
    { headers: { Accept: 'application/json' } }
  );

  if (lichessResp.status === 404) {
    return json({ fen, rawGemini, lichessNotFound: true });
  }

  if (!lichessResp.ok) {
    return json({ error: `Lichess error ${lichessResp.status}` }, 502);
  }

  const moves = await lichessResp.json();
  return json({ fen, rawGemini, moves });
}

async function extractFen(base64, mimeType, apiKey) {
  const prompt = `You are analyzing a chess board screenshot. Output the FEN (Forsyth-Edwards Notation) string for the position shown.

Rules:
- Uppercase = white pieces (K Q R B N P), lowercase = black pieces (k q r b n p)
- White pieces are the lighter-colored pieces, black pieces are darker
- The board may have white at the bottom OR black at the bottom — determine orientation first
- Rank 8 is black's back rank, rank 1 is white's back rank
- Files go a (left from white's view) to h (right from white's view)

Output ONLY the FEN piece-placement string (the first field only, e.g. rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR).
No other text. No spaces around slashes.`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
        generationConfig: { temperature: 0 },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    const msg = err?.error?.message || `Gemini error ${resp.status}`;
    if (resp.status === 429) {
      const seconds = Math.ceil(parseFloat(msg.match(/retry in ([\d.]+)s/i)?.[1] || '60'));
      throw new Error(`RATE_LIMIT:${seconds}`);
    }
    throw new Error(msg);
  }

  const data = await resp.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find(p => p.text && !p.thought) || parts[parts.length - 1] || {};
  const raw = (textPart.text || '').trim().replace(/```[^\n]*\n?/g, '').replace(/`/g, '').trim();

  // Build full FEN from piece placement only
  const placement = raw.split('\n')[0].trim();
  const fen = placement + ' w - - 0 1';
  return { fen: isValidFen(fen) ? fen : 'UNKNOWN', raw };
}

function gridToFen(grid) {
  const lines = grid.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 8) return 'UNKNOWN';
  const ranks = [];
  for (let i = 0; i < 8; i++) {
    const cells = lines[i].split(/\s+/).filter(c => c.length === 1);
    if (cells.length !== 8) return 'UNKNOWN';
    let rank = '', empty = 0;
    for (const c of cells) {
      if (c === '.') { empty++; }
      else { if (empty) { rank += empty; empty = 0; } rank += c; }
    }
    if (empty) rank += empty;
    ranks.push(rank);
  }
  // detect side to move: if more white pieces have moved, black to move — default white
  return ranks.join('/') + ' w - - 0 1';
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
  <title>Joe's Chess Analyzer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0d1117;
      color: #e0e4f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 16px 60px;
    }

    /* ── Header ── */
    .site-header { text-align: center; margin-bottom: 36px; }
    .site-header .logo { font-size: 2.2rem; margin-bottom: 8px; }
    .site-header h1 {
      font-size: 1.75rem; font-weight: 700;
      color: #e2c98a; letter-spacing: -0.02em;
    }
    .site-header .tagline {
      color: #4a5568; font-size: 0.82rem; margin-top: 6px; line-height: 1.5;
    }
    .badge {
      display: inline-block; margin-top: 10px;
      background: #1a2535; border: 1px solid #2a3a55;
      color: #6b7a9a; font-size: 0.72rem; padding: 4px 10px;
      border-radius: 20px; letter-spacing: 0.02em;
    }

    /* ── Upload card ── */
    .upload-card {
      background: #161b27;
      border: 1px solid #1e2a3a;
      border-radius: 16px;
      padding: 24px;
      width: 100%; max-width: 500px;
      margin-bottom: 24px;
    }
    .section-label {
      font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: #4a5568; margin-bottom: 12px;
    }
    .paste-zone {
      border: 2px dashed #1e2a3a;
      border-radius: 12px;
      padding: 44px 20px;
      text-align: center;
      transition: border-color 0.2s, background 0.2s;
      position: relative; outline: none; cursor: default;
    }
    .paste-zone.active { border-color: #e2c98a; background: #1a2235; }
    .paste-zone.has-image { padding: 0; border-color: #2a3a5a; overflow: hidden; }
    .paste-zone img { width: 100%; border-radius: 10px; display: block; }
    .paste-icon { font-size: 2.4rem; margin-bottom: 10px; opacity: 0.7; }
    .paste-label { color: #8892a4; font-size: 0.95rem; font-weight: 500; }
    .paste-hint { color: #3a4458; font-size: 0.78rem; margin-top: 8px; }
    .clear-btn {
      position: absolute; top: 10px; right: 10px;
      background: rgba(0,0,0,0.7); border: none; color: #ccc;
      border-radius: 50%; width: 28px; height: 28px;
      cursor: pointer; font-size: 0.85rem;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    .clear-btn:hover { background: rgba(0,0,0,0.9); }
    .btn-row { display: flex; gap: 10px; margin-top: 14px; }
    .attach-btn {
      flex: 1; padding: 11px;
      background: transparent; color: #8892a4;
      border: 1px solid #1e2a3a; border-radius: 10px;
      font-size: 0.88rem; font-weight: 500; cursor: pointer;
      transition: border-color 0.2s, color 0.2s;
    }
    .attach-btn:hover { border-color: #e2c98a; color: #e2c98a; }
    .analyze-btn {
      flex: 2; padding: 11px;
      background: #e2c98a; color: #0d1117;
      border: none; border-radius: 10px;
      font-size: 0.95rem; font-weight: 700; cursor: pointer;
      transition: opacity 0.2s, transform 0.1s;
    }
    .analyze-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .analyze-btn:not(:disabled):hover { opacity: 0.9; }
    .analyze-btn:not(:disabled):active { transform: scale(0.98); }

    /* ── Results wrapper ── */
    .results-outer {
      width: 100%; max-width: 960px;
      display: none;
    }

    /* ── Status / error ── */
    .spinner {
      display: inline-block; width: 15px; height: 15px;
      border: 2px solid #1e2a3a; border-top-color: #e2c98a;
      border-radius: 50%; animation: spin 0.7s linear infinite;
      vertical-align: middle; margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status-text { text-align: center; color: #4a5568; font-size: 0.9rem; padding: 20px 0; }
    .error-box {
      background: #1a0f0f; border: 1px solid #3a1a1a;
      border-radius: 10px; padding: 16px;
      color: #f08080; font-size: 0.875rem; line-height: 1.6;
    }

    /* ── FEN editor ── */
    .fen-section {
      background: #161b27; border: 1px solid #1e2a3a;
      border-radius: 16px; padding: 20px;
      margin-bottom: 20px;
    }
    .fen-edit {
      width: 100%; background: #0d1117; border: 1px solid #1e2a3a;
      border-radius: 8px; padding: 10px 12px;
      font-family: monospace; font-size: 0.8rem;
      color: #6fdc8c; margin-bottom: 10px;
      resize: none; height: 48px; line-height: 1.6;
    }
    .fen-edit:focus { outline: none; border-color: #e2c98a; }
    .fen-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .fen-link {
      color: #6b7a9a; font-size: 0.78rem; padding: 6px 12px;
      border: 1px solid #1e2a3a; border-radius: 6px; text-decoration: none;
      transition: border-color 0.2s, color 0.2s; white-space: nowrap;
    }
    .fen-link:hover { border-color: #a0b4d0; color: #a0b4d0; }
    .get-moves-btn {
      margin-left: auto; padding: 8px 20px;
      background: #1a3a1a; color: #6fdc8c;
      border: 1px solid #2a5a2a; border-radius: 8px;
      font-size: 0.88rem; font-weight: 700; cursor: pointer;
      transition: background 0.2s; white-space: nowrap;
    }
    .get-moves-btn:hover { background: #2a5a2a; }

    /* ── Position + moves layout ── */
    .analysis-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 20px;
      align-items: start;
    }
    @media (max-width: 700px) {
      .analysis-grid { grid-template-columns: 1fr; }
    }

    .position-panel {
      background: #161b27; border: 1px solid #1e2a3a;
      border-radius: 16px; padding: 20px;
      display: flex; flex-direction: column; align-items: center;
    }
    .moves-panel {
      background: #161b27; border: 1px solid #1e2a3a;
      border-radius: 16px; padding: 20px;
    }
    .panel-title {
      font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: #4a5568; margin-bottom: 14px;
    }

    /* ── Move cards side by side ── */
    .moves-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }
    @media (max-width: 500px) {
      .moves-grid { grid-template-columns: 1fr; }
    }

    .move-card {
      background: #0d1117; border-radius: 12px; padding: 14px 12px;
      border-top: 3px solid #1e2a3a;
      display: flex; flex-direction: column; align-items: center;
      transition: border-color 0.2s;
    }
    .move-card:nth-child(1) { border-top-color: #e2c98a; }
    .move-card:nth-child(2) { border-top-color: #94a3b8; }
    .move-card:nth-child(3) { border-top-color: #78553a; }

    .move-badge {
      font-size: 1rem; margin-bottom: 4px;
    }
    .move-uci {
      font-family: monospace; font-size: 1.25rem; font-weight: 700;
      color: #e0e4f0; margin-bottom: 2px;
    }
    .move-eval {
      font-family: monospace; font-size: 0.82rem; font-weight: 600;
      padding: 2px 8px; border-radius: 4px; margin-bottom: 10px;
      background: #1e2a3a;
    }
    .move-eval.pos { color: #4ade80; }
    .move-eval.neg { color: #f87171; }
    .move-eval.neu { color: #94a3b8; }
    .move-cont { font-size: 0.68rem; color: #3a4458; font-family: monospace; margin-bottom: 10px; min-height: 16px; }

    /* ── Chess board ── */
    .chess-board {
      display: grid;
      grid-template-columns: repeat(8, 26px);
      grid-template-rows: repeat(8, 26px);
      width: 208px; height: 208px;
      border: 2px solid #2a3a5a;
      border-radius: 4px; overflow: hidden;
    }
    .chess-board > div {
      width: 26px; height: 26px;
      display: flex; align-items: center; justify-content: center;
      font-size: 1rem; line-height: 1; user-select: none;
    }
    .chess-board.large {
      grid-template-columns: repeat(8, 34px);
      grid-template-rows: repeat(8, 34px);
      width: 272px; height: 272px;
    }
    .chess-board.large > div { width: 34px; height: 34px; font-size: 1.35rem; }

    .sq-light { background: #f0d9b5; }
    .sq-dark  { background: #b58863; }
    .sq-from  { background: rgba(220, 60, 60, 0.75) !important; }
    .sq-to    { background: rgba(60, 210, 80, 0.75) !important; }
    .pc-w { color: #fff; text-shadow: 0 0 4px #000, 0 0 2px #000; }
    .pc-b { color: #111; text-shadow: 0 0 3px rgba(255,255,255,0.5); }

    .coord-lbl { font-size: 0.5rem; color: #555; display: flex; align-items: center; justify-content: center; }
    .depth-info { font-size: 0.72rem; color: #3a4458; margin-top: 10px; text-align: center; }
    a { color: #e2c98a; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>

  <div class="site-header">
    <div class="logo">♟</div>
    <h1>Joe's Chess Analyzer</h1>
    <p class="tagline">Screenshot any chess position &rarr; get the top 3 engine moves instantly</p>
    <span class="badge">For post-game study &amp; AI practice &mdash; not for use against real people</span>
  </div>

  <div class="upload-card">
    <div class="section-label">Step 1 &mdash; Add your screenshot</div>
    <div class="paste-zone" id="pasteZone" tabindex="0">
      <div id="pastePrompt">
        <div class="paste-icon">&#128247;</div>
        <div class="paste-label">Paste or drag your screenshot here</div>
        <div class="paste-hint">Ctrl+V on desktop &nbsp;&middot;&nbsp; Long-press &rarr; Paste on iPhone</div>
      </div>
      <img id="preview" style="display:none" alt="">
      <button class="clear-btn" id="clearBtn" style="display:none" onclick="clearImage(event)">&#10005;</button>
    </div>
    <input type="file" id="fileInput" accept="image/*" style="display:none" onchange="handleFile(event)">
    <div class="btn-row">
      <button class="attach-btn" onclick="document.getElementById('fileInput').click()">&#128247; Attach</button>
      <button class="analyze-btn" id="analyzeBtn" onclick="analyze()" disabled>Analyze Position</button>
    </div>
  </div>

  <div class="results-outer" id="resultsOuter">
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
    document.getElementById('resultsOuter').style.display = 'none';
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
    document.getElementById('resultsOuter').style.display = 'none';
  }

  function handleFile(e) {
    const f = e.target.files[0];
    if (f) { imageBlob = f; showPreview(f); }
    e.target.value = '';
  }

  const zone = document.getElementById('pasteZone');
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('active'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('active'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('active');
    const f = e.dataTransfer.files[0];
    if (f?.type.startsWith('image/')) { imageBlob = f; showPreview(f); }
  });

  async function analyze(isRetry = false) {
    if (!imageBlob) return;
    const btn = document.getElementById('analyzeBtn');
    const card = document.getElementById('resultsOuter');
    const results = document.getElementById('results');
    btn.disabled = true;
    document.getElementById('resultsOuter').style.display = 'block';
    results.innerHTML = '<p class="status-text"><span class="spinner"></span>Reading board with Gemini&hellip;</p>';

    try {
      const base64 = await toBase64(imageBlob);
      const resp = await fetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, mimeType: imageBlob.type || 'image/png' }),
      });

      const data = await resp.json();

      if (data.rateLimited) {
        if (isRetry) {
          results.innerHTML = \`<div class="error-box">Rate limit still active. Please wait a minute or two, then click Analyze again.</div>\`;
          btn.disabled = false;
          return;
        }
        let secs = (data.retryAfter || 60) + 15;
        const tick = () => {
          results.innerHTML = \`<div class="error-box" style="text-align:center">Gemini rate limit hit &mdash; retrying in <strong>\${secs}s</strong>&hellip;<br><span style="font-size:0.8rem;color:#888">Free tier: 20 requests/min</span></div>\`;
          if (secs <= 0) { analyze(true); return; }
          secs--; setTimeout(tick, 1000);
        };
        tick();
        return;
      }

      if (data.error) {
        results.innerHTML = \`<div class="error-box">\${data.error}</div>\`;
        return;
      }

      // Show editable FEN — user verifies/corrects before getting moves
      showFenEditor(data.fen, results);

    } catch (err) {
      results.innerHTML = \`<div class="error-box">Request failed: \${err.message}</div>\`;
    } finally {
      btn.disabled = false;
    }
  }

  function showFenEditor(fen, container) {
    const lichessUrl = \`https://lichess.org/analysis/\${encodeURIComponent(fen)}\`;
    container.innerHTML = \`
      <div class="fen-section">
        <div class="section-label">Step 2 &mdash; Verify detected position</div>
        <textarea class="fen-edit" id="fenEdit" spellcheck="false">\${fen}</textarea>
        <div class="fen-row">
          <a class="fen-link" id="lichessVerify" href="\${lichessUrl}" target="_blank">Verify in Lichess &#8599;</a>
          <button class="get-moves-btn" onclick="getMovesForFen()">Get Top Moves &rarr;</button>
        </div>
      </div>
      <div id="moveResults"></div>
    \`;
    document.getElementById('fenEdit').addEventListener('input', () => {
      const v = document.getElementById('fenEdit').value.trim();
      document.getElementById('lichessVerify').href = \`https://lichess.org/analysis/\${encodeURIComponent(v)}\`;
    });
  }

  async function getMovesForFen() {
    const rawFen = document.getElementById('fenEdit').value.trim();
    const fen = rawFen.includes(' ') ? rawFen : rawFen + ' w - - 0 1';
    const moveResults = document.getElementById('moveResults');

    moveResults.innerHTML = '<p class="status-text"><span class="spinner"></span>Getting top moves&hellip;</p>';

    try {
      const lichessResp = await fetch(
        \`https://lichess.org/api/cloud-eval?fen=\${encodeURIComponent(fen)}&multiPv=3\`,
        { headers: { Accept: 'application/json' } }
      );

      if (lichessResp.status === 404) {
        moveResults.innerHTML = '<p class="status-text"><span class="spinner"></span>Running Stockfish engine locally&hellip;</p>';
        try {
          const pvs = await analyzeWithStockfish(fen);
          moveResults.innerHTML = \`
            <div class="analysis-grid">
              <div class="position-panel">
                <div class="panel-title">Current Position</div>
                \${renderCurrentBoard(fen)}
                <div class="depth-info">Stockfish local engine</div>
              </div>
              <div class="moves-panel">
                <div class="panel-title">Top 3 Moves</div>
                <div class="moves-grid">\${renderCards(pvs, fen)}</div>
              </div>
            </div>\`;
        } catch (err) {
          moveResults.innerHTML = \`<div class="error-box">Engine error: \${err.message}</div>\`;
        }
        return;
      }

      if (!lichessResp.ok) {
        moveResults.innerHTML = \`<div class="error-box">Lichess error \${lichessResp.status}</div>\`;
        return;
      }

      const moves = await lichessResp.json();
      const pvs = moves.pvs || [];
      const depth = moves.depth ? \`Depth \${moves.depth} &middot; <a href="https://lichess.org/analysis/\${encodeURIComponent(fen)}" target="_blank">Open in Lichess &#8599;</a>\` : '';
      moveResults.innerHTML = \`
        <div class="analysis-grid">
          <div class="position-panel">
            <div class="panel-title">Current Position</div>
            \${renderCurrentBoard(fen)}
            <div class="depth-info">\${depth}</div>
          </div>
          <div class="moves-panel">
            <div class="panel-title">Top 3 Moves</div>
            <div class="moves-grid">\${renderCards(pvs, fen)}</div>
          </div>
        </div>\`;
    } catch (err) {
      moveResults.innerHTML = \`<div class="error-box">Error: \${err.message}</div>\`;
    }
  }

  const SYM = {
    K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',
    k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟',
  };

  function parseFenBoard(fen) {
    return fen.split(' ')[0].split('/').map(row => {
      const rank = [];
      for (const ch of row) {
        if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) rank.push(null);
        else rank.push(ch);
      }
      while (rank.length < 8) rank.push(null); // pad malformed rows
      return rank;
    });
  }

  function applyUci(board, uci) {
    const b = board.map(r => [...r]);
    const ff = uci.charCodeAt(0) - 97, fr = 8 - +uci[1];
    const tf = uci.charCodeAt(2) - 97, tr = 8 - +uci[3];
    const promo = uci[4];
    const piece = b[fr][ff];
    const wasEmpty = b[tr][tf] === null;
    b[fr][ff] = null;
    b[tr][tf] = promo ? (piece === piece.toUpperCase() ? promo.toUpperCase() : promo) : piece;
    // castling
    if ((piece === 'K' || piece === 'k') && Math.abs(tf - ff) === 2) {
      if (tf === 6) { b[fr][5] = b[fr][7]; b[fr][7] = null; }
      else          { b[fr][3] = b[fr][0]; b[fr][0] = null; }
    }
    // en passant
    if ((piece === 'P' || piece === 'p') && ff !== tf && wasEmpty) b[fr][tf] = null;
    return b;
  }

  function renderBoard(board, fromSq, toSq) {
    return renderBoardWithCoords(board, fromSq, toSq);
  }

  function renderCurrentBoard(baseFen) {
    const board = parseFenBoard(baseFen);
    return renderBoardWithCoords(board, null, null, true);
  }

  function renderBoardWithCoords(board, fromSq, toSq, large = false) {
    const sq = large ? 34 : 26;
    const ff = fromSq ? fromSq.charCodeAt(0)-97 : -1;
    const fr = fromSq ? 8-+fromSq[1] : -1;
    const tf = toSq ? toSq.charCodeAt(0)-97 : -1;
    const tr = toSq ? 8-+toSq[1] : -1;
    const lbl = \`font-size:0.5rem;color:#555;display:flex;align-items:center;justify-content:center;\`;
    let html = \`<div style="display:flex;flex-direction:column;align-items:center;">\`;
    html += \`<div style="display:flex;">\`;
    html += \`<div style="display:flex;flex-direction:column;">\`;
    for (let r = 0; r < 8; r++) html += \`<div style="width:10px;height:\${sq}px;\${lbl}">\${8-r}</div>\`;
    html += \`</div><div class="chess-board\${large?' large':''}">\`;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const light = (r + f) % 2 === 0;
        const isFrom = r === fr && f === ff;
        const isTo   = r === tr && f === tf;
        const p = (board[r] || [])[f] || null;
        const isWhite = p && p === p.toUpperCase();
        let cls = light ? 'sq-light' : 'sq-dark';
        if (isFrom) cls += ' sq-from';
        if (isTo)   cls += ' sq-to';
        if (p) cls += isWhite ? ' pc-w' : ' pc-b';
        html += \`<div class="\${cls}">\${p && SYM[p] ? SYM[p] : ''}</div>\`;
      }
    }
    html += \`</div></div>\`;
    html += \`<div style="display:flex;margin-left:10px;">\`;
    for (let f = 0; f < 8; f++) html += \`<div style="width:\${sq}px;height:10px;\${lbl}">\${String.fromCharCode(97+f)}</div>\`;
    html += \`</div></div>\`;
    return html;
  }

  const MEDALS = ['🥇','🥈','🥉'];

  function renderCards(pvs, baseFen) {
    const board = parseFenBoard(baseFen);
    return pvs.slice(0, 3).map((pv, i) => {
      const ms = (pv.moves || '').split(' ');
      const uci = ms[0] || '';
      const cont = ms.slice(1, 3).join(' ');
      let ev = '', cls = 'neu';
      if (pv.cp !== undefined) {
        ev = (pv.cp > 0 ? '+' : '') + (pv.cp / 100).toFixed(2);
        cls = pv.cp > 30 ? 'pos' : pv.cp < -30 ? 'neg' : 'neu';
      } else if (pv.mate !== undefined) {
        ev = 'M' + pv.mate; cls = pv.mate > 0 ? 'pos' : 'neg';
      }
      let boardHtml = '';
      if (uci.length >= 4) {
        try {
          const newBoard = applyUci(board, uci);
          boardHtml = renderBoard(newBoard, uci.slice(0,2), uci.slice(2,4));
        } catch(e) {}
      }
      return \`<div class="move-card">
        <div class="move-badge">\${MEDALS[i]}</div>
        <div class="move-uci">\${uci}</div>
        <div class="move-eval \${cls}">\${ev}</div>
        <div class="move-cont">\${cont ? cont + '&hellip;' : ''}</div>
        \${boardHtml}
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
