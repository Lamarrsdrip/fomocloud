"use client";

import {
  Activity, ArrowRight, ArrowUpRight, Bell, Check, CheckCircle2, ChevronRight,
  CircleDollarSign, Eye, Flame, LineChart, Play, ShieldCheck, Smartphone,
  Sparkles, TrendingUp, Users, WalletCards, Zap
} from "lucide-react";

const howSteps = [
  ["01", "FOLLOW", "Choose platform traders or add verified public wallets you already trust.", Users],
  ["02", "WATCH", "FomoCloud watches every verified source-wallet move, day and night.", Eye],
  ["03", "THINK", "The engine checks entry quality, liquidity, momentum, volume, risk and your settings.", Sparkles],
  ["04", "ACT", "Qualifying trades are recorded, prepared or copied according to your permissions and execution mode.", Zap],
  ["05", "MANAGE", "Profit targets, partial exits, runners and changing market conditions stay under watch.", TrendingUp]
] as const;

const activityExamples = [
  {
    icon: ArrowUpRight,
    tone: "green",
    title: "A trader bought TOKEN",
    steps: ["FomoCloud checked the move.", "The entry still made sense.", "The trade was prepared using that account’s rules."],
    status: "QUALIFIED"
  },
  {
    icon: CircleDollarSign,
    tone: "purple",
    title: "TOKEN reached its first profit target",
    steps: ["Part of the profit was secured.", "Momentum remained healthy.", "The runner stayed open."],
    status: "RUNNER ACTIVE"
  },
  {
    icon: ShieldCheck,
    tone: "amber",
    title: "TOKEN stayed on watch",
    steps: ["Price moved beyond the preferred entry.", "FomoCloud did not chase.", "The account waited for a cleaner pullback."],
    status: "WAITING"
  }
] as const;

