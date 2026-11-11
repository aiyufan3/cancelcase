import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The path JUDGES.md describes, pressed the way a first-time reader would: Open the form, fill
 * it from the fixture email, save, Prepare my case, Approve and export, then take the approved
 * materials from the result. It runs on its own fixture server so the case is untouched, and it
 * checks the downloaded files themselves: their text, their bytes and what they leave out.
 */

const notice = (page: Page, re: RegExp) =>
  page.locator('[role="status"], [role="alert"]').filter({ hasText: re }).first();

async function save(page: Page, link: Locator): Promise<{ name: string; bytes: Buffer }> {
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
  const file = await download.path();
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(file) };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test.describe.configure({ mode: "serial" });

test("form, one press to draft, a rejection, approve and export, and the approved materials", async ({
  page,
}, testInfo) => {
  const dataDir = (testInfo.project.metadata as { dataDir: string }).dataDir;

  await page.goto("/");
  await page
    .getByRole("link", { name: /Open case/ })
    .first()
    .click();
  await page.waitForURL(/\/cases\/fx_case_/);
  const caseId = page.url().split("/cases/")[1]!;

  // Before the cancellation is recorded the only step offered is the form.
  await expect(page.getByRole("button", { name: "Prepare my case" })).toHaveCount(0);
  await expect(page.getByTestId("export-downloads")).toHaveCount(0);
  await page.getByRole("button", { name: "Open the form" }).click();
  await page.getByRole("button", { name: /Fill from the fixture confirmation email/ }).click();
  await page.getByRole("button", { name: "Save cancellation record" }).click();
  await expect(notice(page, /Cancellation recorded/)).toBeVisible();
  await expect(
    page.locator("#charge").getByText("Candidate: charged after cancellation."),
  ).toBeVisible();

  // One press: facts, draft, validation; it stops for approval and sends nothing.
  await page.getByRole("button", { name: "Prepare my case" }).click();
  const card = page.locator("#action-export_refund_request");
  await expect(card.getByText("validation passed", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(card.getByRole("button", { name: "Approve and export" })).toBeEnabled();
  await expect(page.locator("#operations").getByText("SUCCEEDED", { exact: true })).toHaveCount(0);

  // A rejected version exports nothing; a new version is needed before anything can be approved.
  await card.getByText("Reject…").click();
  await card.getByPlaceholder("Reason for rejecting").fill("Reading it once more first");
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(notice(page, /Rejected\. Nothing will be sent from this version/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve and export" })).toHaveCount(0);
  await expect(page.getByTestId("export-downloads")).toHaveCount(0);
  expect(fs.existsSync(path.join(dataDir, "fixture", "exports", caseId))).toBe(false);

  // The step panel says how to continue; the one-press button returns with a new version.
  await expect(page.getByText(/Regenerate the draft to start a new review/).first()).toBeVisible();
  await card.getByRole("button", { name: "Regenerate draft" }).click();
  await expect(card.getByRole("button", { name: "Approve and export" })).toBeEnabled({
    timeout: 30_000,
  });
  const approvedClaim = await card.getByLabel("Claim c1 text").inputValue();
  await card.getByRole("button", { name: "Approve and export" }).click();
  await expect(notice(page, /Exported locally\. Nothing was sent/)).toBeVisible();

  // The result lists the files of this approval; the private archive is not among them.
  const result = page.getByTestId("export-downloads");
  await expect(result).toHaveCount(1);
  await expect(result.getByText("Approved materials for the recipient")).toBeVisible();
  const materialLinks = result.locator("ul").nth(0).getByRole("link");
  const attachmentRows = result.locator("ul").nth(1).locator("li");
  await expect(materialLinks).toHaveCount(3);
  const attachmentCount = await attachmentRows.count();
  expect(attachmentCount).toBeGreaterThan(0);
  // Exactly the attachments the approval sheet listed for this version, no more.
  await expect(result.getByRole("link")).toHaveCount(3 + attachmentCount);
  await expect(result.getByRole("link", { name: /archive/i })).toHaveCount(0);

  // Documentation capture: the result of an approved export.
  await result.scrollIntoViewIfNeeded();
  await page.locator("#operations").screenshot({ path: "test-results/ui-export-result.png" });

  const message = await save(page, result.getByRole("link", { name: "Message to send" }));
  expect(message.name).toMatch(/-refund-request\.md$/);
  const messageText = message.bytes.toString("utf8");
  expect(messageText).toContain(approvedClaim.trim().slice(0, 60));
  // The same bytes the export wrote for this operation.
  const exportDir = path.join(dataDir, "fixture", "exports", caseId);
  expect(message.bytes.equals(fs.readFileSync(path.join(exportDir, message.name)))).toBe(true);

  const packJson = await save(page, result.getByRole("link", { name: "Evidence pack (JSON)" }));
  const packText = packJson.bytes.toString("utf8");
  const pack = JSON.parse(packText) as { audience: string };
  expect(pack.audience).toBe("recipient");
  const packMd = await save(page, result.getByRole("link", { name: "Evidence pack (Markdown)" }));
  // The buyer's private note is visible in the app but was not selected: it is in no download.
  await expect(page.getByText("Buyer's private note").first()).toBeVisible();
  for (const text of [messageText, packText, packMd.bytes.toString("utf8")]) {
    expect(text).not.toContain("Buyer's private note");
    expect(text).not.toContain("local_archive");
  }

  // Each selected attachment: the bytes match the hash shown beside its link.
  for (let i = 0; i < attachmentCount; i++) {
    const row = attachmentRows.nth(i);
    const shown = /sha256 ([0-9a-f]{12})/.exec(await row.innerText())![1]!;
    const attachment = await save(page, row.getByRole("link"));
    expect(attachment.bytes.length).toBeGreaterThan(0);
    expect(sha256(attachment.bytes).startsWith(shown)).toBe(true);
  }

  // After a reload the same materials are still there and can be taken again.
  await page.reload();
  const again = await save(
    page,
    page.getByTestId("export-downloads").getByRole("link", { name: "Message to send" }),
  );
  expect(again.bytes.equals(message.bytes)).toBe(true);

  // A later draft version does not change what the earlier approval's links serve.
  const href = await page
    .getByTestId("export-downloads")
    .getByRole("link", { name: "Message to send" })
    .getAttribute("href");
  const claim = card.getByLabel("Claim c1 text");
  await claim.fill((await claim.inputValue()) + " Added after the export.");
  await card.getByRole("button", { name: "Save edits (re-validate)" }).click();
  await expect(card.getByText("Human edit", { exact: true })).toBeVisible();
  const afterEdit = await page.request.get(href!);
  expect(afterEdit.status()).toBe(200);
  expect((await afterEdit.body()).equals(message.bytes)).toBe(true);

  // A small screen shows the list without sideways scrolling.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("export-downloads").scrollIntoViewIfNeeded();
  await expect(
    page.getByTestId("export-downloads").getByRole("link", { name: "Message to send" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page
    .locator("#operations")
    .screenshot({ path: "test-results/ui-export-result-narrow.png" });
  await page.setViewportSize({ width: 1280, height: 900 });

  // The seller's view has neither the list nor access to the files.
  await page.getByRole("radio", { name: "merchant view" }).click();
  await expect(page.getByText("Evidence visible to the merchant")).toBeVisible();
  await expect(page.getByTestId("export-downloads")).toHaveCount(0);
  const asMerchant = await page.request.get(href!);
  expect(asMerchant.status()).toBe(404);
  expect(((await asMerchant.json()) as { error: { code: string } }).error.code).toBe(
    "EXPORT_NOT_FOUND",
  );
});

test("steps 4 and 5 as written: the simulated timeout applies to one request, then the seller answers", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("link", { name: /Open case/ })
    .first()
    .click();
  await page.waitForURL(/\/cases\/fx_case_/);

  // Step 4: the PayPal channel, one press to draft, the fixture control, Approve and submit.
  await page.getByLabel("Recovery channel").selectOption("paypal");
  await page
    .getByPlaceholder("e.g. merchant did not reply within 7 days")
    .fill("No reply from the merchant for a week (fixture scenario)");
  await page.getByRole("button", { name: "Apply channel" }).click();
  await expect(notice(page, /Channel updated/)).toBeVisible();
  await page.getByRole("button", { name: "Prepare my case", exact: true }).first().click();
  const dispute = page.locator("#action-buyer_create_dispute");
  await expect(dispute.getByRole("button", { name: "Approve and submit" })).toBeEnabled({
    timeout: 30_000,
  });
  const control = dispute.getByLabel("Fixture simulation switch");
  await control.selectOption("timeout");
  await dispute.getByRole("button", { name: "Approve and submit" }).click();
  const ops = page.locator("#operations");
  await expect(ops.getByText("UNKNOWN", { exact: true })).toBeVisible();
  // The control is used up: the next request on this page is not simulated as well.
  await expect(control).toHaveValue("");
  // A case creation is settled by finding the case; recording it as failed is not offered.
  await expect(ops.getByRole("button", { name: "Confirm it failed" })).toHaveCount(0);
  await ops.getByRole("button", { name: "Read back" }).click();
  await expect(ops.getByText(/Read-back found one case/)).toBeVisible();
  await ops
    .getByPlaceholder(/The case appears in the Sandbox/)
    .fill("Verified in the simulated provider view.");
  await ops.getByRole("button", { name: "Confirm it succeeded" }).click();
  await expect(notice(page, /Recovery decision recorded/)).toBeVisible();

  // Step 5: the seller's side, without touching the control again.
  await page.getByRole("radio", { name: "merchant view" }).click();
  await expect(page.getByText("Evidence visible to the merchant")).toBeVisible();
  await expect(page.getByText("Buyer's private note")).toHaveCount(0);
  await page.getByRole("button", { name: "Prepare the response", exact: true }).first().click();
  const response = page.locator("#action-merchant_provide_evidence");
  await expect(response.getByRole("button", { name: "Approve and submit" })).toBeEnabled({
    timeout: 30_000,
  });
  await expect(response.getByLabel("Fixture simulation switch")).toHaveValue("");
  await response.getByRole("button", { name: "Approve and submit" }).click();
  await expect(notice(page, /Submission attempted/)).toBeVisible();
  const merchantOps = page.locator("#operations");
  await expect(merchantOps.getByText("SUCCEEDED", { exact: true }).first()).toBeVisible();
  await expect(merchantOps.getByText("UNKNOWN", { exact: true })).toHaveCount(0);
  await expect(page.locator("#provider").getByText("UNDER REVIEW", { exact: true })).toBeVisible();
});
