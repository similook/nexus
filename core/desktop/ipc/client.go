package ipc

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// CallTimeout bounds one request.
//
// Generous because `start` is the slow one: it validates, pre-resolves DNS over a possibly
// hostile network, creates a TUN device and installs routes. A timeout shorter than that turns
// a slow connect into a spurious failure, and the UI would show an error over a tunnel that
// then comes up.
const CallTimeout = 30 * time.Second

// Client speaks the contract to a running daemon.
//
// This is the reference implementation of the client half, and it exists for two reasons.
// nexusctl uses it to exercise the contract without a GUI in the picture, which is the Phase 3
// acceptance criterion. And it documents, in a language we already use, what the Tauri host
// will do with opaque bytes — so when that host is written there is something to check it
// against.
type Client struct {
	connection net.Conn
	encoder    *json.Encoder

	nextID atomic.Uint64

	mu      sync.Mutex
	pending map[uint64]chan *Frame

	events   func(name string, data json.RawMessage)
	closed   atomic.Bool
	readDone chan struct{}

	hello   HelloEvent
	helloOK chan struct{}
}

// Connect dials the daemon and starts the read loop.
//
// onEvent is called from the read goroutine for every pushed frame, so it must not block: a
// handler that blocks stalls every response on the connection, not just events.
func Connect(path string, onEvent func(name string, data json.RawMessage)) (*Client, error) {
	connection, err := Dial(path)
	if err != nil {
		return nil, fmt.Errorf("connect to the daemon at %s: %w", path, err)
	}

	if onEvent == nil {
		onEvent = func(string, json.RawMessage) {}
	}

	c := &Client{
		connection: connection,
		encoder:    json.NewEncoder(connection),
		pending:    make(map[uint64]chan *Frame),
		events:     onEvent,
		readDone:   make(chan struct{}),
		helloOK:    make(chan struct{}),
	}

	go c.read()
	return c, nil
}

// Hello waits for the daemon's opening frame and checks the protocol version.
//
// Separate from Connect so a caller can decide what a mismatch means. Refusing every method
// individually would be worse: the user would see one failure per button rather than one
// sentence naming the real problem.
func (c *Client) Hello(timeout time.Duration) (HelloEvent, error) {
	select {
	case <-c.helloOK:
		if c.hello.Protocol != Protocol {
			return c.hello, fmt.Errorf(
				"protocol mismatch: this client speaks v%d, the daemon speaks v%d - "+
					"update whichever is older", Protocol, c.hello.Protocol)
		}
		return c.hello, nil
	case <-c.readDone:
		return c.hello, errors.New("the daemon closed the connection before saying hello")
	case <-time.After(timeout):
		return c.hello, errors.New("the daemon did not send a hello frame")
	}
}

func (c *Client) Close() error {
	c.closed.Store(true)
	return c.connection.Close()
}

// Call sends a request and waits for its reply.
//
// result may be nil for methods that return nothing.
func (c *Client) Call(method string, params any, result any) error {
	id := c.nextID.Add(1)

	request := Request{ID: id, Method: method}
	if params != nil {
		encoded, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("encode params: %w", err)
		}
		request.Params = encoded
	}

	// Register BEFORE sending. Registering after would leave a window in which a fast daemon
	// replies to an id nobody is waiting on, and the reply is dropped — a hang that only
	// reproduces under load, which is the worst kind.
	reply := make(chan *Frame, 1)
	c.mu.Lock()
	c.pending[id] = reply
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	if err := c.encoder.Encode(&request); err != nil {
		return fmt.Errorf("send %s: %w", method, err)
	}

	select {
	case frame := <-reply:
		if frame.Ok == nil || !*frame.Ok {
			if frame.Error == "" {
				return fmt.Errorf("%s failed", method)
			}
			return errors.New(frame.Error)
		}
		if result != nil && len(frame.Data) > 0 {
			if err := json.Unmarshal(frame.Data, result); err != nil {
				return fmt.Errorf("decode %s result: %w", method, err)
			}
		}
		return nil

	case <-c.readDone:
		return errors.New("the daemon closed the connection")

	case <-time.After(CallTimeout):
		return fmt.Errorf("%s timed out after %s", method, CallTimeout)
	}
}

func (c *Client) read() {
	defer close(c.readDone)

	scanner := bufio.NewScanner(c.connection)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for scanner.Scan() {
		var frame Frame
		if err := json.Unmarshal(scanner.Bytes(), &frame); err != nil {
			continue
		}

		if frame.IsEvent() {
			if frame.Event == EventHello {
				_ = json.Unmarshal(frame.Data, &c.hello)
				select {
				case <-c.helloOK:
				default:
					close(c.helloOK)
				}
			}
			c.events(frame.Event, frame.Data)
			continue
		}

		c.mu.Lock()
		reply, waiting := c.pending[frame.ID]
		c.mu.Unlock()

		if waiting {
			// Buffered channel plus a non-blocking send: a caller that gave up (timeout,
			// connection closed) has already deregistered, and the read loop must not block
			// on its abandoned channel.
			select {
			case reply <- &frame:
			default:
			}
		}
	}
}

// ---------------------------------------------------------------------------------------
// Typed helpers — the 8 methods, so callers do not re-spell the strings
// ---------------------------------------------------------------------------------------

func (c *Client) Start(config, name string) error {
	return c.Call(MethodStart, StartParams{Config: config, Name: name}, nil)
}

func (c *Client) Stop() error { return c.Call(MethodStop, nil, nil) }

func (c *Client) GetStatus() (StatusSnapshot, error) {
	var status StatusSnapshot
	err := c.Call(MethodGetStatus, nil, &status)
	return status, err
}

func (c *Client) TCPPing(targets []PingTarget) ([]PingResult, error) {
	var result TCPPingResult
	err := c.Call(MethodTCPPing, TCPPingParams{Targets: targets}, &result)
	return result.Results, err
}

func (c *Client) PingProxy() error { return c.Call(MethodPingProxy, nil, nil) }

func (c *Client) ReadLogs(limit int) ([]string, error) {
	var result ReadLogsResult
	err := c.Call(MethodReadLogs, ReadLogsParams{Limit: limit}, &result)
	return result.Lines, err
}

func (c *Client) ClearLogs() error { return c.Call(MethodClearLogs, nil, nil) }

func (c *Client) SetLogStreaming(enabled bool) error {
	return c.Call(MethodSetLogStreaming, SetLogStreamingParams{Enabled: enabled}, nil)
}

func (c *Client) SetClashMode(mode string) error {
	return c.Call(MethodSetClashMode, SetClashModeParams{Mode: mode}, nil)
}

func (c *Client) CloseConnections() error { return c.Call(MethodCloseConnections, nil, nil) }
