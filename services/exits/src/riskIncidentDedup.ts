export function unresolvedRiskIncidentWhere(
  positionId: string,
  code: string,
  since: Date
) {
  return {
    positionId,
    code,
    resolvedAt: { isSet: false as const },
    createdAt: { gte: since }
  };
}
