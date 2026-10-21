#!/usr/bin/env node
'use strict';

/**
 * 末日回响 · 本地叙事服务
 * ------------------------------------------------------------
 * 零依赖。启动后：
 *   1. 静态托管本目录（首页为 丧尸生存.html）
 *   2. GET  /api/info  返回服务状态、工作目录、可用模型
 *   3. POST /api/game  把 叙事设定.txt 模板填好后交给本机 claude CLI 生成剧情
 *
 * 启动：node server.js  或双击「启动聊天.bat」
 * 访问：http://127.0.0.1:3456
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3456);
const TEMPLATE_FILE = path.join(ROOT, '叙事设定.txt');
const ORIGIN_TEMPLATE_FILE = path.join(ROOT, '出身生成.txt');
const ANALYSIS_TEMPLATE_FILE = path.join(ROOT, '行动分析.txt');
const HOME_PAGE = '丧尸生存.html';
const MAX_BODY = 1024 * 1024;
const CLI_TIMEOUT = 180000;

/**
 * 各接口默认模型（仅在前端未显式传 model 时生效；前端设置里的 cliModel 会覆盖）。
 * 值需是 `claude -p --model` 可识别的别名（opus/sonnet/haiku/fable）或完整模型名。
 * 可通过环境变量覆盖：NARRATE_MODEL / ORIGIN_MODEL / ANALYZE_MODEL。
 *
 * - 叙事：留空沿用 CLI 默认（质量优先）；
 * - 出身生成：默认 sonnet（开局一次性，兼顾速度与质量）；
 * - 行动分析：默认 haiku（输入停顿即触发，追求低延迟）。
 */
const DEFAULT_NARRATE_MODEL = process.env.NARRATE_MODEL || '';
const DEFAULT_ORIGIN_MODEL = process.env.ORIGIN_MODEL || 'sonnet';
const DEFAULT_ANALYZE_MODEL = process.env.ANALYZE_MODEL || 'haiku';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

/* ---------- 小工具 ---------- */
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cliInfo() {
  const bin = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  try {
    const r = spawnSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      shell: process.platform === 'win32',
      windowsHide: true
    });
    if (r.status === 0) {
      return { available: true, version: String(r.stdout || '').trim() };
    }
    return { available: false, version: '', error: String(r.stderr || '').trim() };
  } catch (e) {
    return { available: false, version: '', error: e.message };
  }
}

const CLI = cliInfo();

