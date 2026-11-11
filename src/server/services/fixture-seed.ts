import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppContext } from "../context";
import { cases, charges, subscriptions } from "../db/repos";
import type { CaseRecord, ChargeRecord, SubscriptionRecord } from "../records";
import { newId } from "../ids";
import { addAttestation, addEvidence } from "./evidence-store";
import { reconcileCase } from "./case-service";
import { logAudit } from "./audit";
import { initialCancellation, reduceCancellation } from "@/domain/cancellation";
import { sha256Hex } from "@/domain/canonical";
import type { NormalizedFact } from "@/domain/types";

/**
 * Idempotent fixture seed. Reads the committed synthetic fixture directory and creates one
 * subscription, one charge and one case with role-scoped evidence. Every record carries
 * `synthetic` provenance. Running it twice is a no-op.
 */

const factSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "party",
    "subscription",
    "cancellation_request",
    "cancellation_effective",
    "charge",
    "refund",
    "contact",
    "policy",
    "service_period",
    "provider_case",
    "remedy",
  ]),
  label: z.string(),
  at: z.string().nullable(),
  cents: z.number().int().nullable(),
  currency: z.string().nullable(),
  text: z.string(),
});

const providerRefSchema = z.object({
  kind: z.string(),
  value: z.string(),
  provenance: z.literal("synthetic"),
});

const manifestSchema = z.object({
  schema: z.literal("cancelcase.fixture/1"),
  name: z.string(),
  description: z.string(),
  clock: z.string(),
  parties: z.object({
    buyer: z.object({ alias: z.string(), accountAlias: z.string() }),
    merchant: z.object({ alias: z.string() }),
  }),
  subscription: z.object({
    label: z.string(),
    amountCents: z.number().int(),
    currency: z.literal("USD"),
    providerRefs: z.array(providerRefSchema),
    cancellation: z.object({
      requestedAt: z.string(),
      evidence: z.array(z.string()),
    }),
  }),
  demoHints: z.object({
    confirmation: z.object({
      receivedAt: z.string(),
      effectiveAt: z.string(),
      basis: z.enum(["user_attestation", "merchant_confirmation_document"]),
      evidence: z.array(z.string()),
      note: z.string(),
    }),
  }),
  charge: z.object({
    description: z.string(),
    eventTime: z.string(),
    postedTime: z.string(),
    status: z.enum([
      "COMPLETED",
      "PENDING",
      "FAILED",
      "DENIED",
      "REVERSED",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
      "UNKNOWN",
    ]),
    amountCents: z.number().int(),
    currency: z.literal("USD"),
    refundedCents: z.number().int(),
    refundStateKnown: z.boolean(),
    servicePeriodStart: z.string(),
    servicePeriodEnd: z.string(),
    arrearsIndicator: z.boolean(),
    matchMethod: z.enum([
      "explicit_reviewed_association",
      "provider_subscription_transaction",
      "merchant_name_only",
      "none",
    ]),
    providerRefs: z.array(providerRefSchema),
    evidence: z.array(z.string()),
  }),
  evidence: z.array(
    z.object({
      key: z.string(),
      file: z.string(),
      ownerRole: z.enum(["buyer", "merchant"]),
      visibility: z.enum(["private", "shared"]),
      kind: z.enum([
        "receipt",
        "cancellation_confirmation",
        "charge_record",
        "screenshot",
        "communication",
        "merchant_record",
        "note",
        "provider_observation",
        "other",
      ]),
      label: z.string(),
      capturedAt: z.string(),
      eventTime: z.string(),
      facts: z.array(factSchema),
    }),
  ),
  attestations: z.array(
    z.object({
      key: z.string(),
      ownerRole: z.enum(["buyer", "merchant"]),
      visibility: z.enum(["private", "shared"]),
      kind: z.enum([
        "receipt",
        "cancellation_confirmation",
        "charge_record",
        "screenshot",
        "communication",
        "merchant_record",
        "note",
        "provider_observation",
        "other",
      ]),
      label: z.string(),
      capturedAt: z.string(),
      eventTime: z.string(),
      facts: z.array(factSchema),
    }),
  ),
  case: z.object({ channel: z.enum(["merchant_refund", "app_store", "paypal", "chargeback"]) }),
});

