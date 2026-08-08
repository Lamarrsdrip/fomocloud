"use client";
import { useState } from "react";
import {
  Home, Compass, Activity, WalletCards, UserRound, Bell, ShieldCheck,
  ArrowUpRight, ChevronRight, Sparkles, TrendingUp, Zap, CircleDollarSign,
  Pause, Play, Flame, Check, Search, Smartphone
} from "lucide-react";

const people = [
  {name:"Logan Lim",handle:"@loganlim_x",ret:"+182%",initial:"L",tag:"Fast launches"},
  {name:"Avast",handle:"@0xAvast",ret:"+96%",initial:"A",tag:"Early memes"},
  {name:"TechQuant",handle:"@techquant",ret:"+71%",initial:"T",tag:"Momentum"}
];

const moves = [
  {kind:"buy",title:"HTZ copied from Logan",sub:"Bought $500 · 18 sec ago",right:"+74%",note:"Buying is still strong. Letting it run."},
  {kind:"profit",title:"HTZ first profit taken",sub:"Sold 30% at +100%",right:"+$151",note:"The rest stays open while momentum is healthy."},
  {kind:"skip",title:"NOVA is still on watch",sub:"Price jumped beyond our chase window",right:"Watching",note:"We didn't chase. FomoCloud is waiting for a cleaner pullback."}
];

