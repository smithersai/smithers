/-! Cache credentials of a generated GitHub workflow. The empty string models an unset secret. -/
namespace GenerateApplySpec.Cache

def token (pullRequest branch defaultName : Bool) (read write : String) : String :=
  if !pullRequest && branch && defaultName then write else read

theorem tag_reads (pullRequest defaultName : Bool) (read write : String) :
    token pullRequest false defaultName read write = read := by simp [token]

theorem pull_request_reads (branch defaultName : Bool) (read write : String) :
    token true branch defaultName read write = read := by simp [token]

end GenerateApplySpec.Cache
