import { MODEL_TEST_DEADLINE_MS } from "@smthrs/rpc/ConfiguredModel"
import { scenario } from "./coverage/types"
import { PROVIDER_CONFIDENCE, PROVIDER_ECHO_LEAD, PROVIDER_MODEL, PROVIDER_REPLY } from "./support/model-provider-behaviors"
import { runnerCredential } from "./support/model-provider-process"
import { closeComposer, command, expect, openComposer, test } from "./support"
import {
  ACCEPTED_CREDENTIAL, REJECTED_CREDENTIAL, askModel, boot, captureTraffic, composeModel, composerCard, createModel, credentialSha256, fillModelForm,
  listModels, maximize, modelDetail, modelRow, modelsCard, pageText, providerJournal, providerOrigin, testModel, seatSelect, uniqueName,
  type ModelDraft
} from "./models/ui"

/*
 * Every scenario here is host:local. The runner host reaches the real loopback
 * provider using operator credentials.
 */
test.setTimeout(120_000)

const chat = (name: string, extra: Partial<ModelDraft> = {}): ModelDraft => ({
  name, protocol: "openai-chat", baseUrl: providerOrigin(), modelId: PROVIDER_MODEL.answers, credential: ACCEPTED_CREDENTIAL, ...extra
})

test("a model is created through its form and listed", scenario("models.create", {
  capabilities: [],
  coverage: ["action:model.list", "action:model.new", "action:form.submit", "host:local", "path:success", "door:slash", "door:button", "evidence:models-card-readback"]
}), async ({ page }) => {
  await boot(page)
  const name = uniqueName("e2e-created")
  const row = await createModel(page, chat(name))
  await expect(row).toContainText(name)
  await expect(row).toContainText("generation")
  await expect(row).toHaveAttribute("data-test-state", "idle")
  await expect(row).not.toHaveAttribute("data-builtin", "true")
  await maximize(page)
  await expect(modelDetail(page)).toContainText(PROVIDER_MODEL.answers)
  await expect(modelDetail(page)).toContainText(providerOrigin())
  // The credential is a NAME the host holds; the card says whether the host holds it.
  await expect(modelDetail(page).getByTestId("model-credential")).toHaveText(ACCEPTED_CREDENTIAL)
  await expect(modelDetail(page).getByTestId("model-credential")).toHaveAttribute("data-present", "true")
})

test("the bare /model door opens the models card", scenario("models.bare-door", {
  capabilities: [],
  coverage: ["action:model", "host:local", "path:success", "door:slash", "evidence:models-card-readback"]
}), async ({ page }) => {
  await boot(page)
  const forms = page.locator('.smithers-card[data-kind="flow-form"]')
  const before = await forms.count()
  const card = await listModels(page, "/model")
  await expect(card.getByTestId("model-new")).toBeVisible()
  // The whole name is the act: Enter on `/model` must not open a form.
  await expect(forms).toHaveCount(before)
})

test("a model saved past the embedded card's few rows is still the row in view", scenario("models.embedded-overflow", {
  capabilities: [],
  coverage: ["action:model.list", "action:model.save", "action:model.new", "action:form.submit", "host:local", "path:success", "door:slash", "door:button", "dimension:overflow", "evidence:models-card-readback"]
}), async ({ page }) => {
  await boot(page)
  await listModels(page)
  const stem = uniqueName("e2e-many")
  for (const index of [0, 1, 2, 3]) {
    await command(page, `/model.save --name ${stem}-${index} --protocol openai-chat --model ${PROVIDER_MODEL.answers} --credential ${ACCEPTED_CREDENTIAL} --url ${providerOrigin()}`)
    await closeComposer(page)
    await expect(modelRow(page, `${stem}-${index}`)).toBeVisible()
  }
  const row = await createModel(page, chat(`${stem}-last`))
  await expect(modelsCard(page).getByTestId("models-more")).toBeVisible()
  await expect(row.getByRole("button", { name: "Test", exact: true })).toBeVisible()
})

test("a model is listed after a reload", scenario("models.persist-reload", {
  capabilities: [],
  coverage: ["action:model.list", "action:model.new", "host:local", "path:persistence", "door:slash", "dimension:immediate-reload", "evidence:persisted-state-after-reload"]
}), async ({ page }) => {
  await boot(page)
  const name = uniqueName("e2e-durable")
  await createModel(page, chat(name))
  await page.reload()
  await boot(page)
  await listModels(page)
  await expect(modelRow(page, name)).toBeVisible()
  await expect(modelRow(page, name)).toHaveAttribute("data-test-state", "idle")
})

