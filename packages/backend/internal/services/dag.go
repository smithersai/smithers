package services

import "fmt"

// Dispatch-time caps on the user-controlled workflow job graph. Workflow
// definitions are repo-writer-controlled JSON; without caps a single dispatch
// would create an unbounded number of workflow_steps/workflow_tasks rows and
// unbounded DAG-validation work from one push or API call.
const (
	maxWorkflowJobs     = 256
	maxWorkflowJobSteps = 128
	maxWorkflowJobNeeds = 64
	maxWorkflowSteps    = 2048
	maxWorkflowEdges    = 1024
	maxWorkflowDepth    = 64
)

// validateWorkflowJobLimits rejects job graphs that exceed the dispatch caps
// before any run, step, or task row is created.
func validateWorkflowJobLimits(jobs []JobConfig) error {
	if len(jobs) > maxWorkflowJobs {
		return fmt.Errorf("workflow declares %d jobs, exceeding the maximum of %d", len(jobs), maxWorkflowJobs)
	}

	jobNames := make(map[string]struct{}, len(jobs))
	totalSteps := 0
	totalEdges := 0
	for _, job := range jobs {
		if job.Name == "" {
			return fmt.Errorf("workflow contains a job with an empty name")
		}
		if _, exists := jobNames[job.Name]; exists {
			return fmt.Errorf("workflow contains duplicate job %q", job.Name)
		}
		jobNames[job.Name] = struct{}{}

		if len(job.Steps) > maxWorkflowJobSteps {
			return fmt.Errorf("job %q declares %d steps, exceeding the maximum of %d", job.Name, len(job.Steps), maxWorkflowJobSteps)
		}
		if len(job.Needs) > maxWorkflowJobNeeds {
			return fmt.Errorf("job %q declares %d dependencies, exceeding the maximum of %d", job.Name, len(job.Needs), maxWorkflowJobNeeds)
		}
		totalSteps += len(job.Steps)
		totalEdges += len(job.Needs)
	}
	if totalSteps > maxWorkflowSteps {
		return fmt.Errorf("workflow declares %d steps, exceeding the maximum of %d", totalSteps, maxWorkflowSteps)
	}
	if totalEdges > maxWorkflowEdges {
		return fmt.Errorf("workflow declares %d dependency edges, exceeding the maximum of %d", totalEdges, maxWorkflowEdges)
	}

	jobByName := make(map[string]JobConfig, len(jobs))
	for _, job := range jobs {
		jobByName[job.Name] = job
	}
	depthMemo := make(map[string]int, len(jobs))
	visiting := make(map[string]bool, len(jobs))
	var depth func(string) int
	depth = func(name string) int {
		if cached, ok := depthMemo[name]; ok {
			return cached
		}
		if visiting[name] {
			// ValidateDAG reports cycles separately. Do not recurse through one
			// while calculating the resource limit.
			return 0
		}
		job, ok := jobByName[name]
		if !ok {
			return 0
		}
		visiting[name] = true
		longest := 1
		for _, dependency := range job.Needs {
			if dependencyDepth := depth(dependency) + 1; dependencyDepth > longest {
				longest = dependencyDepth
			}
		}
		delete(visiting, name)
		depthMemo[name] = longest
		return longest
	}
	for _, job := range jobs {
		if depth(job.Name) > maxWorkflowDepth {
			return fmt.Errorf("workflow dependency depth exceeds the maximum of %d", maxWorkflowDepth)
		}
	}
	return nil
}

// ValidateDAG checks that the job dependency graph is a valid DAG.
// It returns an error if a job references an unknown dependency,
// depends on itself, or the graph contains a cycle.
func ValidateDAG(jobs []JobConfig) error {
	jobSet := make(map[string]struct{}, len(jobs))
	for _, j := range jobs {
		jobSet[j.Name] = struct{}{}
	}

	adj := make(map[string][]string, len(jobs))
	for _, j := range jobs {
		for _, need := range j.Needs {
			if need == j.Name {
				return fmt.Errorf("job %q has a self-dependency", j.Name)
			}
			if _, ok := jobSet[need]; !ok {
				return fmt.Errorf("job %q depends on unknown job %q", j.Name, need)
			}
			adj[j.Name] = append(adj[j.Name], need)
		}
	}

	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(jobs))

	var visit func(name string) error
	visit = func(name string) error {
		color[name] = gray
		for _, dep := range adj[name] {
			switch color[dep] {
			case gray:
				return fmt.Errorf("dependency cycle detected involving job %q", dep)
			case white:
				if err := visit(dep); err != nil {
					return err
				}
			}
		}
		color[name] = black
		return nil
	}

	for _, j := range jobs {
		if color[j.Name] == white {
			if err := visit(j.Name); err != nil {
				return err
			}
		}
	}
	return nil
}
