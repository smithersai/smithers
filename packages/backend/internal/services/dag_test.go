package services

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateDAG_ValidLinearGraph(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{
		{Name: "build"},
		{Name: "test", Needs: []string{"build"}},
		{Name: "deploy", Needs: []string{"test"}},
	}
	require.NoError(t, ValidateDAG(jobs))
}

func TestValidateDAG_ValidDiamondGraph(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{
		{Name: "build"},
		{Name: "lint", Needs: []string{"build"}},
		{Name: "test", Needs: []string{"build"}},
		{Name: "deploy", Needs: []string{"lint", "test"}},
	}
	require.NoError(t, ValidateDAG(jobs))
}

func TestValidateDAG_NoJobs(t *testing.T) {
	t.Parallel()
	require.NoError(t, ValidateDAG(nil))
	require.NoError(t, ValidateDAG([]JobConfig{}))
}

func TestValidateDAG_SingleJobNoNeeds(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{{Name: "build"}}
	require.NoError(t, ValidateDAG(jobs))
}

func TestValidateDAG_SelfDependency(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{
		{Name: "build", Needs: []string{"build"}},
	}
	err := ValidateDAG(jobs)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "self-dependency")
	assert.Contains(t, err.Error(), "build")
}

func TestValidateDAG_MissingDependency(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{
		{Name: "build", Needs: []string{"nonexistent"}},
	}
	err := ValidateDAG(jobs)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unknown job")
	assert.Contains(t, err.Error(), "nonexistent")
}

func TestValidateDAG_DirectCycle(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{
		{Name: "a", Needs: []string{"b"}},
		{Name: "b", Needs: []string{"a"}},
	}
	err := ValidateDAG(jobs)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cycle")
}

func TestValidateDAG_IndirectCycle(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{
		{Name: "a", Needs: []string{"c"}},
		{Name: "b", Needs: []string{"a"}},
		{Name: "c", Needs: []string{"b"}},
	}
	err := ValidateDAG(jobs)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cycle")
}

func TestValidateDAG_MultipleRootsValid(t *testing.T) {
	t.Parallel()
	jobs := []JobConfig{
		{Name: "lint"},
		{Name: "test"},
		{Name: "deploy", Needs: []string{"lint", "test"}},
	}
	require.NoError(t, ValidateDAG(jobs))
}

func TestValidateWorkflowJobLimits_RejectsJobCount(t *testing.T) {
	t.Parallel()

	jobs := make([]JobConfig, maxWorkflowJobs+1)
	for i := range jobs {
		jobs[i].Name = string(rune('a'+i%26)) + string(rune(i/26+'0'))
	}
	err := validateWorkflowJobLimits(jobs)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "jobs")
}

func TestValidateWorkflowJobLimits_RejectsStepsEdgesAndDepth(t *testing.T) {
	t.Parallel()

	tooManySteps := []JobConfig{{Name: "build", Steps: make([]StepConfig, maxWorkflowJobSteps+1)}}
	require.Error(t, validateWorkflowJobLimits(tooManySteps))

	tooManyEdges := make([]JobConfig, maxWorkflowJobs)
	for i := range tooManyEdges {
		tooManyEdges[i].Name = string(rune('a'+i%26)) + string(rune(i/26+'0'))
		tooManyEdges[i].Needs = make([]string, maxWorkflowJobNeeds)
	}
	require.Error(t, validateWorkflowJobLimits(tooManyEdges))

	deep := make([]JobConfig, maxWorkflowDepth+1)
	for i := range deep {
		deep[i].Name = string(rune('a'+i%26)) + string(rune(i/26+'0'))
		if i > 0 {
			deep[i].Needs = []string{deep[i-1].Name}
		}
	}
	err := validateWorkflowJobLimits(deep)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "depth")
}