test("Test goes green with the measured latency, signed with the credential the host resolved by name", scenario("models.test-passes", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "host:local", "path:success", "door:button", "dimension:credential-by-name", "dimension:streaming", "dimension:credential-value-absent", "evidence:provider-request-journal"]
}), async ({ page }) => {
  const traffic = captureTraffic(page)
  await boot(page)
  const before = (await providerJournal()).length
  const row = await createModel(page, chat(uniqueName("e2e-green")))
  const pressedAt = Date.now()
  const result = await testModel(page, row)
  if (!result.ok) throw new Error(`Expected a pass, received ${JSON.stringify(result)}`)
  await expect(row).toHaveAttribute("data-test-state", "passed")
  await expect(row.locator(".models-dot")).toHaveCount(1)
  // The latency drawn is a measurement of this press: it cannot exceed the time the press took.
  expect(result.latencyMs).toBeLessThanOrEqual(Date.now() - pressedAt)
  await expect(row).not.toHaveAttribute("data-failure-code", /.*/)
  const journal = (await providerJournal()).slice(before)
  expect(journal).toHaveLength(1)
  expect(journal[0]).toMatchObject({ protocol: "openai-chat", modelId: PROVIDER_MODEL.answers, status: 200, authorized: true })
  // The host sent exactly the value it read under the name; the journal holds its hash alone.
  expect(journal[0]!.credentialSha256).toBe(credentialSha256(ACCEPTED_CREDENTIAL))
  const secret = runnerCredential(ACCEPTED_CREDENTIAL)
  expect(await pageText(page)).not.toContain(secret)
  expect(await traffic.read()).not.toContain(secret)
  expect(JSON.stringify(await providerJournal())).not.toContain(secret)
})

test("an Anthropic Messages model tests green over its own key header", scenario("models.test-anthropic-passes", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "host:local", "path:success", "door:button", "dimension:anthropic-messages", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const row = await createModel(page, chat(uniqueName("e2e-anthropic"), { protocol: "anthropic-messages" }))
  expect((await testModel(page, row)).ok).toBe(true)
  await expect(row).toHaveAttribute("data-test-state", "passed")
  const journal = (await providerJournal()).slice(before)
  expect(journal).toHaveLength(1)
  expect(journal[0]).toMatchObject({ protocol: "anthropic-messages", status: 200, authorized: true, credentialSha256: credentialSha256(ACCEPTED_CREDENTIAL) })
  expect(journal[0]!.headers["anthropic-version"]).toBeDefined()
})

test("a rejected key fails typed, and Edit to the accepted credential turns it green", scenario("models.test-key-rejected", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "action:model.edit", "action:form.submit", "host:local", "path:error", "door:button", "dimension:typed-failure", "dimension:retry", "dimension:credential-value-absent", "evidence:provider-request-journal"]
}), async ({ page }) => {
  const traffic = captureTraffic(page)
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-revoked")
  const row = await createModel(page, chat(name, { credential: REJECTED_CREDENTIAL }))
  const result = await testModel(page, row)
  expect(result).toMatchObject({ ok: false, failure: { code: "refused", status: 401 }, fault: "user" })
  await expect(row).toHaveAttribute("data-test-state", "failed")
  await expect(row).toHaveAttribute("data-failure-code", "refused")
  await expect(row).toHaveAttribute("data-failure-fault", "user")
  const journal = (await providerJournal()).slice(before)
  expect(journal).toHaveLength(1)
  expect(journal[0]).toMatchObject({ status: 401, authorized: false, credentialSha256: credentialSha256(REJECTED_CREDENTIAL) })
  // The failure surfaced the card as the one row and the one button that mend it.
  const attention = modelsCard(page).getByTestId("models-attention")
  await expect(attention).toHaveAttribute("data-kind", "test-failed")
  await attention.getByTestId("models-attention-fix").click()
  await fillModelForm(page, { credential: ACCEPTED_CREDENTIAL })
  await expect(modelRow(page, name).getByRole("button", { name: "Test", exact: true })).toBeVisible()
  expect((await testModel(page, modelRow(page, name))).ok).toBe(true)
  await expect(modelRow(page, name)).toHaveAttribute("data-test-state", "passed")
  for (const secret of [runnerCredential(ACCEPTED_CREDENTIAL), runnerCredential(REJECTED_CREDENTIAL)]) {
    expect(await pageText(page)).not.toContain(secret)
    expect(await traffic.read()).not.toContain(secret)
    expect(JSON.stringify(await providerJournal())).not.toContain(secret)
  }
})

