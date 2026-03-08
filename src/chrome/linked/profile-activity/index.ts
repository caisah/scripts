import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const linkedInLoginUrl = "https://www.linkedin.com/login";
const linkedInFeedUrl = "https://www.linkedin.com/feed/";
const manualVerificationTimeoutMs = 30_000;
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const outputDir = path.join(scriptDir, "output");
const secretsPath = fileURLToPath(new URL("../../../../secrets.json", import.meta.url));
const profileActivityDir = fileURLToPath(new URL("../../../../local-html/profile-activity", import.meta.url));
const profileActivityDataPath = path.join(profileActivityDir, "data.json");

type Secrets = {
  linkedin: {
    username: string;
    password: string;
  };
};

type AuthState = "authenticated" | "invalid_credentials" | "verification_required" | "login_required" | "unknown";

type FeedMetrics = {
  profileViewers: string | null;
  postImpressions: string | null;
};

type HistoryEntry = {
  timestamp: string;
  profileViewers: string | null;
  postImpressions: string | null;
};

function logStep(message: string): void {
  process.stderr.write(`[profile-activity] ${new Date().toISOString()} ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function ensureOutputDir(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
}

async function ensureProfileActivityDir(): Promise<void> {
  await mkdir(profileActivityDir, { recursive: true });
}

async function readSecrets(): Promise<Secrets> {
  logStep(`Reading secrets from "${secretsPath}"`);
  const raw = await readFile(secretsPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<Secrets>;
  const username = parsed.linkedin?.username?.trim();
  const password = parsed.linkedin?.password?.trim();

  if (!username || !password) {
    throw new Error(`Set non-empty linkedin.username and linkedin.password in "${secretsPath}".`);
  }

  return {
    linkedin: {
      username,
      password,
    },
  };
}

async function launchBrowser(): Promise<Browser> {
  logStep("Launching headless Chrome");
  return chromium.launch({
    channel: "chrome",
    headless: true,
    timeout: 30_000,
  });
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  logStep("Creating browser context");
  return browser.newContext();
}

async function getPage(context: BrowserContext): Promise<Page> {
  logStep("Creating page");
  return context.newPage();
}

async function saveFailureArtifacts(page: Page, label: string): Promise<void> {
  await ensureOutputDir();
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const screenshotPath = path.join(outputDir, `${safeLabel}.png`);
  const htmlPath = path.join(outputDir, `${safeLabel}.html`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await writeFile(htmlPath, await page.content(), "utf8");
    logStep(`Saved failure artifacts to "${screenshotPath}" and "${htmlPath}"`);
  } catch (error) {
    logStep(`Failed to save failure artifacts: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openLoginPage(page: Page): Promise<void> {
  logStep(`Opening ${linkedInLoginUrl}`);
  await page.goto(linkedInLoginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#username").waitFor({ state: "visible", timeout: 15_000 });
  logStep(`Login page ready at ${page.url()}`);
}

async function submitCredentials(page: Page, secrets: Secrets): Promise<void> {
  logStep("Submitting LinkedIn credentials");
  await page.locator("#username").fill(secrets.linkedin.username);
  await page.locator("#password").fill(secrets.linkedin.password);

  const submitButton = page.locator('button[type="submit"]');
  await submitButton.waitFor({ state: "visible", timeout: 15_000 });
  await submitButton.click();
}

async function detectAuthState(page: Page): Promise<AuthState> {
  const url = page.url();
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();

  if (!url.includes("linkedin.com")) {
    return "unknown";
  }

  if (
    url.includes("/feed") ||
    url.includes("/home") ||
    (await page.locator('nav[aria-label*="Primary"], nav.global-nav').first().isVisible().catch(() => false))
  ) {
    return "authenticated";
  }

  if (
    bodyText.includes("wrong password") ||
    bodyText.includes("incorrect password") ||
    bodyText.includes("couldn\'t find a linkedin account") ||
    bodyText.includes("not the right password")
  ) {
    return "invalid_credentials";
  }

  if (
    url.includes("/checkpoint") ||
    url.includes("/challenge") ||
    bodyText.includes("two-step verification") ||
    bodyText.includes("verification code") ||
    bodyText.includes("captcha") ||
    bodyText.includes("security verification")
  ) {
    return "verification_required";
  }

  if (url.includes("/login") || url.includes("/uas/login")) {
    return "login_required";
  }

  return "unknown";
}

async function waitForPostLoginState(page: Page): Promise<AuthState> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const state = await detectAuthState(page);

    if (state !== "unknown") {
      logStep(`Detected post-login auth state: ${state}`);
      return state;
    }

    await sleep(500);
  }

  logStep("Post-login auth state remained unknown");
  return "unknown";
}

async function waitForManualVerification(page: Page): Promise<void> {
  logStep(`Waiting up to ${manualVerificationTimeoutMs / 1000}s for manual verification`);
  const deadline = Date.now() + manualVerificationTimeoutMs;

  while (Date.now() < deadline) {
    const state = await detectAuthState(page);

    if (state === "authenticated") {
      logStep("Manual verification completed");
      return;
    }

    if (state === "invalid_credentials") {
      throw new Error("LinkedIn rejected the provided credentials.");
    }

    await sleep(1_000);
  }

  throw new Error(`Manual verification did not complete within ${manualVerificationTimeoutMs / 1000} seconds.`);
}

async function loginToLinkedIn(page: Page, secrets: Secrets): Promise<void> {
  await openLoginPage(page);
  await submitCredentials(page, secrets);

  const state = await waitForPostLoginState(page);

  if (state === "authenticated") {
    return;
  }

  if (state === "invalid_credentials") {
    throw new Error("LinkedIn rejected the provided credentials.");
  }

  if (state === "verification_required" || state === "login_required" || state === "unknown") {
    await waitForManualVerification(page);
    return;
  }

  throw new Error(`Unhandled authentication state: ${state}`);
}

function assertAuthenticatedSession(page: Page): void {
  const url = page.url();
  logStep(`Current page URL: ${url}`);

  if (url.includes("/login") || url.includes("/checkpoint") || url.includes("/challenge") || url.includes("/uas/login")) {
    throw new Error("LinkedIn session is not authenticated.");
  }
}

async function waitForFeedContent(page: Page): Promise<void> {
  logStep("Waiting for feed page body");
  await page.locator("body").waitFor({ state: "visible", timeout: 15_000 });

  logStep("Waiting for analytics links or known metric labels");

  try {
    await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText.toLowerCase();

        return (
          bodyText.includes("profile viewers") ||
          bodyText.includes("post impressions") ||
          Boolean(document.querySelector('a[href*="/analytics/profile/"]')) ||
          Boolean(document.querySelector('a[href*="/analytics/post/"]'))
        );
      },
      undefined,
      { timeout: 15_000 }
    );
    logStep("Feed metrics markers detected");
  } catch {
    logStep("Feed metrics markers were not detected before timeout; continuing with best-effort extraction");
  }
}

