package repohostserver

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var operationLabels = []string{
	"InitRepo",
	"DeleteRepo",
	"ImportRefs",
	"ProxyReceivePack",
	"ProxyUploadPack",
	"InfoRefs",
	"InitWikiRepo",
	"InitDocsRepo",
	"CommitWikiPage",
	"CommitDoc",
	"GetWikiPageContent",
	"GetDocContent",
	"ListWikiPageHistory",
	"ListDocHistory",
	"DeleteWikiPage",
	"DeleteDoc",
	"ListBookmarks",
	"CreateBookmark",
	"SetDefaultBookmark",
	"DeleteBookmark",
	"ListChanges",
	"GetChange",
	"GetChangeDiff",
	"GetChangeFiles",
	"ListFilesAtChange",
	"GetChangeConflicts",
	"GetFileAtChange",
	"LandChanges",
	"ListOperations",
	"CreateSnapshot",
}

type Metrics struct {
	registry          *prometheus.Registry
	operationDuration *prometheus.HistogramVec
	serviceUp         prometheus.Gauge
	serviceHealth     prometheus.Gauge
}

func NewMetrics() (*Metrics, error) {
	return newMetrics(prometheus.NewRegistry())
}

func newMetrics(registry *prometheus.Registry) (*Metrics, error) {
	operationDuration := prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name: "smithers_repo_host_operation_duration_seconds",
			Help: "Repo-host operation duration in seconds.",
		},
		[]string{"operation"},
	)
	serviceUp := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_repo_host_service_up",
		Help: "Whether the repo-host process is running (1 = up).",
	})
	serviceHealth := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "smithers_repo_host_service_health",
		Help: "Latest repo-host health status (1 = healthy).",
	})

	for _, label := range operationLabels {
		operationDuration.WithLabelValues(label)
	}

	if err := registry.Register(operationDuration); err != nil {
		return nil, err
	}
	if err := registry.Register(serviceUp); err != nil {
		return nil, err
	}
	if err := registry.Register(serviceHealth); err != nil {
		return nil, err
	}

	serviceUp.Set(1)

	return &Metrics{
		registry:          registry,
		operationDuration: operationDuration,
		serviceUp:         serviceUp,
		serviceHealth:     serviceHealth,
	}, nil
}

func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

func (m *Metrics) StartOperation(operation string) func() {
	timer := prometheus.NewTimer(m.operationDuration.WithLabelValues(operation))
	return func() {
		timer.ObserveDuration()
	}
}

func (m *Metrics) SetServiceHealth(healthy bool) {
	if healthy {
		m.serviceHealth.Set(1)
		return
	}
	m.serviceHealth.Set(0)
}