test("a rate-limited provider fails typed after exactly one request", scenario("models.test-rate-limited", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "host:local", "path:error", "door:button", "dimension:typed-failure", "dimension:no-retry", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const row = await createModel(page, chat(uniqueName("e2e-limited"), { modelId: PROVIDER_MODEL.rateLimited }))
  const result = await testModel(page, row)
  expect(result).toMatchObject({ ok: false, failure: { code: "refused", status: 429 }, fault: "wait" })
  await expect(row).toHaveAttribute("data-failure-code", "refused")
  await expect(row).toHaveAttribute("data-failure-fault", "wait")
  // One Test is one request: the retry ladder is never spent on it.
  const journal = (await providerJournal()).slice(before)
  expect(journal.map((entry) => entry.status)).toEqual([429])
  // The record is not what is wrong, so the one button the failure surfaces tries again.
  const fix = modelsCard(page).getByTestId("models-attention-fix")
  await expect(fix).toHaveText("Test")
  await fix.click()
  await expect.poll(async () => (await providerJournal()).slice(before).map((entry) => entry.status)).toEqual([429, 429])
})

test("a slow provider fails at the deadline the host armed, and chat stays usable meanwhile", scenario("models.test-deadline", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "action:palette.open", "host:local", "path:error", "door:button", "dimension:typed-failure", "dimension:deadline-from-record", "dimension:instant-acknowledgment", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const row = await createModel(page, chat(uniqueName("e2e-slow"), { modelId: PROVIDER_MODEL.slow }))
  const pressedAt = Date.now()
  const settled = testModel(page, row)
  // Requested at once: the row runs, a second press has nothing to press, and the composer still takes input.
  await expect(row).toHaveAttribute("data-test-state", "running")
  await expect(row.getByRole("button", { name: "Test", exact: true })).toBeDisabled()
  await openComposer(page)
  await page.getByTestId("composer-input").fill("still here")
  await expect(page.getByTestId("composer-input")).toHaveValue("still here")
  await page.getByTestId("composer-input").fill("")
  await closeComposer(page)
  const result = await settled
  if (result.ok || result.failure.code !== "timeout") throw new Error(`Expected a timeout, received ${JSON.stringify(result)}`)
  expect(result.fault).toBe("dependency")
  await expect(row).toHaveAttribute("data-failure-code", "timeout")
  await expect(row).toHaveAttribute("data-failure-fault", "dependency")
  // The threshold drawn is the one deadline the host arms, and the press waited it out.
  expect(result.failure.deadlineMs).toBe(MODEL_TEST_DEADLINE_MS)
  expect(Date.now() - pressedAt).toBeGreaterThanOrEqual(MODEL_TEST_DEADLINE_MS)
  await expect(row).toContainText(`timeout · ${MODEL_TEST_DEADLINE_MS} ms`)
  expect((await providerJournal()).slice(before)).toHaveLength(1)
})

test("a provider that answers in no protocol fails typed", scenario("models.test-garbled", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "host:local", "path:error", "door:button", "dimension:typed-failure", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const row = await createModel(page, chat(uniqueName("e2e-garbled"), { modelId: PROVIDER_MODEL.garbled }))
  expect(await testModel(page, row)).toMatchObject({ ok: false, failure: { code: "invalid", field: "protocol" } })
  await expect(row).toHaveAttribute("data-failure-code", "invalid")
  await expect(row).toContainText("invalid · protocol")
  expect((await providerJournal()).slice(before).map((entry) => entry.status)).toEqual([200])
})

test("an origin the credential is not pinned to is forbidden before any request leaves", scenario("models.test-endpoint-forbidden", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "host:local", "path:error", "door:button", "dimension:typed-failure", "dimension:credential-origin-pin", "dimension:no-egress", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  // The same loopback host on another port: a different origin, so not the one the operator declared.
  const elsewhere = new URL(providerOrigin())
  elsewhere.port = String(Number(elsewhere.port) === 65_535 ? 65_534 : Number(elsewhere.port) + 1)
  for (const [label, baseUrl] of [["e2e-elsewhere", elsewhere.origin], ["e2e-remote", "https://models.example.com"]] as const) {
    const row = await createModel(page, chat(uniqueName(label), { baseUrl }))
    expect(await testModel(page, row)).toMatchObject({ ok: false, failure: { code: "endpoint_forbidden" }, fault: "user" })
    await expect(row).toHaveAttribute("data-failure-code", "endpoint_forbidden")
    await expect(row).toHaveAttribute("data-failure-fault", "user")
    await expect(row).toContainText("endpoint_forbidden")
  }
  expect(await providerJournal()).toHaveLength(before)
})

