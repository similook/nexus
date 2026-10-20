//go:build with_utls && nexus_bench

package nexuscore

import (
	"bufio"
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/metrics"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sagernet/sing-vmess/vless"
)

// bench/B-03 — memory ceiling compliance, host proxy (see bench/B-03/README.md).
//
// The core runs ALONE in a child process (this test binary re-executed), configured as the app
// configures it for the Apple extension: tuneRuntime(true), i.e. GOMEMLIMIT 40 MiB and GOGC 100.
// The parent drives traffic through the child's SOCKS inbound to a real Xray server on
// 127.0.0.1 and samples the child's memory, so the load generator's own buffers never count.
//
// What this is NOT: the Network Extension. There is no TUN and no packet stack here, and the
// OS is the CI host's, not iOS. Every figure it produces is a host-proxy estimate and must be
// labelled so until a device run replaces it.
//
//	B03_OUT=<run dir> NEXUS_XRAY_BIN=<xray> go test -tags with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api,nexus_bench \
//	  ./nexuscore/ -run TestB03Memory -v -timeout 0

const b03Uuid = "11111111-2222-3333-4444-555555555555"

// TestB03CoreChild is the measured process. It only runs when the parent starts it.
func TestB03CoreChild(t *testing.T) {
	if os.Getenv("B03_CHILD") != "1" {
		t.Skip("child process of TestB03Memory")
	}
	content, err := os.ReadFile(os.Getenv("B03_CONFIG"))
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(content, &config); err != nil {
		t.Fatal(err)
	}
	tuneRuntime(true) // the extension's policy, exactly as the app applies it
	instance, _, err := probeTestBox(config)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	fmt.Println("B03 READY")

	samples := []metrics.Sample{
		{Name: "/memory/classes/total:bytes"},
		{Name: "/memory/classes/heap/released:bytes"},
		{Name: "/memory/classes/heap/objects:bytes"},
		{Name: "/gc/cycles/total:gc-cycles"},
		{Name: "/sched/goroutines:goroutines"},
	}
	stdin := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(stdin) }()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stdin:
			return
		case <-ticker.C:
			metrics.Read(samples)
			fmt.Printf("B03 M %d %d %d %d %d\n",
				samples[0].Value.Uint64()-samples[1].Value.Uint64(), // Go-held: mapped minus released
				samples[2].Value.Uint64(),                           // live heap objects
				samples[3].Value.Uint64(),                           // GC cycles so far
				samples[4].Value.Uint64(),                           // goroutines
				time.Now().UnixMilli())
		}
	}
}

type b03Sample struct {
	ms         int64
	phase      string
	goHeld     uint64
	heapLive   uint64
	gcCycles   uint64
	goroutines uint64
	rss        uint64 // OS-reported resident size; 0 when the platform gives none
}

