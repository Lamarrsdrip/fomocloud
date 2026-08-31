import {startHeartbeat} from "@memecloud/ops";
/*
 * X is not a discovery feed. The former worker periodically swept token
 * searches, consuming paid quota even for tokens that had not earned a
 * wallet-first research decision. That request path is removed, not slowed.
 *
 * Social context remains optional. Any future event consumer must make one
 * budgeted, cached lookup only after qualified wallet convergence; it must
 * never perform a recurring token sweep.
 */
const mode="EVENT_ONLY_NO_PERIODIC_X_SEARCH";
startHeartbeat("social-hype",()=>({mode,xReadRequests:0,xWriteRequests:0,optional:true,message:"Periodic X token search disabled; social enrichment awaits a qualified event."}));
console.log("[social-worker] online in event-only mode; no periodic X requests will be made");
