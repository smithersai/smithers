import { projectRepositoryUpdate } from "../state/CardProjection"
import { expect, test } from "bun:test"
import { scopedControllers } from "../state/ControllerTestScope"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, silentAgent, unavailableRepositories } from "../state/TestFixtures"
import { PRACTICE_REPO } from "../state/practice/PracticeRepository"
import { payloadFor } from "./SlashPayload"

const createController = scopedControllers()
const setup = async (storage = memoryStorage()) => {
  const store = await createAppStore({kind:"localStorage",storage})
  let fetched = 0
  const controller = createController(store,unavailableRepositories,silentAgent,{fetchImpl:async()=>{fetched++; throw new Error("The example must stay offline")}})
  return {store,controller,fetched:()=>fetched}
}

test("repo update, read receipts, and tags execute through their registered slash/button paths", async () => {
  const {store,controller,fetched} = await setup()
  expect(payloadFor("repo.overview",PRACTICE_REPO)).toEqual({payload:{repo:PRACTICE_REPO}})
  expect((await controller.commands.run("repo.overview",PRACTICE_REPO)).status).toBe("executed")
  const card = [...store.collections.cards.values()].find(c=>c.kind==="repo-update")
  if(card?.kind!=="repo-update") throw new Error("No status card was rendered")
  expect(card.payload.openIssues).toBe(2)
  const first = card.payload.items[0]!
  expect(first.read).toBe(false)
  expect((await controller.commands.run("notifications.tag",`${first.id} needs research`)).status).toBe("executed")
  expect(store.collections.repositoryNotifications.get(first.id)?.tags).toContain("needs research")
  const rawTagged = store.collections.cards.get(card.id)
  const tagged = rawTagged?.kind === "repo-update" ? projectRepositoryUpdate(rawTagged, [...store.collections.repositoryNotifications.values()], [...store.collections.notificationReceipts.values()]) : rawTagged
  expect(tagged?.kind === "repo-update" && tagged.payload.items[0]?.tags).toContain("needs research")
  expect((await controller.commands.run("notifications.read-update",card.id)).status).toBe("executed")
  expect(store.collections.repositoryNotifications.get(first.id)?.readVersion).toBe(first.version)
  const rawRead = store.collections.cards.get(card.id)
  const read = rawRead?.kind === "repo-update" ? projectRepositoryUpdate(rawRead, [...store.collections.repositoryNotifications.values()], [...store.collections.notificationReceipts.values()]) : rawRead
  expect(read?.kind === "repo-update" && read.payload.items.every(item=>item.read)).toBe(true)
  expect((await controller.commands.run("repo.overview",PRACTICE_REPO)).status).toBe("executed")
  const refreshed = store.collections.cards.get(card.id)
  expect(refreshed?.kind === "repo-update" && refreshed.payload.items).toEqual([])
  expect(fetched()).toBe(0)
})

test("registered issue navigation, Back and Forward preserve one embedded frame", async () => {
  const {store,controller,fetched} = await setup()
  expect((await controller.commands.run("issues.list",`open ${PRACTICE_REPO}`)).status).toBe("executed")
  const list = store.collections.cards.get("practice-issues")!
  expect((await controller.commands.run("issues.view",`3 ${PRACTICE_REPO}`)).status).toBe("executed")
  expect(store.collections.cards.get(list.id)?.kind).toBe("issue")
  expect(payloadFor("card.history.back",list.id)).toEqual({payload:{cardId:list.id}})
  expect((await controller.commands.run("card.history.back",list.id)).status).toBe("executed")
  expect(store.collections.cards.get(list.id)?.kind).toBe("issue-list")
  expect((await controller.commands.run("card.history.forward",list.id)).status).toBe("executed")
  const detail=store.collections.cards.get(list.id)
  expect(detail?.kind === "issue" && detail.payload.number).toBe(3)
  expect(detail?.ordinal).toBe(list.ordinal)
  expect([...store.collections.cards.values()].filter(c=>c.kind==="issue-list"||c.kind==="issue")).toHaveLength(1)
  expect(fetched()).toBe(0)
})