// TestB03Memory runs each arm through the load profile and writes the run directory.
func TestB03Memory(t *testing.T) {
	out := os.Getenv("B03_OUT")
	bin := os.Getenv("NEXUS_XRAY_BIN")
	if out == "" || bin == "" {
		t.Skip("set B03_OUT and NEXUS_XRAY_BIN")
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		t.Fatal(err)
	}
	arms := strings.Split(envOr("B03_ARMS", "reality-mlkem,vlessenc-x25519,reality-vlessenc"), ",")
	cycles := envInt("B03_CYCLES", 1)

	var report bytes.Buffer
	fmt.Fprintf(&report, "| Arm | Cycles | Peak RSS (MiB) | Peak Go-held (MiB) | Idle Go-held after load (MiB) | GC cycles/min under load |\n|---|---|---|---|---|---|\n")
	for _, arm := range arms {
		samples := b03RunArm(t, bin, arm, cycles)
		writeB03CSV(t, filepath.Join(out, "samples-"+arm+".csv"), samples)
		fmt.Fprintln(&report, b03Summary(arm, cycles, samples))
	}
	xrayVersion, _ := exec.Command(bin, "version").Output()
	meta := fmt.Sprintf("# B-03 host proxy run\n\n- Date: %s\n- Host: %s, %d CPUs\n- Go: %s\n- Core: sing-box %s + core/patches\n- Xray: %s\n- GOMEMLIMIT: 40 MiB, GOGC 100 (tuneRuntime(true))\n- Load per cycle: idle %ds, bulk %d x %d MiB echoed, burst %d connections x %d KiB held %ds, idle %ds\n\n**Host-proxy estimate, not a Network Extension measurement** (bench/B-03/README.md).\n\n",
		time.Now().UTC().Format(time.RFC3339), runtime.GOOS+"/"+runtime.GOARCH, runtime.NumCPU(),
		runtime.Version(), singBoxVersion(), strings.SplitN(string(xrayVersion), "\n", 2)[0],
		envInt("B03_IDLE_S", 15), envInt("B03_BULK_STREAMS", 4), envInt("B03_BULK_MIB", 32),
		envInt("B03_BURST_CONNS", 300), envInt("B03_BURST_KIB", 16), envInt("B03_BURST_HOLD_S", 10), envInt("B03_IDLE_S", 15))
	if err := os.WriteFile(filepath.Join(out, "result.md"), append([]byte(meta), report.Bytes()...), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Log("\n" + meta + report.String())
}

func b03RunArm(t *testing.T, bin, arm string, cycles int) []b03Sample {
	t.Helper()
	echo := matrixEchoServer(t)
	settings, stream, outbound := b03Arm(t, arm)
	port := startXrayInbound(t, bin, settings, stream, echo)
	outbound["server_port"] = port
	socksPort := freePort(t)
	config := map[string]any{
		"log":       map[string]any{"level": "error"},
		"inbounds":  []any{map[string]any{"type": "mixed", "tag": "in", "listen": "127.0.0.1", "listen_port": socksPort}},
		"outbounds": []any{outbound},
		"route":     map[string]any{"final": "proxy"},
	}
	content, _ := json.Marshal(config)
	configPath := filepath.Join(t.TempDir(), "client.json")
	if err := os.WriteFile(configPath, content, 0o600); err != nil {
		t.Fatal(err)
	}

	child := exec.Command(os.Args[0], "-test.run=^TestB03CoreChild$", "-test.v")
	child.Env = append(os.Environ(), "B03_CHILD=1", "B03_CONFIG="+configPath)
	stdin, _ := child.StdinPipe()
	stdout, _ := child.StdoutPipe()
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); _ = child.Wait() }()

	var mu sync.Mutex
	phase := "start"
	var samples []b03Sample
	ready := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stdout)
		readyOnce := sync.Once{}
		for scanner.Scan() {
			line := scanner.Text()
			if line == "B03 READY" {
				readyOnce.Do(func() { close(ready) })
				continue
			}
			f := strings.Fields(line)
			if len(f) != 7 || f[0] != "B03" || f[1] != "M" {
				continue
			}
			s := b03Sample{goHeld: atou(f[2]), heapLive: atou(f[3]), gcCycles: atou(f[4]), goroutines: atou(f[5]), ms: int64(atou(f[6]))}
			s.rss = processRSS(child.Process.Pid)
			mu.Lock()
			s.phase = phase
			samples = append(samples, s)
			mu.Unlock()
		}
	}()
	select {
	case <-ready:
	case <-time.After(30 * time.Second):
		t.Fatalf("%s: core child did not start", arm)
	}
	setPhase := func(p string) { mu.Lock(); phase = p; mu.Unlock() }
	socks := fmt.Sprintf("127.0.0.1:%d", socksPort)
	idle := time.Duration(envInt("B03_IDLE_S", 15)) * time.Second

	for cycle := 0; cycle < cycles; cycle++ {
		setPhase("idle")
		time.Sleep(idle)
		setPhase("bulk")
		b03Bulk(t, socks, envInt("B03_BULK_STREAMS", 4), envInt("B03_BULK_MIB", 32)<<20)
		setPhase("burst")
		b03Burst(t, socks, envInt("B03_BURST_CONNS", 300), envInt("B03_BURST_KIB", 16)<<10, time.Duration(envInt("B03_BURST_HOLD_S", 10))*time.Second)
		setPhase("idle-after")
		time.Sleep(idle)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(samples) == 0 {
		t.Fatalf("%s: no samples", arm)
	}
	return append([]b03Sample(nil), samples...)
}