test("a credential name no operator declared is unknown, and is never read from the environment", scenario("models.test-credential-unknown", {
  capabilities: [],
  coverage: ["action:model.save", "action:model.test", "host:local", "path:error", "door:slash", "door:button", "dimension:typed-failure", "dimension:no-egress", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-undeclared")
  await listModels(page)
  // HOME is set on every host; without the declared pair it is not a credential.
  await command(page, `/model.save --name ${name} --protocol openai-chat --model ${PROVIDER_MODEL.answers} --credential HOME --url ${providerOrigin()}`)
  await closeComposer(page)
  const row = modelRow(page, name)
  await expect(row).toBeVisible()
  expect(await testModel(page, row)).toMatchObject({ ok: false, failure: { code: "credential_unknown", credential: "HOME" }, fault: "user" })
  await expect(row).toHaveAttribute("data-failure-code", "credential_unknown")
  await expect(row).toContainText("credential_unknown · HOME")
  expect(await providerJournal()).toHaveLength(before)
})

test("Edit changes a model in place and the change survives a reload", scenario("models.edit", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.edit", "action:model.show", "action:form.submit", "action:model.list", "host:local", "path:success", "path:persistence", "door:button", "evidence:persisted-state-after-reload"]
}), async ({ page }) => {
  await boot(page)
  const name = uniqueName("e2e-edited")
  await createModel(page, chat(name))
  // Pressed in the pane: the form is a card in the transcript, so the pane gives way to it.
  await maximize(page)
  // A pane row carries Test and Compose; Edit and Remove are the selected model's acts, beside its facts.
  await modelRow(page, name).locator(".models-row-select").click()
  await modelDetail(page).getByRole("button", { name: "Edit", exact: true }).click()
  await expect(modelsCard(page)).toHaveAttribute("data-maximized", "false")
  await fillModelForm(page, { modelId: PROVIDER_MODEL.garbled })
  await maximize(page)
  await modelRow(page, name).locator('[data-flow="model.show"]').click()
  await expect(modelRow(page, name)).toHaveAttribute("data-selected", "true")
  await expect(modelDetail(page)).toContainText(PROVIDER_MODEL.garbled)
  await expect(modelsCard(page).locator("[data-model-id]").filter({ hasText: name })).toHaveCount(1)
  await page.reload()
  await boot(page)
  await listModels(page)
  await maximize(page)
  await modelRow(page, name).locator('[data-flow="model.show"]').click()
  await expect(modelDetail(page)).toContainText(PROVIDER_MODEL.garbled)
  await expect(modelDetail(page)).not.toContainText(PROVIDER_MODEL.answers)
})

test("Remove deletes a model for good and hands its seat back to the host", scenario("models.remove", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.assign", "action:model.remove", "action:model.list", "host:local", "path:success", "path:persistence", "door:button", "evidence:persisted-state-after-reload"]
}), async ({ page }) => {
  await boot(page)
  const name = uniqueName("e2e-removed")
  await createModel(page, chat(name))
  await maximize(page)
  await seatSelect(page, "explainer").selectOption(name)
  await expect(seatSelect(page, "explainer")).toHaveValue(name)
  await modelRow(page, name).locator(".models-row-select").click()
  await modelDetail(page).getByRole("button", { name: "Remove", exact: true }).click()
  await expect(modelRow(page, name)).toHaveCount(0)
  await expect(seatSelect(page, "explainer")).toHaveValue("default")
  await expect(seatSelect(page, "explainer").locator(`option[value="${name}"]`)).toHaveCount(0)
  await page.reload()
  await boot(page)
  await listModels(page)
  await expect(modelRow(page, name)).toHaveCount(0)
})

test("a model assigned to a seat is still assigned after a reload, and Default hands the seat back", scenario("models.assign-seat", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.assign", "action:model.list", "host:local", "path:success", "path:persistence", "door:button", "dimension:immediate-reload", "evidence:persisted-state-after-reload"]
}), async ({ page }) => {
  await boot(page)
  const name = uniqueName("e2e-seated")
  await createModel(page, chat(name))
  await maximize(page)
  const seat = seatSelect(page, "explainer")
  await expect(seat).toHaveValue("default")
  await seat.selectOption(name)
  await expect(seat).toHaveValue(name)
  await expect(modelsCard(page).locator('[data-seat-row="explainer"]')).toHaveAttribute("data-resolvable", "true")
  await page.reload()
  await boot(page)
  await listModels(page)
  await maximize(page)
  await expect(seatSelect(page, "explainer")).toHaveValue(name)
  await seatSelect(page, "explainer").selectOption("default")
  await expect(seatSelect(page, "explainer")).toHaveValue("default")
  await page.reload()
  await boot(page)
  await listModels(page)
  await maximize(page)
  await expect(seatSelect(page, "explainer")).toHaveValue("default")
})

