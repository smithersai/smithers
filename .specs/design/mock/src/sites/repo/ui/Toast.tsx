/* Mount <Toast/> once in RepoFrame. toast(message) or useToast()(message) queues a dismissible notice. */
import { useEffect, useState } from "react"
import { registerSlash } from "../frame/slash"
type Notice = { id: number; message: string }
let nextId = 0
export const toast = (message: string) => window.dispatchEvent(new CustomEvent("repo-toast", { detail: { id: ++nextId, message } }))
export const useToast = () => toast
const dismiss = (id?: number) => window.dispatchEvent(new CustomEvent("repo-toast-dismiss", { detail: id }))
registerSlash("notice.dismiss", {
  purpose: "Dismiss notification", access: "public", confirm: false,
  fields: [{ name: "notice", label: "Notification number", type: "number", min: 1, required: false }],
  run: ({ notice }) => { dismiss(notice ? Number(notice) : undefined) }
})
export const Toast = () => {
  const [notices, setNotices] = useState<Notice[]>([])
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const receive = (event: Event) => {
      const notice = (event as CustomEvent<Notice>).detail
      setNotices(current => [...current.slice(-2), notice])
      const timer = setTimeout(() => { setNotices(current => current.filter(item => item.id !== notice.id)); timers.delete(timer) }, 6000)
      timers.add(timer)
    }
    const remove = (event: Event) => {
      const id = (event as CustomEvent<number | undefined>).detail
      setNotices(current => current.filter(item => item.id !== (id ?? current.at(-1)?.id)))
    }
    window.addEventListener("repo-toast", receive)
    window.addEventListener("repo-toast-dismiss", remove)
    return () => { window.removeEventListener("repo-toast", receive); window.removeEventListener("repo-toast-dismiss", remove); timers.forEach(clearTimeout) }
  }, [])
  return <div className="repo-ui-toasts" aria-live="polite">{notices.map(notice => <div className="repo-ui-toast" key={notice.id}><span>{notice.message}</span><button title={`/notice.dismiss ${notice.id}`} aria-label="Dismiss notification" onClick={() => dismiss(notice.id)}>×</button></div>)}</div>
}
