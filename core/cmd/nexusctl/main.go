// Command nexusctl drives the nexusd IPC contract from a terminal.
//
// ============================================================================================
// WHY THIS EXISTS AT ALL
//
// ADR-0003 Phase 3's acceptance criterion is "the full contract is exercised WITH NO GUI IN THE
// PICTURE." That is not a convenience — it is the point.
//
// If the first client of this protocol were the Tauri shell, then every protocol bug would
// arrive wearing a costume: a Rust error, a webview console message, a React state that never
// updated. Debugging it would mean deciding, each time, whether the fault was in the daemon,
// the host, the port, or the UI. With nexusctl the contract has a client that is none of those
// things, so a failure here is unambiguously the daemon's.
//
// It also outlives Phase 3. When the GUI eventually misbehaves, the first diagnostic question
// is "does nexusctl see it too?", and that question is only cheap because this binary exists.
//
// `nexusctl verify` is the executable form of the phase gate: it drives every method and
// asserts every event, and either prints a pass list or names what broke.
// ============================================================================================
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/nexus/nexus-core/desktop/ipc"
)

const usage = `nexusctl - drive the nexusd IPC contract (ADR-0003 Phase 3)

Usage:
  nexusctl [-s <socket>] <command>

Commands:
  verify                 drive every method and event, and report
  status                 print one status snapshot
  start -c <config>      start a tunnel
  stop                   stop the tunnel
  logs [-n <count>]      print the core's log ring
  clear-logs             empty the ring
  ping                   measure the active tunnel (pingProxy)
  tcp-ping <host:port>   TCP handshake probe, outside the tunnel
  watch                  subscribe and print events until interrupted

The daemon must already be running:
  nexusd serve
`

func main() {
	socket := ipc.DefaultSocketPath()
	args := os.Args[1:]

	if len(args) >= 2 && args[0] == "-s" {
		socket, args = args[1], args[2:]
	}
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	if err := run(socket, args); err != nil {
		fmt.Fprintln(os.Stderr, "nexusctl: "+err.Error())
		os.Exit(1)
	}
}

func run(socket string, args []string) error {
	// Events are printed as they arrive for the interactive commands, and collected for
	// `verify`. The recorder does both.
	recorder := newRecorder(args[0] == "watch")

	client, err := ipc.Connect(socket, recorder.on)
	if err != nil {
		return err
	}
	defer client.Close()

	hello, err := client.Hello(5 * time.Second)
	if err != nil {
		return err
	}

	switch args[0] {
	case "verify":
		return verify(client, hello, recorder)

	case "status":
		status, err := client.GetStatus()
		if err != nil {
			return err
		}
		return printJSON(status)

	case "start":
		if len(args) < 3 || args[1] != "-c" {
			return fmt.Errorf("start needs -c <config.json>")
		}
		config, err := os.ReadFile(args[2])
		if err != nil {
			return err
		}
		if err = client.Start(string(config), "nexusctl"); err != nil {
			return err
		}
		fmt.Println("started")
		return nil

	case "stop":
		if err := client.Stop(); err != nil {
			return err
		}
		fmt.Println("stopped")
		return nil

	case "logs":
		limit := 0
		if len(args) >= 3 && args[1] == "-n" {
			fmt.Sscanf(args[2], "%d", &limit)
		}
		lines, err := client.ReadLogs(limit)
		if err != nil {
			return err
		}
		for _, line := range lines {
			fmt.Println(line)
		}
		fmt.Fprintf(os.Stderr, "(%d lines)\n", len(lines))
		return nil

	case "clear-logs":
		if err := client.ClearLogs(); err != nil {
			return err
		}
		fmt.Println("cleared")
		return nil

	case "ping":
		if err := client.PingProxy(); err != nil {
			return err
		}
		// pingProxy returns void and answers on an event, exactly as on Android, so the
		// caller has to wait for it rather than read a return value.
		delay, ok := recorder.awaitProxyDelay(10 * time.Second)
		if !ok {
			return fmt.Errorf("no proxyDelay event within 10s")
		}
		if !delay.Ok {
			fmt.Println("proxy unreachable")
			return nil
		}
		fmt.Printf("%d ms\n", delay.DelayMS)
		return nil

	case "tcp-ping":
		if len(args) < 2 {
			return fmt.Errorf("tcp-ping needs <host:port>")
		}
		host, port, err := splitHostPort(args[1])
		if err != nil {
			return err
		}
		results, err := client.TCPPing([]ipc.PingTarget{{ID: "probe", Server: host, Port: port}})
		if err != nil {
			return err
		}
		for _, result := range results {
			if result.MS < 0 {
				fmt.Println("unreachable")
			} else {
				fmt.Printf("%d ms\n", result.MS)
			}
		}
		return nil

	case "watch":
		fmt.Fprintf(os.Stderr, "watching %s (protocol v%d, daemon %s) - Ctrl-C to stop\n",
			socket, hello.Protocol, hello.Daemon)
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
		<-signals
		return nil

	default:
		fmt.Fprint(os.Stderr, usage)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func splitHostPort(value string) (string, int, error) {
	index := strings.LastIndex(value, ":")
	if index < 0 {
		return "", 0, fmt.Errorf("expected host:port, got %q", value)
	}
	var port int
	if _, err := fmt.Sscanf(value[index+1:], "%d", &port); err != nil {
		return "", 0, fmt.Errorf("bad port in %q", value)
	}
	return value[:index], port, nil
}

func printJSON(value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

// ---------------------------------------------------------------------------------------
// Event recorder
// ---------------------------------------------------------------------------------------

type recorder struct {
	echo bool

	mu     sync.Mutex
	counts map[string]int
	states []ipc.ServiceStateEvent

	proxyDelay chan ipc.ProxyDelayEvent
}

func newRecorder(echo bool) *recorder {
	return &recorder{
		echo:       echo,
		counts:     make(map[string]int),
		proxyDelay: make(chan ipc.ProxyDelayEvent, 4),
	}
}

func (r *recorder) on(name string, data json.RawMessage) {
	r.mu.Lock()
	r.counts[name]++
	r.mu.Unlock()

	if r.echo {
		fmt.Printf("%s  %s %s\n", time.Now().Format("15:04:05.000"), name, string(data))
	}

	switch name {
	case ipc.EventServiceState:
		var state ipc.ServiceStateEvent
		if json.Unmarshal(data, &state) == nil {
			r.mu.Lock()
			r.states = append(r.states, state)
			r.mu.Unlock()
		}
	case ipc.EventProxyDelay:
		var delay ipc.ProxyDelayEvent
		if json.Unmarshal(data, &delay) == nil {
			select {
			case r.proxyDelay <- delay:
			default:
			}
		}
	}
}

func (r *recorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.counts[name]
}

func (r *recorder) stateSequence() []ipc.ServiceState {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]ipc.ServiceState, 0, len(r.states))
	for _, state := range r.states {
		out = append(out, state.State)
	}
	return out
}

func (r *recorder) awaitProxyDelay(timeout time.Duration) (ipc.ProxyDelayEvent, bool) {
	select {
	case delay := <-r.proxyDelay:
		return delay, true
	case <-time.After(timeout):
		return ipc.ProxyDelayEvent{}, false
	}
}
