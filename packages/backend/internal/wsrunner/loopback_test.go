package wsrunner

import (
	"net"

	"github.com/pion/webrtc/v4"
)

// Test peers live in one process. Restrict ICE to loopback so VPN routes,
// offline interfaces, and host firewalls cannot determine the test outcome.
func runnerTestPeerConnection(config webrtc.Configuration) (*webrtc.PeerConnection, error) {
	var settings webrtc.SettingEngine
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	return webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(config)
}

func init() { newPeerConnection = runnerTestPeerConnection }
