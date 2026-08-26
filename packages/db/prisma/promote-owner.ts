import {PrismaClient} from "@prisma/client";
const db=new PrismaClient();
const email=(process.env.OWNER_EMAIL||"idrisgana25@gmail.com").trim().toLowerCase();
const user=await db.user.findFirst({where:{email}}).catch(()=>null);
if(!user){console.error(`Owner user ${email} not found. Create/login once first, then rerun.`);process.exitCode=2}else{
  await db.user.update({where:{id:user.id},data:{role:"OWNER",status:"ACTIVE"}});
  await db.user.updateMany({where:{id:{not:user.id},role:"OWNER"},data:{role:"USER"}});
  console.log(`Owner promoted: ${email} (${user.id}). Other human OWNER roles were demoted to USER.`);
}
await db.$disconnect();
