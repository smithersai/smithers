import { WaitlistCard, type WaitlistCardProps } from "@smthrs/ui"

export type WaitlistPromptProps = WaitlistCardProps

export function WaitlistPrompt(props: WaitlistPromptProps) {
  return <WaitlistCard {...props} />
}