test("an explanation is answered by the model assigned to the Explainer seat", scenario("models.seat-explainer-answers", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.assign", "action:agent.explain", "host:local", "path:success", "door:slash", "door:button", "dimension:seat-consumer", "dimension:credential-value-absent", "evidence:provider-request-journal"]
}), async ({ page }) => {
  const traffic = captureTraffic(page)
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-explainer")
  await createModel(page, chat(name))
  await maximize(page)
  await seatSelect(page, "explainer").selectOption(name)
  await expect(seatSelect(page, "explainer")).toHaveValue(name)
  await page.keyboard.press("Escape")
  await command(page, "/agent.explain the loopback provider")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="explain"]').last()
  await expect(card.locator(".explain-card")).toHaveAttribute("data-phase", "answered")
  // The provider's own words, and the card names the model the request carried.
  await expect(card).toContainText(PROVIDER_REPLY.join(""))
  await expect(card.locator(".explain-card-by")).toHaveText(name)
  const journal = (await providerJournal()).slice(before)
  expect(journal).toHaveLength(1)
  expect(journal[0]).toMatchObject({ protocol: "openai-chat", modelId: PROVIDER_MODEL.answers, status: 200, authorized: true, credentialSha256: credentialSha256(ACCEPTED_CREDENTIAL) })
  // A provider that says the credential back: the words around it arrive, the value does not.
  const echo = uniqueName("e2e-explainer-echo")
  await createModel(page, chat(echo, { modelId: PROVIDER_MODEL.echoes }))
  await maximize(page)
  await seatSelect(page, "explainer").selectOption(echo)
  await expect(seatSelect(page, "explainer")).toHaveValue(echo)
  await page.keyboard.press("Escape")
  await command(page, "/agent.explain what the provider was sent")
  await closeComposer(page)
  const echoed = page.locator('.smithers-card[data-kind="explain"]').last()
  await expect(echoed.locator(".explain-card-by")).toHaveText(echo)
  await expect(echoed.locator(".explain-card")).toHaveAttribute("data-phase", "answered")
  await expect(echoed).toContainText(PROVIDER_ECHO_LEAD.trim())
  const secret = runnerCredential(ACCEPTED_CREDENTIAL)
  expect(await echoed.innerText()).not.toContain(secret)
  expect((await providerJournal()).slice(before).map((entry) => [entry.modelId, entry.authorized])).toEqual([[PROVIDER_MODEL.answers, true], [PROVIDER_MODEL.echoes, true]])
  expect(await pageText(page)).not.toContain(secret)
  const crossed = await traffic.read()
  // The turn's own frames were read: the provider's words are in them, and the value is not.
  expect(crossed).toContain(JSON.stringify({ text: PROVIDER_ECHO_LEAD }).slice(1, -1))
  expect(crossed).not.toContain(secret)
})

test("a decision model tests green over the evaluation protocol and no generation seat offers it", scenario("models.decision-test-passes", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "host:local", "path:success", "door:button", "dimension:evaluation-protocol", "dimension:seat-kind", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-decision")
  const row = await createModel(page, chat(name, { protocol: "evaluation" }))
  await expect(row).toContainText("decision")
  const pressedAt = Date.now()
  const result = await testModel(page, row)
  if (!result.ok) throw new Error(`Expected a pass, received ${JSON.stringify(result)}`)
  await expect(row).toHaveAttribute("data-test-state", "passed")
  expect(result.latencyMs).toBeLessThanOrEqual(Date.now() - pressedAt)
  const journal = (await providerJournal()).slice(before)
  expect(journal).toHaveLength(1)
  expect(journal[0]).toMatchObject({ protocol: "evaluation", modelId: PROVIDER_MODEL.answers, status: 200, authorized: true, credentialSha256: credentialSha256(ACCEPTED_CREDENTIAL) })
  expect(journal[0]!.headers["ai-model-id"]).toBe(PROVIDER_MODEL.answers)
  await maximize(page)
  await expect(seatSelect(page, "explainer").locator(`option[value="${name}"]`)).toHaveCount(0)
})

test("a decision model with a rejected key fails typed and asks nothing else", scenario("models.decision-test-refused", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "host:local", "path:error", "door:button", "dimension:typed-failure", "dimension:evaluation-protocol", "dimension:no-fallback", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const row = await createModel(page, chat(uniqueName("e2e-decision-revoked"), { protocol: "evaluation", credential: REJECTED_CREDENTIAL }))
  const result = await testModel(page, row)
  expect(result).toMatchObject({ ok: false, failure: { code: "refused", status: 401 }, fault: "user" })
  await expect(row).toHaveAttribute("data-failure-code", "refused")
  const journal = (await providerJournal()).slice(before)
  expect(journal.map((entry) => [entry.protocol, entry.status])).toEqual([["evaluation", 401]])
})

