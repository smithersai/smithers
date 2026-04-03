import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { FolderOpenIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { FieldDescription } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type BrowserFolderPickerFieldProps = {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  pickerLabel: string
}

type DaemonFolderPickerFieldProps = {
  id: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  pickerLabel: string
  onPick: () => Promise<string | null>
}

type FileWithPath = File & {
  webkitRelativePath?: string
}

function extractFolderSelection(files: FileList) {
  const first = files.item(0) as FileWithPath | null
  if (!first) {
    return ""
  }

  const relativePath = first.webkitRelativePath ?? ""
  return relativePath.split("/").filter(Boolean)[0] ?? ""
}

export function BrowserFolderPickerField({
  id,
  value,
  onChange,
  placeholder,
  pickerLabel,
}: BrowserFolderPickerFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [pickerNote, setPickerNote] = useState<string>("")

  useEffect(() => {
    const input = inputRef.current
    if (!input) {
      return
    }

    input.setAttribute("webkitdirectory", "")
    input.setAttribute("directory", "")
  }, [])

  function handleInputPickerChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files
    if (!files?.length) {
      return
    }

    const selectedFolder = extractFolderSelection(files)
    if (selectedFolder) {
      onChange(selectedFolder)
      setPickerNote("")
    } else {
      setPickerNote("Could not determine selected folder name from browser picker.")
    }

    event.currentTarget.value = ""
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
          <FolderOpenIcon data-icon="inline-start" />
          {pickerLabel}
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          onChange={handleInputPickerChange}
        />
      </div>
      {pickerNote ? <FieldDescription>{pickerNote}</FieldDescription> : null}
    </div>
  )
}

export function DaemonFolderPickerField({
  id,
  value,
  onChange,
  placeholder,
  pickerLabel,
  onPick,
}: DaemonFolderPickerFieldProps) {
  const [isPicking, setIsPicking] = useState(false)
  const [pickerNote, setPickerNote] = useState<string>("")

  async function handlePickClick() {
    try {
      setIsPicking(true)
      setPickerNote("")
      const selectedPath = await onPick()
      if (selectedPath) {
        onChange(selectedPath)
      }
    } catch (error) {
      setPickerNote(error instanceof Error ? error.message : "Failed to pick folder.")
    } finally {
      setIsPicking(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" disabled={isPicking} onClick={() => void handlePickClick()}>
          <FolderOpenIcon data-icon="inline-start" />
          {isPicking ? "Opening..." : pickerLabel}
        </Button>
      </div>
      {pickerNote ? <FieldDescription>{pickerNote}</FieldDescription> : null}
    </div>
  )
}
