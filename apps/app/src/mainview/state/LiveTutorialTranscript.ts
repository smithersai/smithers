import type { LiveTutorialRun } from '@smthrs/rpc/LiveTutorial'
import type { Card } from './AppState'

/** Observed coordinator steps; these are not reconstructed native agent journal spans. */
export const liveTutorialTranscript = (run: LiveTutorialRun): NonNullable<Extract<Card,{kind:'run-trace'}>['payload']['transcriptRows']> =>
  run.events.map((event,index)=>({sequence:index+1,at:event.finishedAt??event.startedAt,kind:event.status,text:[event.label,event.detail].filter(Boolean).join('\n')}))
