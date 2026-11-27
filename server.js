const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
app.use(express.json());

const io = new Server(server, {
  maxHttpBufferSize: 5e6
});

// ========== 配置 ==========
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
const MAX_HISTORY = 100;
const RECALL_LIMIT_MS = 120 * 1000;

// ========== Web Push VAPID 密钥配置 ==========
// 建议在 Render 环境变量中固定配置 VAPID_PUBLIC_KEY 和 VAPID_PRIVATE_KEY
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  vapidKeys = webpush.generateVAPIDKeys();
  console.log('⚠️ 未检测到固定 VAPID 环境变量，已自动生成临时密钥（建议将以下密钥填入 Render 环境变量以防重启失效）：');
  console.log('VAPID_PUBLIC_KEY=' + vapidKeys.publicKey);
  console.log('VAPID_PRIVATE_KEY=' + vapidKeys.privateKey);
}

webpush.setVapidDetails(
  'mailto:admin@chatroom.local',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

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

// 保存设备推送订阅 { nickname: [subscriptionObj, ...] }
let pushSubscriptions = {};
if (fs.existsSync(SUBS_FILE)) {
  try { pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) {}
}

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

async function saveSubscriptions() {
  try { await fs.promises.writeFile(SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2)); } catch (e) {}
}

// ========== Push API 接口 ==========
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe', (req, res) => {
  const { nickname, subscription } = req.body || {};
  if (!nickname || !subscription || !subscription.endpoint) {
    return res.status(400).json({ error: '无效的订阅信息' });
  }
  if (!pushSubscriptions[nickname]) {
    pushSubscriptions[nickname] = [];
  }
  const exists = pushSubscriptions[nickname].some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    pushSubscriptions[nickname].push(subscription);
    saveSubscriptions();
  }
  res.json({ success: true });
});

// 向指定用户或所有离线用户发送系统级 Web Push
async function sendPushToUser(targetNickname, payload) {
  const subs = pushSubscriptions[targetNickname];
  if (!subs || subs.length === 0) return;

  const validSubs = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      validSubs.push(sub);
    } catch (err) {
      // 410 或 404 表示订阅已过期，自动清理
      if (err.statusCode !== 410 && err.statusCode !== 404) {
        validSubs.push(sub);
      }
    }
  }
  pushSubscriptions[targetNickname] = validSubs;
  saveSubscriptions();
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

  // 发送消息 + 离线推送
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

    // 给当前不在线（关掉网页）的所有已订阅用户发送系统横幅通知
    for (const targetUser of Object.keys(pushSubscriptions)) {
      if (targetUser !== nickname && !findSocketByNickname(targetUser)) {
        sendPushToUser(targetUser, {
          type: 'message',
          title: `💬 ${nickname} 发来新消息`,
          body: text || '[图片消息]',
          tag: 'chatroom-offline-msg'
        });
      }
    }
  });

  // 撤回消息
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
      sendPushToUser(targetNickname, {
        type: 'poke',
        title: '👉 管理员戳了你一下',
        body: `管理员 ${socket.nickname} 正在聊天室呼叫你！`,
        tag: 'chatroom-offline-poke'
      });
    }
    io.emit('system message', {
      text: `👉 管理员 ${socket.nickname} 戳了戳 ${targetNickname}`
    });
  });

  // WebRTC 语音通话信令转发（支持关掉网页时的系统级来电推送）
  socket.on('call-offer', ({ to, offer }) => {
    if (!socket.nickname || !to) return;
    const target = findSocketByNickname(to);
    if (target) {
      pendingCalls.delete(to);
      target.emit('call-offer', { from: socket.nickname, offer });
    } else {
      pendingCalls.set(to, { from: socket.nickname, offer, time: Date.now() });
      // 向未打开网页的目标用户发送系统级来电横幅推送
      sendPushToUser(to, {
        type: 'call',
        caller: socket.nickname,
        title: `📞 语音来电：${socket.nickname}`,
        body: `${socket.nickname} 正在给你打语音电话，点击立即进入接听！`,
        tag: 'incoming-voice-call'
      });
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
});
