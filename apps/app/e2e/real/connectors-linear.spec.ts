import { scenario } from "./coverage/types";
import { closeComposer, command, expect, openApp, test } from "./support/test";

const boot = async (page: Parameters<typeof openApp>[0]): Promise<void> => {
  await openApp(page);
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
};

test(
  "the real Connect card exposes every available repository door and keeps keyboard focus usable",
  scenario("connectors.connect-card-doors", {
    capabilities: [],
    coverage: [
      "action:connect",
      "action:auth.sign-in",
      "action:repos.import",
      "host:local",
      "host:production",
      "path:success",
      "path:keyboard",
      "door:slash",
      "door:button",
      "dimension:connector-store",
      "dimension:keyboard",
      "dimension:available-doors",
      "evidence:connect-card-readback",
    ],
    description:
      "Open the actual embedded Connect card and verify its live GitHub and Cloud repository doors and keyboard path without replacing either service.",
  }),
  async ({ page }) => {
    await boot(page);
    await command(page, "/connect");
    await closeComposer(page);

    const card = page.locator('.smithers-card[data-kind="connect"]').last();
    await expect(card).toBeVisible();
    await expect(card).toContainText("GitHub");
    await expect(card).toContainText("Smithers Cloud repository");
    const importButton = card.getByRole("button", { name: "Import", exact: true });
    await expect(importButton).toBeVisible();
    await importButton.focus();
    await expect(importButton).toBeFocused();
    await expect(importButton).toHaveAttribute("data-flow", "repos.import");
    await expect(card.locator('[data-flow="auth.sign-in"], [data-flow="auth.sign-out"]')).toHaveCount(1);
  },
);

test(
  "web Connect refuses local connector creation through the real native-app boundary",
  scenario("connectors.local-native-refusal", {
    capabilities: [],
    coverage: [
      "action:connector.add",
      "action:app.download.prompt",
      "host:local",
      "host:production",
      "path:permission",
      "door:slash",
      "dimension:native-boundary",
      "dimension:no-side-effect",
      "evidence:refusal-card",
    ],
    description:
      "Ask the web host to connect a local repository and require its real native-app refusal, with no connector card claiming a local connection.",
  }),
  async ({ page }) => {
    await boot(page);
    await command(page, "/connector.add read");
    await closeComposer(page);
    await expect(page.getByText(/connector\.add is not in the web app.*native app/i).last()).toBeVisible();
    await expect(page.locator('.smithers-card[data-kind="connector-setup"]')).toHaveCount(0);
    await expect(page.locator('.smithers-card[data-kind="connect"]')).toHaveCount(0);
  },
);

test(
  "Linear and issue linking refuse honestly on web without contacting a fake integration",
  scenario("connectors.linear-web-refusals", {
    capabilities: [],
    coverage: [
      "action:linear.connect",
      "action:linear.connect.open",
      "action:linear.connect.team",
      "action:linear.connect.repo",
      "action:linear.connect.confirm",
      "action:linear.sync",
      "action:linear.activity",
      "action:linear.disconnect",
      "action:issues.link-linear",
      "action:app.download.prompt",
      "host:local",
      "host:production",
      "path:permission",
      "door:slash",
      "dimension:linear-native-boundary",
      "dimension:no-side-effect",
      "evidence:refusal-card",
    ],
    description:
      "Exercise each Linear and issue-linking entry point that the web host cannot execute and verify every real response names the native Cloud-session boundary.",
  }),
  async ({ page }) => {
    await boot(page);
    for (const input of [
      "/linear.connect practice:smithersai/hello-server",
      "/linear.connect.open practice:smithersai/hello-server",
      "/linear.connect.team team-eng practice:smithersai/hello-server",
      "/linear.connect.repo practice:smithersai/hello-server acme/flows",
      "/linear.connect.confirm practice:smithersai/hello-server",
      "/linear.sync",
      "/linear.activity",
      "/linear.disconnect 7 ENG",
      "/issues.link-linear 3 ENG-482",
    ]) {
      await command(page, input);
      await closeComposer(page);
      await expect(page.getByText(/is not in the web app.*native app's Smithers Cloud session/i).last()).toBeVisible();
    }
    await expect(page.locator('.smithers-card[data-kind="connector-setup"]')).toHaveCount(0);
    await expect(page.locator('.smithers-card[data-kind="sync-ops"]')).toHaveCount(0);
  },
);
