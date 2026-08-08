import { db, Prisma } from "@fomocloud/db";

export async function beat(name:string, status="healthy", detail:Prisma.InputJsonObject={}) {
  await db.workerHeartbeat.upsert({
    where:{name},
    create:{name,status,detail,lastBeatAt:new Date()},
    update:{status,detail,lastBeatAt:new Date()}
  });
}

export function startHeartbeat(name:string, detail:(()=>Prisma.InputJsonObject)|Prisma.InputJsonObject = {}) {
  const pulse = async () => {
    try {
      const d = typeof detail === "function" ? detail() : detail;
      await beat(name, "healthy", d);
    } catch (e) {
      console.error(`[${name}] heartbeat`, e);
    }
  };
  void pulse();
  const timer = setInterval(pulse, 15_000);
  timer.unref?.();
  return timer;
}
