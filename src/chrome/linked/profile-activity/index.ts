import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";

const linkedInLoginUrl = "https://www.linkedin.com/login";
const linkedInFeedUrl = "https://www.linkedin.com/feed/";
const manualVerificationTimeoutMs = 30_000;
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const outputDir = path.join(scriptDir, "output");
const userDataDir = path.join(scriptDir, ".playwright-linkedin-profile");
const profileActivityDir = fileURLToPath(new URL("../../../../local-html/profile-activity", import.meta.url));
const profileActivityDataPath = path.join(profileActivityDir, "data.json");
const secretsPath = fileURLToPath(new URL("../../../../secrets.json", import.meta.url));

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

type LinkedInCredentials = {
  username: string;
  password: string;
};

/** Writes a timestamped progress message to stderr. */
function logStep(message: string): void {
  process.stderr.write(`[profile-activity] ${new Date().toISOString()} ${message}\n`);
}

/** Pauses execution for the provided number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Ensures the artifact output directory exists. */
async function ensureOutputDir(): Promise<void> {
  await mkdir(outputDir, { recursive: true });
}

/** Ensures the persistent Chrome profile directory exists. */
async function ensureUserDataDir(): Promise<void> {
  await mkdir(userDataDir, { recursive: true });
}

/** Ensures the local history data directory exists. */
async function ensureProfileActivityDir(): Promise<void> {
  await mkdir(profileActivityDir, { recursive: true });
}

/** Launches Chrome with the persistent LinkedIn profile directory. */
async function launchBrowserContext(): Promise<BrowserContext> {
  await ensureUserDataDir();
  logStep(`Launching persistent Chrome profile at "${userDataDir}"`);
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: true,
    timeout: 30_000,
    viewport: { width: 1280, height: 800 },
  });
}

/** Returns the first existing page or creates a new page in the context. */
async function getPage(context: BrowserContext): Promise<Page> {
  const existingPage = context.pages()[0];

  if (existingPage) {
    logStep("Using existing page from persistent context");
    return existingPage;
  }

  logStep("Creating page");
  return context.newPage();
}

/** Captures screenshot and HTML artifacts for debugging a failed run. */
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

/** Opens LinkedIn's login page and waits for the form to be ready. */
async function openLoginPage(page: Page): Promise<void> {
  logStep(`Opening ${linkedInLoginUrl}`);
  await page.goto(linkedInLoginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator("#username").waitFor({ state: "visible", timeout: 15_000 });
  logStep(`Login page ready at ${page.url()}`);
}

/** Loads LinkedIn credentials from `secrets.json`. */
async function readLinkedInCredentials(): Promise<LinkedInCredentials> {
  const raw = await readFile(secretsPath, "utf8");
  const parsed = JSON.parse(raw) as { linkedin?: Partial<LinkedInCredentials> };
  const username = parsed.linkedin?.username?.trim();
  const password = parsed.linkedin?.password;

  if (!username || !password) {
    throw new Error(`LinkedIn credentials are missing in "${secretsPath}".`);
  }

  return { username, password };
}

/** Infers the current LinkedIn authentication state from the page URL and content. */
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

/** Polls until the page resolves to a known authentication state or times out. */
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

/** Waits for the user to complete any manual LinkedIn verification challenge. */
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

/** Signs in with credentials from `secrets.json` and handles post-login verification. */
async function loginWithSavedCredentials(page: Page): Promise<void> {
  const credentials = await readLinkedInCredentials();
  logStep(`Logging in with credentials from "${secretsPath}"`);
  await openLoginPage(page);
  await page.locator("#username").fill(credentials.username);
  await page.locator("#password").fill(credentials.password);
  await page.locator('button[type="submit"]').click();

  const state = await waitForPostLoginState(page);

  if (state === "authenticated") {
    return;
  }

  if (state === "verification_required") {
    logStep("Credential login requires manual verification");
    await waitForManualVerification(page);
    return;
  }

  if (state === "invalid_credentials") {
    throw new Error("LinkedIn rejected the credentials from secrets.json.");
  }

  throw new Error(`LinkedIn login did not complete successfully. Final auth state: ${state}.`);
}

/** Reuses the saved browser session or falls back to credential-based login. */
async function ensureAuthenticatedSession(page: Page): Promise<void> {
  logStep(`Opening ${linkedInFeedUrl} to reuse saved browser session`);
  await page.goto(linkedInFeedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  const state = await waitForPostLoginState(page);

  if (state === "authenticated") {
    return;
  }

  if (state === "invalid_credentials") {
    throw new Error("LinkedIn rejected the saved session.");
  }

  logStep("Saved browser session unavailable; falling back to secrets.json credentials");
  await loginWithSavedCredentials(page);
}

/** Verifies the current page is not a login or challenge screen. */
function assertAuthenticatedSession(page: Page): void {
  const url = page.url();
  logStep(`Current page URL: ${url}`);

  if (url.includes("/login") || url.includes("/checkpoint") || url.includes("/challenge") || url.includes("/uas/login")) {
    throw new Error("LinkedIn session is not authenticated.");
  }
}

/** Waits for feed content markers that indicate metrics are available to scrape. */
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

/** Opens the LinkedIn feed and waits until metric-related content is available. */
async function openFeedPage(page: Page): Promise<void> {
  logStep(`Opening ${linkedInFeedUrl}`);
  await page.goto(linkedInFeedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  assertAuthenticatedSession(page);
  await waitForFeedContent(page);
}

/** Collapses whitespace and trims a nullable text value. */
function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() || "";
}

/** Extracts the profile viewer and post impression counts from the feed page. */
async function extractFeedMetrics(page: Page): Promise<FeedMetrics> {
  logStep("Extracting feed metrics from page DOM");

  return page.evaluate<FeedMetrics>(() => {
    /** Normalizes DOM text for consistent matching. */
    const normalize = (value: string | null | undefined): string => value?.replace(/\s+/g, " ").trim() || "";
    const numericPattern = /^\d[\d,]*$/;

    /** Returns true when the element is visible and contains readable text. */
    const isVisible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && normalize(element.innerText).length > 0;
    };

    /** Collects unique visible text fragments from a container subtree. */
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

    /** Finds the numeric value adjacent to a matching metric label. */
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

    /** Returns nearby visible text to aid debugging when extraction fails. */
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

    /** Locates a metric label in the DOM and resolves its numeric value. */
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

/** Reads previously stored metric history from disk. */
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

/** Appends the current metric snapshot to the local history file. */
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

/** Logs and prints the extracted metrics as formatted JSON. */
function printMetrics(data: FeedMetrics): void {
  logStep(`Extracted metrics: ${JSON.stringify(data)}`);
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/** Runs the full LinkedIn scrape flow and persists the extracted metrics. */
async function main(): Promise<void> {
  logStep("Starting LinkedIn profile activity scrape");
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await launchBrowserContext();
    page = await getPage(context);
    await ensureAuthenticatedSession(page);
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
    if (context) {
      logStep("Closing browser");
      await context.close();
    }
  }
}

await main();
