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
  const prompt = `Look at this chess board screenshot carefully. Fill in every square of the 8x8 grid below.

Use exactly these characters:
- White pieces: K Q R B N P
- Black pieces: k q r b n p
- Empty square: .

Output exactly 8 lines, each with exactly 8 characters separated by spaces.
Row 1 = rank 8 (the top row of the board, black's back rank).
Row 8 = rank 1 (the bottom row, white's back rank).
Column 1 = file a (leftmost). Column 8 = file h (rightmost).

Example (starting position):
r n b q k b n r
p p p p p p p p
. . . . . . . .
. . . . . . . .
. . . . . . . .
. . . . . . . .
P P P P P P P P
R N B Q K B N R

Output ONLY the 8 lines. No explanation, no labels, no extra text.`;

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
    throw new Error(err?.error?.message || `Gemini error ${resp.status}`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  return gridToFen(text);
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
  <title>Joe's Chess Screenshot Analyzer</title>
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
    .attach-btn {
      width: 100%; padding: 12px;
      background: #1e2d4a; color: #a8b4d0;
      border: 1px solid #2a3a5a; border-radius: 10px;
      font-size: 0.95rem; font-weight: 600; cursor: pointer;
      margin-top: 12px; transition: border-color 0.2s, color 0.2s;
    }
    .attach-btn:hover { border-color: #e2c98a; color: #e2c98a; }
    .analyze-btn {
      width: 100%; padding: 14px;
      background: #e2c98a; color: #1a1a2e;
      border: none; border-radius: 10px;
      font-size: 1rem; font-weight: 700; cursor: pointer;
      transition: opacity 0.2s; margin-top: 10px;
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
      padding: 14px 16px; margin-bottom: 16px;
      border-left: 4px solid #2a3a5a;
    }
    .move-card:nth-child(1) { border-left-color: #e2c98a; }
    .move-card:nth-child(2) { border-left-color: #a0b4d0; }
    .move-card:nth-child(3) { border-left-color: #666; }
    .move-header { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
    .rank { font-size: 1.3rem; font-weight: 700; color: #444; min-width: 24px; }
    .move-card:nth-child(1) .rank { color: #e2c98a; }
    .move-card:nth-child(2) .rank { color: #a0b4d0; }
    .move { font-size: 1.2rem; font-weight: 600; font-family: monospace; }
    .continuation { font-size: 0.75rem; color: #555; font-family: monospace; }
    .eval { margin-left: auto; font-size: 0.9rem; font-family: monospace; font-weight: 600; }
    .pos { color: #6fdc8c; } .neg { color: #ff8b8b; } .neu { color: #a8b4d0; }
    .chess-board {
      display: grid;
      grid-template-columns: repeat(8, 28px);
      grid-template-rows: repeat(8, 28px);
      width: 224px; height: 224px;
      margin: 12px auto 0; border: 2px solid #3a3a5a;
      border-radius: 4px; overflow: hidden; flex-shrink: 0;
    }
    .chess-board > div {
      width: 28px; height: 28px; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      font-size: 1.1rem; line-height: 1; user-select: none;
    }
    .sq-light { background: #f0d9b5; }
    .sq-dark  { background: #b58863; }
    .sq-from  { background: rgba(210, 60, 60, 0.72) !important; }
    .sq-to    { background: rgba(60, 200, 60, 0.72) !important; }
    .pc-w { color: #fff; text-shadow: 0 0 3px #000, 0 0 1px #000; }
    .pc-b { color: #111; text-shadow: 0 0 3px rgba(255,255,255,0.4); }
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
  <h1>Joe's Chess Screenshot Analyzer</h1>
  <p class="sub">Upload a screenshot of your chess game to see the top 3 moves for any position.</p>
  <p class="sub" style="max-width:420px; text-align:center; margin-bottom:24px;">
    Built for post-game study and practice against AI &mdash; not for use during games against real people.
  </p>

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
    <input type="file" id="fileInput" accept="image/*" style="display:none" onchange="handleFile(event)">
    <button class="attach-btn" onclick="document.getElementById('fileInput').click()">&#128247; Attach Screenshot</button>
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
          results.innerHTML = fenHtml + '<div class="fen-label" style="margin-bottom:4px">Detected position</div>' + renderCurrentBoard(fen) + '<div class="depth-info" style="margin-top:12px">Stockfish local analysis — top 3 moves</div>' + renderCards(pvs, fen);
        } catch (err) {
          results.innerHTML = fenHtml + \`<div class="error-box">Engine error: \${err.message}</div>\`;
        }
        return;
      }

      const pvs = moves.pvs || [];
      const depth = moves.depth ? \`<div class="depth-info">Depth \${moves.depth} &middot; <a href="https://lichess.org/analysis/\${encodeURIComponent(fen)}" target="_blank">Open in Lichess</a></div>\` : '';
      results.innerHTML = fenHtml + '<div class="fen-label" style="margin-bottom:4px">Detected position</div>' + renderCurrentBoard(fen) + '<div class="depth-info" style="margin-top:12px">' + (depth || '') + 'Top 3 moves</div>' + renderCards(pvs, fen);

    } catch (err) {
      results.innerHTML = \`<div class="error-box">Request failed: \${err.message}</div>\`;
    } finally {
      btn.disabled = false;
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
    const ff = fromSq.charCodeAt(0)-97, fr = 8-+fromSq[1];
    const tf = toSq.charCodeAt(0)-97,   tr = 8-+toSq[1];
    let html = '<div class="chess-board">';
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
    return html + '</div>';
  }

  function renderCurrentBoard(baseFen) {
    const board = parseFenBoard(baseFen);
    let html = '<div class="chess-board">';
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const light = (r + f) % 2 === 0;
        const p = (board[r] || [])[f] || null;
        const isWhite = p && p === p.toUpperCase();
        let cls = light ? 'sq-light' : 'sq-dark';
        if (p) cls += isWhite ? ' pc-w' : ' pc-b';
        html += \`<div class="\${cls}">\${p && SYM[p] ? SYM[p] : ''}</div>\`;
      }
    }
    return html + '</div>';
  }

  function renderCards(pvs, baseFen) {
    const board = parseFenBoard(baseFen);
    return pvs.slice(0, 3).map((pv, i) => {
      const ms = (pv.moves || '').split(' ');
      const uci = ms[0] || '';
      const cont = ms.slice(1, 4).join(' ');
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
        <div class="move-header">
          <div class="rank">#\${i+1}</div>
          <div>
            <div class="move">\${uci}</div>
            \${cont ? \`<div class="continuation">\${cont}&hellip;</div>\` : ''}
          </div>
          <div class="eval \${cls}">\${ev}</div>
        </div>
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
