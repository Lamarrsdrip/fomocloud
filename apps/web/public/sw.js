self.addEventListener("push", event => {
  let data={title:"MemeCloud",body:"You have a new update",url:"/app/"};
  try { data={...data,...event.data.json()}; } catch {}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,
    icon:"/icon.svg",
    badge:"/icon.svg",
    tag:data.type?`memecloud-${data.type}`:undefined,
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
