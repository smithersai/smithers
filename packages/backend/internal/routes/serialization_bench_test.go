package routes

import (
	"encoding/json"
	"testing"
	"time"
)

func makeSampleRepoResponse(id int64) RepoResponse {
	return RepoResponse{
		ID:              id,
		Owner:           "testuser",
		Name:            "test-repo",
		FullName:        "testuser/test-repo",
		Description:     "A test repository for benchmarking JSON serialization performance",
		Private:         false,
		IsPublic:        true,
		DefaultBookmark: "main",
		Topics:          []string{"go", "benchmark", "testing", "json"},
		IsArchived:      false,
		IsFork:          false,
		NumStars:        42,
		NumWatches:      10,
		NumIssues:       5,
		CloneURL:        "https://smithers.sh/testuser/test-repo.git",
		CreatedAt:       time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		UpdatedAt:       time.Date(2024, 6, 15, 12, 30, 0, 0, time.UTC),
	}
}

func BenchmarkRepoResponse_MarshalJSON(b *testing.B) {
	repo := makeSampleRepoResponse(1)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, err := json.Marshal(repo)
		if err != nil {
			b.Fatal(err)
		}
		if len(data) == 0 {
			b.Fatal("expected non-empty JSON")
		}
	}
}

func BenchmarkRepoResponse_MarshalJSON_Parallel(b *testing.B) {
	repo := makeSampleRepoResponse(1)

	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			data, err := json.Marshal(repo)
			if err != nil {
				b.Fatal(err)
			}
			if len(data) == 0 {
				b.Fatal("expected non-empty JSON")
			}
		}
	})
}

func BenchmarkRepoListResponse_MarshalJSON(b *testing.B) {
	repos := make([]RepoResponse, 20)
	for i := range repos {
		repos[i] = makeSampleRepoResponse(int64(i + 1))
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, err := json.Marshal(repos)
		if err != nil {
			b.Fatal(err)
		}
		if len(data) == 0 {
			b.Fatal("expected non-empty JSON")
		}
	}
}

func BenchmarkRepoResponse_UnmarshalJSON(b *testing.B) {
	repo := makeSampleRepoResponse(1)
	data, err := json.Marshal(repo)
	if err != nil {
		b.Fatal(err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var r RepoResponse
		if err := json.Unmarshal(data, &r); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCreateRepoRequest_UnmarshalJSON(b *testing.B) {
	payload := []byte(`{"name":"test-repo","description":"A test repository","private":false}`)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var req CreateRepoRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkUpdateRepoRequest_UnmarshalJSON(b *testing.B) {
	payload := []byte(`{"name":"new-name","description":"Updated description","private":true}`)

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		var req UpdateRepoRequest
		if err := json.Unmarshal(payload, &req); err != nil {
			b.Fatal(err)
		}
	}
}
