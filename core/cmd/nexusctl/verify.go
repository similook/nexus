package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/nexus/nexus-core/desktop/ipc"
)

// verify drives every method and asserts every event.
//
// It is the Phase 3 gate in executable form. It deliberately does NOT start a tunnel: that
// needs privileges and would take over the routing table of whatever machine ran it, and the
// contract is the thing under test here, not the TUN. `nexusctl start -c` exists for that, and
// the TUN itself is Phase 2's outstanding item.
//
// The checks that matter most are the negative ones. A contract test that only calls things
// that work will pass against a daemon that says yes to everything.
type check struct {
	name string
	run  func(*ipc.Client, *recorder) error
}

func verify(client *ipc.Client, hello ipc.HelloEvent, events *recorder) error {
	fmt.Printf("daemon %s on %s, protocol v%d\n\n", hello.Daemon, hello.OS, hello.Protocol)

	checks := []check{
		{"hello carries a protocol version", func(*ipc.Client, *recorder) error {
			if hello.Protocol != ipc.Protocol {
				return fmt.Errorf("got v%d, expected v%d", hello.Protocol, ipc.Protocol)
			}
			return nil
		}},

		{"serviceState arrives unprompted on connect", func(_ *ipc.Client, r *recorder) error {
			// The daemon pushes current state the moment a client attaches, so a GUI
			// connecting to an already-running tunnel never renders "disconnected" over a
			// live one. Without this the UI has a visible wrong-state window on every
			// reconnect.
			if r.count(ipc.EventServiceState) == 0 {
				return errors.New("no serviceState event was pushed on connect")
			}
			return nil
		}},

		{"getStatus returns a state", func(c *ipc.Client, _ *recorder) error {
			status, err := c.GetStatus()
			if err != nil {
				return err
			}
			switch status.State {
			case ipc.StateStopped, ipc.StateStarting, ipc.StateStarted, ipc.StateUnknown:
			default:
				return fmt.Errorf("state %q is not in the contract's union", status.State)
			}
			return nil
		}},

		{"getStatus reports trafficAvailable honestly", func(c *ipc.Client, _ *recorder) error {
			status, err := c.GetStatus()
			if err != nil {
				return err
			}
			// verify starts no tunnel, so nothing can have moved: every counter must be zero,
			// and that zero is known — the daemon reads sing-box's own traffic manager for a
			// running tunnel (tunnel.Traffic), so the flag says it counts.
			if !status.TrafficAvailable {
				return errors.New("trafficAvailable is false: the daemon is not reporting its counters")
			}
			if status.Uplink != 0 || status.Downlink != 0 || status.UplinkTotal != 0 || status.DownlinkTotal != 0 {
				return errors.New("traffic reported with no tunnel running")
			}
			return nil
		}},

		{"status events arrive at ~1 Hz (R4)", func(_ *ipc.Client, r *recorder) error {
			before := r.count(ipc.EventStatus)
			time.Sleep(2500 * time.Millisecond)
			after := r.count(ipc.EventStatus)

			delta := after - before
			if delta == 0 {
				return errors.New("no status events in 2.5s")
			}
			// R4 is a ceiling, not a target. More than ~1 Hz means something is pushing
			// per-change instead of on a tick, which on mobile is a battery bug and here is
			// a bridge-crossing cost.
			if delta > 5 {
				return fmt.Errorf("%d status events in 2.5s - faster than 1 Hz, R4 violated", delta)
			}
			return nil
		}},

		{"readLogs returns an array, never null", func(c *ipc.Client, _ *recorder) error {
			lines, err := c.ReadLogs(10)
			if err != nil {
				return err
			}
			if lines == nil {
				return errors.New("lines is nil, which marshals to JSON null and is a TypeError in the log view")
			}
			return nil
		}},

		{"readLogs honours its limit", func(c *ipc.Client, _ *recorder) error {
			lines, err := c.ReadLogs(3)
			if err != nil {
				return err
			}
			if len(lines) > 3 {
				return fmt.Errorf("asked for 3, got %d", len(lines))
			}
			return nil
		}},

		{"clearLogs empties the ring", func(c *ipc.Client, _ *recorder) error {
			if err := c.ClearLogs(); err != nil {
				return err
			}
			lines, err := c.ReadLogs(0)
			if err != nil {
				return err
			}
			if len(lines) != 0 {
				return fmt.Errorf("%d lines survived clearLogs", len(lines))
			}
			return nil
		}},

		{"setLogStreaming accepts both values", func(c *ipc.Client, _ *recorder) error {
			if err := c.SetLogStreaming(true); err != nil {
				return err
			}
			return c.SetLogStreaming(false)
		}},

		{"tcpPing reaches a live host", func(c *ipc.Client, _ *recorder) error {
			results, err := c.TCPPing([]ipc.PingTarget{
				{ID: "live", Server: "1.1.1.1", Port: 443},
			})
			if err != nil {
				return err
			}
			if len(results) != 1 {
				return fmt.Errorf("expected 1 result, got %d", len(results))
			}
			if results[0].MS < 0 {
				return errors.New("1.1.1.1:443 unreachable - is this machine online?")
			}
			return nil
		}},

		{"tcpPing reports -1 rather than failing the sweep", func(c *ipc.Client, _ *recorder) error {
			// The important negative. A dead node must come back as a measurement, not as an
			// error, or one bad entry in a subscription takes the whole "Test All" with it.
			results, err := c.TCPPing([]ipc.PingTarget{
				{ID: "live", Server: "1.1.1.1", Port: 443},
				{ID: "dead", Server: "127.0.0.1", Port: 9},
			})
			if err != nil {
				return fmt.Errorf("a dead target failed the whole call: %w", err)
			}
			if len(results) != 2 {
				return fmt.Errorf("expected 2 results, got %d", len(results))
			}
			for _, result := range results {
				if result.ID == "dead" && result.MS != -1 {
					return fmt.Errorf("dead target reported %d ms, expected -1", result.MS)
				}
			}
			return nil
		}},

		{"pingProxy answers on an event, not a return value", func(c *ipc.Client, r *recorder) error {
			if err := c.PingProxy(); err != nil {
				return err
			}
			if _, ok := r.awaitProxyDelay(10 * time.Second); !ok {
				return errors.New("no proxyDelay event within 10s")
			}
			return nil
		}},

		{"an unknown method is refused, not ignored", func(c *ipc.Client, _ *recorder) error {
			err := c.Call("definitelyNotAMethod", nil, nil)
			if err == nil {
				return errors.New("the daemon accepted a method that does not exist")
			}
			if !strings.Contains(err.Error(), "unknown method") {
				return fmt.Errorf("refused, but unhelpfully: %v", err)
			}
			return nil
		}},

		{"setClashMode with no tunnel is refused, not ignored", func(c *ipc.Client, _ *recorder) error {
			// The routing selector must never be told a mode is in effect when nothing is
			// running. verify starts no tunnel, so the no-tunnel contract is what it can check;
			// switching on a live one is covered by core/desktop's routing tests.
			if err := c.SetClashMode("VPN"); err == nil {
				return errors.New("the daemon accepted a routing mode with no tunnel running")
			}
			return nil
		}},

		{"closeConnections with no tunnel is a no-op", func(c *ipc.Client, _ *recorder) error {
			return c.CloseConnections()
		}},

		{"start with no config is refused", func(c *ipc.Client, _ *recorder) error {
			if err := c.Start("", ""); err == nil {
				return errors.New("the daemon accepted an empty config")
			}
			return nil
		}},

		{"the guard rejects a non-loopback listener", func(c *ipc.Client, _ *recorder) error {
			// THE SECURITY CHECK. An unprivileged caller must not be able to make a root
			// daemon bind an open proxy on every interface. If this ever passes, the
			// privilege boundary is open.
			hostile := `{"inbounds":[{"type":"mixed","tag":"in","listen":"0.0.0.0",` +
				`"listen_port":11080}],"outbounds":[{"type":"direct","tag":"direct"}]}`
			err := c.Start(hostile, "hostile")
			if err == nil {
				return errors.New("SECURITY: the daemon accepted a 0.0.0.0 listener")
			}
			if !strings.Contains(err.Error(), "open relay") {
				return fmt.Errorf("rejected, but not for the right reason: %v", err)
			}
			return nil
		}},

		{"the guard rejects a poisoned-looking DNS answer", func(c *ipc.Client, _ *recorder) error {
			// localhost resolves to a loopback address, which assertUsableAddress treats the
			// same way it treats a filtering blackhole: not a reachable proxy server.
			poisoned := `{"inbounds":[],"outbounds":[{"type":"trojan","tag":"proxy",` +
				`"server":"localhost","server_port":443,"password":"x"}]}`
			err := c.Start(poisoned, "poisoned")
			if err == nil {
				return errors.New("SECURITY: the daemon accepted a loopback proxy address")
			}
			if !strings.Contains(err.Error(), "not a reachable server") {
				return fmt.Errorf("rejected, but not for the right reason: %v", err)
			}
			return nil
		}},

		{"the guard rejects a privileged inbound", func(c *ipc.Client, _ *recorder) error {
			hostile := `{"inbounds":[{"type":"tproxy","tag":"in","listen":"127.0.0.1",` +
				`"listen_port":11081}],"outbounds":[{"type":"direct","tag":"direct"}]}`
			if err := c.Start(hostile, "tproxy"); err == nil {
				return errors.New("SECURITY: the daemon accepted a tproxy inbound")
			}
			return nil
		}},

		{"a failed start leaves the state machine consistent", func(_ *ipc.Client, r *recorder) error {
			// Four starts were just refused above. Each must have produced a terminal
			// 'stopped', not left the UI stuck on 'starting' — which is how a connect button
			// ends up spinning forever with nothing behind it.
			sequence := r.stateSequence()
			if len(sequence) == 0 {
				return errors.New("no serviceState events at all")
			}
			if last := sequence[len(sequence)-1]; last != ipc.StateStopped {
				return fmt.Errorf("settled on %q after failed starts, expected %q",
					last, ipc.StateStopped)
			}
			return nil
		}},
	}

	failed := 0
	for _, item := range checks {
		if err := item.run(client, events); err != nil {
			fmt.Printf("  FAIL  %s\n        %v\n", item.name, err)
			failed++
			continue
		}
		fmt.Printf("  ok    %s\n", item.name)
	}

	fmt.Printf("\n%d checks, %d failed\n", len(checks), failed)
	fmt.Printf("events seen: hello=%d serviceState=%d status=%d proxyDelay=%d clashMode=%d\n",
		events.count(ipc.EventHello), events.count(ipc.EventServiceState),
		events.count(ipc.EventStatus), events.count(ipc.EventProxyDelay),
		events.count(ipc.EventClashMode))

	if failed > 0 {
		os.Exit(1)
	}
	return nil
}
