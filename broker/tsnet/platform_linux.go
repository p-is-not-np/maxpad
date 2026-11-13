package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
)

// The protected tree. It must equal ROOTS.linux in ../broker-paths.mjs: the
// Node broker compares its socket and origin paths by exact string, and
// platform_test.go holds the two together.
//
// There is deliberately no file for other platforms. A build for an operating
// system with no protected tree fails to compile, which is the Go-side
// equivalent of broker-paths.mjs refusing an unknown platform.
const base = "/opt/muxpad-broker"

// extendedGrants reports whether path carries any grant beyond its mode bits:
// a POSIX ACL entry (default ACLs included) or a file capability. The same two
// mechanisms protected-path.mjs refuses. A missing or failing tool is an
// error, never "none".
func extendedGrants(path string) (bool, error) {
	acl, err := inspect("getfacl", "--absolute-names", "--omit-header", "--skip-base", "--", path)
	if err != nil || len(bytes.TrimSpace(acl)) > 0 {
		return err == nil, err
	}
	caps, err := inspect("getcap", "--", path)
	if err != nil {
		return false, err
	}
	return len(bytes.TrimSpace(caps)) > 0, nil
}

// getfacl is in /usr/bin; getcap in /sbin on Debian and /usr/sbin elsewhere.
// A variable only so tests can point it at fake tools.
var toolDirs = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"}

func inspect(name string, args ...string) ([]byte, error) {
	for _, dir := range toolDirs {
		tool := dir + "/" + name
		if _, err := os.Stat(tool); err != nil {
			continue
		}
		command := exec.Command(tool, args...)
		command.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL=C"}
		return command.Output()
	}
	return nil, errors.New("protected deployment requires " + name + " (install the acl and libcap2-bin packages)")
}
