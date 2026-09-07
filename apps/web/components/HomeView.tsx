"use client";
import {ArrowDownToLine,TrendingUp,Users,WalletCards} from "lucide-react";
import {money} from "../lib/api";
import {timeAgo} from "../lib/format";
import {useCuratedLive} from "../lib/useCuratedLive";
import {TokenAvatar} from "./TokenAvatar";

function compact(n:any){const x=Number(n);if(!Number.isFinite(x))return null;return x>=1_000_000?`${(x/1_000_000).toFixed(2)}M`:x>=1_000?`${(x/1_000).toFixed(2)}K`:x.toLocaleString(undefined,{maximumFractionDigits:4})}

export default function HomeView({d,setView,openToken,onFund}:{d:any;activity:any;brain:any[];brainDegraded:boolean;setView:(v:any)=>void;openToken:(s:{chain:string;mint:string})=>void;onFund:()=>void}){
 const s=d?.summary||{};
 const live=useCuratedLive(5000);
 const wallet=(live.data?.events||[]).filter((e:any)=>Number(e.buyCount??0)>0&&e.state!=="EXITED").slice(0,8);
 return <>
  <section className="home-hero"><div><span>TOTAL VALUE</span><h2>{money(s.accountValueUsd)}</h2></div><div className="home-hero-pnl"><span>TOTAL PNL</span><b>{money(s.netPnlUsd)}</b></div></section>
  <div className="quick-actions-row"><button onClick={onFund}><ArrowDownToLine/><span>Fund</span></button><button onClick={()=>setView("discover")}><TrendingUp/><span>Live buys</span></button><button onClick={()=>setView("traders")}><Users/><span>Traders</span></button><button onClick={()=>setView("positions")}><WalletCards/><span>Wallet</span></button></div>
  <section className="app-card"><div className="card-title"><div><span>HOW MEMECLOUD WORKS</span><h2>Follow the wallets. Research the token. Trade fast.</h2></div></div><p style={{fontSize:12,color:"#8a8fa0"}}>Admin lists proven meme traders. MemeCloud watches their real swaps, alerts you immediately, researches every bought token, and can trade through Global Brain or your own selected traders.</p><button className="action-primary" onClick={()=>setView("traders")}>Choose traders</button></section>
  <section className="app-card"><div className="card-title"><div><span>LIVE NOW</span><h2>Verified trader buys</h2></div><button className="soft-action" onClick={()=>setView("discover")}>Open Hunt</button></div>
   {live.error&&<div className="notice" style={{marginBottom:10}}><b>Live trader data unavailable</b><div style={{fontSize:11,marginTop:4}}>{live.error}</div></div>}
   {!live.error&&live.loading&&!live.data&&<div className="pnl-empty">Loading verified live swaps…</div>}
   {!live.error&&live.data&&wallet.map((e:any)=>{
      const symbol=e.token?.symbol||e.token?.name;
      const quote=e.latestBuyQuoteAmount&&e.latestBuyQuoteSymbol?`${compact(e.latestBuyQuoteAmount)} ${e.latestBuyQuoteSymbol}`:null;
      const usd=e.latestBuyAmountUsd?money(e.latestBuyAmountUsd):null;
      return <div className="feed-item tap" key={e.id} onClick={()=>openToken({chain:"SOLANA",mint:e.mint})}>
        <TokenAvatar symbol={symbol}/><div><b>{e.trader?.displayName||`Tracked wallet ${e.walletAddress?.slice(0,5)}…${e.walletAddress?.slice(-4)}`} bought {symbol||`${e.mint.slice(0,5)}…${e.mint.slice(-4)}`}</b><small>{quote?`With ${quote}`:"Verified swap"}{usd?` · ${usd}`:""}{e.marketCapAtBuy?` · ${money(e.marketCapAtBuy)} MC`:""} · {timeAgo(e.latestBuyAt||e.firstBuyAt||e.observedAt)}</small></div>
      </div>
   })}
   {!live.error&&live.data&&!wallet.length&&<div className="pnl-empty">No tracked trader is in a live buy session right now. MemeCloud is waiting for the next verified on-chain swap.</div>}
  </section>
 </>;
}