test("the chat-embedded Models card maximizes to its pane and collapses by keyboard", scenario("models.card-maximize", {
  capabilities: [],
  coverage: ["action:model.list", "action:model.new", "action:card.maximize", "action:card.minimize", "host:local", "path:keyboard", "door:slash", "door:button", "dimension:keyboard", "dimension:frame-identity"]
}), async ({ page }) => {
  await boot(page)
  const name = uniqueName("e2e-pane")
  await createModel(page, chat(name))
  const card = modelsCard(page)
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(card.locator('[data-presentation="embedded"]')).toBeVisible()
  await expect(card.getByTestId("model-seats")).toHaveCount(0)
  const open = card.getByRole("button", { name: "Maximize card", exact: true })
  await open.focus()
  await open.press("Enter")
  await expect(card).toHaveAttribute("data-maximized", "true")
  await expect(card.getByRole("button", { name: "Restore", exact: true })).toBeFocused()
  await expect(card.locator('[data-presentation="maximized"]')).toBeVisible()
  await expect(modelRow(page, name)).toBeVisible()
  await expect(modelDetail(page)).toBeVisible()
  await expect(card.getByTestId("model-seats")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(card).toHaveAttribute("data-maximized", "false")
  await expect(card.locator('[data-presentation="embedded"]')).toBeVisible()
  await expect(open).toBeFocused()
})


test("a decision request is composed with a question of each kind, asked, answered per question, and kept across a reload", scenario("models.compose-decision", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.compose", "action:model.question", "action:model.option", "action:model.state", "action:model.ask", "host:local", "path:success", "path:persistence", "door:button", "dimension:evaluation-protocol", "dimension:typed-questions", "dimension:instant-acknowledgment", "evidence:provider-request-journal", "evidence:persisted-state-after-reload"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-composed")
  await createModel(page, chat(name, { protocol: "evaluation" }))
  // Compose from the maximized pane: the composer is a card in the transcript, so the pane returns the card there.
  await maximize(page)
  const composer = await composeModel(page, modelDetail(page), name)
  await expect(modelsCard(page)).toHaveAttribute("data-maximized", "false")
  const body = composer.getByTestId("model-call")
  // Prefilled from the fixed Test: one text field, one boolean question, nothing answered yet.
  await expect(body).toHaveAttribute("data-kind", "decision")
  await expect(composer.locator('[data-field="text"] input[type="text"]')).toHaveValue("The sky is blue.")
  await expect(composer.locator("[data-question]")).toHaveCount(1)
  await expect(composer.getByTestId("model-call-result")).toHaveCount(0)
  // A second question, made a choice with two options; a third, made a score with two rungs.
  await composer.getByTestId("model-call-question-add").click()
  const q1 = composer.locator('[data-question="q1"]')
  await expect(q1).toHaveAttribute("data-question-type", "boolean")
  // Nothing asked yet: the request says so and Ask waits.
  await expect(composer.getByTestId("model-call-problem")).toHaveAttribute("data-problem", "question_empty")
  await expect(composer.getByTestId("model-call-ask")).toBeDisabled()
  await q1.getByLabel("q1 kind").selectOption("choice")
  await expect(q1).toHaveAttribute("data-question-type", "choice")
  await q1.getByLabel("q1 question").fill("Which is it?")
  await expect(composer.getByTestId("model-call-problem")).toHaveAttribute("data-problem", "options_count")
  await q1.getByTestId("model-call-option-add").click()
  await q1.getByTestId("model-call-option-add").click()
  await expect(q1.locator("[data-option]")).toHaveCount(2)
  await q1.locator('[data-option="option1"]').getByLabel("About option1").fill("the sky")
  await composer.getByTestId("model-call-question-add").click()
  const q2 = composer.locator('[data-question="q2"]')
  await q2.getByLabel("q2 kind").selectOption("score")
  await q2.getByLabel("q2 question").fill("How blue?")
  await q2.getByTestId("model-call-option-add").click()
  await q2.getByTestId("model-call-option-add").click()
  await expect(q2.locator("[data-option]")).toHaveCount(2)
  // The id is the person's: renamed in place, the question keeps its kind, wording, options and place.
  await q1.getByLabel("Id").fill("pick")
  await q1.getByLabel("Id").blur()
  const pick = composer.locator('[data-question="pick"]')
  await expect(pick).toHaveAttribute("data-question-type", "choice")
  await expect(pick.locator("[data-option]")).toHaveCount(2)
  await expect(pick.getByLabel("pick question")).toHaveValue("Which is it?")
  await expect(composer.locator('[data-question="q1"]')).toHaveCount(0)
  // A field of another kind joins the state.
  await composer.getByTestId("model-call-field-add").click()
  const field = composer.locator('[data-field="field1"]')
  await field.getByLabel("Kind").selectOption("boolean")
  await expect(field).toHaveAttribute("data-field-kind", "boolean")
  // The box is the store's projection: it flips once the flow has written, not on the click itself.
  await field.locator('input[type="checkbox"]').click()
  await expect(field.locator('input[type="checkbox"]')).toBeChecked()
  await expect(composer.getByTestId("model-call-problem")).toHaveCount(0)
  await expect(composer.getByTestId("model-call-ask")).toBeEnabled()
  const result = await askModel(page, composer)
  expect(result.ok).toBe(true)
  expect(result.answers).toEqual({ ok: `yes · ${PROVIDER_CONFIDENCE.toFixed(2)}`, pick: `option1 · ${PROVIDER_CONFIDENCE.toFixed(2)}`, q2: "rung2 · 1" })
  await expect(body).toHaveAttribute("data-stale", "false")
  const journal = (await providerJournal()).slice(before)
  expect(journal).toHaveLength(1)
  expect(journal[0]).toMatchObject({ protocol: "evaluation", authorized: true, questions: ["ok", "pick", "q2"], state: { text: "The sky is blue.", field1: true } })
  // The fixture is the answer as every test in the repo scripts an evaluator, under the ids the person chose.
  await composer.getByTestId("model-call-fixture").click()
  await expect(composer.getByTestId("model-call-fixture-text")).toContainText("Evaluator.layerScripted")
  await expect(composer.getByTestId("model-call-fixture-text")).toContainText(`["pick"]: { choice: "option1"`)
  // A score carries its distribution by rung index, so a replay is as sure as this answer was and no surer.
  await expect(composer.getByTestId("model-call-fixture-text")).toContainText(`["q2"]: { score: 1, probabilities: { ["0"]: 0, ["1"]: 1 } }`)
  await page.reload()
  await boot(page)
  const kept = composerCard(page, name)
  await expect(kept.locator("[data-question]")).toHaveCount(3)
  await expect(kept.locator('[data-question="pick"] [data-option]')).toHaveCount(2)
  await expect(kept.getByTestId("model-call-answer")).toHaveCount(3)
  await expect(kept.getByTestId("model-call")).toHaveAttribute("data-stale", "false")
})

