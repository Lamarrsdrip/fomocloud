self.addEventListener("install", event => {
  event.waitUntil(caches.open("fomocloud-v05").then(cache => cache.addAll(["/", "/login/", "/manifest.webmanifest", "/icon.svg"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== "fomocloud-v05").map(key => caches.delete(key)))).then(() => clients.claim()));
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy=response.clone();
    void caches.open("fomocloud-v05").then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(response => response || caches.match("/"))));
});
self.addEventListener("push", event => {
  let data={title:"FomoCloud",body:"You have a new update",url:"/app/"};
  try { data={...data,...event.data.json()}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,
    icon:"/icon.svg",
    badge:"/icon.svg",
    tag:data.type?`fomocloud-${data.type}`:undefined,
    data:{url:data.url||"/app/"}
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target=new URL(event.notification.data?.url||"/app/",self.location.origin).href;
  event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(async windows=>{
    for(const client of windows){
      if("navigate" in client) await client.navigate(target);
      if("focus" in client) return client.focus();
    }
    return clients.openWindow(target);
  }));
});