/* ---------- 提示词模板 ---------- */
function fillTemplate(tpl, vars = {}, action = '', history = '') {
  const map = Object.assign({}, vars, { action, history });
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = map[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function buildPrompt(payload) {
  if (!fs.existsSync(TEMPLATE_FILE)) {
    throw new Error('缺少 叙事设定.txt 提示词模板');
  }
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  return fillTemplate(tpl, payload.vars || {}, payload.action || '', payload.history || '');
}

function buildOriginPrompt(payload) {
  if (!fs.existsSync(ORIGIN_TEMPLATE_FILE)) {
    throw new Error('缺少 出身生成.txt 提示词模板');
  }
  const tpl = fs.readFileSync(ORIGIN_TEMPLATE_FILE, 'utf8');
  return fillTemplate(tpl, {
    description: String(payload.description || ''),
    playerName: String(payload.name || '玩家'),
    difficulty: String(payload.difficulty || '困难')
  });
}

function buildAnalysisPrompt(payload) {
  if (!fs.existsSync(ANALYSIS_TEMPLATE_FILE)) {
    throw new Error('缺少 行动分析.txt 提示词模板');
  }
  const tpl = fs.readFileSync(ANALYSIS_TEMPLATE_FILE, 'utf8');
  return fillTemplate(
    tpl,
    { context: String(payload.context || '') },
    String(payload.action || '')
  );
}

/* ---------- 调用本机 claude CLI ---------- */
function callClaude(prompt, model, timeoutMs = CLI_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'text',
      '--no-session-persistence',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none'
    ];
    if (model) args.push('--model', model);

    const env = Object.assign({}, process.env);
    // 避免从当前 Claude Code / 终端会话继承嵌套标记
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SESSION_ID;
    // 禁用自动更新/生命周期切换：否则 claude CLI 启动时可能触发
    // `npm i -g @anthropic-ai/claude-code@latest`，把整次调用卡住（本游戏「一直卡在推演」的根因）。
    env.DISABLE_AUTOUPDATER = '1';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

    const isWin = process.platform === 'win32';
    const bin = isWin ? 'claude.cmd' : 'claude';
    const child = spawn(bin, args, {
      cwd: ROOT,
      env,
      shell: isWin,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(text);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(new Error(`AI 调用超时（${Math.round(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => finish(new Error('无法启动 claude CLI：' + e.message)));
    child.on('close', code => {
      const text = stdout.trim();
      if (code === 0 && text) return finish(null, text);
      const detail = stderr.trim() || stdout.trim() || `claude 退出码 ${code}`;
      finish(new Error('叙事引擎调用失败：' + detail.slice(0, 800)));
    });

    child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

/* ---------- 静态文件 ---------- */
function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  if (pathname === '/') pathname = '/' + HOME_PAGE;

  const target = path.normalize(path.join(ROOT, pathname));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 · 找不到 ' + pathname);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/info' && req.method === 'GET') {
    return sendJSON(res, 200, {
      ok: true,
      cwd: ROOT,
      cli: CLI.available,
      cliVersion: CLI.version,
      template: fs.existsSync(TEMPLATE_FILE),
      originTemplate: fs.existsSync(ORIGIN_TEMPLATE_FILE),
      analysisTemplate: fs.existsSync(ANALYSIS_TEMPLATE_FILE),
      models: ['', 'opus', 'sonnet', 'haiku', 'fable'],
      defaults: {
        narrate: DEFAULT_NARRATE_MODEL || '(CLI 默认)',
        origin: DEFAULT_ORIGIN_MODEL,
        analyze: DEFAULT_ANALYZE_MODEL
      },
      promptFile: '叙事设定.txt',
      originPromptFile: '出身生成.txt',
      analysisPromptFile: '行动分析.txt'
    });
  }

  if (url.pathname === '/api/game' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (e) {
      return sendJSON(res, 400, { error: '请求格式错误：' + e.message });
    }
    try {
      const prompt = buildPrompt(payload);
      const text = await callClaude(prompt, payload.model || DEFAULT_NARRATE_MODEL);
      return sendJSON(res, 200, { text });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || String(e) });
    }
  }

  if (url.pathname === '/api/origin' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (e) {
      return sendJSON(res, 400, { error: '请求格式错误：' + e.message });
    }
    const description = String(payload.description || '').trim();
    if (!description) return sendJSON(res, 400, { error: '请先填写职业描述' });
    if (description.length > 600) return sendJSON(res, 400, { error: '职业描述过长（最多 600 字）' });
    try {
      const prompt = buildOriginPrompt(Object.assign({}, payload, { description }));
      const text = await callClaude(prompt, payload.model || DEFAULT_ORIGIN_MODEL);
      return sendJSON(res, 200, { text });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || String(e) });
    }
  }

  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (e) {
      return sendJSON(res, 400, { error: '请求格式错误：' + e.message });
    }
    const action = String(payload.action || '').trim();
    const context = String(payload.context || '').trim();
    if (!action) return sendJSON(res, 400, { error: '行动内容为空' });
    if (action.length > 500) return sendJSON(res, 400, { error: '行动内容过长（最多 500 字）' });
    if (context.length > 4000) return sendJSON(res, 400, { error: '状态上下文过长' });
    try {
      const prompt = buildAnalysisPrompt({ action, context });
      const text = await callClaude(prompt, payload.model || DEFAULT_ANALYZE_MODEL, 90000);
      return sendJSON(res, 200, { text });
    } catch (e) {
      return sendJSON(res, 500, { error: e.message || String(e) });
    }
  }

  if (url.pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { error: '未知接口' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  末日回响 · 本地叙事服务已启动');
  console.log('  ----------------------------------------');
  console.log(`  页面：http://${HOST}:${PORT}/`);
  console.log(`  目录：${ROOT}`);
  console.log(`  引擎：claude CLI ${CLI.available ? '✓ ' + CLI.version : '✗ 未找到'}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。请关闭已运行的服务，或设置 PORT 后重试。`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
