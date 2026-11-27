self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 处理系统通知的点击与按钮操作
self.addEventListener('notificationclick', (event) => {
  const action = event.action; // 'accept' 或 'reject' 或空（点击通知本体）
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'CALL_NOTIFICATION_ACTION', action });
          return;
        }
      }
    })
  );
});