// b03Arm returns the Xray inbound settings, stream settings and the matching client outbound.
func b03Arm(t *testing.T, arm string) (map[string]any, map[string]any, map[string]any) {
	t.Helper()
	outbound := map[string]any{"type": "vless", "tag": "proxy", "server": "127.0.0.1", "uuid": b03Uuid, "packet_encoding": "xudp"}
	reality := func(flow string) (map[string]any, map[string]any) {
		key, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		target := matrixTLSTarget(t)
		stream := map[string]any{"network": "raw", "security": "reality", "realitySettings": map[string]any{
			"target": fmt.Sprintf("127.0.0.1:%d", target), "serverNames": []string{"localhost"},
			"privateKey": b64(key.Bytes()), "shortIds": []string{"ab"},
		}}
		tls := map[string]any{"enabled": true, "server_name": "localhost",
			"utls":    map[string]any{"enabled": true, "fingerprint": "chrome"},
			"reality": map[string]any{"enabled": true, "public_key": b64(key.PublicKey().Bytes()), "short_id": "ab", "support_x25519mlkem768": true}}
		outbound["flow"] = flow
		return stream, tls
	}
	switch arm {
	case "reality-mlkem":
		stream, tls := reality(vless.FlowVision)
		outbound["tls"] = tls
		return map[string]any{"clients": []any{map[string]any{"id": b03Uuid, "flow": vless.FlowVision}}, "decryption": "none"}, stream, outbound
	case "vlessenc-x25519":
		serverKey, clientKey := encKeys(t, "x25519")
		outbound["encryption"] = "mlkem768x25519plus.native.0rtt." + clientKey
		return map[string]any{"clients": []any{map[string]any{"id": b03Uuid}}, "decryption": "mlkem768x25519plus.native.600s." + serverKey}, map[string]any{"network": "raw"}, outbound
	case "reality-vlessenc":
		serverKey, clientKey := encKeys(t, "x25519")
		stream, tls := reality(vless.FlowVision)
		outbound["tls"] = tls
		outbound["encryption"] = "mlkem768x25519plus.native.0rtt." + clientKey
		return map[string]any{"clients": []any{map[string]any{"id": b03Uuid, "flow": vless.FlowVision}}, "decryption": "mlkem768x25519plus.native.600s." + serverKey}, stream, outbound
	}
	t.Fatalf("unknown arm %q", arm)
	return nil, nil, nil
}

// b03Bulk echoes size bytes on each of streams parallel connections.
func b03Bulk(t *testing.T, socks string, streams, size int) {
	t.Helper()
	var wg sync.WaitGroup
	for i := 0; i < streams; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := b03Connect(socks)
			if err != nil {
				t.Errorf("bulk connect: %v", err)
				return
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(5 * time.Minute))
			chunk := make([]byte, 64<<10)
			_, _ = rand.Read(chunk)
			go func() {
				for sent := 0; sent < size; sent += len(chunk) {
					if _, err := conn.Write(chunk); err != nil {
						return
					}
				}
			}()
			if _, err := io.CopyN(io.Discard, conn, int64(size)); err != nil {
				t.Errorf("bulk echo: %v", err)
			}
		}()
	}
	wg.Wait()
}

// b03Burst opens conns connections at once, echoes size bytes on each, and holds them open.
func b03Burst(t *testing.T, socks string, conns, size int, hold time.Duration) {
	t.Helper()
	var wg sync.WaitGroup
	open := make(chan net.Conn, conns)
	for i := 0; i < conns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := b03Connect(socks)
			if err != nil {
				t.Errorf("burst connect: %v", err)
				return
			}
			_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
			payload := make([]byte, size)
			_, _ = rand.Read(payload)
			go func() { _, _ = conn.Write(payload) }()
			if _, err := io.CopyN(io.Discard, conn, int64(size)); err != nil {
				t.Errorf("burst echo: %v", err)
			}
			open <- conn
		}()
	}
	wg.Wait()
	time.Sleep(hold)
	close(open)
	for conn := range open {
		conn.Close()
	}
}

