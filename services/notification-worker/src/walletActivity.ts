import { db, walletActivityContent } from "@memecloud/db";
import { sendPush } from "@memecloud/notifications";
import { pushAllowed } from "./decisions.js";

let running=false;
export async function deliverWalletActivity(){
  if(running)return;running=true;
  try{
    const events=await db.walletActivity.findMany({where:{notificationStatus:"PENDING"},orderBy:{createdAt:"asc"},take:100});
    for(const event of events){
      const token=await db.discoveryToken.findUnique({where:{chain_mint:{chain:event.chain,mint:event.mint}}});
      // Give the independent metadata worker a short head start, never block the event.
      if(!token?.symbol&&!token?.name&&Date.now()-event.createdAt.getTime()<35_000)continue;
      const content=walletActivityContent(event,token);
      const users=await db.user.findMany({where:{status:"ACTIVE",...(event.public?{}:{follows:{some:{traderId:event.traderId}}})},include:{notificationPrefs:true}});
      for(const user of users){
        const deliveryKey=`wallet-${event.eventKey}-${user.id}`;
        let notification:any;
        try{notification=await db.notification.create({data:{userId:user.id,deliveryKey,type:content.type,title:content.title,body:content.body,data:{...(content.data as any),_delivery:{}} as any}})}
        catch(e:any){if(e.code!=="P2002")throw e;notification=await db.notification.findUnique({where:{deliveryKey}});if(!notification)throw e;}
        const delivery={...((((notification.data as any)??{})._delivery)??{})};
        if(pushAllowed(content.type,user.notificationPrefs)&&delivery.push!=="SENT"&&delivery.push!=="SKIPPED"){
          const r=await sendPush(user.id,{title:content.title,body:content.body,url:content.data.url,type:content.type,tag:deliveryKey,data:content.data});
          if(r.sent>0)delivery.push="SENT";
          else if(r.failed>0){delivery.push="RETRY";await db.notification.update({where:{id:notification.id},data:{data:{...((notification.data as any)??{}),_delivery:delivery} as any}});throw Object.assign(new Error("WALLET_PUSH_DELIVERY_FAILED"),{code:"WALLET_PUSH_DELIVERY_FAILED"})}
          else delivery.push="SKIPPED";
          await db.notification.update({where:{id:notification.id},data:{data:{...((notification.data as any)??{}),_delivery:delivery} as any}});
        }
      }
      await db.walletActivity.update({where:{id:event.id},data:{notificationStatus:"DELIVERED"}});
    }
  }finally{running=false;}
}
