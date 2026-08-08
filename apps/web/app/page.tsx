"use client";
import {
  ArrowRight, ShieldCheck, Zap, WalletCards, Users, Bell, TrendingUp,
  Layers3, Smartphone, CheckCircle2, Sparkles, LineChart
} from "lucide-react";

const features=[
  [Users,"Follow real traders","Choose platform traders or add a public wallet you already trust."],
  [Zap,"Copy in real time","One source-wallet event is detected once, then evaluated independently for every eligible user."],
  [ShieldCheck,"Your limits, your account","Set your own amount per trade, exposure, chains and Auto Copy status."],
  [TrendingUp,"Protect the big runner","Take partial profit while strong meme momentum still has room to continue."],
  [Bell,"Know what happened","See copied trades, skipped trades, pullback waits, profit takes and closes in plain English."],
  [Layers3,"Multi-chain foundation","Trading Cash is shown simply in USD/USDC while balances and permissions remain chain-aware."]
] as const;

export default function Landing(){
  return <main className="landing">
    <div className="landing-glow one"/><div className="landing-glow two"/>
    <div className="public-shell">
      <header className="public-header">
        <a className="brand" href="/"><span className="brandmark">∞</span><b>FomoCloud</b></a>
        <nav className="public-links">
          <a href="#how">How it works</a><a href="#features">Features</a><a href="#security">Security</a>
        </nav>
        <div className="public-actions"><a className="ghost-link" href="/login/">Sign in</a><a className="primary-link" href="/signup/">Start trading <ArrowRight size={16}/></a></div>
      </header>

      <section className="hero">
        <div className="eyebrow"><Sparkles size={14}/> SOCIAL COPY TRADING, BUILT FOR FAST MARKETS</div>
        <h1>Your traders move.<br/><em>Your account reacts.</em></h1>
        <p>Build your own watchlist, follow platform traders, and let the 24/7 engine evaluate every source-wallet move against <b>your</b> cash, limits and copy settings.</p>
        <div className="hero-actions"><a className="hero-primary" href="/signup/">Create my account <ArrowRight size={18}/></a><a className="hero-secondary" href="#how">See how it works</a></div>
        <div className="hero-trust"><span><CheckCircle2 size={15}/> Separate account for every user</span><span><CheckCircle2 size={15}/> Real backend activity</span><span><CheckCircle2 size={15}/> Live funds remain off until authorized</span></div>

        <div className="product-preview">
          <div className="preview-side">
            <span className="brandmark small">∞</span>
            <i/><i/><i/><i/><i/>
          </div>
          <div className="preview-body">
            <div className="preview-top"><div><small>YOUR PRIVATE APP</small><strong>Good morning</strong></div><span className="preview-status">Auto Copy · On</span></div>
            <div className="preview-cards">
              <div><small>Trading Cash</small><b>Your USDC</b><span>Synced per chain</span></div>
              <div><small>Performance</small><b>Your P&amp;L</b><span>Realized + unrealized</span></div>
              <div><small>People you copy</small><b>Your list</b><span>Follow · Watch · Auto Copy</span></div>
            </div>
            <div className="preview-feed">
              <span className="feed-dot"/><div><b>Source wallet detected</b><small>One event → user-specific decisions</small></div><strong>7 sec</strong>
            </div>
            <div className="preview-feed muted-row">
              <span className="feed-dot purple"/><div><b>Your settings are checked</b><small>Cash · chase · exposure · chain · permission</small></div><strong>Fast path</strong>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="how">
        <div className="section-title"><span>HOW IT WORKS</span><h2>Follow people. Keep control.</h2><p>The source signal is shared. The decision and position always belong to the individual user.</p></div>
        <div className="steps">
          <div><b>01</b><h3>Create your account</h3><p>Sign up with email and password, or use a supported wallet sign-in.</p></div>
          <div><b>02</b><h3>Choose traders</h3><p>Use platform picks, watch only, or add your own public trader wallet.</p></div>
          <div><b>03</b><h3>Set your rules</h3><p>Choose amount per trade, exposure, enabled chains and Auto Copy.</p></div>
          <div><b>04</b><h3>See every decision</h3><p>Positions, history, P&amp;L and plain-English reasons stay attached to your account.</p></div>
        </div>
      </section>

      <section id="features" className="feature-section">
        <div className="section-title"><span>THE ACTUAL PRODUCT</span><h2>More than a connect-wallet page.</h2></div>
        <div className="feature-grid">{features.map(([Icon,title,copy])=><article key={title}><Icon size={21}/><h3>{title}</h3><p>{copy}</p></article>)}</div>
      </section>

      <section className="chase-band">
        <div><span>MEME CHASE RULE</span><h2>A coin can be +5,000% today and still be a valid copy.</h2><p>Chase is measured from the followed wallet's actual buy to FomoCloud's current executable entry — not from the token's 24-hour percentage move.</p></div>
        <div className="chase-example"><small>SOURCE WALLET BUY</small><b>$1.00</b><i/><small>CURRENT EXECUTABLE ENTRY</small><b>$1.35</b><strong>Wallet chase = +35%</strong></div>
      </section>

      <section id="security" className="security-band">
        <div className="security-icon"><ShieldCheck size={32}/></div>
        <div><span>ACCOUNT &amp; TRADING SECURITY</span><h2>Login is not trading permission.</h2><p>Email/password creates your account. A wallet connection proves ownership. Unattended live trading still requires a reviewed delegated/session authorization with explicit limits and revocation. The test deployment stays in simulation until that live-money path is ready.</p></div>
      </section>

      <section className="cta">
        <LineChart size={32}/><h2>Build your trader list.</h2><p>Your dashboard starts empty and becomes yours — no fake balance, fake P&amp;L or shared public account.</p><a className="hero-primary" href="/signup/">Start trading <ArrowRight size={18}/></a>
      </section>

      <footer className="public-footer"><div className="brand"><span className="brandmark small">∞</span><b>FomoCloud</b></div><span>24/7 backend · Personal dashboards · Simulation until live authorization</span><span><Smartphone size={14}/> PWA ready</span></footer>
    </div>
  </main>
}
