"use client";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { InstallAppPrompt } from "../components/InstallAppPrompt";

export default function Landing(){
  return <main className="landing">
    <div className="landing-glow one"/><div className="landing-glow two"/>
    <div className="public-shell">
      <header className="public-header">
        <a className="brand" href="/"><span className="brandmark">M</span><b>MemeCloud</b></a>
        <div className="public-actions"><a className="ghost-link" href="/login/">Sign in</a><a className="primary-link" href="/signup/">Start trading <ArrowRight size={16}/></a></div>
      </header>

      <section className="hero">
        <h1>Catch the move<br/><em>before the crowd.</em></h1>
        <p>MemeCloud watches the chain, follows smart money and trades strong meme momentum automatically.</p>
        <div className="hero-actions"><a className="hero-primary" href="/signup/">Start trading <ArrowRight size={18}/></a><a className="hero-secondary" href="/login/">Sign in</a></div>
        <div className="hero-trust"><span><CheckCircle2 size={15}/> Your own account</span><span><CheckCircle2 size={15}/> Real backend activity</span><span><CheckCircle2 size={15}/> Live funds off until you authorize</span></div>

        <div className="product-preview">
          <div className="preview-side">
            <span className="brandmark small">M</span>
            <i/><i/><i/><i/><i/>
          </div>
          <div className="preview-body">
            <div className="preview-top"><div><small>GLOBAL BRAIN</small><strong>Watching the market</strong></div><span className="preview-status">Live</span></div>
            <div className="preview-feed">
              <span className="feed-dot"/><div><b>Whale wallet entered $TOKEN</b><small>12 large wallets in the last minute</small></div><strong>now</strong>
            </div>
            <div className="preview-feed">
              <span className="feed-dot purple"/><div><b>New opportunity found</b><small>Capital surge · momentum building</small></div><strong>7s</strong>
            </div>
            <div className="preview-feed muted-row">
              <span className="feed-dot"/><div><b>Runner active</b><small>Capital recovered, letting the rest ride</small></div><strong>2m</strong>
            </div>
          </div>
        </div>
      </section>

      <footer className="public-footer"><div className="brand"><span className="brandmark small">M</span><b>MemeCloud</b></div><span>Simulation until you go live</span></footer>
    </div>
    <InstallAppPrompt/>
  </main>
}
