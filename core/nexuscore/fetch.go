package nexuscore

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

// proxyTag is the outbound every generated config tunnels through (clients/web singboxConfig.ts).
const proxyTag = "proxy"

// maxFetchBytes bounds a fetched body. Subscriptions are kilobytes; a megabytes-long answer is a
// wrong URL or a hostile server, and this process has a memory ceiling to respect.
const maxFetchBytes = 8 << 20

// FetchViaTunnel GETs rawURL through the running tunnel and writes the body to bodyPath.
//
// ============================================================================================
// WHY THIS EXISTS
//
// The app's own traffic never enters its tunnel: NexusVpnService puts the app's package on the
// VpnService deny list, so the core's sockets and the app's server pings go direct. That is the
// right default, and it means the app has no way to reach a host that is only reachable THROUGH
// the tunnel - a subscription panel blocked on the direct path, which is the case a VPN client
// exists for.
//
// So the core fetches it: dialled through the running box's own proxy outbound, the same path
// tunnelled traffic takes, with the destination's NAME handed to the proxy server so nothing is
// resolved on the device. No listener is opened; nothing else on the device can use this.
// ============================================================================================
//
// Returns JSON: {"status": <code>, "headers": {<lower-case name>: <first value>}}. An error
// means no HTTP response at all.
func (s *Service) FetchViaTunnel(rawURL, userAgent string, timeoutMillis int64, bodyPath string) (string, error) {
	s.mu.Lock()
	started, server := s.started, s.server
	s.mu.Unlock()
	if !started || server == nil || server.StartedService == nil {
		return "", errNotStarted
	}

	// Unlocked: libbox takes its own locks, and s.mu is never held across a call into it.
	instance := server.StartedService.Instance()
	if instance == nil || instance.Box() == nil {
		return "", errNotStarted
	}
	outbound, ok := instance.Box().Outbound().Outbound(proxyTag)
	if !ok {
		return "", fmt.Errorf("nexuscore: the running config has no %q outbound", proxyTag)
	}

	dial := func(ctx context.Context, _, address string) (net.Conn, error) {
		return outbound.DialContext(ctx, N.NetworkTCP, M.ParseSocksaddr(address))
	}
	return fetchTo(dial, rawURL, userAgent, time.Duration(timeoutMillis)*time.Millisecond, bodyPath)
}

type dialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// fetchTo is FetchViaTunnel without the tunnel, so it can be tested with a plain dialer.
func fetchTo(dial dialFunc, rawURL, userAgent string, timeout time.Duration, bodyPath string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", errors.New("nexuscore: only http(s) URLs can be fetched")
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}

	transport := &http.Transport{
		// Never an environment proxy: the tunnel IS the proxy.
		Proxy:                 nil,
		DialContext:           dial,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
		DisableKeepAlives:     true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: timeout}

	request, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	if userAgent != "" {
		request.Header.Set("User-Agent", userAgent)
	}
	request.Header.Set("Accept", "*/*")

	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	file, err := os.Create(bodyPath)
	if err != nil {
		return "", fmt.Errorf("nexuscore: create body file: %w", err)
	}
	written, copyErr := io.Copy(file, io.LimitReader(response.Body, maxFetchBytes+1))
	closeErr := file.Close()
	switch {
	case copyErr != nil:
		_ = os.Remove(bodyPath)
		return "", copyErr
	case closeErr != nil:
		_ = os.Remove(bodyPath)
		return "", closeErr
	case written > maxFetchBytes:
		_ = os.Remove(bodyPath)
		return "", fmt.Errorf("nexuscore: response larger than %d bytes", maxFetchBytes)
	}

	headers := make(map[string]string, len(response.Header))
	for name, values := range response.Header {
		if len(values) > 0 {
			headers[strings.ToLower(name)] = values[0]
		}
	}
	encoded, err := json.Marshal(struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
	}{response.StatusCode, headers})
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