async function openFeedPage(page: Page): Promise<void> {
  logStep(`Opening ${linkedInFeedUrl}`);
  await page.goto(linkedInFeedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assertAuthenticatedSession(page);
  await waitForFeedContent(page);
}

function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() || "";
}

async function extractFeedMetrics(page: Page): Promise<FeedMetrics> {
  logStep("Extracting feed metrics from page DOM");

  return page.evaluate<FeedMetrics>(() => {
    const normalize = (value: string | null | undefined): string => value?.replace(/\s+/g, " ").trim() || "";
    const numericPattern = /^\d[\d,]*$/;

    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && normalize(element.innerText).length > 0;
    };

    const collectVisibleTextItems = (container: HTMLElement) => {
      const nodes = Array.from(container.querySelectorAll<HTMLElement>("*"));
      const items: Array<{ element: HTMLElement; text: string }> = [];
      const seen = new Set<string>();

      for (const node of nodes) {
        if (!isVisible(node)) {
          continue;
        }

        const text = normalize(node.innerText);

        if (!text || seen.has(`${node.tagName}:${text}`)) {
          continue;
        }

        seen.add(`${node.tagName}:${text}`);
        items.push({ element: node, text });
      }

      return items;
    };

    const extractFromItems = (items: Array<{ element: HTMLElement; text: string }>, label: string): string | null => {
      const normalizedLabel = label.toLowerCase();
      const labelIndex = items.findIndex((item) => item.text.toLowerCase() === normalizedLabel);

      if (labelIndex === -1) {
        return null;
      }

      for (let offset = 1; offset <= 8; offset += 1) {
        const nextItem = items[labelIndex + offset];

        if (nextItem && numericPattern.test(nextItem.text)) {
          return nextItem.text;
        }
      }

      for (let offset = 1; offset <= 4; offset += 1) {
        const previousItem = items[labelIndex - offset];

        if (previousItem && numericPattern.test(previousItem.text)) {
          return previousItem.text;
        }
      }

      return null;
    };

    const summarizeWindow = (items: Array<{ element: HTMLElement; text: string }>, label: string): string => {
      const normalizedLabel = label.toLowerCase();
      const labelIndex = items.findIndex((item) => item.text.toLowerCase() === normalizedLabel);

      if (labelIndex === -1) {
        return items.slice(0, 12).map((item) => item.text).join(" | ");
      }

      return items
        .slice(Math.max(0, labelIndex - 4), labelIndex + 9)
        .map((item) => item.text)
        .join(" | ");
    };

    const metricValueFromLabel = (label: string): string => {
      const normalizedLabel = label.toLowerCase();
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("body *"));

      for (const candidate of candidates) {
        const ownText = normalize(candidate.innerText || candidate.textContent);

        if (!ownText || ownText.toLowerCase() !== normalizedLabel) {
          continue;
        }

        console.log(`[profile-activity-dom] ${label} element: ${ownText}`);

        const containers: HTMLElement[] = [];
        let current: HTMLElement | null = candidate.parentElement;

        while (current && containers.length < 4) {
          containers.push(current);
          current = current.parentElement;
        }

        for (const container of containers) {
          const items = collectVisibleTextItems(container);

          if (items.length === 0) {
            continue;
          }

          const value = extractFromItems(items, label);
          const windowText = summarizeWindow(items, label);
          const containerId = `${container.tagName.toLowerCase()}.${Array.from(container.classList).join(".")}`;

          if (value) {
            console.log(`[profile-activity-dom] ${label} container ${containerId}: ${windowText}`);
            console.log(`[profile-activity-dom] ${label} value: ${value}`);
            return value;
          }

          if (items.some((item) => item.text.toLowerCase() === normalizedLabel)) {
            console.log(`[profile-activity-dom] ${label} container ${containerId} no-value: ${windowText}`);
          }
        }

        throw new Error(`Found label \"${label}\" but no nearby numeric value in local container search.`);
      }

      throw new Error(`Could not find a visible block for label \"${label}\".`);
    };

    return {
      profileViewers: metricValueFromLabel("profile viewers"),
      postImpressions: metricValueFromLabel("post impressions"),
    };
  });
}

