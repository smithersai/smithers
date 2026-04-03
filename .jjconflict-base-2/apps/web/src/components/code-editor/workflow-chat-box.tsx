import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"

export function WorkflowChatBox({ disabled = false }: { disabled?: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Workflow chat</CardTitle>
        <CardDescription>
          Prompt changes to the selected workflow and review agent-authored updates.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          disabled={disabled}
          defaultValue="Add an approval gate before deploy and preserve stable task IDs."
        />
        <div className="flex justify-end">
          <Button disabled={disabled}>Send</Button>
        </div>
      </CardContent>
    </Card>
  )
}
