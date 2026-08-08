// Minimal lifecycle + fetch handler. A fetch handler is required for the app to
// be installable (Add to Home Screen / beforeinstallprompt). This is a pass-through
// network-first handler — it intentionally does NOT cache API/trading responses so
// no stale financial data is ever served.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  event.respondWith(fetch(req).catch(() => Response.error()));
});

self.addEventListener("push", event => {
  let data={title:"FomoCloud",body:"You have a new update",url:"/"};
  try { data={...data,...event.data.json()}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body, icon:"/icon.svg", badge:"/icon.svg", data:{url:data.url}
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url=event.notification.data?.url||"/";
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(ws=>{
    const w=ws.find(x=>"focus" in x); return w?w.focus():clients.openWindow(url);
  }));
});
