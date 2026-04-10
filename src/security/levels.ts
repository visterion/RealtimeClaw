export type SecurityLevel = 'guest' | 'family' | 'trusted' | 'owner';

export const SECURITY_LEVEL_ORDER: SecurityLevel[] = ['guest', 'family', 'trusted', 'owner'];

export interface SecurityThresholds {
  family: number;
  trusted: number;
  owner: number;
}

const DEFAULT_THRESHOLDS: SecurityThresholds = {
  family: 0.50,
  trusted: 0.70,
  owner: 0.90,
};

/** Map Eagle confidence score to a SecurityLevel */
export function getSecurityLevel(
  confidence: number,
  thresholds: SecurityThresholds = DEFAULT_THRESHOLDS,
): SecurityLevel {
  if (confidence >= thresholds.owner) return 'owner';
  if (confidence >= thresholds.trusted) return 'trusted';
  if (confidence >= thresholds.family) return 'family';
  return 'guest';
}

/** Return the lower of two SecurityLevels */
function minLevel(a: SecurityLevel, b: SecurityLevel): SecurityLevel {
  const ai = SECURITY_LEVEL_ORDER.indexOf(a);
  const bi = SECURITY_LEVEL_ORDER.indexOf(b);
  return ai <= bi ? a : b;
}

/**
 * Compute effective SecurityLevel = min(confidenceLevel, speakerMaxLevel).
 * Unknown or undefined speakers default to 'guest'.
 */
export function getEffectiveLevel(
  confidence: number,
  speakerId: string | undefined,
  speakerMaxLevels: Record<string, SecurityLevel>,
  thresholds?: SecurityThresholds,
): SecurityLevel {
  const confidenceLevel = getSecurityLevel(confidence, thresholds);
  const speakerMax: SecurityLevel =
    (speakerId !== undefined && speakerId !== '' && speakerMaxLevels[speakerId]) || 'guest';
  return minLevel(confidenceLevel, speakerMax);
}
