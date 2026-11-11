import type { ActionKind, Channel } from "./types";
import { CONNECTED_CHANNELS } from "./types";

/**
 * Channel and recovery-claim rules.
 *
 * One charge has at most one *active* financial recovery claim across channels.
 * Drafting or exporting a merchant refund request is not a claim: nothing has been sent.
 * Escalating to PayPal is a deliberate transfer with a reason and a new review.
 */

export interface ClaimRecord {
  caseId: string;
  chargeId: string;
  channel: Channel;
  /** True once a submission has actually been dispatched (or is in flight) on this channel */
  active: boolean;
  closedReason: string | null;
}

export type ClaimDecision =
  | { allowed: true }
  | { allowed: false; code: "CONCURRENT_CLAIM_BLOCKED" | "CHANNEL_NOT_CONNECTED"; message: string };

export function canOpenActiveClaim(
  existing: ClaimRecord[],
  chargeId: string,
  channel: Channel,
): ClaimDecision {
  const active = existing.filter((c) => c.chargeId === chargeId && c.active);
  const conflicting = active.find((c) => c.channel !== channel);
  if (conflicting) {
    return {
      allowed: false,
      code: "CONCURRENT_CLAIM_BLOCKED",
      message: `An active ${conflicting.channel} claim already exists for this charge. Close or transfer it with a reason before opening a ${channel} claim.`,
    };
  }
  return { allowed: true };
}

export function isConnectedChannel(channel: Channel): boolean {
  return CONNECTED_CHANNELS.includes(channel);
}

/** Submission actions that count as opening an active financial claim. */
export function actionOpensClaim(action: ActionKind): boolean {
  return action === "buyer_create_dispute";
}

export interface ChannelBoundary {
  channel: Channel;
  connected: boolean;
  description: string;
}

export function describeChannel(channel: Channel): ChannelBoundary {
  switch (channel) {
    case "merchant_refund":
      return {
        channel,
        connected: false,
        description:
          "A refund request addressed to the merchant. CancelCase drafts and exports it; you send it yourself. Exporting does not submit anything.",
      };
    case "app_store":
      return {
        channel,
        connected: false,
        description:
          "Charges billed through an app store are handled in that store's own refund process. CancelCase exports the facts; it has no store integration.",
      };
    case "paypal":
      return {
        channel,
        connected: true,
        description:
          "A PayPal case. In Sandbox mode CancelCase can prepare an approved request and read the case back. Outcomes are decided by PayPal, not by this application.",
      };
    case "chargeback":
      return {
        channel,
        connected: false,
        description:
          "A card chargeback is filed with your bank or card issuer. CancelCase exports the facts; it has no bank integration.",
      };
    default: {
      const _exhaustive: never = channel;
      return _exhaustive;
    }
  }
}
