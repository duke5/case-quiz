/**
 * 病例答题比赛 - 后端服务
 * 运行: npm install && npm start
 * 默认访问: http://localhost:3000
 *
 * 密码请在下面 HOST_PASSWORD 修改成你自己的(大屏幕不再单独设密码,只能从主持人登录后打开)
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

// ============ 配置区(部署前请修改) ============
const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'Ydy2026';     // 主持人控制台密码(大屏幕不再单独设密码,入口只在主持人登录后开放)
const QUESTIONS_FILE = path.join(__dirname, 'questions.md');
const SCORES_FILE = path.join(__dirname, 'scores.json'); // 用于崩溃/重启后恢复成绩
const CONFIG_FILE = path.join(__dirname, 'config.js');
const CONFIG_OVERRIDE_FILE = path.join(__dirname, 'config.local.json'); // 主持人在管理页面改的网址等,存这里,不动 config.js 本身

function readOverrides() {
  try {
    if (fs.existsSync(CONFIG_OVERRIDE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_OVERRIDE_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('[配置] 读取 config.local.json 失败,忽略', e.message);
  }
  return {};
}
function writeOverride(patch) {
  const merged = Object.assign({}, readOverrides(), patch);
  fs.writeFileSync(CONFIG_OVERRIDE_FILE, JSON.stringify(merged, null, 2));
}
function loadConfig() {
  delete require.cache[require.resolve(CONFIG_FILE)];
  const base = require(CONFIG_FILE);
  return Object.assign({}, base, readOverrides());
}
let appConfig = loadConfig();

// ============ 题库解析 ============
function parseQuestions(mdText) {
  const results = [];
  const blocks = mdText.split(/\n(?=##\s*\d+)/);
  for (const block of blocks) {
    const m = block.match(
      /##\s*\d+\s*\n+([\s\S]*?)\nA[.．]\s*(.*)\nB[.．]\s*(.*)\nC[.．]\s*(.*)\nD[.．]\s*(.*)\n答案[:：]\s*([ABCD])/
    );
    if (!m) continue;
    const [, qtext, a, b, c, d, ans] = m;
    const idxMap = { A: 0, B: 1, C: 2, D: 3 };
    results.push({
      text: qtext.trim(),
      options: [a.trim(), b.trim(), c.trim(), d.trim()],
      correct: idxMap[ans],
    });
  }
  return results;
}

function loadQuestions() {
  const raw = fs.readFileSync(QUESTIONS_FILE, 'utf-8');
  const qs = parseQuestions(raw);
  if (qs.length === 0) {
    console.warn('[警告] 没有解析到任何题目,请检查 questions.md 格式是否正确');
  } else {
    console.log(`[题库] 已加载 ${qs.length} 道题`);
  }
  return qs;
}

let questions = loadQuestions();
let TOTAL = questions.length;

// ============ 比赛状态(内存) ============
function defaultState() {
  return { idx: -1, phase: 'waiting', timeLimit: 20, startedAt: 0 };
}
let quizState = defaultState();

// ============ 成绩(内存 + 定期落盘,防止服务重启丢数据) ============
let scores = {}; // { playerId: { name, score, correct } }
try {
  if (fs.existsSync(SCORES_FILE)) {
    scores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf-8'));
    console.log(`[成绩] 已从 scores.json 恢复 ${Object.keys(scores).length} 名参赛者的成绩`);
  }
} catch (e) {
  console.warn('[成绩] 读取 scores.json 失败,使用空成绩表', e.message);
}
// persistScores 用一个简单的串行队列写入,避免200人几乎同时提交答案时,
// 多个 fs.writeFile 并发写同一个文件互相打断导致 scores.json 损坏
let scoresWriteBusy = false;
let scoresWritePending = false;
function persistScores() {
  scoresWritePending = true;
  if (scoresWriteBusy) return;
  const flush = () => {
    scoresWriteBusy = true;
    scoresWritePending = false;
    const data = JSON.stringify(scores);
    fs.writeFile(SCORES_FILE, data, (err) => {
      if (err) console.error('[成绩] 保存失败', err.message);
      if (scoresWritePending) {
        flush();
      } else {
        scoresWriteBusy = false;
      }
    });
  };
  flush();
}

// ============ Express + Socket.io ============
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// 把配置暴露给前端页面(标题、主办单位名称等)—— 加 no-store,避免"重新加载配置"后浏览器还拿缓存的旧内容
app.get('/config.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify(publicClientConfig())};`);
});

// 大屏幕用的二维码,内容是 config.js 里 SITE_URL 对应的答题页地址(根路径现在是主持人入口,不能再扫根路径)
// 同样加 no-store——否则改了 SITE_URL 并"重新加载配置"后,大屏幕可能因为浏览器缓存还显示旧二维码
app.get('/qrcode.png', async (req, res) => {
  try {
    const base = appConfig.SITE_URL.replace(/\/+$/, '');
    const playerUrl = base + '/player.html';
    const buf = await QRCode.toBuffer(playerUrl, { width: 360, margin: 1 });
    res.set('Cache-Control', 'no-store');
    res.type('png').send(buf);
  } catch (e) {
    res.status(500).send('二维码生成失败: ' + e.message);
  }
});

const server = http.createServer(app);
const io = new Server(server);

function publicQuestion(q, includeAnswer) {
  const obj = { text: q.text, options: q.options };
  if (includeAnswer) obj.correct = q.correct;
  return obj;
}

function currentStatePayload() {
  const payload = {
    idx: quizState.idx,
    phase: quizState.phase,
    timeLimit: quizState.timeLimit,
    startedAt: quizState.startedAt,
    total: TOTAL,
  };
  if (quizState.idx >= 0 && quizState.idx < TOTAL) {
    const includeAnswer = quizState.phase === 'reveal' || quizState.phase === 'finished';
    payload.question = publicQuestion(questions[quizState.idx], includeAnswer);
  }
  return payload;
}

function currentLeaderboard(limit) {
  const list = Object.entries(scores).map(([id, v]) => ({
    id,
    name: v.name,
    score: v.score,
    correct: v.correct,
  }));
  list.sort((a, b) => b.score - a.score);
  return limit ? list.slice(0, limit) : list;
}

function broadcastState() {
  io.emit('state:update', currentStatePayload());
}
function broadcastLeaderboard() {
  io.emit('leaderboard:update', currentLeaderboard());
}
function publicClientConfig() {
  return {
    ORG_NAME: appConfig.ORG_NAME,
    EVENT_NAME: appConfig.EVENT_NAME,
    SCORE_BASE: appConfig.SCORE_BASE,
    SCORE_SPEED_BONUS_PER_SEC: appConfig.SCORE_SPEED_BONUS_PER_SEC,
  };
}
function broadcastConfig() {
  io.emit('config:update', publicClientConfig());
}

io.on('connection', (socket) => {
  // 新连接立即同步当前状态和排行榜
  socket.emit('state:update', currentStatePayload());
  socket.emit('leaderboard:update', currentLeaderboard());
  socket.emit('config:update', publicClientConfig());

  // 主持人密码校验(大屏幕不再需要密码,只能通过主持人登录后的入口打开)
  socket.on('auth', ({ role, password }, cb) => {
    const ok = role === 'host' && password === HOST_PASSWORD;
    cb && cb({ ok, siteUrl: ok ? appConfig.SITE_URL : undefined });
  });

  // 主持人操作(每次都带密码校验,防止绕过前端直接调用)
  socket.on('host:action', ({ password, action, timeLimit, siteUrl }, cb) => {
    if (password !== HOST_PASSWORD) {
      return cb && cb({ ok: false, error: '密码错误' });
    }
    if (action === 'next') {
      const nextIdx = quizState.idx + 1;
      if (nextIdx >= TOTAL) return cb && cb({ ok: false, error: '已经是最后一题' });
      quizState = {
        idx: nextIdx,
        phase: 'question',
        timeLimit: Number(timeLimit) || 20,
        startedAt: Date.now(),
      };
    } else if (action === 'reveal') {
      if (quizState.phase !== 'question') return cb && cb({ ok: false, error: '当前不在答题阶段' });
      quizState.phase = 'reveal';
    } else if (action === 'finish') {
      quizState.phase = 'finished';
    } else if (action === 'reset') {
      quizState = defaultState();
      scores = {};
      persistScores();
    } else if (action === 'reload_questions') {
      try {
        questions = loadQuestions();
        TOTAL = questions.length;
        // 如果改题库后题目数变少、当前题号已经超出范围,重置比赛状态防止后续访问越界题目
        if (quizState.idx >= TOTAL) {
          quizState = defaultState();
        }
      } catch (e) {
        return cb && cb({ ok: false, error: '题库重新加载失败: ' + e.message });
      }
    } else if (action === 'reload_config') {
      try {
        appConfig = loadConfig();
      } catch (e) {
        return cb && cb({ ok: false, error: '配置重新加载失败: ' + e.message });
      }
    } else if (action === 'set_site_url') {
      const url = String(siteUrl || '').trim();
      if (!url) return cb && cb({ ok: false, error: '网址不能为空' });
      if (!/^https?:\/\//i.test(url)) {
        return cb && cb({ ok: false, error: '网址需要以 http:// 或 https:// 开头' });
      }
      appConfig.SITE_URL = url.replace(/\/+$/, '');
      try {
        writeOverride({ SITE_URL: appConfig.SITE_URL });
      } catch (e) {
        console.warn('[配置] 保存 SITE_URL 覆盖失败(不影响本次运行,重启后可能恢复默认值)', e.message);
      }
      broadcastConfig();
      return cb && cb({ ok: true, siteUrl: appConfig.SITE_URL });
    } else {
      return cb && cb({ ok: false, error: '未知操作' });
    }
    broadcastState();
    broadcastLeaderboard();
    broadcastConfig();
    cb && cb({ ok: true, total: TOTAL });
  });

  // 参赛者加入(playerId 由客户端生成并存在 localStorage,断线重连/刷新页面后能带着同一个ID重新加入,
  // 避免之前用 socket.id 当身份导致的问题:一断线重连 socket.id 就变了,分数记录全部找不到)
  socket.on('player:join', ({ name, playerId }, cb) => {
    const cleanName = String(name || '').trim().slice(0, 20) || '匿名参赛者';
    const id = (typeof playerId === 'string' && playerId.trim()) ? playerId.trim().slice(0, 64) : socket.id;
    scores[id] = scores[id] || { name: cleanName, score: 0, correct: 0, answered: {} };
    scores[id].name = cleanName;
    if (!scores[id].answered) scores[id].answered = {};
    socket.playerId = id;
    persistScores();
    cb && cb({ ok: true, playerId: id, score: scores[id].score, correct: scores[id].correct });
    broadcastLeaderboard();
  });

  // 参赛者提交答案(服务端权威判分,避免客户端作弊)
  socket.on('player:answer', ({ idx, optIdx }, cb) => {
    if (!socket.playerId) return cb && cb({ ok: false, error: '请先加入比赛' });
    if (quizState.idx !== idx || quizState.phase !== 'question') {
      return cb && cb({ ok: false, error: '当前题目已变化,提交无效' });
    }
    // 真正校验时间是否已到,而不只是看阶段——避免倒计时归零后、主持人还没点"公布答案"之前的空窗期被继续提交
    const TIME_GRACE_SEC = 1; // 给网络延迟留一点点缓冲,避免临界点误杀正常提交
    const rawElapsedSec = (Date.now() - quizState.startedAt) / 1000;
    if (rawElapsedSec > quizState.timeLimit + TIME_GRACE_SEC) {
      return cb && cb({ ok: false, error: '本题时间已到,不能再提交' });
    }
    const rec = scores[socket.playerId] || { name: '匿名参赛者', score: 0, correct: 0, answered: {} };
    if (!rec.answered) rec.answered = {};
    if (rec.answered[idx]) {
      // 防止重复提交刷分(服务端强制去重,不依赖前端)
      return cb && cb({ ok: false, error: '本题已提交过,不能重复作答' });
    }
    const q = questions[idx];
    const elapsedSec = Math.min(quizState.timeLimit, Math.max(0, rawElapsedSec));
    const correct = optIdx === q.correct;
    const gained = correct
      ? Math.round(appConfig.SCORE_BASE + Math.max(0, quizState.timeLimit - elapsedSec) * appConfig.SCORE_SPEED_BONUS_PER_SEC)
      : 0;
    rec.answered[idx] = true;
    rec.score += gained;
    if (correct) rec.correct += 1;
    scores[socket.playerId] = rec;
    persistScores();
    cb && cb({ ok: true, correct, gained, totalScore: rec.score });
    broadcastLeaderboard();
  });

  socket.on('disconnect', () => {
    // 成绩保存在内存的 scores 对象里,以客户端持久化的 playerId 为 key(不是 socket.id),
    // 所以断线不会丢分——重连后客户端带着同一个 playerId 重新 player:join 即可恢复
  });
});

server.listen(PORT, () => {
  console.log(`\n病例答题比赛服务已启动`);
  console.log(`本机访问: http://localhost:${PORT}`);
  console.log(`局域网内其他设备访问: http://<你的电脑局域网IP>:${PORT}`);
  console.log(`主持人密码: ${HOST_PASSWORD}\n`);
});