export default function HomePage(){
  const [connected,setConnected]=useState(false);
  const [running,setRunning]=useState(true);
  const [tab,setTab]=useState("Home");
  const nav=[["Home",Home],["Discover",Compass],["Activity",Activity],["Positions",WalletCards],["Profile",UserRound]] as const;

  return <main className="cloud">
    <div className="aurora a"/><div className="aurora b"/>
    <div className="shell">
      <header>
        <div className="brand"><span className="logo">∞</span><b>FomoCloud</b></div>
        <div className="head-actions">
          <button className="round"><Bell size={19}/><i/></button>
          <button className="connect" onClick={()=>setConnected(true)}>
            <WalletCards size={17}/>{connected?"7xD…2qP":"Connect wallet"}
          </button>
        </div>
      </header>

      <section className="welcome">
        <div className="welcome-copy">
          <span className="hello">SMART MEME COPY TRADING</span>
          <h1>Follow the wallets.<br/><em>Let FomoCloud think.</em></h1>
          <p>Pick traders you trust. FomoCloud watches every move, checks the token in real time, buys when the setup makes sense and protects winners without cutting them too early.</p>
          <div className="actions">
            <button className="main-btn" onClick={()=>setConnected(true)}>{connected?"Wallet connected":"Connect wallet"}<ArrowUpRight size={18}/></button>
            <button className="soft-btn">See how it works<ChevronRight size={17}/></button>
          </div>
        </div>

        <div className="status-card">
          <div className="status-top"><span>FomoCloud</span><span className={running?"live":"paused"}><i/>{running?"Working":"Paused"}</span></div>
          <div className="brain"><div className="halo h1"/><div className="halo h2"/><Sparkles size={30}/></div>
          <h3>{running?"Watching for your next trade":"New buys are paused"}</h3>
          <p>{running?"6 traders · real-time token checks · profit protection on":"Open positions can still be protected."}</p>
          <div className="plain-grid">
            <div><span>Per trade</span><b>$500 max</b></div>
            <div><span>Fresh meme chase</span><b>Up to ~40%</b></div>
            <div><span>First new-token profit</span><b>+100%</b></div>
            <div><span>Big winners</span><b>Let them run</b></div>
          </div>
          <button className="control" onClick={()=>setRunning(!running)}>{running?<Pause size={16}/>:<Play size={16}/>} {running?"Pause new buys":"Resume FomoCloud"}</button>
        </div>
      </section>

      <section className="money-row">
        <div><span>Your trading wallet</span><strong>{connected?"$12,482.72":"—"}</strong><small>{connected?"+$841.22 today":"Connect to see your balance"}</small></div>
        <div><span>Open trades</span><strong>{connected?"4":"—"}</strong><small>{connected?"2 already in profit":"Nothing to show yet"}</small></div>
        <div><span>Profit taken today</span><strong>{connected?"+$621.40":"—"}</strong><small>{connected?"After confirmed sells":"Only real confirmed sells count"}</small></div>
      </section>

      <section className="main-grid">
        <div className="card">
          <div className="card-head">
            <div><span className="label">PEOPLE YOU COPY</span><h2>Smart money</h2></div>
            <button className="text-btn">Find traders <Search size={15}/></button>
          </div>
          <div className="people">
            {people.map((p,i)=><div className="person" key={p.handle}>
              <div className={`face f${i}`}>{p.initial}<span><Check size={10}/></span></div>
              <div className="person-name"><b>{p.name}</b><small>{p.handle} · {p.tag}</small></div>
              <div className="return"><b>{p.ret}</b><small>30D</small></div>
              <button>{i<2?"Copying":"Follow"}</button>
            </div>)}
          </div>
        </div>

        <div className="card intelligence">
          <div className="card-head">
            <div><span className="label">RIGHT NOW</span><h2>What FomoCloud sees</h2></div>
            <span className="fresh"><i/>Fresh</span>
          </div>
          <div className="score-ring"><div><b>91</b><span>Momentum</span></div></div>
          <div className="signals">
            <div><Zap size={17}/><span><b>Volume is speeding up</b><small>1-minute buying is 2.4× normal</small></span></div>
            <div><TrendingUp size={17}/><span><b>More buyers than sellers</b><small>Buyer flow is still expanding</small></span></div>
            <div><Flame size={17}/><span><b>Social attention is rising</b><small>Mostly unique accounts, low spam</small></span></div>
            <div><ShieldCheck size={17}/><span><b>No hard risk blocker</b><small>Sell route and liquidity look usable</small></span></div>
          </div>
          <div className="decision"><span>Current style</span><b>Let strong memes breathe</b></div>
        </div>
      </section>

      <section className="activity-card card">
        <div className="card-head"><div><span className="label">YOUR ACTIVITY</span><h2>What the bot did — in plain English</h2></div><button className="text-btn">See everything <ChevronRight size={15}/></button></div>
        <div className="moves">
          {moves.map((m,i)=><div className="move" key={m.title}>
            <div className={`move-icon ${m.kind}`}>{m.kind==="buy"?<ArrowUpRight size={17}/>:m.kind==="profit"?<CircleDollarSign size={17}/>:<ShieldCheck size={17}/>}</div>
            <div className="move-main"><b>{m.title}</b><small>{m.sub}</small><p>{m.note}</p></div>
            <strong>{m.right}</strong>
          </div>)}
        </div>
      </section>

      <section className="runner card">
        <div className="runner-copy">
          <span className="label">HOW PROFITS WORK</span>
          <h2>Take profit. Keep a piece for the crazy move.</h2>
          <p>Fresh memes can move 500%, 2,000% or more. FomoCloud takes some money off the table, then gives the remaining runner more room while volume, buyers, liquidity and hype stay strong.</p>
        </div>
        <div className="ladder">
          <div><span>+100%</span><b>Take some profit</b><small>Fresh-token first target</small></div>
          <i/>
          <div><span>+150%</span><b>Take some more</b><small>Keep the runner alive</small></div>
          <i/>
          <div><span>+200%</span><b>Protect the win</b><small>No final upside cap</small></div>
          <i/>
          <div className="moon"><span>+5000%?</span><b>Still strong? Hold.</b><small>Exit when the trend breaks, not because profit is “too big”.</small></div>
        </div>
      </section>

      <section className="mobile-soon card">
        <div className="mobile-soon-copy">
          <span className="label">MOBILE APP</span>
          <h2>FomoCloud for iPhone &amp; Android <em>— coming soon</em></h2>
          <p>The native apps are on the way. Until then, add FomoCloud to your home screen and it opens full-screen, just like a native app — with push notifications for every copy, profit take and skip.</p>
          <div className="soon-badges">
            <span className="soon-badge"><Smartphone size={16}/> iPhone · Coming soon</span>
            <span className="soon-badge"><Smartphone size={16}/> Android · Coming soon</span>
          </div>
        </div>
        <div className="mobile-soon-art"><div className="phone"><span className="logo">∞</span><b>FomoCloud</b><small>Add to Home Screen today</small></div></div>
      </section>

      <footer>
        <div className="brand"><span className="logo">∞</span><b>FomoCloud</b></div>
        <p>No subscriptions. Transparent trading fees only when enabled.</p>
        <small>Real trades only count after blockchain confirmation.</small>
      </footer>
    </div>

    <nav className="mobile-nav">
      {nav.map(([name,Icon])=><button key={name} className={tab===name?"active":""} onClick={()=>setTab(name)}><Icon size={21}/><span>{name}</span></button>)}
    </nav>
  </main>
}