export default function Landing() {
  return <main className="marketing-page">
    <div className="marketing-orb orb-one"/><div className="marketing-orb orb-two"/>
    <div className="marketing-shell">
      <header className="marketing-header">
        <a className="brand" href="/"><span className="brandmark">∞</span><b>FomoCloud</b></a>
        <nav className="marketing-nav">
          <a href="#how">How it works</a>
          <a href="#product">Product</a>
          <a href="#security">Security</a>
        </nav>
        <div className="marketing-actions">
          <a className="ghost-link" href="/login/">Sign in</a>
          <a className="primary-link" href="/signup/">Start trading <ArrowRight size={15}/></a>
        </div>
      </header>

      <section className="marketing-hero">
        <div className="hero-copy-old">
          <span className="marketing-kicker"><Flame size={14}/> SMART COPY TRADING FOR FAST MARKETS</span>
          <h1>Follow the wallets.<br/><em>Let FomoCloud think.</em></h1>
          <p>Follow traders you trust. FomoCloud watches their verified wallets 24/7, checks every move, and reacts according to your personal settings and permissions.</p>
          <div className="marketing-ctas">
            <a className="hero-primary" href="/signup/">Start trading <ArrowUpRight size={18}/></a>
            <a className="hero-secondary" href="#how">See how it works <ChevronRight size={17}/></a>
          </div>
          <div className="marketing-proof">
            <span><CheckCircle2 size={15}/> Your account, cash and limits</span>
            <span><CheckCircle2 size={15}/> Plain-English decisions</span>
            <span><CheckCircle2 size={15}/> Simulation until live access is authorized</span>
          </div>
        </div>

        <div className="bot-preview" aria-label="FomoCloud product preview">
          <div className="preview-label">PRODUCT PREVIEW · EXAMPLE ACCOUNT</div>
          <div className="bot-preview-top">
            <div className="bot-preview-brand"><span className="brandmark small">∞</span><div><b>FomoCloud</b><small>Watching your traders 24/7</small></div></div>
            <span className="monitoring"><i/> Monitoring</span>
          </div>
          <div className="bot-brain"><div className="brain-ring one"/><div className="brain-ring two"/><Sparkles size={34}/></div>
          <h2>Every wallet move gets checked.</h2>
          <p>Six example traders followed · every decision remains personal to the account.</p>
          <div className="bot-settings">
            <div><span>Per trade</span><b>$500</b></div>
            <div><span>Fresh meme chase</span><b>Adaptive</b></div>
            <div><span>Profit management</span><b>Smart partials + runner</b></div>
            <div><span>Status</span><b className="positive">Monitoring</b></div>
          </div>
          <div className="bot-preview-foot"><Play size={14}/> Example of how the private app presents account controls</div>
        </div>
      </section>

      <section id="how" className="marketing-section how-section">
        <div className="marketing-title">
          <span>HOW IT WORKS</span>
          <h2>Follow people. Keep control.</h2>
          <p>The trader creates the signal. FomoCloud checks it. Your account makes its own decision.</p>
        </div>
        <div className="how-rail">{howSteps.map(([number,title,copy,Icon])=><article key={title}>
          <div className="how-icon"><Icon size={19}/></div><span>{number}</span><h3>{title}</h3><p>{copy}</p>
        </article>)}</div>
        <div className="thinking-strip">
          <span>WHAT FOMOCLOUD CHECKS</span>
          <div>{["Execution move","Liquidity","Momentum","Volume","Risk","Market behavior","Your settings"].map(x=><b key={x}><Check size={12}/>{x}</b>)}</div>
        </div>
      </section>

      <section id="product" className="marketing-section product-story">
        <div className="marketing-title">
          <span>PRODUCT WALKTHROUGH · EXAMPLES</span>
          <h2>What the bot did — in plain English.</h2>
          <p>These examples explain the product. They are not presented as live platform trades or performance.</p>
        </div>
        <div className="example-activity">{activityExamples.map(({icon:Icon,tone,title,steps,status})=><article key={title}>
          <div className={`example-icon ${tone}`}><Icon size={18}/></div>
          <div className="example-copy"><b>{title}</b>{steps.map(step=><span key={step}>{step}</span>)}</div>
          <strong>{status}</strong>
        </article>)}</div>
      </section>

      <section className="runner-section">
        <div className="runner-intro">
          <span>HOW PROFITS WORK</span>
          <h2>Take profit. Keep a piece for the crazy move.</h2>
          <p>FomoCloud can secure profit in stages while a remaining runner stays open. There is no arbitrary final upside cap.</p>
          <div className="runner-note"><TrendingUp size={18}/><p>If volume, liquidity, momentum and market behavior remain healthy, the runner can continue. If conditions weaken, FomoCloud can protect more of the position.</p></div>
        </div>
        <div className="profit-ladder">
          <div><span>+100%</span><b>Take some profit</b><small>Secure the first win</small></div><i/>
          <div><span>+150%</span><b>Take some more</b><small>Reduce risk, keep upside</small></div><i/>
          <div><span>+200%</span><b>Protect the win</b><small>The runner remains</small></div><i/>
          <div className="moon-step"><span>+5000%?</span><b>Still strong?</b><small>Let the runner work</small></div>
        </div>
      </section>

      <section className="mobile-marketing">
        <div className="mobile-copy">
          <span>MOBILE APP</span>
          <h2>FomoCloud for iPhone &amp; Android</h2>
          <strong>COMING SOON</strong>
          <p>Native App Store and Google Play releases are planned. Today, install the FomoCloud PWA from your browser for an app-like full-screen experience.</p>
          <div className="pwa-benefits">
            <span><CheckCircle2 size={14}/> Opens full screen</span>
            <span><CheckCircle2 size={14}/> Has its own Home Screen icon</span>
            <span><CheckCircle2 size={14}/> Supports push where available</span>
          </div>
          <div className="store-soon"><span><Smartphone size={17}/> iPhone · Coming soon</span><span><Smartphone size={17}/> Android · Coming soon</span></div>
        </div>
        <div className="phone-stage" aria-label="FomoCloud mobile app preview">
          <div className="phone phone-back"><div className="phone-island"/><div className="phone-screen"><span className="brandmark small">∞</span><small>RECENT ACTIVITY</small><b>Profit secured.</b><p>The runner is still working.</p><div className="phone-line"/><div className="phone-line short"/></div></div>
          <div className="phone phone-front"><div className="phone-island"/><div className="phone-screen"><div className="phone-head"><span className="brandmark small">∞</span><Bell size={16}/></div><small>TOTAL ACCOUNT VALUE</small><b className="phone-balance">$0.00</b><span className="phone-change">A clean account starts at zero</span><div className="phone-card"><small>AUTO COPY</small><b>Ready when you are</b></div><div className="phone-card"><small>POSITIONS</small><b>No positions yet</b></div></div></div>
        </div>
      </section>

      <section id="security" className="marketing-security">
        <div className="security-icon"><ShieldCheck size={31}/></div>
        <div><span>SECURITY BY DESIGN</span><h2>Login is not trading permission.</h2><p>Your account, wallet ownership and unattended trading authorization are separate. Live automatic execution remains off until the platform has a reviewed permission path with explicit limits and revocation.</p></div>
        <a href="/signup/">Create my account <ArrowRight size={16}/></a>
      </section>

      <section className="marketing-final">
        <LineChart size={31}/><span>YOUR PRIVATE TRADING WORKSPACE</span><h2>Follow the move.<br/>Understand every decision.</h2><p>Start with a clean account. No fake balance, no fake P&amp;L, and no shared public portfolio.</p><a className="hero-primary" href="/signup/">Start trading <ArrowRight size={17}/></a>
      </section>

      <footer className="marketing-footer">
        <div className="brand"><span className="brandmark small">∞</span><b>FomoCloud</b></div>
        <span>24/7 monitoring · Personal account decisions · Simulation safeguards</span>
        <span><WalletCards size={14}/> Your account stays yours</span>
      </footer>
    </div>
  </main>;
}