test("a generation request is composed and asked, and an edit after the answer reads stale until asked again", scenario("models.compose-generation", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.compose", "action:model.prompt", "action:model.ask", "host:local", "path:success", "door:button", "dimension:streaming", "dimension:stale-answer", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-prompted")
  const row = await createModel(page, chat(name))
  const composer = await composeModel(page, row, name)
  const body = composer.getByTestId("model-call")
  await expect(body).toHaveAttribute("data-kind", "generation")
  await expect(composer.getByTestId("model-call-prompt")).toHaveValue("Reply with the single word: ok")
  // Never tested: there is no last test to go back to, so nothing offers it.
  await expect(composer.getByTestId("model-call-recall")).toHaveCount(0)
  await composer.getByTestId("model-call-system").fill("Answer tersely.")
  await composer.getByTestId("model-call-prompt").fill("ping?")
  // Digits past what a number holds exactly are no Max tokens: the box keeps them beside the reason, Ask waits, and nothing leaves.
  await composer.getByTestId("model-call-max-tokens").fill("99999999999999999999")
  await expect(composer.getByTestId("model-call-problem")).toHaveAttribute("data-problem", "max_tokens")
  await expect(composer.getByTestId("model-call-ask")).toBeDisabled()
  await composer.getByTestId("model-call-max-tokens").fill("64")
  await expect(composer.getByTestId("model-call-problem")).toHaveCount(0)
  // What is on screen is what Ask reads: a temperature the request cannot carry stays in its box beside the reason, Ask waits, and nothing leaves.
  const temperature = composer.getByTestId("model-call-temperature")
  await temperature.fill("0.2")
  await temperature.fill("3")
  await expect(composer.getByTestId("model-call-problem")).toHaveAttribute("data-problem", "temperature")
  await expect(temperature).toHaveValue("3")
  await expect(temperature).toHaveAttribute("aria-invalid", "true")
  await expect(composer.getByTestId("model-call-ask")).toBeDisabled()
  expect((await providerJournal()).slice(before)).toHaveLength(0)
  await temperature.fill("0.2")
  await expect(composer.getByTestId("model-call-problem")).toHaveCount(0)
  const first = await askModel(page, composer)
  expect(first).toMatchObject({ ok: true, text: PROVIDER_REPLY.join("") })
  await expect(temperature).toHaveValue("0.2")
  await expect(body).toHaveAttribute("data-stale", "false")
  await expect(composer.getByTestId("model-call-ask")).toHaveText("Ask again")
  // The answer belongs to the request it answered: edit the request and it stands, struck.
  await composer.getByTestId("model-call-prompt").fill("pong?")
  await expect(body).toHaveAttribute("data-stale", "true")
  await expect(composer.getByTestId("model-call-text")).toHaveText(PROVIDER_REPLY.join(""))
  const second = await askModel(page, composer)
  expect(second.ok).toBe(true)
  await expect(body).toHaveAttribute("data-stale", "false")
  const journal = (await providerJournal()).slice(before)
  expect(journal).toHaveLength(2)
  expect(journal[0]).toMatchObject({ protocol: "openai-chat", status: 200, authorized: true, system: true, maxTokens: 64, temperature: 0.2 })
})

