import { expect, test, type Page } from "@playwright/test";

/**
 * Browser acceptance for the offline fixture story. Runs against `scripts/demo.ts` in fixture
 * mode with an isolated data directory: no .env, no network, no credentials.
 */

const notice = (page: Page, re: RegExp) =>
  page.locator('[role="status"], [role="alert"]').filter({ hasText: re }).first();

async function openCase(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.getByText("PayPal Sandbox · demo data", { exact: true }).first()).toBeVisible();
  const link = page.getByRole("link", { name: /Open case/ }).first();
  await link.click();
  await page.waitForURL(/\/cases\/fx_case_/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Alex Example");
  return page.url().split("/cases/")[1]!;
}

async function switchRole(page: Page, role: "buyer" | "merchant") {
  await page.getByRole("radio", { name: `${role} view` }).click();
  await expect(page.getByRole("radio", { name: `${role} view` })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByText(`Evidence visible to the ${role}`)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("buyer records cancellation, reviews the candidate, drafts, edits, approves and exports", async ({
  page,
}) => {
  await openCase(page);
  const check = page.locator("#charge");
  await expect(check.getByText("Needs review.", { exact: false })).toBeVisible();
  await expect(page.getByText("CANCELLATION_NOT_CONFIRMED")).toBeVisible();

  // Record cancellation (never claims to cancel anything).
  await page.getByRole("button", { name: "Record cancellation" }).click();
  await page.getByRole("button", { name: /Fill from the fixture confirmation email/ }).click();
  await expect(page.getByPlaceholder("2026-11-07T12:00:00Z")).toHaveValue("2026-11-07T12:00:00Z");
  await page.getByRole("button", { name: "Save cancellation record" }).click();
  await expect(notice(page, /Cancellation recorded\. This records your facts/)).toBeVisible();
  await expect(check.getByText("Candidate: charged after cancellation.")).toBeVisible();
  await expect(page.getByText("CHARGE_AFTER_EFFECTIVE_CANCELLATION")).toBeVisible();
  await expect(page.getByText("$19.99 USD").first()).toBeVisible();

  // Evidence shows provenance and visibility; the merchant-private log is not visible to the buyer.
  await expect(page.getByText("Buyer's private note")).toBeVisible();
  await expect(page.getByText("Merchant billing log extract")).toHaveCount(0);

  // Draft the merchant refund request.
  const exportCard = page.locator("#action-export_refund_request");
  await exportCard.getByRole("button", { name: "Generate draft" }).click();
  await expect(exportCard.getByText("Template — no model call", { exact: true })).toBeVisible();
  await expect(exportCard.getByText("validation passed", { exact: true })).toBeVisible();
  await expect(exportCard.getByText("sources:", { exact: false }).first()).toBeVisible();

  // Documentation capture: candidate reviewed, draft ready, nothing approved yet.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/ui-buyer-case.png", fullPage: false });

  // Edit a claim -> new version, approval must be re-done.
  const firstClaim = exportCard.getByLabel(/Claim c1 text/);
  await firstClaim.fill((await firstClaim.inputValue()) + " I have attached the confirmation.");
  await exportCard.getByRole("button", { name: "Save edits (re-validate)" }).click();
  await expect(exportCard.getByText("Human edit", { exact: true })).toBeVisible();
  await expect(exportCard.getByText("v2", { exact: true })).toBeVisible();

  // Approve and export.
  await exportCard.getByRole("button", { name: "Approve this draft" }).click();
  await expect(exportCard.getByText(/valid for \d+:\d\d/)).toBeVisible();
  await exportCard.getByRole("button", { name: "Export approved request" }).click();
  await expect(notice(page, /Exported locally\. Nothing was sent/)).toBeVisible();
  const ops = page.locator("#operations");
  await expect(ops.getByText("SUCCEEDED", { exact: true })).toBeVisible();
  await expect(ops.getByText("local export", { exact: true })).toBeVisible();

  // Reload keeps progress.
  await page.reload();
  await expect(page.locator("#operations").getByText("SUCCEEDED", { exact: true })).toBeVisible();
  await expect(page.getByText("Money recovered (verified)")).toBeVisible();
  await expect(page.locator("dd", { hasText: "$0.00 USD" }).first()).toBeVisible();
});

test("buyer escalates to a simulated PayPal case with an ambiguous timeout and recovers it", async ({
  page,
}) => {
  await openCase(page);
  await page.getByLabel("Recovery channel").selectOption("paypal");
  await page
    .getByPlaceholder("e.g. merchant did not reply within 7 days")
    .fill("No reply from the merchant for a week (fixture scenario)");
  await page.getByRole("button", { name: "Apply channel" }).click();
  await expect(notice(page, /Channel updated/)).toBeVisible();

  const card = page.locator("#action-buyer_create_dispute");
  await card.getByRole("button", { name: "Generate draft" }).click();
  await expect(card.getByText("validation passed", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Approve this draft" }).click();
  await card.getByLabel("Fixture simulation switch").selectOption("timeout");
  await card.getByRole("button", { name: "Submit approved request" }).click();

  const ops = page.locator("#operations");
  await expect(ops.getByText("UNKNOWN", { exact: true }).first()).toBeVisible();
  await expect(ops.getByText(/Result unknown/)).toBeVisible();
  await ops.getByRole("button", { name: "Read back" }).click();
  await expect(ops.getByText(/Read-back found one case/)).toBeVisible();
  await ops
    .getByPlaceholder(/The case appears in the Sandbox/)
    .fill("Verified in the simulated provider view.");
  await ops.getByRole("button", { name: "Confirm it succeeded" }).click();
  await expect(notice(page, /Recovery decision recorded/)).toBeVisible();
  await expect(ops.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
  const provider = page.locator("#provider");
  await expect(provider.getByText("WAITING FOR SELLER RESPONSE", { exact: true })).toBeVisible();
  await expect(provider.getByText("synthetic fixture", { exact: true })).toBeVisible();
});

test("merchant view is scoped, blocked submissions explain themselves, and evidence can be submitted", async ({
  page,
}) => {
  await openCase(page);
  await switchRole(page, "merchant");
  await expect(page.getByText("Merchant billing log extract")).toBeVisible();
  await expect(page.getByText("Buyer's private note")).toHaveCount(0);
  await expect(page.getByText("Cancellation confirmation email")).toBeVisible(); // shared evidence works

  const card = page.locator("#action-merchant_provide_evidence");
  await card.getByRole("button", { name: "Generate draft" }).click();
  await expect(card.getByText("validation passed", { exact: true })).toBeVisible();
  const rendered = card.locator("details:not(.reject-disclosure)");
  await rendered.locator("summary").click();
  await expect(rendered).not.toContainText("private note");
  // The approval sheet names the evidence type that would be sent.
  await expect(card.getByText("Evidence type sent")).toBeVisible();
  await expect(card.getByText("CANCELLATION_DETAILS", { exact: true })).toBeVisible();

  // Unsupported capability: blocked before any write.
  await card.getByRole("button", { name: "Approve this draft" }).click();
  await card.getByLabel("Fixture simulation switch").selectOption("unsupported");
  await card.getByRole("button", { name: "Submit approved request" }).click();
  const ops = page.locator("#operations");
  await expect(ops.getByText("CAPABILITY_BLOCKED", { exact: true })).toBeVisible();
  await expect(ops.getByText("FAILED", { exact: true }).first()).toBeVisible();

  // Regenerate, approve again, submit for real (simulated).
  await card.getByLabel("Fixture simulation switch").selectOption("");
  await card.getByRole("button", { name: "Regenerate draft" }).click();
  await expect(card.getByText("v2", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Approve this draft" }).click();
  await card.getByRole("button", { name: "Submit approved request" }).click();
  await expect(notice(page, /Submission attempted/)).toBeVisible();
  await expect(ops.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
  await expect(page.locator("#provider").getByText("UNDER REVIEW", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The case is with the simulated provider" }),
  ).toBeVisible();
  // Submitting evidence never shows a resolution or recovered money.
  await expect(page.locator("#provider").getByText("RESOLVED", { exact: true })).toHaveCount(0);
});

test("rejection, keyboard access, reduced motion and a small screen", async ({ page, browser }) => {
  await openCase(page);
  await switchRole(page, "buyer");
  const exportCard = page.locator("#action-export_refund_request");
  await exportCard.getByRole("button", { name: "Regenerate draft" }).click();
  await expect(exportCard.getByText("v3", { exact: true })).toBeVisible();
  await exportCard.getByText("Reject…", { exact: true }).click();
  await exportCard.getByLabel("Rejection reason").fill("Tone is too strong");
  await exportCard.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(exportCard.getByText("REJECTED", { exact: true })).toBeVisible();

  // Keyboard: the role switch is reachable and operable.
  await page.getByRole("radio", { name: "merchant view" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("radio", { name: "merchant view" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // Reduced motion and a phone-sized viewport render without horizontal overflow.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  const mobile = await context.newPage();
  await mobile.goto(page.url());
  await expect(mobile.getByRole("heading", { level: 1 })).toBeVisible();
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
  // Reduced motion sets the amount at once: no digit waits on a staggered delay.
  const digitDelays = await mobile.evaluate(() =>
    [...document.querySelectorAll(".digit-strip")].map((el) => getComputedStyle(el).animationDelay),
  );
  expect(digitDelays.length).toBeGreaterThan(0);
  expect(new Set(digitDelays)).toEqual(new Set(["0s"]));
  await mobile.screenshot({ path: "test-results/mobile-case.png", fullPage: false });
  await context.close();

  // Merchant capture for documentation.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/ui-merchant-case.png", fullPage: false });
});