// b03Connect is socks5Connect without t: the load runs in goroutines, where t.Fatal is not allowed.
func b03Connect(socks string) (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", socks, 10*time.Second)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	fail := func(what string, err error) (net.Conn, error) {
		conn.Close()
		return nil, fmt.Errorf("%s: %v", what, err)
	}
	if _, err := conn.Write([]byte{5, 1, 0}); err != nil {
		return fail("greeting", err)
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil || reply[1] != 0 {
		return fail("greeting reply", err)
	}
	if _, err := conn.Write([]byte{5, 1, 0, 1, 10, 0, 0, 1, 0, 80}); err != nil {
		return fail("connect", err)
	}
	head := make([]byte, 10)
	if _, err := io.ReadFull(conn, head); err != nil || head[1] != 0 {
		return fail("connect reply", err)
	}
	return conn, nil
}

func b03Summary(arm string, cycles int, samples []b03Sample) string {
	var peakRSS, peakGo, idleGo uint64
	var loadStart, loadEnd b03Sample
	inLoad := false
	for _, s := range samples {
		peakRSS = max(peakRSS, s.rss)
		peakGo = max(peakGo, s.goHeld)
		if s.phase == "idle-after" {
			idleGo = s.goHeld // last idle-after sample wins: where memory settles
		}
		if (s.phase == "bulk" || s.phase == "burst") && !inLoad {
			loadStart, inLoad = s, true
		}
		if s.phase == "bulk" || s.phase == "burst" {
			loadEnd = s
		}
	}
	gcPerMin := "n/a"
	if minutes := float64(loadEnd.ms-loadStart.ms) / 60000; minutes > 0 {
		gcPerMin = strconv.FormatFloat(float64(loadEnd.gcCycles-loadStart.gcCycles)/minutes, 'f', 1, 64)
	}
	rss := "n/a"
	if peakRSS > 0 {
		rss = mib(peakRSS)
	}
	return fmt.Sprintf("| %s | %d | %s | %s | %s | %s |", arm, cycles, rss, mib(peakGo), mib(idleGo), gcPerMin)
}

func writeB03CSV(t *testing.T, path string, samples []b03Sample) {
	t.Helper()
	sort.Slice(samples, func(i, j int) bool { return samples[i].ms < samples[j].ms })
	var b bytes.Buffer
	b.WriteString("ms,phase,go_held_bytes,heap_live_bytes,gc_cycles,goroutines,rss_bytes\n")
	for _, s := range samples {
		fmt.Fprintf(&b, "%d,%s,%d,%d,%d,%d,%d\n", s.ms, s.phase, s.goHeld, s.heapLive, s.gcCycles, s.goroutines, s.rss)
	}
	if err := os.WriteFile(path, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// processRSS is the OS's resident size for pid, or 0 where there is no cheap portable read.
// macOS/Linux: ps (KiB). Windows: tasklist's working set (KiB).
func processRSS(pid int) uint64 {
	if runtime.GOOS == "windows" {
		out, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH").Output()
		if err != nil {
			return 0
		}
		fields := strings.Split(strings.TrimSpace(string(out)), "\",\"")
		if len(fields) < 5 {
			return 0
		}
		kib := strings.NewReplacer(",", "", ".", "", " K\"", "", "K\"", "", " ", "").Replace(fields[4])
		return atou(strings.TrimSpace(kib)) << 10
	}
	out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	return atou(strings.TrimSpace(string(out))) << 10
}

func mib(b uint64) string { return strconv.FormatFloat(float64(b)/(1<<20), 'f', 1, 64) }

func atou(s string) uint64 { v, _ := strconv.ParseUint(s, 10, 64); return v }

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil && v > 0 {
		return v
	}
	return fallback
}

// singBoxVersion reads the pinned version from go.mod: a test binary carries no -ldflags stamp,
// so Version() says "unknown" here.
func singBoxVersion() string {
	content, err := os.ReadFile(filepath.Join("..", "go.mod"))
	if err != nil {
		return "unknown"
	}
	for _, line := range strings.Split(string(content), "\n") {
		f := strings.Fields(line)
		if len(f) >= 3 && f[0] == "require" && f[1] == "github.com/sagernet/sing-box" {
			return f[2]
		}
		if len(f) >= 2 && f[0] == "github.com/sagernet/sing-box" {
			return f[1]
		}
	}
	return "unknown"
}