test("the repository overview is the web pane's home: issues, a detail and a PR are locations in its one frame", async () => {
  const {store,controller,fetched} = await setup()
  expect((await controller.commands.run("repo.overview",PRACTICE_REPO)).status).toBe("executed")
  const overview = [...store.collections.cards.values()].find(c=>c.kind==="repo-update")
  if(overview?.kind!=="repo-update") throw new Error("No status card was rendered")
  expect((await controller.commands.run("issues.list",`open ${PRACTICE_REPO}`)).status).toBe("executed")
  expect([...store.collections.cards.values()]).toHaveLength(1)
  expect(store.collections.cards.get(overview.id)?.kind).toBe("issue-list")
  expect((await controller.commands.run("issues.view",`3 ${PRACTICE_REPO}`)).status).toBe("executed")
  expect(store.collections.cards.get(overview.id)?.kind).toBe("issue")
  expect((await controller.commands.run("prs.view",`4 ${PRACTICE_REPO}`)).status).toBe("executed")
  const detail = store.collections.cards.get(overview.id)
  expect(detail?.kind).toBe("pr")
  expect(detail?.navigation).toEqual({index:3,length:4})
  expect([...store.collections.cards.values()]).toHaveLength(1)
  expect((await controller.commands.run("card.history.back",overview.id)).status).toBe("executed")
  expect(store.collections.cards.get(overview.id)?.kind).toBe("issue")
  expect((await controller.commands.run("card.history.back",overview.id)).status).toBe("executed")
  expect(store.collections.cards.get(overview.id)?.kind).toBe("issue-list")
  expect((await controller.commands.run("card.history.back",overview.id)).status).toBe("executed")
  expect(store.collections.cards.get(overview.id)?.kind).toBe("repo-update")
  expect((await controller.commands.run("card.history.forward",overview.id)).status).toBe("executed")
  expect(store.collections.cards.get(overview.id)?.kind).toBe("issue-list")
  expect(fetched()).toBe(0)
})

test("numbered issue and PR targets accept explicit repositories before catalog loading", () => {
  for(const name of ["issues.view","issues.close","issues.reopen","prs.view","issue.flows","issue.repro","issue.implement"]){
    expect(payloadFor(name,"3 owner/not-loaded",undefined,new Set())).toEqual({payload:{number:3,repo:"owner/not-loaded"}})
  }
})


test("starting the tutorial gathers context, then Show issues is its first repository view", async () => {
  const { store, controller } = await setup()
  await controller.guideAct("start")
  expect(store.collections.repositoryContexts.size).toBe(1)
  expect([...store.collections.cards.values()].filter(card => card.kind === "repo-update")).toEqual([])
  expect((await controller.commands.run("repo.update", PRACTICE_REPO)).status).toBe("executed")
  expect([...store.collections.cards.values()].filter(card => card.kind === "repo-update")).toEqual([])
  expect((await controller.commands.run("issues.list", `open ${PRACTICE_REPO}`)).status).toBe("executed")
  expect([...store.collections.cards.values()].filter(card => card.kind === "issue-list")).toHaveLength(1)
})

test("replay clears only this conversation's practice presentation and fresh actions cannot restore old history", async () => {
  const storage = memoryStorage()
  const { store, controller } = await setup(storage)
  await controller.guideAct("start")
  await controller.commands.run("issues.list", `open ${PRACTICE_REPO}`)
  await controller.guideAct("next")
  await controller.commands.run("issues.view", `3 ${PRACTICE_REPO}`)
  expect(store.session().guide?.completed).toContain("issue.opened")
  const previous = store.collections.cards.get("practice-issues")!
  if (previous.kind !== "issue") throw new Error("Expected the completed practice issue presentation")
  expect(store.collections.cardHistories.has(previous.id)).toBe(true)
  const otherRepo = { ...previous, id: "other-repo", payload: { ...previous.payload, repo: "acme/real" } }
  const otherConversation = { ...previous, id: "other-conversation-practice", tabId: "chat:other" }
  await store.dispatch({ type: "card.upsert", actor: "system", card: otherRepo }).isPersisted.promise
  await store.dispatch({ type: "card.upsert", actor: "system", card: otherConversation }).isPersisted.promise
  const playthrough = store.session().guide?.playthrough ?? 0
  expect((await controller.commands.run("tut")).status).toBe("executed")
  expect(store.session().guide).toMatchObject({ step: 1, playthrough: playthrough + 1, completed: ["tutorial.started"] })
  expect(store.collections.cards.has(previous.id)).toBe(false)
  expect(store.collections.cardHistories.has(previous.id)).toBe(false)
  expect([...store.collections.frames.values()].some(frame => frame.cardId === previous.id)).toBe(false)
  expect(store.collections.cards.get(otherRepo.id)?.payload).toEqual(otherRepo.payload)
  expect(store.collections.cards.get(otherConversation.id)?.payload).toEqual(otherConversation.payload)
  await store.settled?.()
  const restored = await setup(storage)
  expect(restored.store.session().guide).toMatchObject({ step: 1, playthrough: playthrough + 1 })
  expect(restored.store.collections.cards.has(previous.id)).toBe(false)
  expect(restored.store.collections.cardHistories.has(previous.id)).toBe(false)
  await restored.controller.commands.run("issues.list", `open ${PRACTICE_REPO}`)
  expect(restored.store.collections.cards.get(previous.id)?.kind).toBe("issue-list")
  expect(restored.store.collections.cards.get(previous.id)?.navigation).toBeUndefined()
  await restored.controller.commands.run("card.history.back", previous.id)
  expect(restored.store.collections.cards.get(previous.id)?.kind).toBe("issue-list")
  await restored.controller.commands.run("issues.view", `3 ${PRACTICE_REPO}`)
  expect(restored.store.collections.cardHistories.get(previous.id)?.entries).toHaveLength(2)
})
