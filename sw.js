self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 监听离线 Web Push 推送（不打开网页也能触发）
self.addEventListener('push', (event) => {
  let data = {
    type: 'message',
    title: '聊天室新提醒',
    body: '你有一条新动态，点击查看',
    tag: 'chatroom-push'
  };

  if (event.data) {
    try {
      data = Object.assign(data, event.data.json());
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const isCall = data.type === 'call';
  const options = {
    body: data.body,
    tag: data.tag || (isCall ? 'incoming-voice-call' : 'chatroom-msg'),
    renotify: true,
    requireInteraction: isCall, // 如果是来电，横幅常驻不自动消失
    vibrate: isCall ? [400, 150, 400, 150, 400] : [200, 100, 200],
    data: { url: '/', type: data.type },
    actions: isCall
      ? [
          { action: 'accept', title: '✅ 打开并接听' },
          { action: 'reject', title: '❌ 忽略' }
        ]
      : []
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// 点击系统横幅通知时的动作
self.addEventListener('notificationclick', (event) => {
  const action = event.action;
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 如果网页已经开着，直接聚焦过去
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'CALL_NOTIFICATION_ACTION', action });
          return;
        }
      }
      // 如果网页之前被关掉了，点击横幅自动打开网页
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});
