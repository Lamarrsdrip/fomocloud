import {Contract,Interface,WebSocketProvider,formatUnits,id} from "ethers";
import {db,type Chain} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {walletTier} from "@memecloud/brain";
import {EVM_DEFAULTS as defaults,isQuote,classifySwapSide,quoteAmountUsd} from "./classify.js";

const PAIR_ABI=["function token0() view returns(address)","function token1() view returns(address)"];
const ERC20_ABI=["function decimals() view returns(uint8)","function balanceOf(address) view returns(uint256)","function symbol() view returns(string)"];
const swapIface=new Interface(["event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)"]);
const SWAP_TOPIC=id("Swap(address,uint256,uint256,uint256,uint256,address)");
let config=await getConfig<any>("brain");
// Real bug found by audit, same class already fixed in market-worker/paper-worker/executor/exits/
// flow-worker this session: config was read once at process startup and cached forever. An Admin
// change to profileTradeUsd (the wallet-profiling USD threshold) or bnbUsd/ethUsd (native-token USD
// price, used to value every native-token-denominated swap) silently had no effect until someone
// manually restarted this service -- worse than most instances of this bug, since a stale native
// price doesn't just fail to apply a new setting, it keeps mispricing every observed swap
// indefinitely as the real market price drifts. RPC endpoint changes (bnbWs/ethWs) still require a
// restart -- switching those live means tearing down and recreating the WebSocketProvider itself.
// Reconnect/watchdog hardening (previously deferred here) is now implemented below, matching
// flow-worker's SOL-side pattern: a silence-based watchdog tears down and reconnects a chain whose
// subscription goes quiet for too long.
setInterval(()=>void getConfig<any>("brain").then(c=>{config=c}).catch(e=>console.error("[evm-flow-worker] config reload failed, keeping previous",e)),5*60_000);
const chains=([
  {chain:"BNB",ws:config?.bnbWs||process.env.BNB_RPC_WS},
  {chain:"ETHEREUM",ws:config?.ethWs||process.env.ETH_RPC_WS}
] as {chain:Chain;ws?:string}[]).filter(x=>x.ws);
let logs=0,saved=0,profiled=0,errors=0,reconnects=0;const meta=new Map<string,{token0:string;token1:string;d0:number;d1:number}>();
// Real gap found by forensic audit, explicitly deferred by name in the comment above when this
// worker was first written ("reconnect/watchdog hardening is a larger, separate piece of work
// matching flow-worker's SOL-side sophistication"). Currently harmless in production only because
// BNB_RPC_WS/ETH_RPC_WS are unset -- the moment either is configured, a single WebSocket drop would
// otherwise silently kill that chain's entire flow ingestion forever with no self-healing. Mirrors
// services/flow-worker's proven pattern exactly: track last-event freshness per chain, and a
// silence-based watchdog (not provider-internal error/close events, which ethers v6's
// WebSocketProvider does not expose in a stable cross-version way) tears down and reconnects a
// chain whose subscription has gone quiet for too long.
const providers=new Map<Chain,WebSocketProvider>();
const lastEventAt=new Map<Chain,number>();
async function pairMeta(provider:WebSocketProvider,address:string){const k=address.toLowerCase();if(meta.has(k))return meta.get(k)!;const p=new Contract(address,PAIR_ABI,provider),[t0,t1]=await Promise.all([p.token0(),p.token1()]);const [d0,d1]=await Promise.all([new Contract(t0,ERC20_ABI,provider).decimals(),new Contract(t1,ERC20_ABI,provider).decimals()]);const m={token0:String(t0),token1:String(t1),d0:Number(d0),d1:Number(d1)};meta.set(k,m);return m}
async function balanceUsd(provider:WebSocketProvider,chain:Chain,address:string,nativeUsd:number){let usd=0;try{usd+=Number(formatUnits(await provider.getBalance(address),18))*nativeUsd}catch{};for(const stable of defaults[chain]?.stables??[])try{const c=new Contract(stable,ERC20_ABI,provider),d=Number(await c.decimals()),b=await c.balanceOf(address);usd+=Number(formatUnits(b,d))}catch{};return usd}
async function connectAndSubscribe(chain:Chain,ws:string){
  const provider=new WebSocketProvider(ws);
  providers.set(chain,provider);
  lastEventAt.set(chain,Date.now());
  provider.on({topics:[SWAP_TOPIC]},async(log:any)=>{
    logs++;
    // Update freshness on any received event, even one this worker ultimately ignores below --
    // the watchdog cares whether the subscription itself is alive, not whether every log parses
    // into a trade (same discipline as flow-worker's lastEventAt).
    lastEventAt.set(chain,Date.now());
    try{
      const nativeUsd=Number((chain==="BNB"?config?.bnbUsd:config?.ethUsd)??0);
      const pm=await pairMeta(provider,log.address),parsed=swapIface.parseLog(log);
      if(!parsed)return;
      const a0in=BigInt(parsed.args.amount0In),a1in=BigInt(parsed.args.amount1In),a0out=BigInt(parsed.args.amount0Out),a1out=BigInt(parsed.args.amount1Out);
      const classified=classifySwapSide(chain,pm,a0in,a1in,a0out,a1out);
      if(!classified)return;
      const {side,mint,quoteToken,quoteRaw,quoteDec}=classified;
      const tx=await provider.getTransaction(log.transactionHash),wallet=tx?.from;
      if(!wallet)return;
      const amountUsd=quoteAmountUsd(chain,quoteToken,Number(formatUnits(quoteRaw,quoteDec)),nativeUsd);
      const known=Boolean(await db.traderWallet.findUnique({where:{chain_address:{chain,address:wallet}}})||await db.smartWalletCandidate.findUnique({where:{chain_address:{chain,address:wallet}}}));
      let bal:number|undefined,tier="FLOW";
      if((amountUsd??0)>=Number(config?.profileTradeUsd??5000)||known){
        bal=await balanceUsd(provider,chain,wallet,nativeUsd);
        tier=walletTier(bal);
        profiled++;
        if((bal??0)>=50_000&&!known)await db.smartWalletCandidate.upsert({where:{chain_address:{chain,address:wallet}},create:{chain,address:wallet,stage:"DISCOVERED",source:"ONCHAIN_FLOW",sourceToken:mint,label:tier,metadata:{conservativeLiquidBalanceUsd:bal,discoveredBy:"EVM_SWAP_LOG"} as any},update:{source:"ONCHAIN_FLOW",sourceToken:mint,label:tier}}).catch(()=>{})
      }
      await db.chainFlowObservation.create({data:{chain,mint,walletAddress:wallet,txHash:log.transactionHash,side,amountUsd,walletBalanceUsd:bal,walletTier:tier,knownWallet:known,source:"EVM_V2_SWAP_LOG",observedAt:new Date()}}).then(()=>saved++).catch(()=>{})
    }catch(e){errors++;console.error(`[evm-flow:${chain}]`,e)}
  });
  console.log(`[evm-flow] ${chain} online`);
}
async function reconnect(chain:Chain,ws:string){
  reconnects++;
  const old=providers.get(chain);
  try{old?.removeAllListeners();await old?.destroy()}catch(e){console.warn(`[evm-flow:${chain}] error tearing down stale provider`,e)}
  try{
    await connectAndSubscribe(chain,ws);
  }catch(e){
    errors++;console.error(`[evm-flow:${chain}] reconnect failed`,e);
    lastEventAt.set(chain,Date.now()-60_000); // retry again in 30s rather than waiting a full 90s
  }
}
async function watchdog(){
  for(const c of chains){
    const last=lastEventAt.get(c.chain);if(last===undefined)continue; // not connected yet
    const silentMs=Date.now()-last;
    // Same 90s threshold and rationale as flow-worker: real swap volume on any chain this worker
    // targets is high enough that a live subscription sees SOME event well within that window.
    if(silentMs>90_000){
      console.warn(`[evm-flow:${c.chain}] no events for ${Math.round(silentMs/1000)}s — reconnecting (reconnect #${reconnects+1})`);
      await reconnect(c.chain,c.ws!);
    }
  }
}
for(const c of chains)void connectAndSubscribe(c.chain,c.ws!).catch(e=>{errors++;console.error(e)});
setInterval(()=>void watchdog(),15_000);
startHeartbeat("evm-flow-scanner",()=>({chains:chains.map(x=>x.chain),logs,saved,profiled,errors,reconnects,pairCache:meta.size,silentForSec:Object.fromEntries([...lastEventAt.entries()].map(([c,t])=>[c,Math.round((Date.now()-t)/1000)]))}));
// Keep the process alive as an idle Windows/NSSM service when no BNB/ETH RPC is configured yet;
// the heartbeat timer alone is unref'd and would let Node exit with nothing else open.
setInterval(()=>{},60_000);
console.log(chains.length?"[evm-flow-worker] started":"[evm-flow-worker] idle: no BNB_RPC_WS/ETH_RPC_WS configured");
