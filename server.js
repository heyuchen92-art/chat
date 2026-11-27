const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// 修复 1：调高传输上限至 5MB，防止 2MB 图片转 Base64 后超出默认 1MB 限制导致断连
const io = new Server(server, {
  maxHttpBufferSize: 5e6
});

// ========== 配置 ==========
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const MAX_HISTORY = 100; // 最多保留 100 条历史消息，防止包含 Base64 图片的文件无限膨胀

// ========== 静态资源 ==========
app.use(express.static(path.join(__dirname)));

// ========== 消息持久化（JSON 文件） ==========
let messages = [];
if (fs.existsSync(MESSAGES_FILE)) {
  try {
    messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch (e) {
    messages = [];
  }
}

// 修复 5：改用异步写入，避免高并发时同步 I/O 阻塞主线程
let isSaving = false;
let pendingSave = false;

async function saveMessages() {
  if (isSaving) {
    pendingSave = true;
    return;
  }
  isSaving = true;
  try {
    await fs.promises.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2));
  } catch (err) {
    console.error('保存历史消息失败:', err);
  } finally {
    isSaving = false;
    if (pendingSave) {
      pendingSave = false;
      saveMessages();
    }
  }
}

// ========== 禁言状态 ==========
// key: 昵称, value: 禁言截止时间戳（0 表示永久）
const mutedUsers = new Map();

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 用户加入
  socket.on('join', (rawNickname) => {
    let nickname = String(rawNickname || '').trim().slice(0, 20);
    if (!nickname) return;

    // 修复 4：防止重名冲突，若已存在相同昵称则自动加后缀
    const onlineUsers = getOnlineUsers();
    if (onlineUsers.some(u => u.nickname === nickname)) {
      nickname = `${nickname}_${Math.floor(10 + Math.random() * 90)}`;
    }

    socket.nickname = nickname;
    socket.isAdmin = false;

    socket.broadcast.emit('system message', { text: `${nickname} 加入了聊天室` });
    io.emit('online users', getOnlineUsers());
  });

  // 管理员登录
  socket.on('admin login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.isAdmin = true;
      socket.emit('admin login success');
      io.emit('system message', { text: `管理员 (${socket.nickname}) 已上线` });
      // 修复 2：管理员登录后立即刷新所有人的在线用户列表，显示皇冠标志
      io.emit('online users', getOnlineUsers());
    } else {
      socket.emit('admin login fail');
    }
  });

  // 发送消息
  socket.on('chat message', (msg) => {
    const nickname = socket.nickname;
    if (!nickname || !msg) return;

    // 禁言检查
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

    const text = String(msg.text || '').trim().slice(0, 1000); // 限制单条文本长度
    const image = (typeof msg.image === 'string' && msg.image.startsWith('data:image/'))
      ? msg.image
      : null;

    if (!text && !image) return;

    const message = {
      nickname,
      text,
      image,
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      isAdmin: socket.isAdmin || false
    };

    messages.push(message);
    if (messages.length > MAX_HISTORY) {
      messages = messages.slice(-MAX_HISTORY);
    }

    saveMessages();
    io.emit('chat message', message);
  });

  // 禁言用户（仅管理员）
  socket.on('mute user', (data) => {
    if (!socket.isAdmin || !data) return;
    const { nickname, duration } = data;
    const mins = Math.max(0, parseInt(duration, 10) || 0);
    const muteUntil = mins === 0 ? 0 : Date.now() + mins * 60 * 1000;

    mutedUsers.set(nickname, muteUntil);
    // 修复 3：只发送一次 system message，避免前端收到两个事件渲染出两条重复提示
    io.emit('system message', {
      text: `管理员已将 ${nickname} 禁言${mins === 0 ? '（永久）' : ` ${mins} 分钟`}`
    });
  });

  // 解除禁言（仅管理员）
  socket.on('unmute user', (nickname) => {
    if (!socket.isAdmin || !nickname) return;
    mutedUsers.delete(nickname);
    io.emit('system message', { text: `管理员已解除 ${nickname} 的禁言` });
  });

  // 获取历史消息
  socket.on('get history', () => {
    socket.emit('history', messages);
  });

  // 断开连接
  socket.on('disconnect', () => {
    if (socket.nickname) {
      socket.broadcast.emit('system message', { text: `${socket.nickname} 离开了聊天室` });
      io.emit('online users', getOnlineUsers());
    }
  });
});

function getOnlineUsers() {
  const users = [];
  for (const [id, socket] of io.of('/').sockets) {
    if (socket.nickname) {
      users.push({ id, nickname: socket.nickname, isAdmin: socket.isAdmin });
    }
  }
  return users;
}

// ========== 启动 ==========
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});
