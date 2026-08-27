const API = process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://fomocloud-api.173-212-249-202.sslip.io"
    : "http://localhost:4000");
const TOKEN_KEY = "memecloud_access";

export function getAccessToken() {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setAccessToken(token:string|null) {
  if (typeof window === "undefined") return;
  if(token) sessionStorage.setItem(TOKEN_KEY,token); else sessionStorage.removeItem(TOKEN_KEY);
}
export async function apiFetch<T=any>(path:string, init:RequestInit={}, retry=true):Promise<T> {
  const headers=new Headers(init.headers);
  const token=getAccessToken();
  if(token) headers.set("authorization",`Bearer ${token}`);
  if(init.body && !headers.has("content-type")) headers.set("content-type","application/json");
  const res=await fetch(`${API}${path}`,{...init,headers,credentials:"include"});
  if(res.status===401 && retry){
    const refreshed=await fetch(`${API}/auth/refresh`,{method:"POST",credentials:"include"}).catch(()=>null);
    if(refreshed?.ok){
      const data=await refreshed.json(); setAccessToken(data.accessToken);
      return apiFetch<T>(path,init,false);
    }
  }
  const body=await res.json().catch(()=>({}));
  if(!res.ok) throw Object.assign(new Error(body?.error||`Request failed (${res.status})`),{status:res.status,body});
  return body as T;
}
export async function login(email:string,password:string){
  const data=await apiFetch<any>("/auth/login",{method:"POST",body:JSON.stringify({email,password})},false);
  setAccessToken(data.accessToken); return data;
}
export async function signup(email:string,password:string,displayName:string){
  const data=await apiFetch<any>("/auth/signup",{method:"POST",body:JSON.stringify({email,password,displayName})},false);
  setAccessToken(data.accessToken); return data;
}
export async function logout(){
  try{await apiFetch("/auth/logout",{method:"POST"},false)}catch{}
  setAccessToken(null);
}
export function money(n:number|undefined|null){
  if(n===null||n===undefined||!Number.isFinite(Number(n))) return "—";
  return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(n));
}
export function pct(n:number|undefined|null){
  if(n===null||n===undefined||!Number.isFinite(Number(n))) return "—";
  return `${Number(n)>=0?"+":""}${Number(n).toFixed(1)}%`;
}
export function plainError(e:any){
  if(typeof e?.body?.message==="string"&&e.body.message) return e.body.message;
  const code=String(e?.body?.error??e?.message??"UNKNOWN");
  const map:Record<string,string>={
    INVALID_CREDENTIALS:"That email or password isn't correct.",
    EMAIL_ALREADY_REGISTERED:"An account already exists with this email.",
    PASSWORD_REQUIREMENTS:"Use at least 8 characters for your password.",
    UNAUTHORIZED:"Your session ended. Please sign in again.",
    ACCOUNT_NOT_ACTIVE:"This account is not currently active.",
    EMAIL_VERIFICATION_REQUIRED:"Verify your email before turning Auto Copy on.",
    X_OAUTH_NOT_CONFIGURED:"X linking has not been configured by the platform yet.",
    EMAIL_NOT_CONFIGURED:"Email has not been configured by the administrator yet.",
    SOURCE_WALLET_REQUIRED:"Add the trader's verified public wallet before enabling Auto Copy.",
    WALLET_OR_X_REQUIRED:"Add a public trading wallet or an X username.",
    REVOKE_TRADING_PERMISSION_FIRST:"Revoke this wallet's trading permission before unlinking it.",
    CHAIN_LISTENER_NOT_IMPLEMENTED:"That chain is prepared in the data model, but live source-wallet tracking is not implemented yet. You can keep the trader as a favorite for now.",
    PUBLIC_USERNAME_REQUIRED:"Choose a public username before making your community profile discoverable.",
    PUBLIC_PROFILE_NOT_FOUND:"That user has not enabled a public community profile.",
    SOURCE_WALLET_ALREADY_MAPPED:"That public source wallet is already assigned to another tracked trader.",
    REFRESH_REPLAYED:"Your session was already refreshed elsewhere. Please sign in again.",
    EXECUTION_PRICE_IMPACT_TOO_HIGH:"The real executable route would move the price too much, so the trade was skipped.",
    SOURCE_EXECUTION_PRICE_MISSING:"We detected the trader's buy, but cannot verify its real execution price yet.",
    MARKET_DATA_INCOMPLETE:"Critical market data is still being verified. No trade was invented.",
    EXECUTION_ADAPTER_NOT_CONFIGURED:"That network is prepared but does not yet have a verified execution route."
  };
  return map[code]??code.replaceAll("_"," ").toLowerCase();
}
