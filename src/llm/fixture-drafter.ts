import type {
  ActionKind,
  Claim,
  DraftContent,
  NormalizedFact,
  Role,
  RoleSnapshot,
} from "@/domain/types";
import { formatCents } from "@/domain/money";
import { formatUtc, sameUtcDay } from "@/domain/time";
import type { Drafter, DrafterFailure, DrafterResult } from "./drafter";

/**
 * Deterministic template drafter used in fixture mode and as the labelled fallback when a
 * live model run fails. Its output is labelled "Template — no model call" and is never
 * reported as a model response.
 */
export class FixtureDrafter implements Drafter {
  readonly kind = "fixture_template" as const;
  readonly label = "Template — no model call";

  async draft(input: {
    snapshot: RoleSnapshot;
    action: ActionKind;
    role: Role;
    attachmentEvidenceIds: string[];
  }): Promise<DrafterResult | DrafterFailure> {
    const content = buildTemplateDraft(
      input.snapshot,
      input.action,
      input.role,
      input.attachmentEvidenceIds,
    );
    return {
      ok: true,
      content,
      origin: "fixture_template",
      calls: 0,
      notes: [
        "Deterministic template drafted from the role-filtered snapshot; no model was called.",
      ],
    };
  }
}

/** How the letter names the basis of the effective time, in place of the raw basis label. */
function basisPhrase(basisText: string): string {
  if (basisText.startsWith("merchant confirmation document"))
    return " according to the confirmation I kept";
  if (basisText.startsWith("provider API observation"))
    return " according to the subscription record";
  if (basisText.startsWith("user attestation")) return " according to my own record";
  return "";
}

/** A day in words, in UTC: "Nov 10, 2026". */
function day(iso: string | null): string {
  return formatUtc(iso) ?? "an unknown date";
}

function find(snapshot: RoleSnapshot, kind: NormalizedFact["kind"]): NormalizedFact | null {
  return snapshot.facts.find((f) => f.kind === kind) ?? null;
}

/** The context line of a refund request sent to the merchant before any PayPal case exists. */
export const MERCHANT_FIRST_CONTEXT = "I am contacting you first, before opening a PayPal dispute.";

export function buildTemplateDraft(
  snapshot: RoleSnapshot,
  action: ActionKind,
  role: Role,
  attachmentEvidenceIds: string[],
): DraftContent {
  const cancelReq = find(snapshot, "cancellation_request");
  const cancelEff = find(snapshot, "cancellation_effective");
  const charge = find(snapshot, "charge");
  const refund = find(snapshot, "refund");
  const period = find(snapshot, "service_period");
  const providerCase = find(snapshot, "provider_case");
  // When the cancellation took effect on the same UTC day as the charge, the day alone does not
  // show which came first, so those two sentences also give the time.
  const sameDay = Boolean(cancelEff && charge && sameUtcDay(cancelEff.at, charge.at));
  const when = (iso: string | null): string =>
    (sameDay ? formatUtc(iso, { time: true }) : formatUtc(iso)) ?? "an unknown date";
  const claims: Claim[] = [];
  let n = 0;
  const claim = (kind: Claim["kind"], text: string, facts: (NormalizedFact | null)[]): void => {
    const present = facts.filter((f): f is NormalizedFact => f !== null);
    claims.push({
      id: `c${++n}`,
      kind,
      text,
      sourceIds: Array.from(new Set(present.flatMap((f) => f.sourceIds))),
      factIds: present.map((f) => f.id),
    });
  };

  const amount = snapshot.requestedCents ?? snapshot.claimableCents;
  const amountText = amount !== null ? formatCents(amount).replace(" USD", "") : null;
  const chargeAmountText =
    charge?.cents !== null && charge?.cents !== undefined
      ? formatCents(charge.cents).replace(" USD", "")
      : null;

  if (action === "export_refund_request" || action === "buyer_create_dispute") {
    if (cancelReq) {
      claim("fact", `I requested cancellation of this subscription on ${day(cancelReq.at)}.`, [
        cancelReq,
      ]);
    }
    if (cancelEff) {
      claim(
        "fact",
        `The cancellation became effective on ${when(cancelEff.at)}${basisPhrase(cancelEff.text)}.`,
        [cancelEff],
      );
    } else {
      claim(
        "unknown",
        "I do not have a confirmed effective cancellation time on record; this request is based on the facts listed below.",
        [],
      );
    }
    if (charge) {
      claim(
        "fact",
        `A charge of ${chargeAmountText ?? "an amount I cannot confirm"} was completed on ${when(charge.at)}, which is after the effective cancellation time.`,
        [charge, period],
      );
    }
    if (refund && refund.cents) {
      claim(
        "fact",
        `A refund of ${formatCents(refund.cents).replace(" USD", "")} has already been recorded and is deducted from this request.`,
        [refund],
      );
    }
    // A letter to the merchant says where it stands; nothing is claimed about replies that the
    // case does not record.
    if (
      action === "export_refund_request" &&
      snapshot.channel === "merchant_refund" &&
      !providerCase
    ) {
      claim("context", MERCHANT_FIRST_CONTEXT, []);
    }
    claim(
      "request",
      amountText
        ? `I am requesting a refund of ${amountText} to the original payment method.`
        : "I am requesting a review of this charge; the refundable amount could not be determined from the facts on file.",
      [],
    );
  } else if (action === "merchant_provide_evidence") {
    claim(
      "context",
      "This response summarizes the merchant's records for the disputed subscription charge.",
      [],
    );
    if (cancelReq)
      claim("fact", `Our records show a cancellation request dated ${day(cancelReq.at)}.`, [
        cancelReq,
      ]);
    if (cancelEff)
      claim("fact", `The cancellation is recorded as effective on ${when(cancelEff.at)}.`, [
        cancelEff,
      ]);
    if (charge) {
      claim(
        "fact",
        `A charge of ${chargeAmountText ?? "an undetermined amount"} was initiated on ${when(charge.at)}.`,
        [charge, period],
      );
    }
    if (refund && refund.cents)
      claim(
        "fact",
        `A refund of ${formatCents(refund.cents).replace(" USD", "")} has been issued.`,
        [refund],
      );
    if (providerCase)
      claim("context", `This response is submitted for the ${providerCase.text}.`, [providerCase]);
    // Mention attached records only when the response carries files.
    claim(
      "request",
      attachmentEvidenceIds.length > 0
        ? "We ask the reviewer to consider the attached records when evaluating the claim."
        : "We ask the reviewer to consider these records when evaluating the claim.",
      [],
    );
  } else {
    claim("context", "No draft template exists for this action.", []);
  }

  // A subscription can have cancellation facts recorded after this charge, and a case may
  // concern another reason. The subject identifies the response without judging the dispute.
  const subject =
    action === "merchant_provide_evidence"
      ? "Merchant response: disputed subscription charge"
      : "Refund request: charge after subscription cancellation";

  // The buyer case-creation request carries no files; attachments belong to evidence submissions.
  return {
    action,
    role,
    subject,
    claims,
    attachmentEvidenceIds: action === "buyer_create_dispute" ? [] : attachmentEvidenceIds,
  };
}