test("an answer archived with its conversation is gone when the conversation returns to a model rebound meanwhile", scenario("models.compose-archive-rebind", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.compose", "action:model.ask", "action:chat.clear", "action:model.edit", "action:form.submit", "host:local", "path:success", "door:button", "door:slash", "dimension:archive-restore", "dimension:rebound-binding", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-archived")
  const row = await createModel(page, chat(name))
  const composer = await composeModel(page, row, name)
  expect(await askModel(page, composer)).toMatchObject({ ok: true, text: PROVIDER_REPLY.join("") })
  await command(page, "/chat.clear")
  const back = page.getByRole("link", { name: "Open the archived conversation" })
  await expect(back).toBeVisible()
  await closeComposer(page)
  await expect(composer).toHaveCount(0)
  // Rebound from the new conversation, where the composer is not a live card.
  await listModels(page)
  await modelRow(page, name).getByRole("button", { name: "Edit", exact: true }).click()
  await fillModelForm(page, { modelId: PROVIDER_MODEL.echoes })
  await expect(page.locator('.flow-form[data-flow-name="model.save"]').getByTestId("flow-form-submit")).toHaveCount(0)
  await back.click()
  await expect(composer).toBeVisible()
  // The first binding's words are not the second's: the card returns with its request and no answer.
  await expect(composer.getByTestId("model-call-result")).toHaveCount(0)
  await expect(composer.getByTestId("model-call-text")).toHaveCount(0)
  await expect(composer.getByTestId("model-call-ask")).toHaveText("Ask")
  await expect(composer.getByTestId("model-call-ask")).toBeEnabled()
  expect((await askModel(page, composer)).ok).toBe(true)
  expect((await providerJournal()).slice(before).map((entry) => entry.modelId)).toEqual([PROVIDER_MODEL.answers, PROVIDER_MODEL.echoes])
})

test("the composer prefills from the model's last Test, and Last test brings it back to ask again", scenario("models.compose-recall", {
  capabilities: [],
  coverage: ["action:model.new", "action:model.test", "action:model.compose", "action:model.question", "action:model.recall", "action:model.ask", "host:local", "path:success", "door:button", "dimension:prefill-from-record", "evidence:provider-request-journal"]
}), async ({ page }) => {
  await boot(page)
  const before = (await providerJournal()).length
  const name = uniqueName("e2e-recalled")
  const row = await createModel(page, chat(name, { protocol: "evaluation" }))
  expect((await testModel(page, row)).ok).toBe(true)
  const composer = await composeModel(page, row, name)
  // The Test's own request and the answer it recorded, already on the card.
  await expect(composer.locator('[data-question="ok"]')).toHaveAttribute("data-question-type", "boolean")
  await expect(composer.locator('[data-question="ok"]').getByTestId("model-call-answer")).toHaveText(`yes · ${PROVIDER_CONFIDENCE.toFixed(2)}`)
  await expect(composer.getByTestId("model-call-result")).toHaveAttribute("data-ok", "true")
  await expect(composer.getByTestId("model-call")).toHaveAttribute("data-stale", "false")
  await composer.getByTestId("model-call-question-add").click()
  await expect(composer.locator("[data-question]")).toHaveCount(2)
  await expect(composer.getByTestId("model-call")).toHaveAttribute("data-stale", "true")
  await composer.getByTestId("model-call-recall").click()
  await expect(composer.locator("[data-question]")).toHaveCount(1)
  await expect(composer.getByTestId("model-call")).toHaveAttribute("data-stale", "false")
  const again = await askModel(page, composer)
  expect(again).toMatchObject({ ok: true, answers: { ok: `yes · ${PROVIDER_CONFIDENCE.toFixed(2)}` } })
  const journal = (await providerJournal()).slice(before)
  expect(journal.map((entry) => entry.questions)).toEqual([["ok"], ["ok"]])
})

