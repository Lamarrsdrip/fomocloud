import {Contract,Interface,WebSocketProvider,formatUnits,id} from "ethers";
import {db,type Chain} from "@memecloud/db";
import {getConfig} from "@memecloud/config";
import {startHeartbeat} from "@memecloud/ops";
import {walletTier} from "@memecloud/brain";

const PAIR_ABI=["function token0() view returns(address)","function token1() view returns(address)"];
const ERC20_ABI=["function decimals() view returns(uint8)","function balanceOf(address) view returns(uint256)","function symbol() view returns(string)"];
const swapIface=new Interface(["event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)"]);
const SWAP_TOPIC=id("Swap(address,uint256,uint256,uint256,uint256,address)");
const defaults:any={
  BNB:{native:"0xBB4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",stables:["0x55d398326f99059fF775485246999027B3197955","0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"]},
  ETHEREUM:{native:"0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",stables:["0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","0xdAC17F958D2ee523a2206206994597C13D831ec7"]}
};
let config=await getConfig<any>("brain");
// Real bug found by audit, same class already fixed in market-worker/paper-worker/executor/exits/
// flow-worker this session: config was read once at process startup and cached forever. An Admin
// change to profileTradeUsd (the wallet-profiling USD threshold) or bnbUsd/ethUsd (native-token USD
// price, used to value every native-token-denominated swap) silently had no effect until someone
// manually restarted this service -- worse than most instances of this bug, since a stale native
// price doesn't just fail to apply a new setting, it keeps mispricing every observed swap
// indefinitely as the real market price drifts. RPC endpoint changes (bnbWs/ethWs) still require a
// restart -- switching those live means tearing down and recreating the WebSocketProvider itself,
// out of scope for this pass since this worker has no BNB_RPC_WS/ETH_RPC_WS configured in
// production right now (verified idle) and reconnect/watchdog hardening is a larger, separate piece
// of work matching flow-worker's SOL-side sophistication.
setInterval(()=>void getConfig<any>("brain").then(c=>{config=c}).catch(e=>console.error("[evm-flow-worker] config reload failed, keeping previous",e)),5*60_000);
const chains=([
  {chain:"BNB",ws:config?.bnbWs||process.env.BNB_RPC_WS},
  {chain:"ETHEREUM",ws:config?.ethWs||process.env.ETH_RPC_WS}
] as {chain:Chain;ws?:string}[]).filter(x=>x.ws);
let logs=0,saved=0,profiled=0,errors=0;const meta=new Map<string,{token0:string;token1:string;d0:number;d1:number}>();
async function pairMeta(provider:WebSocketProvider,address:string){const k=address.toLowerCase();if(meta.has(k))return meta.get(k)!;const p=new Contract(address,PAIR_ABI,provider),[t0,t1]=await Promise.all([p.token0(),p.token1()]);const [d0,d1]=await Promise.all([new Contract(t0,ERC20_ABI,provider).decimals(),new Contract(t1,ERC20_ABI,provider).decimals()]);const m={token0:String(t0),token1:String(t1),d0:Number(d0),d1:Number(d1)};meta.set(k,m);return m}
async function balanceUsd(provider:WebSocketProvider,chain:Chain,address:string,nativeUsd:number){let usd=0;try{usd+=Number(formatUnits(await provider.getBalance(address),18))*nativeUsd}catch{};for(const stable of defaults[chain]?.stables??[])try{const c=new Contract(stable,ERC20_ABI,provider),d=Number(await c.decimals()),b=await c.balanceOf(address);usd+=Number(formatUnits(b,d))}catch{};return usd}
function isQuote(chain:Chain,a:string){const d=defaults[chain];return a.toLowerCase()===d.native.toLowerCase()||d.stables.some((x:string)=>x.toLowerCase()===a.toLowerCase())}
async function start(chain:Chain,ws:string){const provider=new WebSocketProvider(ws),d=defaults[chain];provider.on({topics:[SWAP_TOPIC]},async(log:any)=>{logs++;try{const nativeUsd=Number((chain==="BNB"?config?.bnbUsd:config?.ethUsd)??0);const pm=await pairMeta(provider,log.address),parsed=swapIface.parseLog(log);if(!parsed)return;const a0in=BigInt(parsed.args.amount0In),a1in=BigInt(parsed.args.amount1In),a0out=BigInt(parsed.args.amount0Out),a1out=BigInt(parsed.args.amount1Out);let side:"BUY"|"SELL"|null=null,mint="",quoteToken="",quoteRaw=0n,quoteDec=18;if(isQuote(chain,pm.token0)&&!isQuote(chain,pm.token1)){mint=pm.token1;quoteToken=pm.token0;quoteDec=pm.d0;if(a0in>0n&&a1out>0n){side="BUY";quoteRaw=a0in}else if(a0out>0n&&a1in>0n){side="SELL";quoteRaw=a0out}}else if(isQuote(chain,pm.token1)&&!isQuote(chain,pm.token0)){mint=pm.token0;quoteToken=pm.token1;quoteDec=pm.d1;if(a1in>0n&&a0out>0n){side="BUY";quoteRaw=a1in}else if(a1out>0n&&a0in>0n){side="SELL";quoteRaw=a1out}}if(!side)return;const tx=await provider.getTransaction(log.transactionHash),wallet=tx?.from;if(!wallet)return;let amountUsd:number|undefined;const q=Number(formatUnits(quoteRaw,quoteDec));if(d.stables.some((x:string)=>x.toLowerCase()===quoteToken.toLowerCase()))amountUsd=q;else if(quoteToken.toLowerCase()===d.native.toLowerCase()&&nativeUsd>0)amountUsd=q*nativeUsd;const known=Boolean(await db.traderWallet.findUnique({where:{chain_address:{chain,address:wallet}}})||await db.smartWalletCandidate.findUnique({where:{chain_address:{chain,address:wallet}}}));let bal:number|undefined,tier="FLOW";if((amountUsd??0)>=Number(config?.profileTradeUsd??5000)||known){bal=await balanceUsd(provider,chain,wallet,nativeUsd);tier=walletTier(bal);profiled++;if((bal??0)>=50_000&&!known)await db.smartWalletCandidate.upsert({where:{chain_address:{chain,address:wallet}},create:{chain,address:wallet,stage:"DISCOVERED",source:"ONCHAIN_FLOW",sourceToken:mint,label:tier,metadata:{conservativeLiquidBalanceUsd:bal,discoveredBy:"EVM_SWAP_LOG"} as any},update:{source:"ONCHAIN_FLOW",sourceToken:mint,label:tier}}).catch(()=>{})}await db.chainFlowObservation.create({data:{chain,mint,walletAddress:wallet,txHash:log.transactionHash,side,amountUsd,walletBalanceUsd:bal,walletTier:tier,knownWallet:known,source:"EVM_V2_SWAP_LOG",observedAt:new Date()}}).then(()=>saved++).catch(()=>{})}catch(e){errors++;console.error(`[evm-flow:${chain}]`,e)}});console.log(`[evm-flow] ${chain} online`)}
for(const c of chains)void start(c.chain,c.ws!).catch(e=>{errors++;console.error(e)});
startHeartbeat("evm-flow-scanner",()=>({chains:chains.map(x=>x.chain),logs,saved,profiled,errors,pairCache:meta.size}));
// Keep the process alive as an idle Windows/NSSM service when no BNB/ETH RPC is configured yet;
// the heartbeat timer alone is unref'd and would let Node exit with nothing else open.
setInterval(()=>{},60_000);
console.log(chains.length?"[evm-flow-worker] started":"[evm-flow-worker] idle: no BNB_RPC_WS/ETH_RPC_WS configured");