async function readHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await readFile(profileActivityDataPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("ENOENT")) {
      return [];
    }

    throw error;
  }
}

async function appendHistoryEntry(data: FeedMetrics): Promise<void> {
  await ensureProfileActivityDir();
  const history = await readHistory();
  const entry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    profileViewers: data.profileViewers,
    postImpressions: data.postImpressions,
  };

  history.push(entry);
  await writeFile(profileActivityDataPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  logStep(`Appended history entry to "${profileActivityDataPath}"`);
}

function printMetrics(data: FeedMetrics): void {
  logStep(`Extracted metrics: ${JSON.stringify(data)}`);
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

async function main(): Promise<void> {
  logStep("Starting LinkedIn profile activity scrape");
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    const secrets = await readSecrets();
    browser = await launchBrowser();
    context = await createContext(browser);
    page = await getPage(context);
    await loginToLinkedIn(page, secrets);
    await openFeedPage(page);
    const data = await extractFeedMetrics(page);
    await appendHistoryEntry(data);

    printMetrics({
      profileViewers: normalizeText(data.profileViewers) || null,
      postImpressions: normalizeText(data.postImpressions) || null,
    });
  } catch (error) {
    if (page) {
      await saveFailureArtifacts(page, "profile-activity-failure");
    }

    const message = error instanceof Error ? error.stack || error.message : String(error);
    logStep(`Failure: ${message}`);
    throw error;
  } finally {
    if (browser) {
      logStep("Closing browser");
      await browser.close();
    }
  }
}

await main();
