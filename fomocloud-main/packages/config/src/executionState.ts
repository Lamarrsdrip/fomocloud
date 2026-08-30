export type ExecutionStatus =
  | "SIMULATION"
  | "READY_FOR_LIVE"
  | "LIVE_BLOCKED"
  | "LIVE"
  | "PAUSED"
  | "DEGRADED";

export type QualifiedSignalAction = "SIMULATION" | "LIVE_TRANSACTION" | "BLOCKED";

export type ExecutionBlocker = {
  code: string;
  source: "ENVIRONMENT" | "DATABASE" | "RISK" | "RPC" | "SCANNER" | "ROUTER" | "SIGNER" | "WALLET" | "WORKER";
  message: string;
};

export type ExecutionStateInput = {
  liveTradingRequested: boolean;
  environmentMode?: string | null;
  emergencyPaused: boolean;
  rpcCredentialsVerified: boolean;
  rpcOperational: boolean;
  chainDataFresh: boolean;
  scannerDegraded: boolean;
  jupiterVerified: boolean;
  jupiterOperational: boolean;
  signerConfigured: boolean;
  signerVerified: boolean;
  signerOperational: boolean;
  activeDelegatedWallets: number;
  requiredWorkersHealthy: boolean;
  openLivePositions: number;
};

/**
 * The single execution-state truth table. Every caller that can construct a trade uses the
 * resulting nextQualifiedSignalAction; UI/API callers render the exact same fields.
 */
export function resolveExecutionState(input: ExecutionStateInput) {
  const environmentMode = String(input.environmentMode ?? "simulation").toUpperCase() === "LIVE"
    ? "LIVE" as const
    : "SIMULATION" as const;
  const requestedMode = input.liveTradingRequested ? "LIVE" as const : "SIMULATION" as const;
  const blockers: ExecutionBlocker[] = [];
  const add = (code: string, source: ExecutionBlocker["source"], message: string) => blockers.push({ code, source, message });

  if (environmentMode !== "LIVE") add("EXECUTION_RUNTIME_SIMULATION", "ENVIRONMENT", "The executor VPS safety gate is SIMULATION (EXECUTION_MODE), so it cannot construct a live transaction.");
  if (input.emergencyPaused) add("KILL_SWITCH_ACTIVE", "RISK", "The emergency new-entry kill switch is active.");
  if (!input.rpcCredentialsVerified) add("RPC_NOT_VERIFIED", "RPC", "No configured Solana RPC has a current, matching credential verification.");
  else if (!input.rpcOperational) add("RPC_DEGRADED", "RPC", "The configured Solana execution RPC is not operational now (for example, rate-limited or unavailable).");
  if (!input.chainDataFresh) add("SCANNER_STALE", "SCANNER", "The scanner has not persisted a fresh real Solana observation within the readiness window.");
  if (input.scannerDegraded) add("SCANNER_DEGRADED", "SCANNER", "The Solana scanner reports degraded progress (rate limiting, disabled flow, or stale successful RPC work).");
  if (!input.jupiterVerified) add("JUPITER_NOT_VERIFIED", "ROUTER", "Jupiter has no current verification matching the saved configuration.");
  else if (!input.jupiterOperational) add("JUPITER_DEGRADED", "ROUTER", "Jupiter routing is not operational now.");
  if (!input.signerConfigured) add("SIGNER_UNAVAILABLE", "SIGNER", "The executor does not have a complete delegated signer configuration loaded.");
  else if (!input.signerVerified) add("SIGNER_NOT_VERIFIED", "SIGNER", "The delegated signer has no current verification matching the saved configuration.");
  else if (!input.signerOperational) add("SIGNER_DEGRADED", "SIGNER", "The delegated signer is not operational now.");
  if (input.activeDelegatedWallets < 1) add("NO_AUTHORIZED_WALLET", "WALLET", "No Solana wallet has a currently active delegated trading authorization.");
  if (!input.requiredWorkersHealthy) add("EXECUTION_WORKER_UNHEALTHY", "WORKER", "One or more required execution/data workers are not sending a fresh heartbeat.");

  const readyForLive = blockers.length === 0;
  const newEntriesLive = input.liveTradingRequested && readyForLive;
  const actualRuntimeMode = newEntriesLive ? "LIVE" as const : "SIMULATION" as const;
  const nextQualifiedSignalAction: QualifiedSignalAction = input.emergencyPaused
    ? "BLOCKED"
    : environmentMode === "SIMULATION"
      ? "SIMULATION"
      : newEntriesLive
        ? "LIVE_TRANSACTION"
        : "BLOCKED";
  const hasOperationalDegradation = blockers.some(b => b.source !== "ENVIRONMENT");
  const status: ExecutionStatus = input.emergencyPaused
    ? "PAUSED"
    : input.liveTradingRequested
      ? (newEntriesLive ? "LIVE" : "LIVE_BLOCKED")
      : readyForLive
        ? "READY_FOR_LIVE"
        : hasOperationalDegradation
          ? "DEGRADED"
          : "SIMULATION";

  return {
    requestedMode,
    environmentMode,
    actualRuntimeMode,
    status,
    readiness: readyForLive ? "READY" as const : input.emergencyPaused ? "PAUSED" as const : hasOperationalDegradation ? "DEGRADED" as const : "BLOCKED" as const,
    readyForLive,
    newEntriesLive,
    nextQualifiedSignalAction,
    blockers,
    reasons: blockers.map(b => b.message),
    openLivePositions: input.openLivePositions
  };
}
