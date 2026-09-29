package nexuscore

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The fetch itself, with a plain dialer standing in for the tunnel's proxy outbound. Loopback
// only: nothing here touches the network or a TUN.

var plainDial = (&net.Dialer{Timeout: 2 * time.Second}).DialContext

func TestFetchWritesBodyAndReportsStatusAndHeaders(t *testing.T) {
	var gotUserAgent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUserAgent = r.Header.Get("User-Agent")
		w.Header().Set("Subscription-Userinfo", "upload=1; download=2; total=3; expire=4")
		_, _ = w.Write([]byte("vless://example\n"))
	}))
	defer server.Close()

	body := filepath.Join(t.TempDir(), "body")
	result, err := fetchTo(plainDial, server.URL+"/sub", "Nexus/0.1 (sing-box)", 5*time.Second, body)
	if err != nil {
		t.Fatalf("fetchTo: %v", err)
	}

	var decoded struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
	}
	if err = json.Unmarshal([]byte(result), &decoded); err != nil {
		t.Fatalf("result is not JSON: %v (%s)", err, result)
	}
	if decoded.Status != http.StatusOK {
		t.Errorf("status %d", decoded.Status)
	}
	if decoded.Headers["subscription-userinfo"] != "upload=1; download=2; total=3; expire=4" {
		t.Errorf("headers %v: subscription-userinfo missing or not lower-cased", decoded.Headers)
	}
	if gotUserAgent != "Nexus/0.1 (sing-box)" {
		t.Errorf("the server saw User-Agent %q", gotUserAgent)
	}
	content, err := os.ReadFile(body)
	if err != nil || string(content) != "vless://example\n" {
		t.Errorf("body file = %q, %v", content, err)
	}
}

func TestFetchReportsAnHTTPErrorAsAStatusNotAFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "gone", http.StatusGone)
	}))
	defer server.Close()

	result, err := fetchTo(plainDial, server.URL, "", 5*time.Second, filepath.Join(t.TempDir(), "body"))
	if err != nil {
		t.Fatalf("an HTTP error is an answer, not a failure: %v", err)
	}
	if !strings.Contains(result, `"status":410`) {
		t.Errorf("result %s, expected status 410", result)
	}
}

func TestFetchFailsWithoutAnAnswer(t *testing.T) {
	// A port nothing listens on: the "no usable network" case, which must be an error.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()

	body := filepath.Join(t.TempDir(), "body")
	if _, err = fetchTo(plainDial, "http://"+address+"/", "", 2*time.Second, body); err == nil {
		t.Fatal("fetchTo succeeded against a closed port")
	}
	if _, statErr := os.Stat(body); !os.IsNotExist(statErr) {
		t.Error("a failed fetch left a body file behind")
	}
}

func TestFetchRefusesOversizedBodies(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		chunk := make([]byte, 1<<20)
		for i := 0; i < maxFetchBytes/len(chunk)+1; i++ {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	defer server.Close()

	body := filepath.Join(t.TempDir(), "body")
	if _, err := fetchTo(plainDial, server.URL, "", 10*time.Second, body); err == nil {
		t.Fatal("an oversized body was accepted")
	}
	if _, statErr := os.Stat(body); !os.IsNotExist(statErr) {
		t.Error("an oversized body was left on disk")
	}
}

func TestFetchRefusesNonHTTPURLs(t *testing.T) {
	for _, bad := range []string{"file:///etc/passwd", "ftp://example.com/x", "not a url", "https://"} {
		if _, err := fetchTo(plainDial, bad, "", time.Second, filepath.Join(t.TempDir(), "body")); err == nil {
			t.Errorf("%q was fetched", bad)
		}
	}
}

func TestFetchViaTunnelNeedsARunningTunnel(t *testing.T) {
	var s Service
	if _, err := s.FetchViaTunnel("https://example.com/", "", 1000, filepath.Join(t.TempDir(), "body")); err == nil {
		t.Fatal("FetchViaTunnel ran with no tunnel")
	}
}
