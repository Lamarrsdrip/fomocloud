"use client";
import {
  ArrowRight, ShieldCheck, Zap, WalletCards, Users, Bell, TrendingUp,
  Layers3, Smartphone, CheckCircle2, Sparkles, LineChart
} from "lucide-react";
import { InstallAppPrompt } from "../components/InstallAppPrompt";

const features=[
  [Sparkles,"Autonomous discovery","Continuously surface emerging opportunities from market activity, liquidity, flow and verified on-chain evidence."],
  [LineChart,"Market intelligence","Turn executable prices, momentum, volume and risk into explainable context instead of noisy alerts."],
  [Users,"Wallet intelligence","Analyze strong traders and public wallets as one evidence source—not as the product's only strategy."],
  [Layers3,"Opportunity scoring","Combine fresh evidence into ranked candidates so weak or incomplete setups fail closed."],
  [ShieldCheck,"Risk-aware decisions","Check entry quality, exposure, chain permissions and account rules before any simulated execution."],
  [TrendingUp,"Position management","Track profit targets, partial exits, runners and changing conditions after entry."]
] as const;

export default function Landing(){
  return <main className="landing">
    <div className="landing-glow one"/><div className="landing-glow two"/>
    <div className="public-shell">
      <header className="public-header">
        <a className="brand" href="/"><span className="brandmark">K</span><b>MemeCloud</b></a>
        <nav className="public-links">
          <a href="#how">How it works</a><a href="#features">Features</a><a href="#security">Security</a>
        </nav>
        <div className="public-actions"><a className="ghost-link" href="/login/">Sign in</a><a className="primary-link" href="/signup/">Start trading <ArrowRight size={16}/></a></div>
      </header>

      <section className="hero">
        <div className="eyebrow"><Sparkles size={14}/> AUTONOMOUS CRYPTO INTELLIGENCE</div>
        <h1>Discover the signal.<br/><em>Act on intelligence.</em></h1>
        <p>MemeCloud discovers opportunities, analyzes markets and wallets, scores evidence, makes account-specific decisions, and manages positions through one explainable 24/7 system.</p>
        <div className="hero-actions"><a className="hero-primary" href="/signup/">Create my account <ArrowRight size={18}/></a><a className="hero-secondary" href="#how">See how it works</a></div>
        <div className="hero-trust"><span><CheckCircle2 size={15}/> Separate account for every user</span><span><CheckCircle2 size={15}/> Real backend activity</span><span><CheckCircle2 size={15}/> Live funds remain off until authorized</span></div>

        <div className="product-preview">
          <div className="preview-side">
            <span className="brandmark small">K</span>
            <i/><i/><i/><i/><i/>
          </div>
          <div className="preview-body">
            <div className="preview-top"><div><small>YOUR PRIVATE APP</small><strong>Good morning</strong></div><span className="preview-status">Auto Copy · On</span></div>
            <div className="preview-cards">
              <div><small>Trading Cash</small><b>Your USDC</b><span>Synced per chain</span></div>
              <div><small>Performance</small><b>Your P&amp;L</b><span>Realized + unrealized</span></div>
              <div><small>Intelligence sources</small><b>Your signals</b><span>Discovery · Wallets · Markets</span></div>
            </div>
            <div className="preview-feed">
              <span className="feed-dot"/><div><b>Opportunity detected</b><small>Market + wallet evidence → account decision</small></div><strong>7 sec</strong>
            </div>
            <div className="preview-feed muted-row">
              <span className="feed-dot purple"/><div><b>Your settings are checked</b><small>Cash · chase · exposure · chain · permission</small></div><strong>Fast path</strong>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="how">
        <div className="section-title"><span>HOW MemeCloud WORKS</span><h2>From discovery to learning.</h2><p>Every stage remains explainable, account-aware and simulation-gated until live execution is explicitly authorized.</p></div>
        <div className="steps">
          <div><b>01</b><h3>Discover</h3><p>Monitor market structure, token activity and verified wallet behavior for emerging candidates.</p></div>
          <div><b>02</b><h3>Score</h3><p>Rank evidence for liquidity, momentum, execution quality and risk without inventing missing data.</p></div>
          <div><b>03</b><h3>Decide</h3><p>Apply your cash, exposure, chain and automation permissions to every opportunity independently.</p></div>
          <div><b>04</b><h3>Manage</h3><p>Track positions, partial exits, runners, outcomes and the evidence behind each action.</p></div>
        </div>
      </section>

      <section id="features" className="feature-section">
        <div className="section-title"><span>THE INTELLIGENCE SYSTEM</span><h2>More than a copy-trading bot.</h2></div>
        <div className="feature-grid">{features.map(([Icon,title,copy])=><article key={title}><Icon size={21}/><h3>{title}</h3><p>{copy}</p></article>)}</div>
      </section>

      <section className="chase-band">
        <div><span>INTELLIGENT ENTRY</span><h2>Headline movement is not execution quality.</h2><p>MemeCloud compares a verified evidence anchor with the current executable route, liquidity and risk—not a token's headline 24-hour percentage.</p></div>
        <div className="chase-example"><small>SOURCE WALLET BUY</small><b>$1.00</b><i/><small>CURRENT EXECUTABLE ENTRY</small><b>$1.35</b><strong>Wallet chase = +35%</strong></div>
      </section>

      <section id="security" className="security-band">
        <div className="security-icon"><ShieldCheck size={32}/></div>
        <div><span>ACCOUNT &amp; TRADING SECURITY</span><h2>Login is not trading permission.</h2><p>Email/password creates your MemeCloud account. A wallet connection proves ownership. Unattended live trading still requires a reviewed delegated/session authorization with explicit limits and revocation. This deployment stays in simulation until that live-money path is ready.</p></div>
      </section>

      <section className="security-band">
        <div className="security-icon"><Smartphone size={32}/></div>
        <div><span>MOBILE APP EXPERIENCE</span><h2>Install MemeCloud today.</h2><p>Add the PWA to your Home Screen for a full-screen trading workspace. Native iOS and Android releases are coming soon; installed launches go directly to secure sign-in.</p></div>
      </section>

      <section className="cta">
        <LineChart size={32}/><h2>Build your trader list.</h2><p>Your dashboard starts empty and becomes yours — no fake balance, fake P&amp;L or shared public account.</p><a className="hero-primary" href="/signup/">Start trading <ArrowRight size={18}/></a>
      </section>

      <footer className="public-footer"><div className="brand"><span className="brandmark small">K</span><b>MemeCloud</b></div><span>Autonomous intelligence · Personal dashboards · Simulation until live authorization</span><span><Smartphone size={14}/> PWA ready</span></footer>
    </div>
    <InstallAppPrompt/>
  </main>
}
