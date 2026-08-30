import type { ChainIngestionStatus } from "@memecloud/db";

export const FLOW_INGESTION_ATTEMPTS=8;
export const FLOW_PROCESSING_STALE_MS=120_000;

export function shouldQueue(status:ChainIngestionStatus):boolean{
  return ["SEEN","QUEUED","RETRYING"].includes(status);
}

export function shouldRecoverProcessing(status:ChainIngestionStatus,processingAt:Date|undefined|null,now=Date.now()):boolean{
  if(status!=="PROCESSING"||!processingAt)return false;
  return now-processingAt.getTime()>FLOW_PROCESSING_STALE_MS;
}

export function terminalAfterFailure(attemptsMade:number,configuredAttempts=FLOW_INGESTION_ATTEMPTS):boolean{
  return attemptsMade>=configuredAttempts;
}
