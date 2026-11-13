package main

import (
	"os"
	"regexp"
	"runtime"
	"testing"
)

// The helper and the Node broker must agree on the protected tree, or the
// broker refuses the socket the helper forwards to.
func TestBaseMatchesBrokerPaths(t *testing.T) {
	src, err := os.ReadFile("../broker-paths.mjs")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`\b` + runtime.GOOS + `: '([^']+)'`).FindSubmatch(src)
	if m == nil {
		t.Fatalf("broker-paths.mjs has no root for %s", runtime.GOOS)
	}
	if string(m[1]) != base {
		t.Fatalf("tsnet base %q, broker-paths.mjs %q", base, m[1])
	}
	if socketPath != base+"/state/broker.sock" {
		t.Fatalf("socket path %q is outside the protected state", socketPath)
	}
}

// Unix socket paths are short (104 bytes on macOS), and macOS's per-user
// TMPDIR is long, so the socket tests there use /private/tmp. Elsewhere the
// ordinary temporary directory is short enough.
func shortTempRoot() string {
	if runtime.GOOS == "darwin" {
		return "/private/tmp"
	}
	return os.TempDir()
}
