import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const { LINKEDIN_PROFILE_URL } = process.env;

if (!LINKEDIN_PROFILE_URL) {
  throw new Error("Set LINKEDIN_PROFILE_URL before running this script.");
}

const outputPath = path.resolve("scripts/output/linkedin-profile.json");
const userDataDir = path.resolve(
  process.env.LINKEDIN_USER_DATA_DIR ||
    path.join(os.homedir(), "Library/Application Support/Google/Chrome")
);
const profileDir = process.env.LINKEDIN_PROFILE_DIR || "Default";

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chrome",
  headless: true,
  args: [`--profile-directory=${profileDir}`],
});
const page = context.pages()[0] || (await context.newPage());

try {
  await page.goto(LINKEDIN_PROFILE_URL, { waitUntil: "networkidle" });

  if (page.url().includes("/login") || page.url().includes("/checkpoint")) {
    throw new Error(
      "The selected browser profile is not already logged into LinkedIn or LinkedIn blocked the session reuse."
    );
  }

  const data = await page.evaluate(() => {
    const text = (selector) => {
      const node = document.querySelector(selector);
      return node ? node.textContent?.replace(/\s+/g, " ").trim() || null : null;
    };

    return {
      name: text("h1"),
      headline: text(".text-body-medium.break-words"),
      location: text(".text-body-small.inline.t-black--light.break-words"),
      about:
        text('section:has(#about) .inline-show-more-text span[aria-hidden="true"]') ||
        text('#about ~ * span[aria-hidden="true"]'),
    };
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify({ url: LINKEDIN_PROFILE_URL, ...data }, null, 2)}\n`);
  process.stdout.write(`${outputPath}\n`);
} finally {
  await context.close();
}
