import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { db } from "@memecloud/db";

const jwtSecret = process.env.AUTH_JWT_SECRET ?? "development-only-change-me";

export type TokenPayload = { sub:string; role:"USER"|"OWNER"|"ADMIN"|"SUPPORT"; email?:string };
export type AuthedRequest = Request & { user: TokenPayload };

export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false });
// Every other /v1 route was previously unrated-limited. The manual-trade endpoint is the one
// that actually matters here: it calls Jupiter twice per request (forward+reverse quote) even
// in simulation, and once live trading is on it can submit real Solana transactions -- an
// authenticated account hammering it is both a real-money risk and a way to exhaust the whole
// platform's shared Jupiter quota (the same 429 pressure fixed in market-worker/discovery-worker
// this session). Keyed by user, not IP, since this is auth-gated.
export const tradeLimiter = rateLimit({ windowMs: 60_000, limit: 6, standardHeaders: "draft-7", legacyHeaders: false, keyGenerator:(req:any)=>req.user?.sub||req.ip });

export function auth(req:Request,res:Response,next:NextFunction) {
  const token=String(req.headers.authorization??"").replace(/^Bearer\s+/i,"");
  try {
    const payload=jwt.verify(token,jwtSecret,{issuer:"memecloud-api",audience:"memecloud-web"}) as TokenPayload;
    void db.user.findUnique({where:{id:payload.sub},select:{email:true,role:true,status:true}}).then(user=>{
      if(!user||user.status!=="ACTIVE") return res.status(401).json({error:"UNAUTHORIZED"});
      (req as AuthedRequest).user={...payload,role:user.role as TokenPayload["role"],email:user.email??payload.email};
      next();
    }).catch(next);
  } catch {
    res.status(401).json({error:"UNAUTHORIZED"});
  }
}
export function requireAdmin(req:Request,res:Response,next:NextFunction) {
  auth(req,res,()=>{
    const role=(req as AuthedRequest).user.role;
    if(role!=="OWNER" && role!=="ADMIN" && role!=="SUPPORT") return res.status(403).json({error:"ADMIN_FORBIDDEN"});
    next();
  });
}
export function adminOnly(req:Request,res:Response,next:NextFunction) {
  requireAdmin(req,res,()=>{
    if((req as AuthedRequest).user.role!=="OWNER") return res.status(403).json({error:"OWNER_REQUIRED"});
    next();
  });
}