export type FixtureManifest = z.infer<typeof manifestSchema>;

export const DEFAULT_FIXTURE_DIR = path.resolve(process.cwd(), "fixtures", "charged-after-cancel");

export function loadFixtureManifest(fixtureDir = DEFAULT_FIXTURE_DIR): {
  manifest: FixtureManifest;
  fingerprint: string;
} {
  const raw = fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8");
  const manifest = manifestSchema.parse(JSON.parse(raw));
  const fileHashes = manifest.evidence.map((e) =>
    sha256Hex(
      fs.readFileSync(
        /* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ fixtureDir, e.file),
      ),
    ),
  );
  return { manifest, fingerprint: sha256Hex(raw + fileHashes.join("")) };
}

export interface SeedResult {
  seeded: boolean;
  caseId: string;
  fingerprint: string;
}

export function seedFixture(ctx: AppContext, fixtureDir = DEFAULT_FIXTURE_DIR): SeedResult {
  if (ctx.config.mode !== "fixture") throw new Error("The fixture seed only runs in fixture mode.");
  const { manifest, fingerprint } = loadFixtureManifest(fixtureDir);
  const meta = ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get("seed_fingerprint") as
    { value: string } | undefined;
  const existingCase = cases.list(ctx.db)[0];
  if (meta && existingCase)
    return { seeded: false, caseId: existingCase.id, fingerprint: meta.value };

  const now = ctx.clock.now().toISOString();
  const env = "fixture" as const;
  const accountAlias = manifest.parties.buyer.accountAlias;
  const subscriptionId = newId(env, "sub");
  const caseId = newId(env, "case");
  const chargeId = newId(env, "charge");

  // Evidence first, so cancellation and charge records can reference the generated IDs.
  const evidenceIdsByKey = new Map<string, string>();
  const toFacts = (
    facts: z.infer<typeof factSchema>[],
    visibility: "private" | "shared",
    ownerRole: "buyer" | "merchant",
  ): NormalizedFact[] =>
    facts.map((f) => ({
      ...f,
      sourceIds: [],
      visibleTo: visibility === "shared" ? ["buyer", "merchant"] : [ownerRole],
    }));

  const seedTxn = ctx.db.transaction(() => {
    for (const e of manifest.evidence) {
      const bytes = fs.readFileSync(
        /* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ fixtureDir, e.file),
      );
      const record = addEvidence(ctx, {
        caseId,
        subscriptionId,
        accountAlias,
        ownerRole: e.ownerRole,
        visibility: e.visibility,
        provenance: "synthetic",
        kind: e.kind,
        label: e.label,
        filename: path.basename(e.file),
        declaredMime: null,
        bytes,
        capturedAt: e.capturedAt,
        eventTime: e.eventTime,
        facts: toFacts(e.facts, e.visibility, e.ownerRole),
      });
      evidenceIdsByKey.set(e.key, record.id);
    }
    for (const a of manifest.attestations) {
      const record = addAttestation(ctx, {
        caseId,
        subscriptionId,
        accountAlias,
        ownerRole: a.ownerRole,
        visibility: a.visibility,
        provenance: "synthetic",
        kind: a.kind,
        label: a.label,
        capturedAt: a.capturedAt,
        eventTime: a.eventTime,
        facts: toFacts(a.facts, a.visibility, a.ownerRole),
      });
      evidenceIdsByKey.set(a.key, record.id);
    }
    const resolve = (keys: string[]) =>
      keys.map((k) => evidenceIdsByKey.get(k)).filter((v): v is string => Boolean(v));

    // The fixture starts with a recorded *request*; the operator records the confirmation in the UI.
    let cancellation = initialCancellation();
    cancellation = reduceCancellation(cancellation, {
      type: "RECORD_CANCELLATION_REQUEST",
      requestedAt: manifest.subscription.cancellation.requestedAt,
      evidenceIds: resolve(manifest.subscription.cancellation.evidence),
    });
    const subscription: SubscriptionRecord = {
      id: subscriptionId,
      environment: env,
      accountAlias,
      ownerAlias: manifest.parties.buyer.alias,
      merchantAlias: manifest.parties.merchant.alias,
      label: manifest.subscription.label,
      amountCents: manifest.subscription.amountCents,
      currency: manifest.subscription.currency,
      providerRefs: manifest.subscription.providerRefs as SubscriptionRecord["providerRefs"],
      providerStatus: null,
      providerStatusObservedAt: null,
      cancellation,
      sourceIds: resolve(["receipt-original"]),
      lastSyncAt: null,
      createdAt: now,
      updatedAt: now,
    };
    subscriptions.insert(ctx.db, subscription);

    const charge: ChargeRecord = {
      id: chargeId,
      environment: env,
      accountAlias,
      merchantAlias: manifest.parties.merchant.alias,
      subscriptionId,
      matchMethod: manifest.charge.matchMethod,
      providerRefs: manifest.charge.providerRefs as ChargeRecord["providerRefs"],
      description: manifest.charge.description,
      eventTime: manifest.charge.eventTime,
      postedTime: manifest.charge.postedTime,
      ingestedTime: now,
      status: manifest.charge.status,
      amountCents: manifest.charge.amountCents,
      currency: manifest.charge.currency,
      refundedCents: manifest.charge.refundedCents,
      refundStateKnown: manifest.charge.refundStateKnown,
      servicePeriodStart: manifest.charge.servicePeriodStart,
      servicePeriodEnd: manifest.charge.servicePeriodEnd,
      arrearsIndicator: manifest.charge.arrearsIndicator,
      sourceIds: resolve(manifest.charge.evidence),
      dedupeKey:
        manifest.charge.providerRefs.find((r) => r.kind === "seller_transaction_id")?.value ??
        chargeId,
      createdAt: now,
      updatedAt: now,
    };
    charges.insert(ctx.db, charge);

    const caseRecord: CaseRecord = {
      id: caseId,
      environment: env,
      accountAlias,
      chargeId,
      subscriptionId,
      buyerAlias: manifest.parties.buyer.alias,
      merchantAlias: manifest.parties.merchant.alias,
      channel: manifest.case.channel,
      claimActive: false,
      claimClosedReason: null,
      buyerState: "FLAGGED",
      merchantState: "FLAGGED",
      classification: "NEEDS_REVIEW",
      reasonCodes: [],
      claimableCents: null,
      requestedCents: null,
      evidenceSnapshotVersion: 1,
      providerObservation: null,
      origin: "fixture_seed",
      originNote: "Seeded from the committed synthetic fixture.",
      createdAt: now,
      updatedAt: now,
    };
    cases.insert(ctx.db, caseRecord);
    ctx.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run("seed_fingerprint", fingerprint);
    ctx.db
      .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run("seed_name", manifest.name);
    ctx.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(
      "demo_hints",
      JSON.stringify({
        confirmation: {
          ...manifest.demoHints.confirmation,
          evidenceIds: resolve(manifest.demoHints.confirmation.evidence),
        },
      }),
    );
    logAudit(ctx, {
      action: "fixture.seeded",
      caseId,
      details: { fixture: manifest.name, fingerprint, evidenceCount: evidenceIdsByKey.size },
    });
  });
  seedTxn();
  reconcileCase(ctx, caseId, "fixture_seed");
  return { seeded: true, caseId, fingerprint };
}

export interface DemoHints {
  confirmation: {
    receivedAt: string;
    effectiveAt: string;
    /** Demo hints describe a manual record, which can never claim provider provenance */
    basis: "user_attestation" | "merchant_confirmation_document";
    evidenceIds: string[];
    note: string;
  };
}

export function readDemoHints(ctx: AppContext): DemoHints | null {
  if (ctx.config.mode !== "fixture") return null;
  const row = ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get("demo_hints") as
    { value: string } | undefined;
  return row ? (JSON.parse(row.value) as DemoHints) : null;
}
