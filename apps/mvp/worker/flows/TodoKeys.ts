import { digestSync } from "@smthrs/crypto"

export const branchKey = (attemptId: string): string => digestSync(`smithers/todo-branch/v1\n${attemptId}`)
export const pullKey = (attemptId: string): string => digestSync(`smithers/todo-pull/v1\n${attemptId}`)
