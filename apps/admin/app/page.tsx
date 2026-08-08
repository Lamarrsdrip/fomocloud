"use client";
import { useState } from "react";

const sections = [
  ["Branding","App name, logo, support links and public URLs."],
  ["Chains & Routing","Enable Solana, Base, Ethereum, BNB, Arbitrum, Avalanche, Sui and other adapters."],
  ["Execution","RPCs, aggregators, signer provider and live/simulation controls."],
  ["Market Data","Helius, Birdeye and fallback providers."],
  ["Push Notifications","Built-in Web Push using VAPID keys."],
  ["Email","SMTP configuration, sender identity and test email."],
  ["Broadcasts","Send push/email announcements to users."],
  ["Fees","Transparent execution-fee settings; no subscription required."],
  ["Risk & Meme Intelligence","Global defaults and emergency kill switches."]
];

export default function Admin(){
  const [active,setActive]=useState("Branding");
  return <main>
    <aside>
      <div className="brand"><span>∞</span><b>FomoCloud Admin</b></div>
      <p className="muted">Operations & configuration</p>
      <nav>{sections.map(([n])=><button key={n} className={active===n?"active":""} onClick={()=>setActive(n)}>{n}</button>)}</nav>
    </aside>
    <section className="workspace">
      <header><div><small>ADMIN CONTROL CENTER</small><h1>{active}</h1></div><div className="health"><i/>System healthy</div></header>
      <div className="intro">{sections.find(x=>x[0]===active)?.[1]}</div>

      {active==="Branding" && <Panel title="Public app">
        <Field label="App name" value="FomoCloud"/><Field label="Temporary domain" placeholder="https://your-temp-domain.hostingersite.com"/>
        <Field label="Support email" placeholder="support@yourdomain.com"/>
      </Panel>}

      {active==="Chains & Routing" && <Panel title="Trading networks">
        <Toggle name="Solana" on/><Toggle name="Base" on/><Toggle name="Ethereum" on/><Toggle name="BNB Chain" on/>
        <Toggle name="Arbitrum"/><Toggle name="Avalanche"/><Toggle name="Sui"/>
        <p className="hint">Users see one Trading Cash balance in USD/USDC. FomoCloud routes each trade through the enabled adapter for that chain.</p>
      </Panel>}

      {active==="Execution" && <><Panel title="Trading cash"><Field label="Default cash asset" value="USDC"/><Field label="Execution mode" value="Simulation until live-ready"/></Panel>
      <Panel title="Execution providers"><Field label="Jupiter API key"/><Field label="0x / EVM router key"/><Field label="Signer provider API key"/><Field label="Admin live-enable phrase"/></Panel></>}

      {active==="Market Data" && <Panel title="Market data providers"><Field label="Helius API key"/><Field label="Birdeye API key"/><Field label="Fallback RPC"/><button className="primary">Save & test providers</button></Panel>}

      {active==="Push Notifications" && <Panel title="Built-in browser push">
        <Field label="VAPID public key"/><Field label="VAPID private key"/><Field label="VAPID subject" placeholder="mailto:admin@yourdomain.com"/>
        <p className="hint">No Firebase is required for web push. The app registers its own service worker and stores browser subscriptions.</p>
        <button className="primary">Save & send test push</button>
      </Panel>}

      {active==="Email" && <Panel title="SMTP email">
        <Field label="SMTP host"/><Field label="SMTP port" value="587"/><Field label="SMTP username"/><Field label="SMTP password"/>
        <Field label="From name/email" placeholder="FomoCloud <hello@yourdomain.com>"/>
        <div className="row"><button className="primary">Save email</button><button>Send test email</button></div>
      </Panel>}

      {active==="Broadcasts" && <Panel title="New broadcast">
        <Field label="Title" placeholder="FomoCloud update"/><label>Message<textarea placeholder="Write the message users should receive..."/></label>
        <div className="row"><select><option>Push notification</option><option>Email</option><option>Push + Email</option></select><select><option>All users</option><option>Active traders</option></select></div>
        <button className="primary">Queue broadcast</button>
        <p className="hint">Broadcasts are queued for fan-out so sending to thousands of users does not block the admin request.</p>
      </Panel>}

      {active==="Fees" && <Panel title="Platform fee"><Field label="Execution fee (basis points)" value="0"/><p className="hint">Keep 0 during testing. Production fee must be shown before authorization and on every trade receipt.</p></Panel>}

      {active==="Risk & Meme Intelligence" && <Panel title="Global defaults">
        <Field label="Fresh meme base chase %" value="40"/><Field label="Hyper momentum max chase %" value="55"/>
        <Field label="New token TP1 %" value="100"/><Field label="New token TP2 %" value="150"/><Field label="New token TP3 %" value="200"/>
        <Toggle name="Emergency new-entry kill switch"/>
        <p className="hint">These are defaults. Per-user limits still apply. Only objective catastrophic conditions should hard-block globally.</p>
      </Panel>}
    </section>
  </main>
}
function Panel({title,children}:{title:string,children:any}){return <div className="panel"><h2>{title}</h2>{children}</div>}
function Field({label,value="",placeholder=""}:{label:string,value?:string,placeholder?:string}){return <label>{label}<input defaultValue={value} placeholder={placeholder}/></label>}
function Toggle({name,on=false}:{name:string,on?:boolean}){return <div className="toggle"><span>{name}</span><button className={on?"on":""}><i/></button></div>}
