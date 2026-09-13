import { expect, test } from "bun:test"
import { scopedControllers } from "../state/ControllerTestScope"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, silentAgent, unavailableRepositories } from "../state/TestFixtures"
import { PRACTICE_REPO } from "../state/practice/PracticeRepository"
import { payloadFor } from "./SlashPayload"

const createController = scopedControllers()
const setup = async () => {
  const store = await createAppStore({kind:"localStorage",storage:memoryStorage()})
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
  const tagged = store.collections.cards.get(card.id)
  expect(tagged?.kind === "repo-update" && tagged.payload.items[0]?.tags).toContain("needs research")
  expect((await controller.commands.run("notifications.read-update",card.id)).status).toBe("executed")
  expect(store.collections.repositoryNotifications.get(first.id)?.readVersion).toBe(first.version)
  const read = store.collections.cards.get(card.id)
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
