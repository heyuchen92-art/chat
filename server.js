const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
app.use(express.json());

const io = new Server(server, {
  maxHttpBufferSize: 5e6
});

// ========== 基础配置 ==========
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const MAX_HISTORY = 100;
const RECALL_LIMIT_MS = 120 * 1000;

// ========== Gmail 离线邮件通知配置（Resend API） ==========
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const NOTIFY_GMAIL = (process.env.NOTIFY_GMAIL || '').trim();
const CHATROOM_URL = (process.env.CHATROOM_URL || 'https://chat-4oqu.onrender.com').trim();
let lastEmailNotifyTime = 0;
const NOTIFY_COOLDOWN_MS = 3 * 60 * 1000; // 普通消息 3 分钟冷却，防止连续发消息刷屏

async function sendGmailNotification(senderName, previewText, isCall = false, targetName = '') {
  if (!RESEND_API_KEY || !NOTIFY_GMAIL) return;

  const now = Date.now();
  // 语音呼叫立即发送，普通消息和戳一戳遵守 3 分钟冷却
  if (!isCall && now - lastEmailNotifyTime < NOTIFY_COOLDOWN_MS) {
    return;
  }
  lastEmailNotifyTime = now;

  const targetHint = targetName ? `（呼叫 ${targetName}）` : '';
  const subject = isCall
    ? `📞 [紧急来电] ${senderName} 正在聊天室呼叫你${targetHint}`
    : `💬 [聊天室新消息] ${senderName} 发来了动态`;

  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; padding: 20px; background: #140826; color: #f3e8ff; border-radius: 14px; max-width: 480px;">
      <h2 style="color: #c084fc; margin-top: 0; font-size: 18px;">${escapeHtmlServer(subject)}</h2>
      <p style="color: #e9d5ff; font-size: 15px; line-height: 1.6; background: rgba(255,255,255,0.08); padding: 12px 14px; border-radius: 10px;">
        <strong>内容详情：</strong>${escapeHtmlServer(previewText)}
      </p>
      <a href="${CHATROOM_URL}" 
         style="display: inline-block; margin-top: 14px; padding: 11px 22px; background: #9333ea; color: #ffffff; text-decoration: none; font-weight: bold; border-radius: 10px;">
        立即打开聊天室
      </a>
      <p style="color: rgba(233,213,255,0.5); font-size: 12px; margin-top: 16px; margin-bottom: 0;">
        发送时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
      </p>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: '聊天室提醒 <onboarding@resend.dev>',
        to: [NOTIFY_GMAIL],
        subject: subject,
        html: htmlContent
      })
    });
    if (!res.ok) {
      console.error('Gmail 通知发送失败:', await res.text());
    }
  } catch (err) {
    console.error('Gmail 通知请求异常:', err.message);
  }
}

function escapeHtmlServer(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ========== 静态资源（拦截敏感文件） ==========
app.use((req, res, next) => {
  const blockedFiles = [
    '/messages.json', '/users.json', '/subscriptions.json',
    '/server.js', '/package.json', '/package-lock.json'
  ];
  if (blockedFiles.includes(req.path.toLowerCase())) {
    return res.status(403).send('禁止访问');
  }
  next();
});

app.use(express.static(path.join(__dirname)));

// ========== 数据持久化 ==========
let messages = [];
if (fs.existsSync(MESSAGES_FILE)) {
  try { messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); } catch (e) {}
}

let knownUsers = new Set();
if (fs.existsSync(USERS_FILE)) {
  try {
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(arr)) knownUsers = new Set(arr);
  } catch (e) {}
}
messages.forEach(m => { if (m.nickname) knownUsers.add(m.nickname); });

