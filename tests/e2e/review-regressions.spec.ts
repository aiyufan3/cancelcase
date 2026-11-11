import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * AUD13 (independent audit): unsaved visible edits must never approve or send an older server
 * draft. The UI blocks approval while edits are unsaved; after saving, the approved and exported
 * content is exactly the edited version shown on screen.
 *
 * Runs after the main fixture story on the same fixture database; it only uses the buyer's
 * local export action, which is always available for the candidate case.
 */

const dataDir =
  process.env.CC_E2E_DATA_DIR ?? path.resolve(import.meta.dirname, "../../test-results/e2e-data");

test("AUD13 unsaved edits block approval; the exported text is the saved, approved version", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: /Open case/ })
    .first()
    .click();
  await page.waitForURL(/\/cases\/fx_case_/);
  const caseId = page.url().split("/cases/")[1]!;
  await page.getByRole("radio", { name: "buyer view" }).click();

  const card = page.locator("#action-export_refund_request");
  await card.getByRole("button", { name: /Generate draft|Regenerate draft/ }).click();
  // The previous version may still show "validation passed"; wait for this run to finish so the
  // edit lands on the version it produced, not on one that is about to be replaced.
  await expect(card.getByText(/New draft version ready|No new version was needed/)).toBeVisible();
  await expect(card.getByText("validation passed", { exact: true })).toBeVisible();

  const sentence = ` Reference note ${Date.now()}.`;
  const claim = card.getByLabel("Claim c1 text");
  await claim.fill((await claim.inputValue()) + sentence);

  // Unsaved edits: approving would approve the older server version, so it is blocked.
  await expect(card.getByRole("button", { name: "Approve this draft" })).toBeDisabled();
  await expect(card.getByText(/Save your edits first/)).toBeVisible();

  await card.getByRole("button", { name: "Save edits (re-validate)" }).click();
  await expect(card.getByText("Human edit", { exact: true })).toBeVisible();
  await expect(card.getByLabel("Claim c1 text")).toHaveValue(
    new RegExp(sentence.trim().replace(/\./g, "\\.")),
  );

  await card.getByRole("button", { name: "Approve this draft" }).click();
  await expect(card.getByText(/valid for \d+:\d\d/)).toBeVisible();
  await card.getByRole("button", { name: "Export approved request" }).click();
  // An earlier test's export can already show SUCCEEDED; wait for this card's own export.
  await expect(card.getByText(/Exported locally/)).toBeVisible();
  await expect(
    page.locator("#operations").getByText("SUCCEEDED", { exact: true }).first(),
  ).toBeVisible();

  const dir = path.join(dataDir, "fixture", "exports", caseId);
  const newest = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith("-refund-request.md"))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0]!;
  expect(fs.readFileSync(path.join(dir, newest.f), "utf8")).toContain(sentence.trim());
});

test("Sandbox return pages are static and never echo the return parameters", async ({ page }) => {
  for (const kind of ["approved", "cancelled"] as const) {
    await page.goto(
      `/sandbox/${kind}?token=EC-SYNTHETIC-TOKEN-0000&subscription_id=I-SYNTHETIC0000`,
    );
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("pnpm sandbox:setup --resume")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/sandbox/${kind}$`));
    const html = await page.content();
    expect(html).not.toContain("EC-SYNTHETIC-TOKEN-0000");
    expect(html).not.toContain("I-SYNTHETIC0000");
  }
  await expect(page.getByText(/does not prove/)).toHaveCount(0);
  // The consent return carries an authorization code; it is dropped before the page renders.
  await page.goto("/sandbox/consent?code=SYNTHETIC-AUTH-CODE-0000&scope=openid&state=0");
  await expect(page).toHaveURL(/\/sandbox\/consent$/);
  await expect(page.getByText("pnpm sandbox:check")).toBeVisible();
  await expect(page.getByText(/does not prove that consent was granted/)).toBeVisible();
  expect(await page.content()).not.toContain("SYNTHETIC-AUTH-CODE-0000");
  await page.goto("/sandbox/approved");
  await expect(page.getByText(/does not prove that the subscription was approved/)).toBeVisible();
});

test("switching the role never silently discards unsaved draft edits", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: /Open case/ })
    .first()
    .click();
  await page.waitForURL(/\/cases\/fx_case_/);
  await page.getByRole("radio", { name: "buyer view" }).click();
  const card = page.locator("#action-export_refund_request");
  await card.getByRole("button", { name: /Generate draft|Regenerate draft/ }).click();
  // Same wait as above: an edit typed while the new version arrives would be lost.
  await expect(card.getByText(/New draft version ready|No new version was needed/)).toBeVisible();
  await expect(card.getByText("validation passed", { exact: true })).toBeVisible();
  const claim = card.getByLabel("Claim c1 text");
  const edited = (await claim.inputValue()) + " Unsaved sentence.";
  await claim.fill(edited);

  await page.getByRole("radio", { name: "merchant view" }).click();
  await expect(page.getByText(/unsaved edits in a draft/)).toBeVisible();
  await expect(page.getByRole("radio", { name: "buyer view" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(card.getByLabel("Claim c1 text")).toHaveValue(edited);

  await page.getByRole("radio", { name: "merchant view" }).click();
  await page.getByRole("button", { name: "Discard edits and switch" }).click();
  await expect(page.getByRole("radio", { name: "merchant view" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.getByRole("radio", { name: "buyer view" }).click();
  await expect(page.getByRole("radio", { name: "buyer view" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});
