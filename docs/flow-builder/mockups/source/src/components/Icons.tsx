import type { ReactNode } from "react"

const svg = (children: ReactNode, size = 16) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

export const IconClock = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>)
export const IconBox = () => svg(<><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></>)
export const IconSpark = () => svg(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8" /></>)
export const IconScale = () => svg(<><path d="M12 3v18M7 7h10M5 11l2-4 2 4a2 2 0 0 1-4 0ZM15 11l2-4 2 4a2 2 0 0 1-4 0Z" /></>)
export const IconPerson = () => svg(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>)
export const IconBranch = () => svg(<><circle cx="6" cy="5" r="2.2" /><circle cx="18" cy="5" r="2.2" /><circle cx="12" cy="19" r="2.2" /><path d="M6 7.2v3.3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.2M12 13.5v3.3" /></>)
export const IconMerge = () => svg(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M8.2 6H11a4 4 0 0 1 4 4v0M8.2 18H11a4 4 0 0 0 4-4v0" /></>)
export const IconMaximize = () => svg(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />)
export const IconMinimize = () => svg(<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />)
export const IconChevron = () => svg(<path d="m6 9 6 6 6-6" />)
export const IconPin = () => svg(<><path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" /></>)
export const IconMore = () => svg(<><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>)
export const IconCheck = () => svg(<path d="m4 12.5 5 5L20 6.5" />)
export const IconX = () => svg(<path d="M6 6l12 12M18 6 6 18" />)
export const IconPlay = () => svg(<path d="M7 4.5 19 12 7 19.5z" fill="currentColor" stroke="none" />)
export const IconPause = () => svg(<><rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" /></>)
export const IconRestart = () => svg(<><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4" /></>)
export const IconBolt = () => svg(<path d="M13 3 5 14h6l-1 7 8-11h-6z" />)
export const IconLock = () => svg(<><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></>)
export const IconDatabase = () => svg(<><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>)
export const IconWiki = () => svg(<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v18H6.5A2.5 2.5 0 0 1 4 18.5z" /><path d="M8 3v18" /></>)
export const IconDispatch = () => svg(<><circle cx="12" cy="12" r="2.5" /><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /></>)
export const IconFlows = () => svg(<><rect x="3" y="4" width="7" height="5" rx="1.5" /><rect x="14" y="4" width="7" height="5" rx="1.5" /><rect x="8.5" y="15" width="7" height="5" rx="1.5" /><path d="M6.5 9v3h11V9M12 12v3" /></>)
export const IconKey = () => svg(<><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15 12v2" /></>)
export const IconHistory = () => svg(<><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" /><path d="M3.5 4v4h4M12 7.5V12l3 2" /></>)
export const IconUser = () => svg(<><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>)
export const IconSun = () => svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>)
export const IconMoon = () => svg(<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />)
export const IconCode = () => svg(<><path d="m9 8-5 4 5 4M15 8l5 4-5 4" /></>)
export const IconCursor = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 3.2 19.3 11 12.6 12.6 10.6 19.6z" fill="currentColor" />
  </svg>
)

export const KIND_ICON = {
  trigger: IconClock,
  action: IconBox,
  agent: IconSpark,
  jev: IconScale,
  human: IconPerson,
  branch: IconBranch,
  merge: IconMerge
} as const