let isSavingMsg = false;
let pendingSaveMsg = false;
async function saveMessages() {
  if (isSavingMsg) { pendingSaveMsg = true; return; }
  isSavingMsg = true;
  try {
    await fs.promises.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {} finally {
    isSavingMsg = false;
    if (pendingSaveMsg) { pendingSaveMsg = false; saveMessages(); }
  }
}

async function saveUsers() {
  try { await fs.promises.writeFile(USERS_FILE, JSON.stringify([...knownUsers], null, 2)); } catch (e) {}
}

// ========== 状态管理 ==========
const mutedUsers = new Map();
const pokeCooldown = new Map();
const pendingCalls = new Map();

function findSocketByNickname(nickname) {
  for (const [, s] of io.of('/').sockets) {
    if (s.nickname === nickname) return s;
  }
  return null;
}

function getAllUsersStatus() {
  const onlineMap = new Map();
  for (const [, socket] of io.of('/').sockets) {
    if (socket.nickname) {
      onlineMap.set(socket.nickname, { isAdmin: socket.isAdmin });
      knownUsers.add(socket.nickname);
    }
  }

  const list = [];
  for (const nickname of knownUsers) {
    const onlineInfo = onlineMap.get(nickname);
    list.push({
      nickname,
      online: Boolean(onlineInfo),
      isAdmin: onlineInfo ? onlineInfo.isAdmin : false
    });
  }

  list.sort((a, b) => Number(b.online) - Number(a.online));
  return list;
}

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  socket.on('join', (rawNickname) => {
    let nickname = String(rawNickname || '').trim().slice(0, 20);
    if (!nickname) return;

    if (findSocketByNickname(nickname)) {
      nickname = `${nickname}_${Math.floor(10 + Math.random() * 90)}`;
    }

    socket.nickname = nickname;
    socket.isAdmin = false;

    if (!knownUsers.has(nickname)) {
      knownUsers.add(nickname);
      saveUsers();
    }

    socket.broadcast.emit('system message', { text: `${nickname} 上线了` });
    io.emit('online users', getAllUsersStatus());

    // 如果有人正在呼叫刚上线的该用户，立即推送来电
    const pending = pendingCalls.get(nickname);
    if (pending) {
      const callerSocket = findSocketByNickname(pending.from);
      if (callerSocket) {
        socket.emit('call-offer', { from: pending.from, offer: pending.offer });
      } else {
        pendingCalls.delete(nickname);
      }
    }
  });

  socket.on('admin login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      socket.emit('admin login success');
      io.emit('system message', { text: `管理员 (${socket.nickname}) 已上线` });
      io.emit('online users', getAllUsersStatus());
    } else {
      socket.emit('admin login fail');
    }
  });

  // 发送消息 + Gmail 离线通知
  socket.on('chat message', (msg) => {
    const nickname = socket.nickname;
    if (!nickname || !msg) return;

    const muteUntil = mutedUsers.get(nickname);
    if (muteUntil !== undefined) {
      if (muteUntil === 0 || Date.now() < muteUntil) {
        const timeStr = muteUntil === 0
          ? '永久'
          : `至 ${new Date(muteUntil).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        socket.emit('muted notice', { message: `您已被禁言${timeStr}` });
        return;
      } else {
        mutedUsers.delete(nickname);
      }
    }

    const text = String(msg.text || '').trim().slice(0, 1000);
    const image = (typeof msg.image === 'string' && msg.image.startsWith('data:image/'))
      ? msg.image
      : null;

    if (!text && !image) return;

    const now = Date.now();
    const message = {
      id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      nickname,
      text,
      image,
      time: new Date(now).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      isAdmin: socket.isAdmin || false
    };

    messages.push(message);
    if (messages.length > MAX_HISTORY) {
      messages = messages.slice(-MAX_HISTORY);
    }

    saveMessages();
    io.emit('chat message', message);

    // 只要存在不在线的历史用户，且不在冷却期内，就发送 Gmail 邮件提醒
    const allUsers = getAllUsersStatus();
    const hasOfflineUser = allUsers.some(u => !u.online && u.nickname !== nickname);
    if (hasOfflineUser) {
      sendGmailNotification(nickname, text || '[图片消息]', false);
    }
  });

  // 撤回消息（120秒内）
  socket.on('recall message', (msgId) => {
    if (!socket.nickname || !msgId) return;
    const index = messages.findIndex(m => m.id === msgId);
    if (index === -1) {
      socket.emit('recall error', '该消息已不存在或已被撤回');
      return;
    }

    const targetMsg = messages[index];
    const isOwner = targetMsg.nickname === socket.nickname;

    if (!isOwner && !socket.isAdmin) {
      socket.emit('recall error', '无权撤回他人消息');
      return;
    }

    if (!socket.isAdmin && Date.now() - targetMsg.timestamp > RECALL_LIMIT_MS) {
      socket.emit('recall error', '发送已超过 120 秒，无法撤回');
      return;
    }

    messages.splice(index, 1);
    saveMessages();

    const recallText = socket.isAdmin && !isOwner
      ? `管理员 ${socket.nickname} 撤回了 ${targetMsg.nickname} 的一条消息`
      : `「${targetMsg.nickname}」撤回了一条消息`;

    io.emit('message recalled', { id: msgId, text: recallText });
  });

  // 禁言与解除禁言
  socket.on('mute user', (data) => {
    if (!socket.isAdmin || !data) return;
    const { nickname, duration } = data;
    const mins = Math.max(0, parseInt(duration, 10) || 0);
    const muteUntil = mins === 0 ? 0 : Date.now() + mins * 60 * 1000;

    mutedUsers.set(nickname, muteUntil);
    io.emit('system message', {
      text: `管理员已将 ${nickname} 禁言${mins === 0 ? '（永久）' : ` ${mins} 分钟`}`
    });
  });

  socket.on('unmute user', (nickname) => {
    if (!socket.isAdmin || !nickname) return;
    mutedUsers.delete(nickname);
    io.emit('system message', { text: `管理员已解除 ${nickname} 的禁言` });
  });

  // 管理员戳一戳
  socket.on('poke user', (targetNickname) => {
    if (!socket.isAdmin || !targetNickname) return;
    const now = Date.now();
    const lastPoke = pokeCooldown.get(socket.id) || 0;
    if (now - lastPoke < 3000) return;
    pokeCooldown.set(socket.id, now);

    const targetSocket = findSocketByNickname(targetNickname);
    if (targetSocket) {
      targetSocket.emit('poked', { from: socket.nickname });
    } else {
      sendGmailNotification(socket.nickname, `管理员 ${socket.nickname} 戳了戳 ${targetNickname}`, false, targetNickname);
    }
    io.emit('system message', {
      text: `👉 管理员 ${socket.nickname} 戳了戳 ${targetNickname}`
    });
  });

  // WebRTC 语音通话信令转发（支持离线时发送紧急来电 Gmail）
  socket.on('call-offer', ({ to, offer }) => {
    if (!socket.nickname || !to) return;
    const target = findSocketByNickname(to);
    if (target) {
      pendingCalls.delete(to);
      target.emit('call-offer', { from: socket.nickname, offer });
    } else {
      pendingCalls.set(to, { from: socket.nickname, offer, time: Date.now() });
      sendGmailNotification(
        socket.nickname,
        `${socket.nickname} 正在向 ${to} 发起语音通话，请点击下方按钮进入聊天室接听！`,
        true,
        to
      );
    }
  });

  socket.on('call-answer', ({ to, answer }) => {
    pendingCalls.delete(socket.nickname);
    const target = findSocketByNickname(to);
    if (target) target.emit('call-answer', { from: socket.nickname, answer });
  });

  socket.on('call-ice', ({ to, candidate }) => {
    const target = findSocketByNickname(to);
    if (target) target.emit('call-ice', { from: socket.nickname, candidate });
  });

  socket.on('call-reject', ({ to, reason }) => {
    pendingCalls.delete(socket.nickname);
    const target = findSocketByNickname(to);
    if (target) target.emit('call-reject', { from: socket.nickname, reason: reason || '对方拒绝了通话' });
  });

  socket.on('call-hangup', ({ to }) => {
    pendingCalls.delete(to);
    const target = findSocketByNickname(to);
    if (target) target.emit('call-hangup', { from: socket.nickname });
  });

  socket.on('get history', () => {
    socket.emit('history', messages);
  });

  socket.on('disconnect', () => {
    pokeCooldown.delete(socket.id);
    if (socket.nickname) {
      for (const [targetName, info] of pendingCalls.entries()) {
        if (info.from === socket.nickname) pendingCalls.delete(targetName);
      }
      socket.broadcast.emit('system message', { text: `${socket.nickname} 离线了` });
      io.emit('online users', getAllUsersStatus());
    }
  });
});

server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
  if (RESEND_API_KEY && NOTIFY_GMAIL) {
    console.log(`✅ Gmail 离线邮件通知已启用，接收邮箱: ${NOTIFY_GMAIL}`);
  } else {
    console.log('ℹ️ 未配置 RESEND_API_KEY 或 NOTIFY_GMAIL，跳过 Gmail 离线通知');
  }
});
